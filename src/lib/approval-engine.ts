// ActionOS Pay: Approval State Machine & Cryptographic Binding
// Invariant: An approval is strictly and immutably bound to:
// { quoteId, version, totalCents, currency, supplierId, quoteChecksum }
// Any change to the quote invalidates the approval.

import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { evaluatePolicy, evaluatePolicyAsync } from './policy-engine';
import { verifyQuoteIntegrity } from './quote-engine';
import { Approval, Quote, Supplier, TeamMember } from './types';

export interface CreateApprovalParams {
  quote: Quote;
  approver: TeamMember;
  decision: 'approved' | 'rejected';
  reason?: string;
  budgetLimitCents: number;
  orgBudgetLimitCents?: number;
  requesterId?: string;
  supplier?: Supplier;
}

/**
 * Constant-time hex string comparison to protect against timing attacks.
 */
export function safeTimingCompareHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  try {
    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    if (bufA.length !== bufB.length || bufA.length === 0) return false;
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

function hasRealPayPalCredentialsConfigured(): boolean {
  const cid = process.env.PAYPAL_CLIENT_ID;
  const sec = process.env.PAYPAL_CLIENT_SECRET;
  if (!cid || !sec) return false;
  const isPlaceholderVal = (val: string) => {
    const lower = val.trim().toLowerCase();
    return lower === '' || lower.startsWith('your-') || lower.includes('your-paypal') || lower.includes('placeholder');
  };
  return !isPlaceholderVal(cid) && !isPlaceholderVal(sec);
}

export const PUBLIC_DEMO_SIGNING_SECRET = 'c0ffee-demo-signing-secret-at-least-32-characters-long';

/**
 * Retrieves the cryptographic secret key used for HMAC-SHA256 approval signing.
 * Requires APPROVAL_SIGNING_SECRET exclusively and fails closed if missing or below
 * minimum cryptographic strength (32 characters). Shared infrastructure keys
 * (such as SUPABASE_SERVICE_ROLE_KEY) or default secrets are strictly rejected.
 *
 * Security Invariant: The publicly-known demo secret from .env.example is permitted
 * ONLY in local zero-config demo mode (APP_MODE=demo, non-production, no live PayPal credentials,
 * no remote Supabase). Every other environment requires a unique generated secret.
 */
export function getApprovalSigningSecret(): string {
  const secret = process.env.APPROVAL_SIGNING_SECRET;

  if (!secret || secret.trim().length < 32) {
    throw new Error(
      'Cryptographic Failure: Dedicated APPROVAL_SIGNING_SECRET (>= 32 chars) is required. Shared infrastructure keys (such as SUPABASE_SERVICE_ROLE_KEY) or weak fallback secrets are strictly prohibited.'
    );
  }

  const trimmed = secret.trim();

  // Security Invariant: Public demo template key is strictly prohibited outside local offline demo mode
  const isDemoMode = process.env.APP_MODE === 'demo';
  const isProduction = process.env.NODE_ENV === 'production';
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const hasLiveSupabase = Boolean(supabaseUrl && !supabaseUrl.includes('your-project-ref') && !supabaseUrl.includes('localhost'));
  const hasRealPayPal = hasRealPayPalCredentialsConfigured();

  const isPermittedLocalDemo = isDemoMode && !isProduction && !hasLiveSupabase && !hasRealPayPal;

  if (trimmed === PUBLIC_DEMO_SIGNING_SECRET && !isPermittedLocalDemo) {
    throw new Error(
      'Security Invariant: The public demo signing secret from .env.example is permitted ONLY in local zero-config demo mode (APP_MODE=demo, non-production, no live PayPal credentials, no remote Supabase). Generate a unique APPROVAL_SIGNING_SECRET (>= 32 chars).'
    );
  }

  return trimmed;
}

/**
 * Computes an immutable digital signature sealing the approval decision to the quote terms.
 * Uses server-controlled HMAC-SHA256 to guarantee authenticity and prevent client-side forgery.
 */
export function computeApprovalSignature(
  params: {
    quoteId: string;
    quoteVersion: number;
    quoteChecksum: string;
    totalCents: number;
    currency: string;
    supplierId: string;
    approverId: string;
    decision: string;
  },
  secretKey?: string
): string {
  const effectiveKey = secretKey || getApprovalSigningSecret();
  const payload = [
    params.quoteId,
    params.quoteVersion,
    params.quoteChecksum,
    params.totalCents,
    params.currency,
    params.supplierId,
    params.approverId,
    params.decision,
  ].join('::');

  return createHmac('sha256', effectiveKey).update(payload).digest('hex');
}

/**
 * Verifies that an approval strictly binds to the given quote and has not been invalidated.
 * Enforces secret-backed HMAC-SHA256 verification via constant-time comparison.
 * Legacy unkeyed SHA-256 signatures are strictly rejected.
 */
export function verifyApprovalBinding(approval: Approval, quote: Quote): {
  valid: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];

  if (approval.quoteId !== quote.id) {
    reasons.push(`Approval quote ID mismatch: approved "${approval.quoteId}", but quote is "${quote.id}"`);
  }

  if (approval.quoteVersion !== quote.version) {
    reasons.push(
      `Approval version mismatch: approved version ${approval.quoteVersion}, but quote is currently version ${quote.version}. Quote modifications invalidate previous approvals.`
    );
  }

  if (approval.approvedTotalCents !== quote.totalCents) {
    reasons.push(
      `Approval amount mismatch: approved ${approval.approvedTotalCents} cents, but quote total is ${quote.totalCents} cents.`
    );
  }

  if (approval.approvedCurrency !== quote.currency) {
    reasons.push(
      `Approval currency mismatch: approved ${approval.approvedCurrency}, but quote currency is ${quote.currency}.`
    );
  }

  if (approval.approvedSupplierId !== quote.supplierId) {
    reasons.push(
      `Approval supplier mismatch: approved supplier "${approval.approvedSupplierId}", but quote supplier is "${quote.supplierId}".`
    );
  }

  if (approval.decision !== 'approved') {
    reasons.push(`Approval record indicates decision was "${approval.decision}", not "approved".`);
  }

  if (!verifyQuoteIntegrity(quote)) {
    reasons.push('Underlying quote checksum failed: quote content was altered.');
  }

  try {
    const expectedHmacSignature = computeApprovalSignature({
      quoteId: quote.id,
      quoteVersion: quote.version,
      quoteChecksum: quote.checksumHash,
      totalCents: quote.totalCents,
      currency: quote.currency,
      supplierId: quote.supplierId,
      approverId: approval.approverId,
      decision: approval.decision,
    });

    if (!safeTimingCompareHex(approval.digitalSignature, expectedHmacSignature)) {
      reasons.push(
        'Approval digital signature mismatch: signature failed cryptographic HMAC-SHA256 verification or does not seal current quote terms. Legacy unkeyed SHA-256 signatures are prohibited.'
      );
    }
  } catch (err) {
    reasons.push(
      `Approval signature verification error: ${err instanceof Error ? err.message : 'Unknown cryptographic error'}`
    );
  }

  return {
    valid: reasons.length === 0,
    reasons,
  };
}

