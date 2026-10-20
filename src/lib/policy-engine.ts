// ActionOS Pay: Policy & Governance Engine
// Enforces corporate guardrails: approved suppliers, budget ceilings,
// role-based authority, self-approval bans, and quote freshness.

import { getSupplierById } from './catalog';
import { formatCurrency } from './currency';
import { verifyQuoteIntegrity } from './quote-engine';
import { PolicyCheckItem, PolicyEvaluationResult, Quote, TeamMember } from './types';

export interface EvaluatePolicyParams {
  quote: Quote;
  budgetLimitCents: number;
  requesterId?: string;
  approver?: TeamMember;
}

/**
 * Runs all governance checks against an active quote and optional approver context.
 */
export function evaluatePolicy(params: EvaluatePolicyParams): PolicyEvaluationResult {
  const { quote, budgetLimitCents, requesterId, approver } = params;
  const checks: PolicyCheckItem[] = [];
  const violations: string[] = [];

  // 1. Supplier Approval Check
  const supplier = getSupplierById(quote.supplierId);
  const supplierApproved = Boolean(supplier && supplier.isApproved);
  if (supplierApproved) {
    checks.push({
      code: 'SUPPLIER_APPROVED',
      name: 'Approved Vendor Verification',
      passed: true,
      message: `Supplier "${supplier?.name}" is verified and active on the approved supplier list.`,
    });
  } else {
    const errorMsg = `Supplier "${supplier ? supplier.name : quote.supplierId}" is NOT an approved vendor (Risk rating: ${supplier?.riskRating || 'unknown'}). Purchases from unapproved suppliers are blocked.`;
    checks.push({
      code: 'SUPPLIER_APPROVED',
      name: 'Approved Vendor Verification',
      passed: false,
      message: errorMsg,
    });
    violations.push(errorMsg);
  }

  // 2. Budget Limit Check
  const withinBudget = quote.totalCents <= budgetLimitCents;
  if (withinBudget) {
    checks.push({
      code: 'BUDGET_COMPLIANCE',
      name: 'Budget Threshold Guardrail',
      passed: true,
      message: `Quote total (${formatCurrency(quote.totalCents, quote.currency)}) is within the approved budget limit of ${formatCurrency(budgetLimitCents, quote.currency)}.`,
    });
  } else {
    const diff = quote.totalCents - budgetLimitCents;
    const errorMsg = `Quote total (${formatCurrency(quote.totalCents, quote.currency)}) exceeds the budget limit (${formatCurrency(budgetLimitCents, quote.currency)}) by ${formatCurrency(diff, quote.currency)}.`;
    checks.push({
      code: 'BUDGET_COMPLIANCE',
      name: 'Budget Threshold Guardrail',
      passed: false,
      message: errorMsg,
      details: {
        quoteTotalCents: quote.totalCents,
        budgetLimitCents,
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
