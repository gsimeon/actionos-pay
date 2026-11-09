import { describe, expect, it, beforeEach } from 'vitest';
import { POST as createOrderRoute } from '@/app/api/paypal/create-order/route';
import { POST as captureOrderRoute } from '@/app/api/paypal/capture-order/route';
import { POST as stateRoute } from '@/app/api/procurement/state/route';
import { LedgerEngine } from '@/lib/ledger';
import {
  verifyWebhookSignature,
  validatePayPalEnv,
  isSimulationAllowed,
} from '@/lib/paypal-service';
import { computeQuoteChecksum } from '@/lib/quote-engine';
import { computeApprovalSignature } from '@/lib/approval-engine';
import { DEMO_BUSINESS, DEMO_MEMBERS, DEMO_SUPPLIERS } from '@/lib/catalog';
import { Approval, PaymentAttempt, ProcurementRequest, Quote } from '@/lib/types';
import { randomUUID } from 'crypto';

describe('Phase 12: Payment Reservation, Capture Claims, Webhook Boundary & Production Lockdown', () => {
  const adminMember = DEMO_MEMBERS.find((m) => m.role === 'admin')!;
  const approverMember = DEMO_MEMBERS.find((m) => m.role === 'approver')!;
  const requesterMember = DEMO_MEMBERS.find((m) => m.role === 'requester')!;

  let validRequest: ProcurementRequest;
  let validQuote: Quote;
  let validApproval: Approval;

  beforeEach(() => {
    LedgerEngine.reset();
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;
    delete process.env.PAYPAL_WEBHOOK_ID;
    delete process.env.PAYPAL_ALLOW_SIMULATION;
    const env = process.env as Record<string, string | undefined>;
    env.APP_MODE = 'demo';
    env.NODE_ENV = 'test';

    validRequest = {
      id: randomUUID(),
      businessId: DEMO_BUSINESS.id,
      requesterId: requesterMember.userId,
      requesterName: requesterMember.userName,
      rawPrompt: 'Phase 12 Test Equipment',
      status: 'approved',
      budgetLimitCents: 100000,
      currency: 'USD',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    LedgerEngine.saveRequest(validRequest);

    const quoteId = randomUUID();
    const items = [
      {
        id: randomUUID(),
        quoteId,
        itemName: 'Server Hardware',
        quantity: 1,
        unitPriceCents: 100000,
        totalCents: 100000,
      },
    ];

    validQuote = {
      id: quoteId,
      requestId: validRequest.id,
      businessId: DEMO_BUSINESS.id,
      supplierId: DEMO_SUPPLIERS[0].id,
      supplierName: DEMO_SUPPLIERS[0].name,
      version: 1,
      items,
      subtotalCents: 100000,
      taxCents: 0,
      shippingCents: 0,
      totalCents: 100000,
      currency: 'USD',
      checksumHash: computeQuoteChecksum({
        requestId: validRequest.id,
        version: 1,
        supplierId: DEMO_SUPPLIERS[0].id,
        totalCents: 100000,
        currency: 'USD',
        items,
      }),
      status: 'approved',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      createdAt: new Date().toISOString(),
    };
    LedgerEngine.saveQuote(validQuote);

    validApproval = {
      id: randomUUID(),
      quoteId: validQuote.id,
      businessId: DEMO_BUSINESS.id,
      approverId: approverMember.userId,
      approverName: approverMember.userName,
      approverRole: 'approver',
      quoteVersion: validQuote.version,
      approvedTotalCents: validQuote.totalCents,
      approvedCurrency: validQuote.currency,
      approvedSupplierId: validQuote.supplierId,
      decision: 'approved',
      digitalSignature: computeApprovalSignature({
        quoteId: validQuote.id,
        quoteVersion: validQuote.version,
        quoteChecksum: validQuote.checksumHash,
        totalCents: validQuote.totalCents,
        currency: validQuote.currency,
        supplierId: validQuote.supplierId,
        approverId: approverMember.userId,
        decision: 'approved',
      }),
      createdAt: new Date().toISOString(),
    };
    LedgerEngine.saveApproval(validApproval);
  });

  describe('Finding 1 & C: Production Lockdown & State Reset Hardening', () => {
    it('strictly prohibits state reset on POST /api/procurement/state in production even with APP_MODE=demo', async () => {
      const env = process.env as Record<string, string | undefined>;
      const oldNodeEnv = env.NODE_ENV;
      const oldAppMode = env.APP_MODE;
      try {
        env.NODE_ENV = 'production';
        env.APP_MODE = 'demo';

        const req = new Request('http://localhost/api/procurement/state', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-demo-user-id': adminMember.userId,
          },
          body: JSON.stringify({ action: 'reset' }),
        });

        const res = await stateRoute(req);
        expect(res.status).toBe(403);
        const json = await res.json();
        expect(json.error).toContain('State reset is disabled in production environment');
      } finally {
        env.NODE_ENV = oldNodeEnv;
        if (oldAppMode) env.APP_MODE = oldAppMode;
        else delete env.APP_MODE;
      }
    });

    it('strictly prohibits simulation in production mode under any environment setting', () => {
      const env = process.env as Record<string, string | undefined>;
      const oldNodeEnv = env.NODE_ENV;
      const oldAppMode = env.APP_MODE;
      const oldSim = env.PAYPAL_ALLOW_SIMULATION;
      try {
        env.NODE_ENV = 'production';
        env.APP_MODE = 'demo';
        env.PAYPAL_ALLOW_SIMULATION = 'true';

        expect(isSimulationAllowed()).toBe(false);
      } finally {
        env.NODE_ENV = oldNodeEnv;
        if (oldAppMode) env.APP_MODE = oldAppMode;
        else delete env.APP_MODE;
        if (oldSim) env.PAYPAL_ALLOW_SIMULATION = oldSim;
        else delete env.PAYPAL_ALLOW_SIMULATION;
      }
    });
  });

  describe('Finding A & D: Webhook Configuration Boundary & Environment Validation', () => {
    it('validates PAYPAL_ENV runtime values and rejects typos with an explicit error', () => {
      expect(validatePayPalEnv('sandbox')).toBe('sandbox');
      expect(validatePayPalEnv('live')).toBe('live');
      expect(validatePayPalEnv('SANDBOX')).toBe('sandbox');
      expect(validatePayPalEnv('LIVE')).toBe('live');
      expect(validatePayPalEnv(undefined)).toBe('sandbox');

      expect(() => validatePayPalEnv('sandbx')).toThrow('Invalid PAYPAL_ENV configuration: "sandbx"');
      expect(() => validatePayPalEnv('test')).toThrow('Invalid PAYPAL_ENV configuration: "test"');
      expect(() => validatePayPalEnv('production')).toThrow('Invalid PAYPAL_ENV configuration: "production"');
    });

    it('allows mock verification strictly in development with explicit demo mode and no PayPal credentials', async () => {
      const env = process.env as Record<string, string | undefined>;
      env.NODE_ENV = 'development';
      env.APP_MODE = 'demo';
      delete env.PAYPAL_CLIENT_ID;
      delete env.PAYPAL_CLIENT_SECRET;
      delete env.PAYPAL_WEBHOOK_ID;

      const res = await verifyWebhookSignature({
        headers: {
          'x-mock-sandbox-signature': 'MOCK-SIGNATURE-VALID-12345',
        },
        body: JSON.stringify({ id: 'EVT-1' }),
      });

      expect(res.verified).toBe(true);
      expect(res.reason).toContain('Sandbox demo test signature verified');
    });

    it('rejects mock verification in development when APP_MODE is not demo', async () => {
      const env = process.env as Record<string, string | undefined>;
      env.NODE_ENV = 'development';
      delete env.APP_MODE;
      delete env.PAYPAL_CLIENT_ID;
      delete env.PAYPAL_CLIENT_SECRET;

      const res = await verifyWebhookSignature({
        headers: {
          'x-mock-sandbox-signature': 'MOCK-SIGNATURE-VALID-12345',
        },
        body: JSON.stringify({ id: 'EVT-1' }),
      });

      expect(res.verified).toBe(false);
      expect(res.reason).toContain('Security Fail-Closed');
    });

    it('rejects mock verification in production even when APP_MODE=demo is set', async () => {
      const env = process.env as Record<string, string | undefined>;
      env.NODE_ENV = 'production';
      env.APP_MODE = 'demo';
      delete env.PAYPAL_CLIENT_ID;
      delete env.PAYPAL_CLIENT_SECRET;

      const res = await verifyWebhookSignature({
        headers: {
          'x-mock-sandbox-signature': 'MOCK-SIGNATURE-VALID-12345',
        },
        body: JSON.stringify({ id: 'EVT-1' }),
      });

      expect(res.verified).toBe(false);
      expect(res.reason).toContain('Security Fail-Closed');
    });

    it('fails closed when real PayPal credentials exist but PAYPAL_WEBHOOK_ID is missing (mock prohibited)', async () => {
      const env = process.env as Record<string, string | undefined>;
      env.NODE_ENV = 'development';
      env.APP_MODE = 'demo';
      env.PAYPAL_CLIENT_ID = 'test-client-id';
      env.PAYPAL_CLIENT_SECRET = 'test-client-secret';
      delete env.PAYPAL_WEBHOOK_ID;

      const res = await verifyWebhookSignature({
        headers: {
          'x-mock-sandbox-signature': 'MOCK-SIGNATURE-VALID-12345',
        },
        body: JSON.stringify({ id: 'EVT-1' }),
      });

      expect(res.verified).toBe(false);
      expect(res.reason).toContain('PAYPAL_WEBHOOK_ID is missing or placeholder');
    });

    it('fails closed when missing required signature headers in live or production environment', async () => {
      const env = process.env as Record<string, string | undefined>;
      env.NODE_ENV = 'production';
      env.PAYPAL_CLIENT_ID = 'real-client-id';
      env.PAYPAL_CLIENT_SECRET = 'real-client-secret';
      env.PAYPAL_WEBHOOK_ID = 'WH-123456789';

      const res = await verifyWebhookSignature({
        headers: {},
        body: JSON.stringify({ id: 'EVT-1' }),
      });

      expect(res.verified).toBe(false);
      expect(res.reason).toContain('Missing required PayPal signature verification headers');
    });
  });

  describe('Finding B: Atomic Payment Attempt Reservation & Concurrency', () => {
    it('atomically reserves payment attempt before creating PayPal order', async () => {
      const stableKey = `order-${validQuote.id}-v${validQuote.version}`;
      const reservation = await LedgerEngine.reservePaymentAttemptAsync({
        quoteId: validQuote.id,
        businessId: validQuote.businessId,
        amountCents: validQuote.totalCents,
        currency: validQuote.currency,
        idempotencyKey: stableKey,
        reservationSeconds: 120,
      });

      expect(reservation.status).toBe('RESERVED');
      expect(reservation.paymentAttemptId).toBeDefined();
      expect(reservation.paymentAttempt?.status).toBe('created');
      expect(reservation.paymentAttempt?.orderReservationExpiresAt).toBeDefined();
    });

    it('returns IN_FLIGHT when a second concurrent request attempts reservation on an active reservation', async () => {
      const stableKey = `order-${validQuote.id}-v${validQuote.version}`;
      const res1 = await LedgerEngine.reservePaymentAttemptAsync({
        quoteId: validQuote.id,
        businessId: validQuote.businessId,
        amountCents: validQuote.totalCents,
        currency: validQuote.currency,
        idempotencyKey: stableKey,
        reservationSeconds: 120,
      });
      expect(res1.status).toBe('RESERVED');

      // Second concurrent reservation request
      const res2 = await LedgerEngine.reservePaymentAttemptAsync({
        quoteId: validQuote.id,
        businessId: validQuote.businessId,
        amountCents: validQuote.totalCents,
        currency: validQuote.currency,
        idempotencyKey: stableKey,
        reservationSeconds: 120,
      });
      expect(res2.status).toBe('IN_FLIGHT');
      expect(res2.expiresAt).toBeDefined();
    });

    it('returns REPLAY with existing order when an order has already been confirmed', async () => {
      const stableKey = `order-${validQuote.id}-v${validQuote.version}`;
      const res1 = await LedgerEngine.reservePaymentAttemptAsync({
        quoteId: validQuote.id,
        businessId: validQuote.businessId,
        amountCents: validQuote.totalCents,
        currency: validQuote.currency,
        idempotencyKey: stableKey,
        reservationSeconds: 120,
      });
      expect(res1.status).toBe('RESERVED');

      await LedgerEngine.confirmPaymentOrderAsync({
        paymentAttemptId: res1.paymentAttemptId!,
        providerOrderId: 'SIM-ORDER-999',
        providerResponse: { id: 'SIM-ORDER-999', status: 'CREATED', is_simulated: true },
      });

      // Subsequent request checks reservation -> gets REPLAY
      const res2 = await LedgerEngine.reservePaymentAttemptAsync({
        quoteId: validQuote.id,
        businessId: validQuote.businessId,
        amountCents: validQuote.totalCents,
        currency: validQuote.currency,
        idempotencyKey: stableKey,
        reservationSeconds: 120,
      });
      expect(res2.status).toBe('REPLAY');
      expect(res2.providerOrderId).toBe('SIM-ORDER-999');
    });

    it('marks reservation as failed when PayPal order creation fails, permitting subsequent retry', async () => {
      const stableKey = `order-${validQuote.id}-v${validQuote.version}`;
      const res1 = await LedgerEngine.reservePaymentAttemptAsync({
        quoteId: validQuote.id,
        businessId: validQuote.businessId,
        amountCents: validQuote.totalCents,
        currency: validQuote.currency,
        idempotencyKey: stableKey,
        reservationSeconds: 120,
      });
      expect(res1.status).toBe('RESERVED');

      await LedgerEngine.failPaymentAttemptAsync(res1.paymentAttemptId!, 'PayPal provider connection timeout');

      const attempt = LedgerEngine.getPaymentForQuote(validQuote.id);
      expect(attempt?.status).toBe('failed');
      expect(attempt?.errorMessage).toBe('PayPal provider connection timeout');

      // Subsequent retry succeeds in reserving cleanly
      const res2 = await LedgerEngine.reservePaymentAttemptAsync({
        quoteId: validQuote.id,
        businessId: validQuote.businessId,
        amountCents: validQuote.totalCents,
        currency: validQuote.currency,
        idempotencyKey: stableKey,
        reservationSeconds: 120,
      });
      expect(res2.status).toBe('RESERVED');
    });

    it('handles concurrent order creation calls to /api/paypal/create-order gracefully without duplicate orders', async () => {
      const req1 = new Request('http://localhost/api/paypal/create-order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-demo-user-id': approverMember.userId,
        },
        body: JSON.stringify({ quoteId: validQuote.id }),
      });

      const res1 = await createOrderRoute(req1);
      expect(res1.status).toBe(200);
      const json1 = await res1.json();
      expect(json1.success).toBe(true);
      expect(json1.orderId).toBeDefined();

      // Second immediate call with same quoteId
      const req2 = new Request('http://localhost/api/paypal/create-order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-demo-user-id': approverMember.userId,
        },
        body: JSON.stringify({ quoteId: validQuote.id }),
      });

      const res2 = await createOrderRoute(req2);
      expect(res2.status).toBe(200);
      const json2 = await res2.json();
      expect(json2.success).toBe(true);
      expect(json2.isReplay).toBe(true);
      expect(json2.orderId).toBe(json1.orderId); // Returns the exact same active order ID!
    });
  });

  describe('Finding 3: Atomic Capture Protection & Simultaneous Request Guards', () => {
    let activePayment: PaymentAttempt;

    beforeEach(async () => {
      const stableKey = `order-${validQuote.id}-v${validQuote.version}`;
      const res = await LedgerEngine.reservePaymentAttemptAsync({
        quoteId: validQuote.id,
        businessId: validQuote.businessId,
        amountCents: validQuote.totalCents,
        currency: validQuote.currency,
        idempotencyKey: stableKey,
        reservationSeconds: 120,
      });

      await LedgerEngine.confirmPaymentOrderAsync({
        paymentAttemptId: res.paymentAttemptId!,
        providerOrderId: 'SIM-ORDER-CAPTURE-123',
        providerResponse: { id: 'SIM-ORDER-CAPTURE-123', status: 'CREATED', is_simulated: true },
      });

      activePayment = LedgerEngine.getPaymentByOrderId('SIM-ORDER-CAPTURE-123')!;
    });

    it('acquires capture lease atomically and rejects simultaneous capture with 429 Retry-After', async () => {
      const claim1 = await LedgerEngine.claimPaymentCaptureAsync(activePayment.providerOrderId!, 60);
      expect(claim1.status).toBe('CLAIMED');
      expect(claim1.leaseExpiresAt).toBeDefined();

      // Second simultaneous capture attempt
      const claim2 = await LedgerEngine.claimPaymentCaptureAsync(activePayment.providerOrderId!, 60);
      expect(claim2.status).toBe('IN_FLIGHT');
      expect(claim2.leaseExpiresAt).toBeDefined();
    });

    it('returns ALREADY_CAPTURED on retry after successful capture without recharging', async () => {
      const req1 = new Request('http://localhost/api/paypal/capture-order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-demo-user-id': approverMember.userId,
        },
        body: JSON.stringify({ orderId: activePayment.providerOrderId }),
      });

      const res1 = await captureOrderRoute(req1);
      expect(res1.status).toBe(200);
      const json1 = await res1.json();
      expect(json1.success).toBe(true);
      expect(json1.status).toBe('COMPLETED');
      expect(json1.captureId).toBeDefined();

      // Second capture attempt for already-captured order
      const req2 = new Request('http://localhost/api/paypal/capture-order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-demo-user-id': approverMember.userId,
        },
        body: JSON.stringify({ orderId: activePayment.providerOrderId }),
      });

      const res2 = await captureOrderRoute(req2);
      expect(res2.status).toBe(200);
      const json2 = await res2.json();
      expect(json2.success).toBe(true);
      expect(json2.isReplay).toBe(true);
      expect(json2.captureId).toBe(json1.captureId);
    });

    it('releases capture lease upon capture failure so it can be safely retried', async () => {
      const claim = await LedgerEngine.claimPaymentCaptureAsync(activePayment.providerOrderId!, 60);
      expect(claim.status).toBe('CLAIMED');

      await LedgerEngine.releasePaymentCaptureClaimAsync(claim.paymentAttemptId!, 'failed', 'Card declined by issuing bank');

      const updated = LedgerEngine.getPaymentByOrderId(activePayment.providerOrderId!);
      expect(updated?.status).toBe('failed');
      expect(updated?.captureLeaseExpiresAt).toBeUndefined();
    });

    it('allows retry after lease expiration (simulating timeout recovery)', async () => {
      const claim1 = await LedgerEngine.claimPaymentCaptureAsync(activePayment.providerOrderId!, 60);
      expect(claim1.status).toBe('CLAIMED');

      // Artificially expire the lease
      activePayment.captureLeaseExpiresAt = new Date(Date.now() - 1000).toISOString();

      // Retry re-claims the expired lease
      const claim2 = await LedgerEngine.claimPaymentCaptureAsync(activePayment.providerOrderId!, 60);
      expect(claim2.status).toBe('CLAIMED');
    });
  });
});