/**
 * Executes the approval decision, enforcing policy guardrails and issuing a sealed record.
 */
export function processApprovalDecision(params: CreateApprovalParams): {
  approval: Approval;
  policyResult: ReturnType<typeof evaluatePolicy>;
} {
  const { quote, approver, decision, reason, budgetLimitCents, orgBudgetLimitCents, requesterId } = params;

  // Run policy checks
  const policyResult = evaluatePolicy({
    quote,
    budgetLimitCents,
    orgBudgetLimitCents,
    requesterId,
    approver,
  });

  // If approved, policy MUST pass completely
  if (decision === 'approved' && !policyResult.passed) {
    throw new Error(
      `Cannot approve quote due to policy violations: ${policyResult.violations.join('; ')}`
    );
  }

  const digitalSignature = computeApprovalSignature({
    quoteId: quote.id,
    quoteVersion: quote.version,
    quoteChecksum: quote.checksumHash,
    totalCents: quote.totalCents,
    currency: quote.currency,
    supplierId: quote.supplierId,
    approverId: approver.userId,
    decision,
  });

  const approval: Approval = {
    id: randomUUID(),
    quoteId: quote.id,
    businessId: quote.businessId,
    approverId: approver.userId,
    approverName: approver.userName,
    approverRole: approver.role,
    quoteVersion: quote.version,
    approvedTotalCents: quote.totalCents,
    approvedCurrency: quote.currency,
    approvedSupplierId: quote.supplierId,
    decision,
    reason,
    digitalSignature,
    createdAt: new Date().toISOString(),
  };

  return { approval, policyResult };
}

/**
 * Authoritatively executes the approval decision asynchronously.
 * Enforces authoritative policy guardrails via evaluatePolicyAsync and issues a sealed record.
 */
export async function processApprovalDecisionAsync(params: CreateApprovalParams): Promise<{
  approval: Approval;
  policyResult: ReturnType<typeof evaluatePolicy>;
}> {
  const { quote, approver, decision, reason, budgetLimitCents, orgBudgetLimitCents, requesterId, supplier } = params;

  // Run authoritative policy checks asynchronously
  const policyResult = await evaluatePolicyAsync({
    quote,
    budgetLimitCents,
    orgBudgetLimitCents,
    requesterId,
    approver,
    supplier,
  });

  // If approved, policy MUST pass completely
  if (decision === 'approved' && !policyResult.passed) {
    throw new Error(
      `Cannot approve quote due to policy violations: ${policyResult.violations.join('; ')}`
    );
  }

  const digitalSignature = computeApprovalSignature({
    quoteId: quote.id,
    quoteVersion: quote.version,
    quoteChecksum: quote.checksumHash,
    totalCents: quote.totalCents,
    currency: quote.currency,
    supplierId: quote.supplierId,
    approverId: approver.userId,
    decision,
  });

  const approval: Approval = {
    id: randomUUID(),
    quoteId: quote.id,
    businessId: quote.businessId,
    approverId: approver.userId,
    approverName: approver.userName,
    approverRole: approver.role,
    quoteVersion: quote.version,
    approvedTotalCents: quote.totalCents,
    approvedCurrency: quote.currency,
    approvedSupplierId: quote.supplierId,
    decision,
    reason,
    digitalSignature,
    createdAt: new Date().toISOString(),
  };

  return { approval, policyResult };
}
