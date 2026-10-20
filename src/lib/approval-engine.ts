// ActionOS Pay: Approval State Machine & Cryptographic Binding
// Invariant: An approval is strictly and immutably bound to:
// { quoteId, version, totalCents, currency, supplierId, quoteChecksum }
// Any change to the quote invalidates the approval.

import { createHash, randomUUID } from 'crypto';
import { evaluatePolicy } from './policy-engine';
import { verifyQuoteIntegrity } from './quote-engine';
import { Approval, Quote, TeamMember } from './types';

export interface CreateApprovalParams {
  quote: Quote;
  approver: TeamMember;
  decision: 'approved' | 'rejected';
  reason?: string;
  budgetLimitCents: number;
  requesterId?: string;
}

/**
 * Computes an immutable digital signature sealing the approval decision to the quote terms.
 */
export function computeApprovalSignature(params: {
  quoteId: string;
  quoteVersion: number;
  quoteChecksum: string;
  totalCents: number;
  currency: string;
  supplierId: string;
  approverId: string;
  decision: string;
}): string {
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

  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Verifies that an approval strictly binds to the given quote and has not been invalidated.
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

  const expectedSignature = computeApprovalSignature({
    quoteId: quote.id,
    quoteVersion: quote.version,
    quoteChecksum: quote.checksumHash,
    totalCents: quote.totalCents,
    currency: quote.currency,
    supplierId: quote.supplierId,
    approverId: approval.approverId,
    decision: approval.decision,
  });

  if (approval.digitalSignature !== expectedSignature) {
    reasons.push('Approval digital signature mismatch: signature does not seal current quote terms.');
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
  const { quote, approver, decision, reason, budgetLimitCents, requesterId } = params;

  // Run policy checks
  const policyResult = evaluatePolicy({
    quote,
    budgetLimitCents,
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
