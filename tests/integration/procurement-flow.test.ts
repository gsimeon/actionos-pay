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

import { POST as planRoute } from '../../src/app/api/procurement/plan/route';
import { POST as quoteRoute } from '../../src/app/api/procurement/quote/route';
import { POST as approveRoute } from '../../src/app/api/procurement/approve/route';
import { POST as createOrderRoute } from '../../src/app/api/paypal/create-order/route';
import { POST as captureOrderRoute } from '../../src/app/api/paypal/capture-order/route';
import { POST as webhookRoute } from '../../src/app/api/paypal/webhook/route';

describe('End-to-End Procurement Flow Integration', () => {
  beforeEach(() => {
    process.env.APP_MODE = 'demo';
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
    await LedgerEngine.saveRequestAsync(req);

    // Step 2: Calculate server-side authoritative quote
    const supplierId = plan.suggestedSupplierId || '00000000-0000-4000-8000-000000000100';
    const quote = calculateQuote({
      requestId,
      businessId: DEMO_BUSINESS.id,
      supplierId,
      items: plan.items.map((i) => ({ sku: i.sku, quantity: i.quantity })),
    });

    await LedgerEngine.saveQuoteAsync(quote);
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
    await LedgerEngine.saveApprovalAsync(approval);

    expect(verifyApprovalBinding(approval, quote).valid).toBe(true);
    expect(LedgerEngine.getRequest(requestId)?.status).toBe('approved');

    // Step 5: Server creates PayPal sandbox order bound to approved quote
    const orderRes = await createPayPalOrder({
      quote,
      approval,
    });
    await LedgerEngine.savePaymentAttemptAsync(orderRes.paymentAttempt);

    expect(orderRes.orderId).toBeDefined();
    expect(orderRes.paymentAttempt.status).toBe('created');
    expect(LedgerEngine.getRequest(requestId)?.status).toBe('payment_pending');

    // Step 6: Server captures payment after checkout
    const captureRes = await capturePayPalOrder({
      orderId: orderRes.orderId,
      paymentAttempt: orderRes.paymentAttempt,
    });
    await LedgerEngine.savePaymentAttemptAsync(captureRes.paymentAttempt);

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

  it('executes full procurement and payment lifecycle via actual HTTP Route handlers', async () => {
    const requester = DEMO_MEMBERS.find((m) => m.role === 'requester')!;
    const approver = DEMO_MEMBERS.find((m) => m.role === 'approver')!;

    // Step 1: POST /api/procurement/plan
    const planReq = new Request('http://localhost/api/procurement/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Order 2 Dell XPS 15 laptops from AfriTech for our engineering team. Budget under $5,000.',
        budgetLimitCents: 500000,
        requesterId: requester.userId,
      }),
    });
    const planRes = await planRoute(planReq);
    expect(planRes.status).toBe(200);
    const planJson = await planRes.json();
    expect(planJson.request.id).toBeDefined();
    const requestId = planJson.request.id;

    // Step 2: POST /api/procurement/quote
    const quoteReq = new Request('http://localhost/api/procurement/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId,
        supplierId: '00000000-0000-4000-8000-000000000100',
        items: [{ sku: 'LAP-DELL-XPS15', quantity: 2 }],
      }),
    });
    const quoteRes = await quoteRoute(quoteReq);
    expect(quoteRes.status).toBe(200);
    const quoteJson = await quoteRes.json();
    expect(quoteJson.quote.id).toBeDefined();
    const quoteId = quoteJson.quote.id;
    const totalCents = quoteJson.quote.totalCents;

    // Step 3: POST /api/procurement/approve
    const approveReq = new Request('http://localhost/api/procurement/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteId,
        decision: 'approved',
        approverUserId: approver.userId,
        reason: 'Approved via full HTTP integration test.',
      }),
    });
    const approveRes = await approveRoute(approveReq);
    expect(approveRes.status).toBe(200);
    const approveJson = await approveRes.json();
    expect(approveJson.approval.digitalSignature).toBeDefined();

    // Step 4: POST /api/paypal/create-order
    const createOrderReq = new Request('http://localhost/api/paypal/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteId }),
    });
    const createOrderRes = await createOrderRoute(createOrderReq);
    expect(createOrderRes.status).toBe(200);
    const createOrderJson = await createOrderRes.json();
    expect(createOrderJson.orderId).toBeDefined();
    const orderId = createOrderJson.orderId;

    // Step 5: POST /api/paypal/capture-order
    const captureReq = new Request('http://localhost/api/paypal/capture-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId }),
    });
    const captureRes = await captureOrderRoute(captureReq);
    expect(captureRes.status).toBe(200);
    const captureJson = await captureRes.json();
    expect(captureJson.status).toBe('COMPLETED');
    const captureId = captureJson.captureId;

    // Step 6: POST /api/paypal/webhook (Reconciliation & Fulfillment)
    const webhookReq = new Request('http://localhost/api/paypal/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'paypal-transmission-sig': 'valid-simulation-sig-12345',
      },
      body: JSON.stringify({
        id: `WH-E2E-${randomUUID()}`,
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: {
          id: captureId,
          status: 'COMPLETED',
          supplementary_data: { related_ids: { order_id: orderId } },
          amount: {
            value: (totalCents / 100).toFixed(2),
            currency_code: 'USD',
          },
        },
      }),
    });
    const webhookRes = await webhookRoute(webhookReq);
    expect(webhookRes.status).toBe(200);
    const webhookJson = await webhookRes.json();
    expect(webhookJson.status).toBe('processed');

    // Step 7: Verify final state across ledger
    const finalReq = await LedgerEngine.getRequestAsync(requestId);
    expect(finalReq?.status).toBe('fulfilled');

    const finalPayment = await LedgerEngine.getPaymentByOrderIdAsync(orderId);
    expect(finalPayment?.status).toBe('captured');
  });
});
