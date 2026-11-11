// ActionOS Pay: Policy & Governance Engine
// Enforces corporate guardrails: approved suppliers, budget ceilings,
// role-based authority, self-approval bans, and quote freshness.

import {
  getSupplierById,
  getBusinessBudgetLimitCents,
  resolveAuthoritativeSupplierAsync,
  resolveAuthoritativeBusinessBudgetLimitAsync,
} from './catalog';
import { isSupabaseConfigured } from './supabase';
import { formatCurrency } from './currency';
import { verifyQuoteIntegrity } from './quote-engine';
import { PolicyCheckItem, PolicyEvaluationResult, Quote, Supplier, TeamMember } from './types';

export interface EvaluatePolicyParams {
  quote: Quote;
  budgetLimitCents: number;
  orgBudgetLimitCents?: number;
  requesterId?: string;
  approver?: TeamMember;
  supplier?: Supplier;
}

/**
 * Runs all governance checks against an active quote and optional approver context.
 */
export function evaluatePolicy(params: EvaluatePolicyParams): PolicyEvaluationResult {
  const { quote, budgetLimitCents, orgBudgetLimitCents, requesterId, approver } = params;
  const checks: PolicyCheckItem[] = [];
  const violations: string[] = [];

  // 1. Supplier Approval & Tenant Ownership Check
  const isSupabase = isSupabaseConfigured();
  const supplier =
    params.supplier !== undefined
      ? params.supplier
      : isSupabase
      ? undefined // Strict fail-closed: Never fall back to local demo fixtures when Supabase is configured
      : getSupplierById(quote.supplierId);
  const supplierApproved = Boolean(supplier && supplier.isApproved);
  const supplierMatchesTenant = Boolean(
    supplier && (!supplier.businessId || supplier.businessId === quote.businessId)
  );

  if (supplier && supplierApproved && supplierMatchesTenant) {
    checks.push({
      code: 'SUPPLIER_APPROVED',
      name: 'Approved Vendor Verification',
      passed: true,
      message: `Supplier "${supplier.name}" is verified, active, and authorized for business organization "${quote.businessId}".`,
    });
  } else {
    let errorMsg: string;
    if (!supplier) {
      errorMsg = isSupabase
        ? `Supplier "${quote.supplierId}" was not found in the organization's database supplier registry. Purchases from unrecognized vendors are blocked.`
        : `Supplier "${quote.supplierId}" was not found in the approved supplier registry. Purchases from unrecognized vendors are blocked.`;
    } else if (!supplierMatchesTenant) {
      errorMsg = `Cross-tenant supplier violation: Supplier "${supplier.name}" belongs to business "${supplier.businessId}" and is NOT authorized for business "${quote.businessId}". Purchases across organizational boundaries are strictly prohibited.`;
    } else {
      errorMsg = `Supplier "${supplier.name}" is NOT an approved vendor (Risk rating: ${supplier.riskRating || 'unknown'}). Purchases from unapproved suppliers are blocked.`;
    }
    checks.push({
      code: 'SUPPLIER_APPROVED',
      name: 'Approved Vendor Verification',
      passed: false,
      message: errorMsg,
    });
    violations.push(errorMsg);
  }

  // 2. Budget Limit & Organization Spending Ceiling Check
  // Authoritative organization spending ceiling: Resolved explicitly from params or authoritatively from quote.businessId
  const authoritativeOrgLimit =
    typeof orgBudgetLimitCents === 'number'
      ? orgBudgetLimitCents
      : getBusinessBudgetLimitCents(quote.businessId);

  // If the organization limit is zero or unrecognized, fail closed immediately
  const effectiveCeiling =
    authoritativeOrgLimit > 0
      ? Math.min(budgetLimitCents, authoritativeOrgLimit)
      : 0;

  const withinBudget = quote.totalCents <= effectiveCeiling && effectiveCeiling > 0;
  if (withinBudget) {
    checks.push({
      code: 'BUDGET_COMPLIANCE',
      name: 'Budget Threshold Guardrail',
      passed: true,
      message: `Quote total (${formatCurrency(quote.totalCents, quote.currency)}) is within the approved budget limit of ${formatCurrency(effectiveCeiling, quote.currency)}.`,
    });
  } else {
    const diff = quote.totalCents - effectiveCeiling;
    const isOrgBreach = quote.totalCents > authoritativeOrgLimit;
    const errorMsg = isOrgBreach
      ? `Quote total (${formatCurrency(quote.totalCents, quote.currency)}) exceeds the organization's authoritative budget ceiling (${formatCurrency(authoritativeOrgLimit, quote.currency)}) by ${formatCurrency(quote.totalCents - authoritativeOrgLimit, quote.currency)}.`
      : `Quote total (${formatCurrency(quote.totalCents, quote.currency)}) exceeds the budget limit (${formatCurrency(budgetLimitCents, quote.currency)}) by ${formatCurrency(diff, quote.currency)}.`;
    checks.push({
      code: 'BUDGET_COMPLIANCE',
      name: 'Budget Threshold Guardrail',
      passed: false,
      message: errorMsg,
      details: {
        quoteTotalCents: quote.totalCents,
        budgetLimitCents: effectiveCeiling,
        orgBudgetLimitCents: authoritativeOrgLimit,
        overageCents: diff,
      },
    });
    violations.push(errorMsg);
  }

  // 3. Quote Integrity & Expiration Check
  const isIntegrityValid = verifyQuoteIntegrity(quote);
  const isExpired = new Date(quote.expiresAt).getTime() <= Date.now();

  if (isIntegrityValid && !isExpired) {
    checks.push({
      code: 'QUOTE_FRESHNESS_AND_INTEGRITY',
      name: 'Quote Integrity & Expiration',
      passed: true,
      message: `Quote integrity verified via SHA-256 seal. Valid until ${new Date(quote.expiresAt).toLocaleDateString()}.`,
    });
  } else {
    const errorMsg = !isIntegrityValid
      ? 'Quote cryptographic checksum failed: terms or amounts were tampered with.'
      : 'Quote has expired. A fresh quote must be prepared.';
    checks.push({
      code: 'QUOTE_FRESHNESS_AND_INTEGRITY',
      name: 'Quote Integrity & Expiration',
      passed: false,
      message: errorMsg,
    });
    violations.push(errorMsg);
  }

  // 4. Approver Authorization (if evaluating an approval action)
  if (approver) {
    const hasRole = approver.role === 'approver' || approver.role === 'admin';
    if (!hasRole) {
      const errorMsg = `User "${approver.userName}" holds role "${approver.role}". Only 'approver' or 'admin' roles can grant procurement approval.`;
      checks.push({
        code: 'APPROVER_ROLE',
        name: 'Approval Authority Check',
        passed: false,
        message: errorMsg,
      });
      violations.push(errorMsg);
    } else {
      checks.push({
        code: 'APPROVER_ROLE',
        name: 'Approval Authority Check',
        passed: true,
        message: `User "${approver.userName}" holds authorized role "${approver.role}".`,
      });
    }

    // Self-approval ban for purchases > $500 (50000 cents)
    const isSelfApproval = requesterId && requesterId === approver.userId;
    if (isSelfApproval && quote.totalCents > 50000) {
      const errorMsg = `Self-approval violation: Requesters cannot approve their own purchases over ${formatCurrency(50000)}.`;
      checks.push({
        code: 'SELF_APPROVAL_BAN',
        name: 'Segregation of Duties (SoD)',
        passed: false,
        message: errorMsg,
      });
      violations.push(errorMsg);
    } else {
      checks.push({
        code: 'SELF_APPROVAL_BAN',
        name: 'Segregation of Duties (SoD)',
        passed: true,
        message: 'Independent approver confirmed. Segregation of duties maintained.',
      });
    }

    // Approver delegated limit check
    if (approver.approvalLimitCents < quote.totalCents) {
      const errorMsg = `Quote total (${formatCurrency(quote.totalCents)}) exceeds approver's delegated spending threshold (${formatCurrency(approver.approvalLimitCents)}).`;
      checks.push({
        code: 'APPROVER_LIMIT',
        name: 'Delegated Spending Limit',
        passed: false,
        message: errorMsg,
      });
      violations.push(errorMsg);
    } else {
      checks.push({
        code: 'APPROVER_LIMIT',
        name: 'Delegated Spending Limit',
        passed: true,
        message: `Approver threshold (${formatCurrency(approver.approvalLimitCents)}) covers total amount.`,
      });
    }
  }

  return {
    passed: violations.length === 0,
    checks,
    violations,
  };
}

/**
 * Authoritatively evaluates policy asynchronously.
 * Resolves the supplier and organization budget limit authoritatively from the database in Supabase mode
 * (or from registered fixtures in local demo mode), ensuring complete consistency with quote generation.
 */
export async function evaluatePolicyAsync(
  params: EvaluatePolicyParams
): Promise<PolicyEvaluationResult> {
  const { quote, orgBudgetLimitCents } = params;

  // Resolve supplier authoritatively from database in Supabase mode or fixtures in demo mode
  const resolvedSupplier =
    params.supplier ||
    (await resolveAuthoritativeSupplierAsync(quote.businessId, quote.supplierId));

  // Resolve authoritative organization spending ceiling
  const resolvedOrgLimit =
    typeof orgBudgetLimitCents === 'number' && orgBudgetLimitCents > 0
      ? orgBudgetLimitCents
      : await resolveAuthoritativeBusinessBudgetLimitAsync(quote.businessId);

  return evaluatePolicy({
    ...params,
    orgBudgetLimitCents: resolvedOrgLimit,
    supplier: resolvedSupplier,
  });
}
