import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { parseProcurementIntent } from '@/lib/ai-planner';
import { getApprovalSigningSecret, PUBLIC_DEMO_SIGNING_SECRET } from '@/lib/approval-engine';
import { verifyOrderFinancialIntegrity } from '@/lib/paypal-service';
import { PaymentAttempt } from '@/lib/types';
import { POST as planRoutePost } from '@/app/api/procurement/plan/route';

describe('Phase 15: Submission Readiness, Gemini Model Default & Transaction Acceptance', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
    process.env.APP_MODE = 'demo';
    process.env.APPROVAL_SIGNING_SECRET = 'a-secure-custom-test-signing-secret-that-is-32-chars-long';
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.AI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.AI_MODEL;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe('1. Gemini AI Planner Integration & Key Header Security', () => {
    it('calls Gemini REST API using x-goog-api-key header and gemini-2.5-flash by default', async () => {
      process.env.GEMINI_API_KEY = 'test-gemini-key-secure';

      const mockGeminiResponse = {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    summary: 'Procurement of 2 Dell XPS 15 Laptops',
                    justification: 'Engineering team equipment renewal',
                    currency: 'USD',
                    budgetLimitCents: 500000,
                    items: [
                      {
                        sku: 'LAP-DELL-XPS15',
                        matchedProductId: 'prod-dell-xps15',
                        productName: 'Dell XPS 15 9530 Enterprise Edition',
                        quantity: 2,
                        estimatedUnitPriceCents: 179900,
                        suggestedSupplierId: 'sup-afritech',
                      },
                    ],
                    clarificationNeeded: false,
                    suggestedSupplierId: 'sup-afritech',
                    confidenceScore: 0.95,
                  }),
                },
              ],
            },
          },
        ],
      };

      let capturedUrl = '';
      let capturedHeaders: Record<string, string> = {};

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        capturedUrl = String(input);
        capturedHeaders = (init?.headers as Record<string, string>) || {};
        return {
          ok: true,
          json: async () => mockGeminiResponse,
        } as unknown as Response;
      });

      const plan = await parseProcurementIntent('Order 2 Dell XPS 15 laptops from AfriTech for our engineering team');

      expect(fetchSpy).toHaveBeenCalled();
      // Ensure API key is NOT passed as a query param in the URL
      expect(capturedUrl).not.toContain('?key=');
      expect(capturedUrl).toContain('/models/gemini-2.5-flash:generateContent');
      // Ensure key is passed in the x-goog-api-key header
      expect(capturedHeaders['x-goog-api-key']).toBe('test-gemini-key-secure');
      // Ensure response metadata attributes AI source and model
      expect(plan.plannerSource).toBe('gemini');
      expect(plan.plannerModel).toBe('gemini-2.5-flash');
      expect(plan.confidenceScore).toBe(0.95);
      expect(plan.items).toHaveLength(1);
      expect(plan.items[0].sku).toBe('LAP-DELL-XPS15');
    });

    it('respects custom AI_MODEL configuration', async () => {
      process.env.GEMINI_API_KEY = 'test-gemini-key-secure';
      process.env.AI_MODEL = 'gemini-2.5-pro';

      const mockGeminiResponse = {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    summary: 'Custom Model Test Plan',
                    currency: 'USD',
                    budgetLimitCents: 300000,
                    items: [],
                    clarificationNeeded: false,
                    confidenceScore: 0.9,
                  }),
                },
              ],
            },
          },
        ],
      };

      let capturedUrl = '';
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        capturedUrl = String(input);
        return {
          ok: true,
          json: async () => mockGeminiResponse,
        } as unknown as Response;
      });

      const plan = await parseProcurementIntent('Need custom equipment');
      expect(capturedUrl).toContain('/models/gemini-2.5-pro:generateContent');
      expect(plan.plannerSource).toBe('gemini');
      expect(plan.plannerModel).toBe('gemini-2.5-pro');
    });
  });

  describe('2. Fail-Closed Order Financial & Identity Integrity Verification', () => {
    const testAttempt: PaymentAttempt = {
      id: randomUUID(),
      quoteId: 'quote-test-1234',
      businessId: 'biz-test-1',
      provider: 'paypal',
      providerOrderId: 'ORDER-SANDBOX-TEST',
      amountCents: 391285, // $3,912.85
      currency: 'USD',
      status: 'approved',
      idempotencyKey: 'idem-test-integrity',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    it('rejects order missing purchase_units array fail-closed', () => {
      const liveOrder = { id: 'ORDER-SANDBOX-TEST', status: 'APPROVED' };
      const res = verifyOrderFinancialIntegrity(liveOrder, testAttempt);
      expect(res.valid).toBe(false);
      expect(res.error).toContain('missing required purchase_units array');
    });

    it('rejects order with missing purchase unit amount fail-closed', () => {
      const liveOrder = {
        id: 'ORDER-SANDBOX-TEST',
        status: 'APPROVED',
        purchase_units: [{ reference_id: 'quote-test-1234' }],
      };
      const res = verifyOrderFinancialIntegrity(liveOrder, testAttempt);
      expect(res.valid).toBe(false);
      expect(res.error).toContain('missing required amount or currency_code');
    });

    it('rejects order with currency mismatch fail-closed', () => {
      const liveOrder = {
        id: 'ORDER-SANDBOX-TEST',
        status: 'APPROVED',
        purchase_units: [
          {
            reference_id: 'quote-test-1234',
            amount: { currency_code: 'EUR', value: '3912.85' },
          },
        ],
      };
      const res = verifyOrderFinancialIntegrity(liveOrder, testAttempt);
      expect(res.valid).toBe(false);
      expect(res.error).toContain('currency mismatch');
    });

    it('rejects order with amount mismatch fail-closed', () => {
      const liveOrder = {
        id: 'ORDER-SANDBOX-TEST',
        status: 'APPROVED',
        purchase_units: [
          {
            reference_id: 'quote-test-1234',
            amount: { currency_code: 'USD', value: '1000.00' },
          },
        ],
      };
      const res = verifyOrderFinancialIntegrity(liveOrder, testAttempt);
      expect(res.valid).toBe(false);
      expect(res.error).toContain('amount mismatch');
    });

    it('rejects order with reference_id mismatch against paymentAttempt.quoteId', () => {
      const liveOrder = {
        id: 'ORDER-SANDBOX-TEST',
        status: 'APPROVED',
        purchase_units: [
          {
            reference_id: 'wrong-quote-5678',
            amount: { currency_code: 'USD', value: '3912.85' },
          },
        ],
      };
      const res = verifyOrderFinancialIntegrity(liveOrder, testAttempt);
      expect(res.valid).toBe(false);
      expect(res.error).toContain('reference_id mismatch');
    });

    it('accepts perfectly matching live order and extracts capture metadata', () => {
      const liveOrder = {
        id: 'ORDER-SANDBOX-TEST',
        status: 'COMPLETED',
        purchase_units: [
          {
            reference_id: 'quote-test-1234',
            amount: { currency_code: 'USD', value: '3912.85' },
            payments: {
              captures: [
                {
                  id: 'CAP-LIVE-SANDBOX-999',
                  status: 'COMPLETED',
                  amount: { currency_code: 'USD', value: '3912.85' },
                },
              ],
            },
          },
        ],
      };
      const res = verifyOrderFinancialIntegrity(liveOrder, testAttempt);
      expect(res.valid).toBe(true);
      expect(res.unitAmount?.value).toBe('3912.85');
      expect(res.unitAmount?.currency_code).toBe('USD');
      expect(res.referenceId).toBe('quote-test-1234');
      expect(res.captures?.[0].id).toBe('CAP-LIVE-SANDBOX-999');
    });
  });

  describe('3. Strict 4-Part Signing Secret Lockdown', () => {
    it('rejects public demo key when APP_MODE is not "demo"', () => {
      process.env.APPROVAL_SIGNING_SECRET = PUBLIC_DEMO_SIGNING_SECRET;
      process.env.APP_MODE = 'staging';

      expect(() => getApprovalSigningSecret()).toThrow('Security Invariant');
    });

    it('rejects public demo key when real PayPal credentials are configured', () => {
      process.env.APPROVAL_SIGNING_SECRET = PUBLIC_DEMO_SIGNING_SECRET;
      process.env.APP_MODE = 'demo';
      process.env.PAYPAL_CLIENT_ID = 'real-paypal-client-id';
      process.env.PAYPAL_CLIENT_SECRET = 'real-paypal-client-secret';

      expect(() => getApprovalSigningSecret()).toThrow('Security Invariant');
    });

    it('permits public demo key ONLY when all 4 local demo invariants hold', () => {
      process.env.APPROVAL_SIGNING_SECRET = PUBLIC_DEMO_SIGNING_SECRET;
      process.env.APP_MODE = 'demo';
      (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
      delete process.env.PAYPAL_CLIENT_ID;
      delete process.env.PAYPAL_CLIENT_SECRET;
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;

      expect(getApprovalSigningSecret()).toBe(PUBLIC_DEMO_SIGNING_SECRET);
    });
  });

  describe('4. AI Plan API Route Abuse Protection', () => {
    it('returns HTTP 400 when prompt exceeds 2,000 characters', async () => {
      const longPrompt = 'A'.repeat(2001);
      const req = new Request('http://localhost:3000/api/procurement/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: longPrompt }),
      });

      const res = await planRoutePost(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('Prompt exceeds maximum permitted length of 2,000 characters.');
    });
  });
});
