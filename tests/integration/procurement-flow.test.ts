import { beforeEach, describe, expect, it } from 'vitest';
import { parseProcurementIntent } from '../../src/lib/ai-planner';
import { processApprovalDecision, verifyApprovalBinding } from '../../src/lib/approval-engine';
import { DEMO_BUSINESS, DEMO_MEMBERS } from '../../src/lib/catalog';
import { LedgerEngine } from '../../src/lib/ledger';
import { capturePayPalOrder, createPayPalOrder } from '../../src/lib/paypal-service';
import { evaluatePolicy } from '../../src/lib/policy-engine';
import { calculateQuote } from '../../src/lib/quote-engine';
import { ProcurementRequest } from '../../src/lib/types';
import { randomUUID } from 'crypto';

describe('End-to-End Procurement Flow Integration', () => {
  beforeEach(() => {
    LedgerEngine.reset();
  });

  it('executes full procurement lifecycle: intent -> plan -> quote -> approval -> payment -> ledger', async () => {
    const requester = DEMO_MEMBERS.find((m) => m.role === 'requester')!;
    const approver = DEMO_MEMBERS.find((m) => m.role === 'approver')!;

    // Step 1: User submits natural language intent
    const rawPrompt = 'Order 2 Dell XPS 15 laptops from AfriTech for our engineering team. Budget under $5,000.';
    const plan = await parseProcurementIntent(rawPrompt, 500000);

    expect(plan.items.length).toBeGreaterThan(0);
    expect(plan.budgetLimitCents).toBe(500000);
    expect(plan.clarificationNeeded).toBe(false);

    const requestId = randomUUID();
    const req: ProcurementRequest = {
      id: requestId,
      businessId: DEMO_BUSINESS.id,
      requesterId: requester.userId,
      requesterName: requester.userName,
      rawPrompt,
      structuredPlan: plan,
      status: 'draft',
      budgetLimitCents: plan.budgetLimitCents,
      currency: plan.currency,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    LedgerEngine.saveRequest(req);

    // Step 2: Calculate server-side authoritative quote
    const supplierId = plan.suggestedSupplierId || '00000000-0000-4000-8000-000000000100';
    const quote = calculateQuote({
      requestId,
      businessId: DEMO_BUSINESS.id,
      supplierId,
      items: plan.items.map((i) => ({ sku: i.sku, quantity: i.quantity })),
    });

    LedgerEngine.saveQuote(quote);
    expect(quote.status).toBe('active');
    expect(quote.totalCents).toBeLessThanOrEqual(plan.budgetLimitCents);

    // Step 3: Run policy engine checks
    const policyResult = evaluatePolicy({
      quote,
      budgetLimitCents: req.budgetLimitCents,
      requesterId: requester.userId,
      approver,
    });
    expect(policyResult.passed).toBe(true);

    // Step 4: Authorized user approves exact quote version
    const { approval } = processApprovalDecision({
      quote,
      approver,
      decision: 'approved',
      reason: 'Approved for Q4 engineering onboarding.',
      budgetLimitCents: req.budgetLimitCents,
      requesterId: requester.userId,
    });
    LedgerEngine.saveApproval(approval);

    expect(verifyApprovalBinding(approval, quote).valid).toBe(true);
    expect(LedgerEngine.getRequest(requestId)?.status).toBe('approved');

    // Step 5: Server creates PayPal sandbox order bound to approved quote
    const orderRes = await createPayPalOrder({
      quote,
      approval,
    });
    LedgerEngine.savePaymentAttempt(orderRes.paymentAttempt);

    expect(orderRes.orderId).toBeDefined();
    expect(orderRes.paymentAttempt.status).toBe('created');
    expect(LedgerEngine.getRequest(requestId)?.status).toBe('payment_pending');

    // Step 6: Server captures payment after checkout
    const captureRes = await capturePayPalOrder({
      orderId: orderRes.orderId,
      paymentAttempt: orderRes.paymentAttempt,
    });
    LedgerEngine.savePaymentAttempt(captureRes.paymentAttempt);

    expect(captureRes.status).toBe('COMPLETED');
    expect(captureRes.paymentAttempt.status).toBe('captured');
    expect(LedgerEngine.getRequest(requestId)?.status).toBe('paid');

    // Step 7: Verify authoritative ledger audit trail
    const auditEvents = LedgerEngine.getAuditEvents(DEMO_BUSINESS.id);
    expect(auditEvents.length).toBeGreaterThanOrEqual(4);

    const actions = auditEvents.map((e) => e.action);
    expect(actions).toContain('QUOTE_CALCULATED');
    expect(actions).toContain('QUOTE_APPROVED');
    expect(actions).toContain('PAYMENT_ATTEMPT_CREATED');
    expect(actions).toContain('PAYMENT_CAPTURED');
  });
});
