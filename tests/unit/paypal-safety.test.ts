import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPayPalOrder, capturePayPalOrder, verifyWebhookSignature } from '@/lib/paypal-service';
import { Quote, Approval, PaymentAttempt } from '@/lib/types';
import { computeApprovalSignature } from '@/lib/approval-engine';
import { computeQuoteChecksum } from '@/lib/quote-engine';

describe('PayPal Safety & Anti-False-Positive Invariants', () => {
  const originalEnv = process.env;

  const validQuote: Quote = {
    id: 'test-quote-safety-1',
    requestId: 'test-req-safety-1',
    businessId: 'test-biz-1',
    supplierId: 'sup-dell-premier',
    supplierName: 'Dell Technologies',
    version: 1,
    subtotalCents: 100000,
    taxCents: 8000,
    shippingCents: 1500,
    totalCents: 109500,
    currency: 'USD',
    checksumHash: '',
    status: 'approved',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    createdAt: new Date().toISOString(),
    items: [
      {
        id: 'item-1',
        quoteId: 'test-quote-safety-1',
        itemName: 'Dell UltraSharp Monitor',
        sku: 'DELL-U2723QE',
        quantity: 2,
        unitPriceCents: 50000,
        totalCents: 100000,
      },
    ],
  };
  validQuote.checksumHash = computeQuoteChecksum({
    requestId: validQuote.requestId,
    version: validQuote.version,
    supplierId: validQuote.supplierId,
    totalCents: validQuote.totalCents,
    currency: validQuote.currency,
    items: validQuote.items,
  });

  const validApproval: Approval = {
    id: 'test-appr-safety-1',
    quoteId: validQuote.id,
    businessId: validQuote.businessId,
    approverId: 'usr-chidi-02',
    approverName: 'Chidi Anagonye',
    approverRole: 'approver',
    quoteVersion: 1,
    approvedTotalCents: validQuote.totalCents,
    approvedCurrency: 'USD',
    approvedSupplierId: validQuote.supplierId,
    decision: 'approved',
    digitalSignature: '',
    createdAt: new Date().toISOString(),
  };
  validApproval.digitalSignature = computeApprovalSignature({
    quoteId: validQuote.id,
    quoteVersion: validQuote.version,
    quoteChecksum: validQuote.checksumHash,
    totalCents: validQuote.totalCents,
    currency: validQuote.currency,
    supplierId: validQuote.supplierId,
    approverId: validApproval.approverId,
    decision: validApproval.decision,
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('fails loudly when PayPal credentials are set and order creation fails, never falling back to simulation', async () => {
    process.env.PAYPAL_CLIENT_ID = 'test-client-id';
    process.env.PAYPAL_CLIENT_SECRET = 'test-client-secret';
    process.env.PAYPAL_MODE = 'sandbox';

    // Mock PayPal token endpoint to succeed
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/v1/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'fake-jwt-token' }), { status: 200 });
      }
      if (urlStr.includes('/v2/checkout/orders')) {
        // PayPal rejects order creation (e.g. rate limit, validation failure, card decline)
        return new Response(
          JSON.stringify({ name: 'VALIDATION_ERROR', message: 'Invalid purchase units' }),
          { status: 400 }
        );
      }
      return new Response('Not found', { status: 404 });
    });

    await expect(
      createPayPalOrder({ quote: validQuote, approval: validApproval })
    ).rejects.toThrow(/PayPal order creation failed \(HTTP 400\)/);

    expect(fetchMock).toHaveBeenCalled();
  });

  it('fails loudly when PayPal capture fails, returning FAILED status and not simulating success', async () => {
    process.env.PAYPAL_CLIENT_ID = 'test-client-id';
    process.env.PAYPAL_CLIENT_SECRET = 'test-client-secret';
    process.env.PAYPAL_MODE = 'sandbox';

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/v1/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'fake-jwt-token' }), { status: 200 });
      }
      if (urlStr.includes('/capture')) {
        return new Response(
          JSON.stringify({
            name: 'UNPROCESSABLE_ENTITY',
            message: 'Payment instrument declined by issuing bank',
          }),
          { status: 422 }
        );
      }
      return new Response('Not found', { status: 404 });
    });

    const pendingPayment: PaymentAttempt = {
      id: 'pay-attempt-1',
      quoteId: validQuote.id,
      businessId: validQuote.businessId,
      provider: 'paypal',
      providerOrderId: 'REAL-PP-ORD-12345',
      amountCents: validQuote.totalCents,
      currency: 'USD',
      status: 'created',
      idempotencyKey: 'idem-1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = await capturePayPalOrder({
      orderId: 'REAL-PP-ORD-12345',
      paymentAttempt: pendingPayment,
    });

    expect(result.status).toBe('FAILED');
    expect(result.isSimulated).toBe(false);
    expect(result.paymentAttempt.status).toBe('failed');
    expect(result.errorMessage).toContain('Payment instrument declined');
  });

  it('marks simulated orders unambiguously with isSimulated: true and SIM-DEMO- prefix', async () => {
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;
    process.env.PAYPAL_ALLOW_SIMULATION = 'true';

    const result = await createPayPalOrder({
      quote: validQuote,
      approval: validApproval,
    });

    expect(result.isSimulated).toBe(true);
    expect(result.orderId).toMatch(/^SIM-DEMO-ORD-/);
    expect(result.paymentAttempt.providerResponse?.is_simulated).toBe(true);
  });

  it('guarantees capture idempotency: already captured payments return without recharging', async () => {
    const capturedPayment: PaymentAttempt = {
      id: 'pay-attempt-2',
      quoteId: validQuote.id,
      businessId: validQuote.businessId,
      provider: 'paypal',
      providerOrderId: 'SIM-DEMO-ORD-CAPTURED',
      providerCaptureId: 'CAP-RECORDED-ALREADY',
      amountCents: validQuote.totalCents,
      currency: 'USD',
      status: 'captured',
      idempotencyKey: 'idem-2',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await capturePayPalOrder({
      orderId: 'SIM-DEMO-ORD-CAPTURED',
      paymentAttempt: capturedPayment,
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.captureId).toBe('CAP-RECORDED-ALREADY');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('strictly verifies webhook signature and rejects spoofed headers', async () => {
    process.env.PAYPAL_WEBHOOK_ID = 'test-webhook-id';
    process.env.PAYPAL_CLIENT_ID = 'test-client-id';
    process.env.PAYPAL_CLIENT_SECRET = 'test-client-secret';

    const result = await verifyWebhookSignature({
      headers: {
        'paypal-transmission-id': 'spoofed-id',
        // Missing required cert-url and auth-algo headers
      },
      body: '{"event_type": "PAYMENT.CAPTURE.COMPLETED"}',
    });

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('Missing required PayPal signature verification headers');
  });
});
