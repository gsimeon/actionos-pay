import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { capturePayPalOrder } from '@/lib/paypal-service';
import { LedgerEngine } from '@/lib/ledger';
import { POST as captureRoute } from '@/app/api/paypal/capture-order/route';
import { PaymentAttempt } from '@/lib/types';
import { DEMO_BUSINESS, DEMO_MEMBERS } from '@/lib/catalog';
import { NextRequest } from 'next/server';

describe('Phase 13: Production Capture Lockdown & Capture State Alignment', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
    process.env.APP_MODE = 'demo';
    process.env.PAYPAL_ALLOW_SIMULATION = 'true';
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('P1 Finding 1: Simulated Payment Capture Boundary Lockdown', () => {
    it('throws when capturing a simulated order if NODE_ENV=production', async () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = 'production';

      const simulatedAttempt: PaymentAttempt = {
        id: randomUUID(),
        quoteId: randomUUID(),
        businessId: 'biz-1',
        provider: 'paypal',
        providerOrderId: 'SIM-DEMO-ORD-TEST1',
        amountCents: 50000,
        currency: 'USD',
        status: 'created',
        idempotencyKey: 'idem-test-1',
        providerResponse: { is_simulated: true },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await expect(
        capturePayPalOrder({
          orderId: 'SIM-DEMO-ORD-TEST1',
          paymentAttempt: simulatedAttempt,
        })
      ).rejects.toThrow('Production Security Invariant: Simulated payment orders cannot be captured in production.');
    });

    it('throws when capturing an order with is_simulated=true if NODE_ENV=production even without SIM prefix', async () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = 'production';

      const simulatedAttempt: PaymentAttempt = {
        id: randomUUID(),
        quoteId: randomUUID(),
        businessId: 'biz-1',
        provider: 'paypal',
        providerOrderId: 'ORD-PROD-MOCK-999',
        amountCents: 50000,
        currency: 'USD',
        status: 'created',
        idempotencyKey: 'idem-test-2',
        providerResponse: { is_simulated: true },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await expect(
        capturePayPalOrder({
          orderId: 'ORD-PROD-MOCK-999',
          paymentAttempt: simulatedAttempt,
        })
      ).rejects.toThrow('Production Security Invariant: Simulated payment orders cannot be captured in production.');
    });

    it('throws when capturing a simulated order if real PayPal credentials exist', async () => {
      process.env.PAYPAL_CLIENT_ID = 'live-client-id-xyz';
      process.env.PAYPAL_CLIENT_SECRET = 'live-client-secret-xyz';
      process.env.PAYPAL_ENV = 'sandbox';

      const simulatedAttempt: PaymentAttempt = {
        id: randomUUID(),
        quoteId: randomUUID(),
        businessId: 'biz-1',
        provider: 'paypal',
        providerOrderId: 'SIM-DEMO-ORD-TEST2',
        amountCents: 50000,
        currency: 'USD',
        status: 'created',
        idempotencyKey: 'idem-test-3',
        providerResponse: { is_simulated: true },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await expect(
        capturePayPalOrder({
          orderId: 'SIM-DEMO-ORD-TEST2',
          paymentAttempt: simulatedAttempt,
        })
      ).rejects.toThrow('Security Invariant: Simulated orders cannot be captured when real PayPal credentials are configured.');
    });

    it('throws when capturing a simulated order if simulation is disabled', async () => {
      delete process.env.APP_MODE;
      delete process.env.PAYPAL_ALLOW_SIMULATION;
      // In non-demo, non-test environment simulation is disabled
      (process.env as Record<string, string | undefined>).NODE_ENV = 'development';

      const simulatedAttempt: PaymentAttempt = {
        id: randomUUID(),
        quoteId: randomUUID(),
        businessId: 'biz-1',
        provider: 'paypal',
        providerOrderId: 'SIM-DEMO-ORD-TEST3',
        amountCents: 50000,
        currency: 'USD',
        status: 'created',
        idempotencyKey: 'idem-test-4',
        providerResponse: { is_simulated: true },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await expect(
        capturePayPalOrder({
          orderId: 'SIM-DEMO-ORD-TEST3',
          paymentAttempt: simulatedAttempt,
        })
      ).rejects.toThrow('Simulation Invariant: Simulated payment capture is prohibited when simulation mode is disabled.');
    });

    it('POST /api/paypal/capture-order returns 403 when simulated order is submitted in production', async () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = 'production';

      const orderId = 'SIM-DEMO-ORD-PROD-ATTACK';
      const testPayment: PaymentAttempt = {
        id: randomUUID(),
        quoteId: randomUUID(),
        businessId: DEMO_BUSINESS.id,
        provider: 'paypal',
        providerOrderId: orderId,
        amountCents: 50000,
        currency: 'USD',
        status: 'approved',
        idempotencyKey: 'idem-test-5',
        providerResponse: { is_simulated: true },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await LedgerEngine.savePaymentAttemptAsync(testPayment);

      const req = new NextRequest('http://localhost:3000/api/paypal/capture-order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer dummy-token',
        },
        body: JSON.stringify({
          orderId,
          callerUserId: DEMO_MEMBERS[2].userId,
        }),
      });

      const res = await captureRoute(req);
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toContain('Production Security Invariant: Simulated payment orders cannot be captured in production.');
    });

    it('POST /api/paypal/capture-order returns 403 when simulated order is submitted with configured credentials', async () => {
      process.env.PAYPAL_CLIENT_ID = 'live-client-id-xyz';
      process.env.PAYPAL_CLIENT_SECRET = 'live-client-secret-xyz';
      process.env.PAYPAL_ENV = 'sandbox';

      const orderId = 'SIM-DEMO-ORD-CREDS-ATTACK';
      const testPayment: PaymentAttempt = {
        id: randomUUID(),
        quoteId: randomUUID(),
        businessId: DEMO_BUSINESS.id,
        provider: 'paypal',
        providerOrderId: orderId,
        amountCents: 50000,
        currency: 'USD',
        status: 'approved',
        idempotencyKey: 'idem-test-5',
        providerResponse: { is_simulated: true },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await LedgerEngine.savePaymentAttemptAsync(testPayment);

      const req = new NextRequest('http://localhost:3000/api/paypal/capture-order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-demo-user-id': DEMO_MEMBERS[2].userId,
        },
        body: JSON.stringify({
          orderId,
          callerUserId: DEMO_MEMBERS[2].userId,
        }),
      });

      const res = await captureRoute(req);
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toContain('Security Invariant: Simulated orders cannot be captured when real PayPal credentials are configured.');
    });
  });

  describe('P1 Finding 2: Capture State Alignment (Failed Attempt Handling)', () => {
    it('claimPaymentCaptureAsync returns status=FAILED when payment attempt has status=failed', async () => {
      const orderId = `ORD-FAIL-TEST-${randomUUID().slice(0, 8)}`;
      const failedPayment: PaymentAttempt = {
        id: randomUUID(),
        quoteId: randomUUID(),
        businessId: DEMO_BUSINESS.id,
        provider: 'paypal',
        providerOrderId: orderId,
        amountCents: 50000,
        currency: 'USD',
        status: 'failed',
        idempotencyKey: 'idem-test-fail-1',
        errorMessage: 'Capture rejected by provider: ORDER_NOT_APPROVED',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await LedgerEngine.savePaymentAttemptAsync(failedPayment);

      const claim = await LedgerEngine.claimPaymentCaptureAsync(orderId, 60);
      expect(claim.status).toBe('FAILED');
      expect(claim.errorMessage).toContain('ORDER_NOT_APPROVED');
    });

    it('POST /api/paypal/capture-order returns 402 for failed payment attempts without re-executing capture', async () => {
      const orderId = `ORD-FAIL-ROUTE-${randomUUID().slice(0, 8)}`;
      const failedPayment: PaymentAttempt = {
        id: randomUUID(),
        quoteId: randomUUID(),
        businessId: DEMO_BUSINESS.id,
        provider: 'paypal',
        providerOrderId: orderId,
        amountCents: 50000,
        currency: 'USD',
        status: 'failed',
        idempotencyKey: 'idem-test-fail-1',
        errorMessage: 'Capture rejected by provider: ORDER_NOT_APPROVED',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await LedgerEngine.savePaymentAttemptAsync(failedPayment);

      const req = new NextRequest('http://localhost:3000/api/paypal/capture-order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-demo-user-id': DEMO_MEMBERS[2].userId,
        },
        body: JSON.stringify({
          orderId,
          callerUserId: DEMO_MEMBERS[2].userId,
        }),
      });

      const res = await captureRoute(req);
      expect(res.status).toBe(402);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.status).toBe('FAILED');
      expect(data.error).toContain('ORDER_NOT_APPROVED');
    });
  });
});
