import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LedgerEngine } from '@/lib/ledger';
import { evaluatePolicy, evaluatePolicyAsync } from '@/lib/policy-engine';
import { DEMO_BUSINESS, SECOND_TEST_BUSINESS, DEMO_MEMBERS, DEMO_SUPPLIERS } from '@/lib/catalog';
import { resetSupabaseClientForTesting, setSupabaseClientForTesting } from '@/lib/supabase';
import { POST as captureOrderRoute } from '@/app/api/paypal/capture-order/route';
import { PaymentAttempt, Quote } from '@/lib/types';
import type { SupabaseClient } from '@supabase/supabase-js';
import * as paypalService from '@/lib/paypal-service';

describe('Phase 23: Final Payment Security & Hackathon Release Gate', () => {
  const originalEnv = { ...process.env };
  const requester = DEMO_MEMBERS[0]; // Amina Bello (Apex Innovations)
  const approver = DEMO_MEMBERS[1]; // Chidi Okonkwo (Apex Innovations)

  beforeEach(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
    process.env.APP_MODE = 'demo';
    process.env.APPROVAL_SIGNING_SECRET = 'a-secure-custom-test-signing-secret-that-is-32-chars-long';
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;
    resetSupabaseClientForTesting();
    LedgerEngine.reset();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetSupabaseClientForTesting();
    LedgerEngine.reset();
    vi.restoreAllMocks();
  });

  describe('1. Strict Supabase Policy Supplier Registry Fail-Closed Invariant (P1)', () => {
    it('strictly rejects fixture supplier IDs in Supabase mode when not found in database', async () => {
      // Configure Supabase mode
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://wycykgykpbtschrydtld.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key-32-chars-minimum-here';

      // Mock database returning null for supplier
      setSupabaseClientForTesting({
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'suppliers') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                  }),
                }),
              }),
            };
          }
          if (table === 'businesses') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: { budget_limit_cents: 1000000 },
                    error: null,
                  }),
                }),
              }),
            };
          }
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }),
          };
        }),
      } as unknown as SupabaseClient);

      // Quote uses DEMO_SUPPLIERS[0].id (a fixture ID)
      const quote: Quote = {
        id: 'quote-test-p23-sup-1',
        requestId: 'req-test-p23-sup-1',
        businessId: DEMO_BUSINESS.id,
        supplierId: DEMO_SUPPLIERS[0].id,
        supplierName: DEMO_SUPPLIERS[0].name,
        items: [
          {
            id: 'item-1',
            quoteId: 'quote-test-p23-sup-1',
            itemName: 'Laptop',
            quantity: 1,
            unitPriceCents: 150000,
            totalCents: 150000,
          },
        ],
        subtotalCents: 150000,
        taxCents: 0,
        shippingCents: 0,
        totalCents: 150000,
        currency: 'USD',
        version: 1,
        checksumHash: 'dummy-checksum',
        status: 'active',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        createdAt: new Date().toISOString(),
      };

      // In Supabase mode, evaluatePolicyAsync MUST reject the supplier fail-closed
      const result = await evaluatePolicyAsync({
        quote,
        budgetLimitCents: 200000,
        requesterId: requester.userId,
      });

      expect(result.passed).toBe(false);
      const supplierCheck = result.checks.find((c) => c.code === 'SUPPLIER_APPROVED');
      expect(supplierCheck).toBeDefined();
      expect(supplierCheck?.passed).toBe(false);
      expect(supplierCheck?.message).toContain('was not found in the organization\'s database supplier registry');
    });

    it('synchronous evaluatePolicy fails closed when Supabase is configured and supplier is omitted', () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://wycykgykpbtschrydtld.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key-32-chars-minimum-here';

      const quote: Quote = {
        id: 'quote-test-p23-sync',
        requestId: 'req-test-p23-sync',
        businessId: DEMO_BUSINESS.id,
        supplierId: DEMO_SUPPLIERS[0].id,
        supplierName: DEMO_SUPPLIERS[0].name,
        items: [],
        subtotalCents: 10000,
        taxCents: 0,
        shippingCents: 0,
        totalCents: 10000,
        currency: 'USD',
        version: 1,
        checksumHash: 'dummy',
        status: 'active',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        createdAt: new Date().toISOString(),
      };

      const result = evaluatePolicy({
        quote,
        budgetLimitCents: 50000,
        orgBudgetLimitCents: 1000000,
      });

      expect(result.passed).toBe(false);
      const supplierCheck = result.checks.find((c) => c.code === 'SUPPLIER_APPROVED');
      expect(supplierCheck?.passed).toBe(false);
      expect(supplierCheck?.message).toContain('database supplier registry');
    });
  });

  describe('2. PayPal Capture Order: Early Authentication & Timing Attack Hardening (P1)', () => {
    it('rejects unauthenticated capture requests before querying the database or leaking order existence', async () => {
      // In Supabase mode without demo headers
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://wycykgykpbtschrydtld.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key-32-chars-minimum-here';

      // No Bearer token, no x-demo-user-id
      const req = new Request('http://localhost:3000/api/paypal/capture-order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          orderId: 'ORD-UNKNOWN-999',
        }),
      });

      const res = await captureOrderRoute(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBeDefined();
    });

    it('rejects cross-tenant capture requests with 403 Forbidden', async () => {
      const payment: PaymentAttempt = {
        id: 'pay-cross-p23',
        quoteId: 'quote-p23-1',
        businessId: SECOND_TEST_BUSINESS.id, // Belongs to Sahara Cloud
        provider: 'paypal',
        providerOrderId: 'ORD-TENANT-B-1',
        amountCents: 50000,
        currency: 'USD',
        status: 'approved',
        idempotencyKey: 'idem-p23-cross',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await LedgerEngine.savePaymentAttemptAsync(payment);

      // Caller belongs to DEMO_BUSINESS (Apex Innovations)
      const req = new Request('http://localhost:3000/api/paypal/capture-order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-demo-user-id': requester.userId,
        },
        body: JSON.stringify({
          orderId: 'ORD-TENANT-B-1',
          callerUserId: requester.userId,
        }),
      });

      const res = await captureOrderRoute(req);
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toContain('does not belong to business');
    });
  });

  describe('3. Live PayPal Pre-Capture Verification & Graceful Reconciliation (P1)', () => {
    it('gracefully reconciles an already COMPLETED live PayPal order without duplicate capture', async () => {
      process.env.PAYPAL_CLIENT_ID = 'live-client-id-test';
      process.env.PAYPAL_CLIENT_SECRET = 'live-client-secret-test';
      process.env.PAYPAL_ENV = 'sandbox';

      const orderId = '8W858496F8629784G';
      const quoteId = 'quote-p23-recon-1';
      const amountCents = 391285; // $3,912.85

      const payment: PaymentAttempt = {
        id: 'pay-recon-p23',
        quoteId,
        businessId: DEMO_BUSINESS.id,
        provider: 'paypal',
        providerOrderId: orderId,
        amountCents,
        currency: 'USD',
        status: 'approved',
        idempotencyKey: 'idem-p23-recon',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await LedgerEngine.savePaymentAttemptAsync(payment);

      // Mock live PayPal order returned from getPayPalOrderDetails
      const mockLiveOrder = {
        id: orderId,
        status: 'COMPLETED',
        purchase_units: [
          {
            reference_id: quoteId,
            amount: {
              currency_code: 'USD',
              value: '3912.85',
            },
            payments: {
              captures: [
                {
                  id: '39D85904TN573983J',
                  status: 'COMPLETED',
                  amount: {
                    currency_code: 'USD',
                    value: '3912.85',
                  },
                },
              ],
            },
          },
        ],
      };

      vi.spyOn(paypalService, 'getPayPalOrderDetails').mockResolvedValue(mockLiveOrder);
      const captureSpy = vi.spyOn(paypalService, 'capturePayPalOrder');

      const req = new Request('http://localhost:3000/api/paypal/capture-order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-demo-user-id': approver.userId,
        },
        body: JSON.stringify({
          orderId,
          callerUserId: approver.userId,
        }),
      });

      const res = await captureOrderRoute(req);
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.status).toBe('COMPLETED');
      expect(data.captureId).toBe('39D85904TN573983J');
      expect(data.isReplay).toBe(true);

      // Verify capturePayPalOrder API was NOT called again (prevent duplicate capture)
      expect(captureSpy).not.toHaveBeenCalled();

      // Verify ledger was authoritatively updated to captured
      const updatedPayment = await LedgerEngine.getPaymentByOrderIdAsync(orderId);
      expect(updatedPayment?.status).toBe('captured');
      expect(updatedPayment?.providerCaptureId).toBe('39D85904TN573983J');
    });

    it('rejects capture with 400 when live PayPal order is not approved by payer', async () => {
      process.env.PAYPAL_CLIENT_ID = 'live-client-id-test';
      process.env.PAYPAL_CLIENT_SECRET = 'live-client-secret-test';
      process.env.PAYPAL_ENV = 'sandbox';

      const orderId = 'ORD-UNAPPROVED-123';
      const quoteId = 'quote-p23-unapproved-1';
      const amountCents = 150000;

      const payment: PaymentAttempt = {
        id: 'pay-unapproved-p23',
        quoteId,
        businessId: DEMO_BUSINESS.id,
        provider: 'paypal',
        providerOrderId: orderId,
        amountCents,
        currency: 'USD',
        status: 'approved',
        idempotencyKey: 'idem-p23-unapproved',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await LedgerEngine.savePaymentAttemptAsync(payment);

      const mockLiveOrder = {
        id: orderId,
        status: 'CREATED', // Not yet approved by payer
        purchase_units: [
          {
            reference_id: quoteId,
            amount: {
              currency_code: 'USD',
              value: '1500.00',
            },
          },
        ],
      };

      vi.spyOn(paypalService, 'getPayPalOrderDetails').mockResolvedValue(mockLiveOrder);

      const req = new Request('http://localhost:3000/api/paypal/capture-order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-demo-user-id': approver.userId,
        },
        body: JSON.stringify({
          orderId,
          callerUserId: approver.userId,
        }),
      });

      const res = await captureOrderRoute(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toContain('PayPal order status is "CREATED"');
    });

    it('rejects capture with 400 when live PayPal order amount mismatches ledger terms', async () => {
      process.env.PAYPAL_CLIENT_ID = 'live-client-id-test';
      process.env.PAYPAL_CLIENT_SECRET = 'live-client-secret-test';
      process.env.PAYPAL_ENV = 'sandbox';

      const orderId = 'ORD-TAMPER-AMOUNT-123';
      const quoteId = 'quote-p23-tamper-1';
      const amountCents = 150000; // Expected: $1500.00

      const payment: PaymentAttempt = {
        id: 'pay-tamper-p23',
        quoteId,
        businessId: DEMO_BUSINESS.id,
        provider: 'paypal',
        providerOrderId: orderId,
        amountCents,
        currency: 'USD',
        status: 'approved',
        idempotencyKey: 'idem-p23-tamper',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await LedgerEngine.savePaymentAttemptAsync(payment);

      const mockLiveOrder = {
        id: orderId,
        status: 'APPROVED',
        purchase_units: [
          {
            reference_id: quoteId,
            amount: {
              currency_code: 'USD',
              value: '9999.00', // Tampered amount!
            },
          },
        ],
      };

      vi.spyOn(paypalService, 'getPayPalOrderDetails').mockResolvedValue(mockLiveOrder);

      const req = new Request('http://localhost:3000/api/paypal/capture-order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-demo-user-id': approver.userId,
        },
        body: JSON.stringify({
          orderId,
          callerUserId: approver.userId,
        }),
      });

      const res = await captureOrderRoute(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toContain('Order amount mismatch');
    });
  });
});
