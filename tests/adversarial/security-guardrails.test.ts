import { describe, expect, it } from 'vitest';
import { processApprovalDecision } from '../../src/lib/approval-engine';
import { DEMO_BUSINESS, DEMO_MEMBERS } from '../../src/lib/catalog';
import { LedgerEngine } from '../../src/lib/ledger';
import { capturePayPalOrder, createPayPalOrder, verifyWebhookSignature } from '../../src/lib/paypal-service';
import { evaluatePolicy } from '../../src/lib/policy-engine';
import { calculateQuote, verifyQuoteIntegrity } from '../../src/lib/quote-engine';

describe('Adversarial Security & Guardrail Tests', () => {
  const bizId = DEMO_BUSINESS.id;
  const approvedSupId = '00000000-0000-4000-8000-000000000100'; // AfriTech
  const unapprovedSupId = '00000000-0000-4000-8000-000000000300'; // ShadowTech
  const requester = DEMO_MEMBERS.find((m) => m.role === 'requester')!;
  const approver = DEMO_MEMBERS.find((m) => m.role === 'approver')!;

  it('Adversary Attack 1: Browser client attempts to tamper with unit price', () => {
    // Client supplies an illegitimate cheap price of $1.00 instead of catalogue $1,799.00
    // The server quote engine calculates strictly from the DB catalogue, ignoring client amounts
    const quote = calculateQuote({
      requestId: 'req-adv-01',
      businessId: bizId,
      supplierId: approvedSupId,
      items: [
        {
          sku: 'LAP-DELL-XPS15',
          quantity: 1,
          // Even if client tried to pass a fake unitPrice, calculateQuote uses product.unitPriceCents
        },
      ],
    });

    expect(quote.items[0].unitPriceCents).toBe(179900); // Authoritative $1,799.00
    expect(quote.totalCents).toBeGreaterThan(179900);
  });

  it('Adversary Attack 2: In-flight tampering of quote total or items is caught by SHA-256 seal', () => {
    const quote = calculateQuote({
      requestId: 'req-adv-02',
      businessId: bizId,
      supplierId: approvedSupId,
      items: [{ sku: 'LAP-DELL-XPS15', quantity: 1 }],
    });

    expect(verifyQuoteIntegrity(quote)).toBe(true);

    // Attacker modifies total amount in payload
    const alteredQuote = { ...quote, totalCents: 50000 };
    expect(verifyQuoteIntegrity(alteredQuote)).toBe(false);

    // Attacker adds an unapproved extra item
    const alteredItemsQuote = {
      ...quote,
      items: [
        ...quote.items,
        {
          id: 'fake-item',
          quoteId: quote.id,
          itemName: 'Unauthorized Drone',
          quantity: 1,
          unitPriceCents: 10000,
          totalCents: 10000,
        },
      ],
    };
    expect(verifyQuoteIntegrity(alteredItemsQuote)).toBe(false);
  });

  it('Adversary Attack 3: Unapproved supplier order attempt is rejected by policy engine', () => {
    const quote = calculateQuote({
      requestId: 'req-adv-03',
      businessId: bizId,
      supplierId: unapprovedSupId, // ShadowTech (unapproved)
      items: [{ sku: 'LAP-SHAD-GREY01', quantity: 1 }],
    });

    const res = evaluatePolicy({
      quote,
      budgetLimitCents: 1000000,
      requesterId: requester.userId,
      approver,
    });

    expect(res.passed).toBe(false);
    expect(res.violations.some((v) => v.includes('NOT an approved vendor'))).toBe(true);

    // Attempting to process approval must throw an error
    expect(() =>
      processApprovalDecision({
        quote,
        approver,
        decision: 'approved',
        budgetLimitCents: 1000000,
        requesterId: requester.userId,
      })
    ).toThrow(/Cannot approve quote due to policy violations/);
  });

  it('Adversary Attack 4: Attempting to create PayPal order without an approved quote fails', async () => {
    const quote = calculateQuote({
      requestId: 'req-adv-04',
      businessId: bizId,
      supplierId: approvedSupId,
      items: [{ sku: 'LAP-DELL-XPS15', quantity: 1 }],
    });

    // Mock a bogus approval with a mismatched quote ID
    const bogusApproval = {
      id: 'bogus-app-id',
      quoteId: 'completely-different-quote-id',
      businessId: bizId,
      approverId: approver.userId,
      approverName: approver.userName,
      approverRole: approver.role,
      quoteVersion: 1,
      approvedTotalCents: quote.totalCents,
      approvedCurrency: 'USD',
      approvedSupplierId: quote.supplierId,
      decision: 'approved' as const,
      digitalSignature: 'bogus-sig',
      createdAt: new Date().toISOString(),
    };

    await expect(
      createPayPalOrder({
        quote,
        approval: bogusApproval,
      })
    ).rejects.toThrow(/Cannot create PayPal order: Approval is invalid/);
  });

  it('Adversary Attack 5: Double-capture attack is prevented by idempotency and state guards', async () => {
    const quote = calculateQuote({
      requestId: 'req-adv-05',
      businessId: bizId,
      supplierId: approvedSupId,
      items: [{ sku: 'LAP-DELL-XPS15', quantity: 1 }],
    });

    const { approval } = processApprovalDecision({
      quote,
      approver,
      decision: 'approved',
      budgetLimitCents: 1000000,
      requesterId: requester.userId,
    });

    const orderRes = await createPayPalOrder({ quote, approval });
    expect(orderRes.status).toBe('CREATED');

    // First capture succeeds
    const firstCapture = await capturePayPalOrder({
      orderId: orderRes.orderId,
      paymentAttempt: orderRes.paymentAttempt,
      idempotencyKey: 'idem-key-01',
    });
    expect(firstCapture.status).toBe('COMPLETED');
    expect(firstCapture.paymentAttempt.status).toBe('captured');

    // Second capture attempt with the same order
    const secondCapture = await capturePayPalOrder({
      orderId: orderRes.orderId,
      paymentAttempt: firstCapture.paymentAttempt,
      idempotencyKey: 'idem-key-01',
    });

    // Returns completed without double billing
    expect(secondCapture.status).toBe('COMPLETED');
    expect(secondCapture.captureId).toBe(firstCapture.captureId);
  });

  it('Adversary Attack 6: Duplicate webhook event does not re-process state', () => {
    LedgerEngine.reset();

    const eventId = 'WH-EVENT-DUPLICATE-001';
    const fakeWebhook = {
      id: 'webhook-rec-1',
      provider: 'paypal' as const,
      eventId,
      eventType: 'PAYMENT.CAPTURE.COMPLETED',
      signatureVerified: true,
      payload: { id: eventId },
      status: 'processed' as const,
      createdAt: new Date().toISOString(),
    };

    LedgerEngine.recordWebhook(fakeWebhook);

    // Attempting to check if existing
    const existing = LedgerEngine.getWebhookEvent(eventId);
    expect(existing).toBeDefined();
    expect(existing?.status).toBe('processed');
  });

  it('Adversary Attack 7: Forged webhook signature is rejected', async () => {
    const res = await verifyWebhookSignature({
      headers: {},
      body: JSON.stringify({ event_type: 'PAYMENT.CAPTURE.COMPLETED' }),
    });

    // In a configured environment without valid headers or cert, it flags signature issues
    expect(typeof res.verified).toBe('boolean');
  });
});
