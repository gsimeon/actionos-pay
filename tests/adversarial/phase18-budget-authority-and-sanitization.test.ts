import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { POST as planRoutePost } from '@/app/api/procurement/plan/route';
import { POST as quoteRoutePost } from '@/app/api/procurement/quote/route';
import { POST as approveRoutePost } from '@/app/api/procurement/approve/route';
import { POST as webhookRoutePost } from '@/app/api/paypal/webhook/route';
import { GET as recoverRouteGet, POST as recoverRoutePost } from '@/app/api/paypal/webhook/recover/route';
import { evaluatePolicy } from '@/lib/policy-engine';
import { processApprovalDecision } from '@/lib/approval-engine';
import { DEMO_BUSINESS, DEMO_MEMBERS, DEMO_SUPPLIERS, getBusinessBudgetLimitCents } from '@/lib/catalog';
import { LedgerEngine } from '@/lib/ledger';
import { Quote } from '@/lib/types';
import { computeQuoteChecksum } from '@/lib/quote-engine';
import { resetRateLimits } from '@/lib/rate-limiter';

describe('Phase 18: Budget Authority, API Error Sanitization & Accessibility Gates', () => {
  const originalEnv = { ...process.env };
  const requester = DEMO_MEMBERS[0]; // Amina Bello (Requester, limit $2,500)
  const approver = DEMO_MEMBERS[1]; // Chidi Okonkwo (Approver, limit $15,000)
  const admin = DEMO_MEMBERS[2]; // Tunde Davies (Admin, limit $50,000)

  const sampleQuote: Quote = {
    id: 'quote-phase18-001',
    requestId: 'req-phase18-001',
    businessId: DEMO_BUSINESS.id,
    supplierId: DEMO_SUPPLIERS[0].id,
    supplierName: DEMO_SUPPLIERS[0].name,
    version: 1,
    subtotalCents: 1200000, // $12,000.00 (Exceeds Org $10,000 limit, but within Chidi's $15,000 limit)
    taxCents: 0,
    shippingCents: 0,
    totalCents: 1200000,
    currency: 'USD',
    status: 'active',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    createdAt: new Date().toISOString(),
    checksumHash: '',
    items: [
      {
        id: 'item-p18-1',
        quoteId: 'quote-phase18-001',
        itemName: 'Server Cluster Workstation',
        quantity: 1,
        unitPriceCents: 1200000,
        totalCents: 1200000,
      },
    ],
  };
  sampleQuote.checksumHash = computeQuoteChecksum({
    requestId: sampleQuote.requestId,
    version: sampleQuote.version,
    supplierId: sampleQuote.supplierId,
    totalCents: sampleQuote.totalCents,
    currency: sampleQuote.currency,
    items: sampleQuote.items,
  });

  beforeEach(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
    process.env.APP_MODE = 'demo';
    process.env.APPROVAL_SIGNING_SECRET = 'a-secure-custom-test-signing-secret-that-is-32-chars-long';
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;
    delete process.env.AI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    resetRateLimits();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetRateLimits();
    vi.restoreAllMocks();
  });

  describe('1. Authoritative Organization Budget Ceiling & Requester Constraints', () => {
    it('verifies that getBusinessBudgetLimitCents returns authoritative $10,000 org ceiling', () => {
      const ceiling = getBusinessBudgetLimitCents(DEMO_BUSINESS.id);
      expect(ceiling).toBe(1000000); // $10,000.00
    });

    it('rejects planning request with negative budget limit (HTTP 400)', async () => {
      const req = new Request('http://localhost/api/procurement/plan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-demo-user-id': requester.userId,
          'x-business-id': requester.businessId,
        },
        body: JSON.stringify({
          prompt: 'Order 2 Dell XPS 15 laptops',
          budgetLimitCents: -50000,
          requesterId: requester.userId,
        }),
      });

      const res = await planRoutePost(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('Budget limit must be a positive integer in cents');
    });

    it('rejects planning request with zero budget limit (HTTP 400)', async () => {
      const req = new Request('http://localhost/api/procurement/plan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-demo-user-id': requester.userId,
          'x-business-id': requester.businessId,
        },
        body: JSON.stringify({
          prompt: 'Order 2 Dell XPS 15 laptops',
          budgetLimitCents: 0,
          requesterId: requester.userId,
        }),
      });

      const res = await planRoutePost(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('Budget limit must be a positive integer in cents');
    });

    it('rejects planning request with non-integer decimal budget (HTTP 400)', async () => {
      const req = new Request('http://localhost/api/procurement/plan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-demo-user-id': requester.userId,
          'x-business-id': requester.businessId,
        },
        body: JSON.stringify({
          prompt: 'Order 2 Dell XPS 15 laptops',
          budgetLimitCents: 1500.5,
          requesterId: requester.userId,
        }),
      });

      const res = await planRoutePost(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('Budget limit must be a positive integer in cents');
    });

    it('rejects planning request when requester attempts to exceed the organization budget ceiling ($15k > $10k)', async () => {
      const req = new Request('http://localhost/api/procurement/plan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-demo-user-id': requester.userId,
          'x-business-id': requester.businessId,
        },
        body: JSON.stringify({
          prompt: 'Order 6 Dell XPS 15 laptops with $15,000 budget',
          budgetLimitCents: 1500000, // $15,000.00 (Exceeds $10,000.00 org ceiling)
          requesterId: requester.userId,
        }),
      });

      const res = await planRoutePost(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('exceeds the authoritative organization budget ceiling');
      expect(json.error).toContain('$10,000.00');
    });

    it('accepts planning request with valid budget limit within org ceiling ($5k <= $10k)', async () => {
      const req = new Request('http://localhost/api/procurement/plan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-demo-user-id': requester.userId,
          'x-business-id': requester.businessId,
        },
        body: JSON.stringify({
          prompt: 'Order 2 Dell XPS 15 laptops',
          budgetLimitCents: 500000, // $5,000.00
          requesterId: requester.userId,
        }),
      });

      const res = await planRoutePost(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.request.budgetLimitCents).toBe(500000);
    });

    it('defaults to authoritative organization ceiling ($10,000) when budgetLimitCents is omitted', async () => {
      const req = new Request('http://localhost/api/procurement/plan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-demo-user-id': requester.userId,
          'x-business-id': requester.businessId,
        },
        body: JSON.stringify({
          prompt: 'Order 2 Dell XPS 15 laptops',
          requesterId: requester.userId,
        }),
      });

      const res = await planRoutePost(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.request.budgetLimitCents).toBe(DEMO_BUSINESS.budgetLimitCents);
    });
  });

  describe('2. Policy Engine Budget Guardrails & Organization Ceiling Invariants', () => {
    it('fails policy evaluation when quote exceeds organization budget limit ($12k > $10k), even if request budget was spoofed to $15k', () => {
      const policyResult = evaluatePolicy({
        quote: sampleQuote, // $12,000.00
        budgetLimitCents: 1500000, // Spoofed request budget of $15,000.00
        orgBudgetLimitCents: 1000000, // Authoritative org ceiling of $10,000.00
        requesterId: requester.userId,
      });

      expect(policyResult.passed).toBe(false);
      const budgetCheck = policyResult.checks.find((c) => c.code === 'BUDGET_COMPLIANCE');
      expect(budgetCheck?.passed).toBe(false);
      expect(budgetCheck?.message).toContain('exceeds the organization\'s authoritative budget ceiling');
      expect(budgetCheck?.message).toContain('$10,000.00');
    });

    it('processApprovalDecision rejects quote that breaches organization ceiling even if approver limit covers quote total', () => {
      // Chidi has $15,000 limit, quote is $12,000, org ceiling is $10,000
      expect(() =>
        processApprovalDecision({
          quote: sampleQuote,
          approver,
          decision: 'approved',
          budgetLimitCents: 1500000, // Spoofed request budget
          orgBudgetLimitCents: 1000000, // Hard org limit
          requesterId: requester.userId,
        })
      ).toThrow(/exceeds the organization's authoritative budget ceiling/);
    });
  });

  describe('3. API Error Sanitization & Correlation IDs', () => {
    it('returns sanitized error response with correlationId on unexpected /api/procurement/quote failure', async () => {
      vi.spyOn(LedgerEngine, 'getRequestAsync').mockRejectedValueOnce(
        new Error('FATAL_DATABASE_CONNECTION_POOL_EXHAUSTED_SECRET_INTERNALS')
      );

      const req = new Request('http://localhost/api/procurement/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: 'req-any',
          supplierId: DEMO_SUPPLIERS[0].id,
          items: [{ sku: 'LAP-DELL-XPS15', quantity: 1 }],
        }),
      });

      const res = await quoteRoutePost(req);
      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toBe(
        'An unexpected internal error occurred while calculating quote or verifying guardrails.'
      );
      expect(json.error).not.toContain('FATAL_DATABASE');
      expect(json.correlationId).toBeDefined();
      expect(typeof json.correlationId).toBe('string');
    });

    it('returns sanitized error response with correlationId on unexpected /api/procurement/approve failure', async () => {
      vi.spyOn(LedgerEngine, 'getQuoteAsync').mockRejectedValueOnce(
        new Error('POSTGRES_INTERNAL_CONNECTION_TIMEOUT_HOST_IP_10.0.0.1')
      );

      const req = new Request('http://localhost/api/procurement/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteId: 'quote-any',
          decision: 'approved',
          approverUserId: approver.userId,
        }),
      });

      const res = await approveRoutePost(req);
      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toBe(
        'An unexpected internal error occurred while processing approval.'
      );
      expect(json.error).not.toContain('POSTGRES_INTERNAL');
      expect(json.correlationId).toBeDefined();
    });

    it('returns sanitized error response with correlationId on unexpected /api/paypal/webhook failure', async () => {
      vi.spyOn(LedgerEngine, 'claimWebhookEventAsync').mockRejectedValueOnce(
        new Error('UNEXPECTED_INTERNAL_REDIS_OR_DB_SOCKET_ERROR')
      );

      const req = new Request('http://localhost/api/paypal/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'paypal-transmission-sig': 'test-sig',
        },
        body: JSON.stringify({
          id: 'WH-EVT-ERR-001',
          event_type: 'PAYMENT.CAPTURE.COMPLETED',
          resource: { id: 'test' },
        }),
      });

      const res = await webhookRoutePost(req);
      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toBe(
        'An unexpected internal error occurred while processing PayPal webhook.'
      );
      expect(json.error).not.toContain('UNEXPECTED_INTERNAL');
      expect(json.correlationId).toBeDefined();
    });

    it('returns sanitized error response with correlationId on unexpected /api/paypal/webhook/recover GET failure', async () => {
      process.env.CRON_SECRET = 'valid-test-cron-secret-32-chars-long';
      vi.spyOn(LedgerEngine, 'getWebhookMetricsAsync').mockRejectedValueOnce(
        new Error('INTERNAL_METRICS_QUERY_EXECUTION_FAILURE')
      );

      const req = new Request('http://localhost/api/paypal/webhook/recover', {
        method: 'GET',
        headers: {
          'x-cron-secret': 'valid-test-cron-secret-32-chars-long',
        },
      });

      const res = await recoverRouteGet(req);
      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toBe(
        'An unexpected internal error occurred while retrieving webhook recovery metrics.'
      );
      expect(json.error).not.toContain('INTERNAL_METRICS');
      expect(json.correlationId).toBeDefined();
    });

    it('returns sanitized error response with correlationId on unexpected /api/paypal/webhook/recover POST failure', async () => {
      process.env.CRON_SECRET = 'valid-test-cron-secret-32-chars-long';
      vi.spyOn(LedgerEngine, 'claimExpiredWebhookEventsAsync').mockRejectedValueOnce(
        new Error('INTERNAL_DURABLE_WORKER_CONCURRENCY_LOCK_FAIL')
      );

      const req = new Request('http://localhost/api/paypal/webhook/recover', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-cron-secret': 'valid-test-cron-secret-32-chars-long',
        },
        body: JSON.stringify({ batchSize: 5 }),
      });

      const res = await recoverRoutePost(req);
      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toBe(
        'An unexpected internal error occurred while executing the webhook recovery worker.'
      );
      expect(json.error).not.toContain('INTERNAL_DURABLE');
      expect(json.correlationId).toBeDefined();
    });
  });
});
