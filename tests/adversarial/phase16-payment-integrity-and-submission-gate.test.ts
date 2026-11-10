import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import {
  verifyOrderFinancialIntegrity,
  verifyCaptureFinancialIntegrity,
  capturePayPalOrder,
} from '@/lib/paypal-service';
import {
  parseProcurementIntent,
  resolveGeminiModel,
  ALLOWED_GEMINI_MODELS,
} from '@/lib/ai-planner';
import { checkRateLimit, resetRateLimits } from '@/lib/rate-limiter';
import { POST as planRoutePost } from '@/app/api/procurement/plan/route';
import { POST as captureOrderRoute } from '@/app/api/paypal/capture-order/route';
import { POST as createOrderRoute } from '@/app/api/paypal/create-order/route';
import { LedgerEngine } from '@/lib/ledger';
import { PaymentAttempt } from '@/lib/types';

describe('Phase 16: Final Payment Integrity, Capture Verification & Submission Gate', () => {
  const originalEnv = { ...process.env };

  const testPaymentAttempt: PaymentAttempt = {
    id: 'pay-test-uuid-9999',
    quoteId: 'quote-auth-7777',
    businessId: 'biz-test-1111',
    provider: 'paypal',
    providerOrderId: 'ORDER-PAYPAL-12345',
    amountCents: 194892, // $1,948.92
    currency: 'USD',
    status: 'created',
    idempotencyKey: 'idemp-test-9999',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
    process.env.APP_MODE = 'demo';
    process.env.APPROVAL_SIGNING_SECRET = 'a-secure-custom-test-signing-secret-that-is-32-chars-long';
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;
    delete process.env.AI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.AI_MODEL;
    resetRateLimits();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetRateLimits();
    vi.restoreAllMocks();
  });

  describe('1. P1: Mandatory PayPal Reference ID Verification', () => {
    it('rejects order with missing reference_id fail-closed', () => {
      const orderWithoutRef = {
        id: 'ORDER-PAYPAL-12345',
        status: 'APPROVED',
        purchase_units: [
          {
            amount: { currency_code: 'USD', value: '1948.92' },
          },
        ],
      };

      const result = verifyOrderFinancialIntegrity(orderWithoutRef, testPaymentAttempt);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Missing or mismatched PayPal quote reference');
    });

    it('rejects order with empty or whitespace-only reference_id fail-closed', () => {
      const orderWithEmptyRef = {
        id: 'ORDER-PAYPAL-12345',
        status: 'APPROVED',
        purchase_units: [
          {
            reference_id: '   ',
            amount: { currency_code: 'USD', value: '1948.92' },
          },
        ],
      };

      const result = verifyOrderFinancialIntegrity(orderWithEmptyRef, testPaymentAttempt);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Missing or mismatched PayPal quote reference');
    });

    it('rejects order with mismatched reference_id fail-closed', () => {
      const orderWithWrongRef = {
        id: 'ORDER-PAYPAL-12345',
        status: 'APPROVED',
        purchase_units: [
          {
            reference_id: 'quote-attacker-tampered-8888',
            amount: { currency_code: 'USD', value: '1948.92' },
          },
        ],
      };

      const result = verifyOrderFinancialIntegrity(orderWithWrongRef, testPaymentAttempt);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Missing or mismatched PayPal quote reference');
      expect(result.error).toContain('quote-auth-7777');
    });

    it('accepts order when reference_id strictly matches paymentAttempt.quoteId', () => {
      const validOrder = {
        id: 'ORDER-PAYPAL-12345',
        status: 'APPROVED',
        purchase_units: [
          {
            reference_id: 'quote-auth-7777',
            amount: { currency_code: 'USD', value: '1948.92' },
          },
        ],
      };

      const result = verifyOrderFinancialIntegrity(validOrder, testPaymentAttempt);
      expect(result.valid).toBe(true);
      expect(result.referenceId).toBe('quote-auth-7777');
    });
  });

  describe('2. P1: Order Structure & Single Purchase Unit Constraint', () => {
    it('rejects order with multiple purchase units fail-closed', () => {
      const multiUnitOrder = {
        id: 'ORDER-PAYPAL-12345',
        status: 'APPROVED',
        purchase_units: [
          {
            reference_id: 'quote-auth-7777',
            amount: { currency_code: 'USD', value: '1948.92' },
          },
          {
            reference_id: 'quote-attacker-second-unit',
            amount: { currency_code: 'USD', value: '500.00' },
          },
        ],
      };

      const result = verifyOrderFinancialIntegrity(multiUnitOrder, testPaymentAttempt);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('expected exactly one purchase unit, received 2');
    });
  });

  describe('3. P1: Strict Capture Financial Integrity Verification', () => {
    it('rejects completed order when capture object is missing', () => {
      const result = verifyCaptureFinancialIntegrity(undefined, testPaymentAttempt);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('does not contain an existing capture record');
    });

    it('rejects capture record missing a valid capture ID', () => {
      const invalidCapture = {
        id: '   ',
        status: 'COMPLETED',
        amount: { currency_code: 'USD', value: '1948.92' },
      };

      const result = verifyCaptureFinancialIntegrity(invalidCapture, testPaymentAttempt);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('missing a valid capture ID');
    });

    it('rejects capture record whose status is not COMPLETED (e.g. PENDING)', () => {
      const pendingCapture = {
        id: 'CAP-SANDBOX-1111',
        status: 'PENDING',
        amount: { currency_code: 'USD', value: '1948.92' },
      };

      const result = verifyCaptureFinancialIntegrity(pendingCapture, testPaymentAttempt);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('expected "COMPLETED"');
    });

    it('rejects capture record with amount mismatch', () => {
      const tamperedAmountCapture = {
        id: 'CAP-SANDBOX-1111',
        status: 'COMPLETED',
        amount: { currency_code: 'USD', value: '100.00' },
      };

      const result = verifyCaptureFinancialIntegrity(tamperedAmountCapture, testPaymentAttempt);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Capture amount mismatch');
    });

    it('rejects capture record with currency mismatch', () => {
      const wrongCurrencyCapture = {
        id: 'CAP-SANDBOX-1111',
        status: 'COMPLETED',
        amount: { currency_code: 'EUR', value: '1948.92' },
      };

      const result = verifyCaptureFinancialIntegrity(wrongCurrencyCapture, testPaymentAttempt);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Capture currency mismatch');
    });

    it('accepts perfectly verified capture and returns verified captureId', () => {
      const validCapture = {
        id: '99U541804T041110C',
        status: 'COMPLETED',
        amount: { currency_code: 'USD', value: '1948.92' },
      };

      const result = verifyCaptureFinancialIntegrity(validCapture, testPaymentAttempt);
      expect(result.valid).toBe(true);
      expect(result.captureId).toBe('99U541804T041110C');
    });
  });

  describe('4. P1: capturePayPalOrder Never Fabricates Capture IDs', () => {
    it('fails closed when live PayPal API returns capture without capture ID', async () => {
      process.env.PAYPAL_CLIENT_ID = 'test-client-id';
      process.env.PAYPAL_CLIENT_SECRET = 'test-client-secret';

      // Mock PayPal OAuth token
      vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('/v1/oauth2/token')) {
          return new Response(
            JSON.stringify({ access_token: 'mock-access-token', token_type: 'Bearer', expires_in: 3600 }),
            { status: 200 }
          );
        }
        if (urlStr.includes('/capture')) {
          // Return live response with missing capture ID
          return new Response(
            JSON.stringify({
              id: 'ORDER-PAYPAL-12345',
              status: 'COMPLETED',
              purchase_units: [
                {
                  payments: {
                    captures: [
                      {
                        status: 'COMPLETED',
                        // id is missing!
                        amount: { currency_code: 'USD', value: '1948.92' },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response('Not Found', { status: 404 });
      });

      const res = await capturePayPalOrder({
        orderId: 'ORDER-PAYPAL-12345',
        paymentAttempt: testPaymentAttempt,
      });

      expect(res.status).toBe('FAILED');
      expect(res.captureId).toBe('');
      expect(res.paymentAttempt.status).toBe('failed');
      expect(res.errorMessage).toContain('missing a valid capture ID');
    });

    it('rejects replay capture if payment attempt has missing or synthetic providerCaptureId', async () => {
      const capturedAttemptWithoutId: PaymentAttempt = {
        ...testPaymentAttempt,
        status: 'captured',
        providerCaptureId: undefined,
      };

      await expect(
        capturePayPalOrder({
          orderId: 'ORDER-PAYPAL-12345',
          paymentAttempt: capturedAttemptWithoutId,
        })
      ).rejects.toThrow('Captured payment attempt lacks a verified provider capture ID');
    });

    it('returns HTTP 500 Financial Integrity Error if ALREADY_CAPTURED claim has no valid capture ID', async () => {
      const businessId = '00000000-0000-4000-8000-000000000001';
      const orderId = `ORD-CORRUPT-${randomUUID().slice(0, 8)}`;
      const corruptedAttempt: PaymentAttempt = {
        ...testPaymentAttempt,
        id: randomUUID(),
        businessId,
        providerOrderId: orderId,
        status: 'captured',
        providerCaptureId: undefined, // Missing capture ID
      };

      await LedgerEngine.savePaymentAttemptAsync(corruptedAttempt);

      const req = new Request('http://localhost:3000/api/paypal/capture-order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-demo-user-id': '00000000-0000-4000-8000-000000000020', // Chidi (Approver)
          'x-business-id': businessId,
        },
        body: JSON.stringify({
          orderId,
          callerUserId: '00000000-0000-4000-8000-000000000020',
        }),
      });

      const res = await captureOrderRoute(req);
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toContain('lacks verified provider capture ID');
      expect(data.captureId).toBeUndefined();
    });
  });

  describe('5. P2: Gemini AI Model Validation & Operational Visibility', () => {
    it('resolves valid allowed Gemini models correctly', () => {
      expect(ALLOWED_GEMINI_MODELS).toContain('gemini-2.5-flash');
      expect(ALLOWED_GEMINI_MODELS).toContain('gemini-2.0-flash');
      expect(ALLOWED_GEMINI_MODELS).toContain('gemini-1.5-flash');

      expect(resolveGeminiModel('gemini-2.0-flash')).toBe('gemini-2.0-flash');
      expect(resolveGeminiModel('gemini-1.5-flash')).toBe('gemini-1.5-flash');
      expect(resolveGeminiModel('gemini-2.5-flash')).toBe('gemini-2.5-flash');
    });

    it('rejects arbitrary or unknown model strings and defaults safely to gemini-2.5-flash', () => {
      expect(resolveGeminiModel('arbitrary-unvetted-model')).toBe('gemini-2.5-flash');
      expect(resolveGeminiModel('')).toBe('gemini-2.5-flash');
      expect(resolveGeminiModel(undefined)).toBe('gemini-2.5-flash');
    });

    it('returns plannerStatus: gemini_success when Gemini API returns valid plan', async () => {
      process.env.GEMINI_API_KEY = 'test-gemini-key-live';

      vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('generativelanguage.googleapis.com')) {
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: JSON.stringify({
                          summary: 'Procurement of 2 Dell XPS 15 Laptops',
                          justification: 'Engineering team gear renewal',
                          currency: 'USD',
                          budgetLimitCents: 500000,
                          items: [
                            {
                              sku: 'LAP-DELL-XPS15',
                              matchedProductId: '00000000-0000-4000-8000-000000000101',
                              productName: 'Dell XPS 15 9530 Enterprise Edition',
                              quantity: 2,
                              estimatedUnitPriceCents: 179900,
                              suggestedSupplierId: '00000000-0000-4000-8000-000000000100',
                            },
                          ],
                          clarificationNeeded: false,
                          suggestedSupplierId: '00000000-0000-4000-8000-000000000100',
                          confidenceScore: 0.96,
                        }),
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response('Not Found', { status: 404 });
      });

      const plan = await parseProcurementIntent('Order 2 Dell XPS 15 laptops from AfriTech for engineers.');
      expect(plan.plannerSource).toBe('gemini');
      expect(plan.plannerModel).toBe('gemini-2.5-flash');
      expect(plan.plannerStatus).toBe('gemini_success');
    });

    it('returns plannerStatus: deterministic_fallback with classified fallbackReason when Gemini API fails', async () => {
      process.env.GEMINI_API_KEY = 'test-gemini-key-fail';

      vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('generativelanguage.googleapis.com')) {
          return new Response(JSON.stringify({ error: { code: 429, message: 'Resource exhausted' } }), {
            status: 429,
          });
        }
        return new Response('Not Found', { status: 404 });
      });

      const plan = await parseProcurementIntent('Order 2 Dell XPS 15 laptops from AfriTech for engineers.');
      expect(plan.plannerSource).toBe('deterministic');
      expect(plan.plannerStatus).toBe('deterministic_fallback');
      expect(plan.fallbackReason).toBe('GEMINI_HTTP_429');
    });
  });

  describe('6. P2: Procurement Planning Rate Limiting & Throttling', () => {
    it('allows requests up to configured limit within window', () => {
      const userKey = 'test-user-limit-1';
      for (let i = 0; i < 10; i++) {
        const check = checkRateLimit(userKey, 10, 60);
        expect(check.allowed).toBe(true);
        expect(check.remaining).toBe(10 - (i + 1));
      }
    });

    it('throttles 11th request with allowed: false and returns retryAfter', () => {
      const userKey = 'test-user-limit-2';
      for (let i = 0; i < 10; i++) {
        checkRateLimit(userKey, 10, 60);
      }

      const blocked = checkRateLimit(userKey, 10, 60);
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
      expect(blocked.retryAfter).toBeGreaterThan(0);
    });

    it('returns HTTP 429 with Retry-After when planning route rate limit is exceeded', async () => {
      const requesterId = '00000000-0000-4000-8000-000000000010'; // Amina Bello (DEMO_MEMBERS[0].userId)
      const businessId = '00000000-0000-4000-8000-000000000001'; // DEMO_BUSINESS.id

      // Exhaust 10 allowed requests
      for (let i = 0; i < 10; i++) {
        checkRateLimit(`plan-rate-limit:${requesterId}`, 10, 60);
      }

      const req = new Request('http://localhost:3000/api/procurement/plan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-demo-user-id': requesterId,
          'x-business-id': businessId,
        },
        body: JSON.stringify({
          prompt: 'Order 2 Dell XPS 15 laptops',
          requesterId,
          businessId,
        }),
      });

      const res = await planRoutePost(req);
      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBeTruthy();
      const data = await res.json();
      expect(data.error).toContain('Rate limit exceeded');
    });
  });
});
