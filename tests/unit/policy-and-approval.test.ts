import { describe, expect, it } from 'vitest';
import { processApprovalDecision, verifyApprovalBinding } from '../../src/lib/approval-engine';
import { DEMO_BUSINESS, DEMO_MEMBERS } from '../../src/lib/catalog';
import { evaluatePolicy } from '../../src/lib/policy-engine';
import { calculateQuote } from '../../src/lib/quote-engine';

describe('Policy and Governance Engine', () => {
  const reqId = 'req-policy-01';
  const bizId = DEMO_BUSINESS.id;
  const approvedSupId = '00000000-0000-4000-8000-000000000100'; // AfriTech (approved)
  const unapprovedSupId = '00000000-0000-4000-8000-000000000300'; // ShadowTech (unapproved)

  const requester = DEMO_MEMBERS.find((m) => m.role === 'requester')!;
  const approver = DEMO_MEMBERS.find((m) => m.role === 'approver')!;

  it('passes policy check when supplier is approved and total is within budget', () => {
    const quote = calculateQuote({
      requestId: reqId,
      businessId: bizId,
      supplierId: approvedSupId,
      items: [{ sku: 'LAP-DELL-XPS15', quantity: 1 }], // $1,799.00
    });

    const res = evaluatePolicy({
      quote,
      budgetLimitCents: 500000, // $5,000 budget
      requesterId: requester.userId,
      approver,
    });

    expect(res.passed).toBe(true);
    expect(res.violations).toHaveLength(0);
  });

  it('fails policy check when supplier is unapproved', () => {
    const quote = calculateQuote({
      requestId: reqId,
      businessId: bizId,
      supplierId: unapprovedSupId,
      items: [{ sku: 'LAP-SHAD-GREY01', quantity: 1 }],
    });

    const res = evaluatePolicy({
      quote,
      budgetLimitCents: 500000,
      requesterId: requester.userId,
      approver,
    });

    expect(res.passed).toBe(false);
    expect(res.violations.some((v) => v.includes('NOT an approved vendor'))).toBe(true);
  });

  it('fails policy check when quote total exceeds request budget', () => {
    const quote = calculateQuote({
      requestId: reqId,
      businessId: bizId,
      supplierId: approvedSupId,
      items: [{ sku: 'LAP-DELL-XPS15', quantity: 4 }], // > $7,000
    });

    const res = evaluatePolicy({
      quote,
      budgetLimitCents: 300000, // Only $3,000 budget
      requesterId: requester.userId,
      approver,
    });

    expect(res.passed).toBe(false);
    expect(res.violations.some((v) => v.includes('exceeds the budget limit'))).toBe(true);
  });

  it('enforces segregation of duties (prohibits self-approval over $500)', () => {
    const quote = calculateQuote({
      requestId: reqId,
      businessId: bizId,
      supplierId: approvedSupId,
      items: [{ sku: 'LAP-DELL-XPS15', quantity: 1 }], // ~$1,980 total
    });

    // Attempting self-approval where approver === requester
    const res = evaluatePolicy({
      quote,
      budgetLimitCents: 500000,
      requesterId: approver.userId, // Same user!
      approver,
    });

    expect(res.passed).toBe(false);
    expect(res.violations.some((v) => v.includes('Self-approval violation'))).toBe(true);
  });
});

describe('Approval State Machine & Binding', () => {
  const reqId = 'req-app-02';
  const bizId = DEMO_BUSINESS.id;
  const approvedSupId = '00000000-0000-4000-8000-000000000100';
  const requester = DEMO_MEMBERS.find((m) => m.role === 'requester')!;
  const approver = DEMO_MEMBERS.find((m) => m.role === 'approver')!;

  it('creates an immutable, cryptographically sealed approval', () => {
    const quote = calculateQuote({
      requestId: reqId,
      businessId: bizId,
      supplierId: approvedSupId,
      items: [{ sku: 'LAP-DELL-XPS15', quantity: 1 }],
    });

    const { approval } = processApprovalDecision({
      quote,
      approver,
      decision: 'approved',
      reason: 'Necessary for Q4 engineering headcount.',
      budgetLimitCents: 500000,
      requesterId: requester.userId,
    });

    expect(approval.decision).toBe('approved');
    expect(approval.digitalSignature).toBeDefined();
    expect(approval.quoteVersion).toBe(quote.version);
    expect(approval.approvedTotalCents).toBe(quote.totalCents);

    const check = verifyApprovalBinding(approval, quote);
    expect(check.valid).toBe(true);
  });

  it('invalidates approval when quote version or terms change', () => {
    const quoteV1 = calculateQuote({
      requestId: reqId,
      businessId: bizId,
      supplierId: approvedSupId,
      version: 1,
      items: [{ sku: 'LAP-DELL-XPS15', quantity: 1 }],
    });

    const { approval } = processApprovalDecision({
      quote: quoteV1,
      approver,
      decision: 'approved',
      budgetLimitCents: 500000,
      requesterId: requester.userId,
    });

    // Now supplier issues quote version 2 with updated price or item
    const quoteV2 = calculateQuote({
      requestId: reqId,
      businessId: bizId,
      supplierId: approvedSupId,
      version: 2,
      items: [{ sku: 'LAP-DELL-XPS15', quantity: 2 }],
    });

    // Verification must fail!
    const check = verifyApprovalBinding(approval, quoteV2);
    expect(check.valid).toBe(false);
    expect(check.reasons.some((r) => r.includes('Approval version mismatch'))).toBe(true);
  });
});
