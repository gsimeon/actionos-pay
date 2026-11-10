import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { evaluatePolicy } from '@/lib/policy-engine';
import { processApprovalDecision } from '@/lib/approval-engine';
import {
  DEMO_BUSINESS,
  SECOND_TEST_BUSINESS,
  DEMO_MEMBERS,
  DEMO_SUPPLIERS,
  getBusinessById,
  getBusinessBudgetLimitCents,
  resolveAuthoritativeBusinessBudgetLimitAsync,
} from '@/lib/catalog';
import { Quote } from '@/lib/types';
import { computeQuoteChecksum } from '@/lib/quote-engine';
import { authorizeRequest } from '@/lib/auth-guard';
import { resetSupabaseClientForTesting, setSupabaseClientForTesting } from '@/lib/supabase';
import { checkRateLimit, resetRateLimits } from '@/lib/rate-limiter';
import type { SupabaseClient } from '@supabase/supabase-js';

describe('Phase 19 & 20: Final Hackathon Acceptance, Multi-Tenant Isolation & Auth Sanitization', () => {
  const originalEnv = { ...process.env };
  const approver = DEMO_MEMBERS[1]; // Chidi Okonkwo (limit $15,000)

  // Tenant A Supplier (AfriTech) & Tenant B Supplier (Atlas Cloud)
  const supplierTenantA = DEMO_SUPPLIERS.find((s) => s.businessId === DEMO_BUSINESS.id)!;
  const supplierTenantB = DEMO_SUPPLIERS.find((s) => s.businessId === SECOND_TEST_BUSINESS.id)!;

  // $4,500 quote (Passes Demo Business $10k ceiling; Fails Second Business $3k ceiling)
  const quoteMid: Quote = {
    id: 'quote-mid-4500',
    requestId: 'req-mid-4500',
    businessId: DEMO_BUSINESS.id,
    supplierId: supplierTenantA.id,
    supplierName: supplierTenantA.name,
    version: 1,
    subtotalCents: 450000, // $4,500.00
    taxCents: 0,
    shippingCents: 0,
    totalCents: 450000,
    currency: 'USD',
    status: 'active',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    createdAt: new Date().toISOString(),
    checksumHash: '',
    items: [
      {
        id: 'item-mid-1',
        quoteId: 'quote-mid-4500',
        itemName: 'Developer Laptop Workstation',
        quantity: 2,
        unitPriceCents: 225000,
        totalCents: 450000,
      },
    ],
  };
  quoteMid.checksumHash = computeQuoteChecksum({
    requestId: quoteMid.requestId,
    version: quoteMid.version,
    supplierId: quoteMid.supplierId,
    totalCents: quoteMid.totalCents,
    currency: quoteMid.currency,
    items: quoteMid.items,
  });

  beforeEach(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
    process.env.APP_MODE = 'demo';
    process.env.APPROVAL_SIGNING_SECRET = 'a-secure-custom-test-signing-secret-that-is-32-chars-long';
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    resetSupabaseClientForTesting();
    resetRateLimits();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetSupabaseClientForTesting();
    resetRateLimits();
    vi.restoreAllMocks();
  });

  describe('1. Multi-Tenant Spending Ceilings & Isolation', () => {
    it('retrieves distinct authoritative budget ceilings for registered tenants', () => {
      expect(getBusinessBudgetLimitCents(DEMO_BUSINESS.id)).toBe(1000000); // $10,000.00
      expect(getBusinessBudgetLimitCents(SECOND_TEST_BUSINESS.id)).toBe(300000); // $3,000.00
    });

    it('fails closed with 0 budget limit for unknown or unverified tenant IDs', () => {
      const unknownTenantId = '99999999-9999-4000-8000-999999999999';
      expect(getBusinessById(unknownTenantId)).toBeUndefined();
      expect(getBusinessBudgetLimitCents(unknownTenantId)).toBe(0);
    });

    it('resolveAuthoritativeBusinessBudgetLimitAsync retrieves database limit when Supabase is configured and fails closed on unknown tenant', async () => {
      const limitA = await resolveAuthoritativeBusinessBudgetLimitAsync(DEMO_BUSINESS.id);
      expect(limitA).toBe(1000000);

      const limitB = await resolveAuthoritativeBusinessBudgetLimitAsync(SECOND_TEST_BUSINESS.id);
      expect(limitB).toBe(300000);

      const limitUnknown = await resolveAuthoritativeBusinessBudgetLimitAsync('unknown-tenant');
      expect(limitUnknown).toBe(0);
    });

    it('proves that two organisations with different limits receive different policy outcomes for the exact same $4,500 quote', () => {
      // 1. Tenant A (Apex Innovations Africa Ltd, $10,000 ceiling): $4,500 quote PASSES
      const policyTenantA = evaluatePolicy({
        quote: quoteMid,
        budgetLimitCents: 500000, // $5,000 requested allocation
        requesterId: DEMO_MEMBERS[0].userId,
      });
      expect(policyTenantA.passed).toBe(true);
      const budgetCheckA = policyTenantA.checks.find((c) => c.code === 'BUDGET_COMPLIANCE');
      expect(budgetCheckA?.passed).toBe(true);

      // 2. Tenant B (Sahara Cloud Logistics Ltd, $3,000 ceiling, using its own supplier): Same $4,500 quote FAILS CLOSED
      const quoteTenantB: Quote = {
        ...quoteMid,
        businessId: SECOND_TEST_BUSINESS.id,
        supplierId: supplierTenantB.id,
        supplierName: supplierTenantB.name,
      };
      const policyTenantB = evaluatePolicy({
        quote: quoteTenantB,
        budgetLimitCents: 500000, // Requester requested $5,000, but org limit is $3,000
        requesterId: DEMO_MEMBERS[0].userId,
      });
      expect(policyTenantB.passed).toBe(false);
      const budgetCheckB = policyTenantB.checks.find((c) => c.code === 'BUDGET_COMPLIANCE');
      expect(budgetCheckB?.passed).toBe(false);
      expect(budgetCheckB?.message).toContain('exceeds the organization\'s authoritative budget ceiling');
      expect(budgetCheckB?.message).toContain('$3,000.00');
    });

    it('fails closed when an unknown tenant submits a quote', () => {
      const quoteUnknownTenant: Quote = {
        ...quoteMid,
        businessId: 'unregistered-rogue-tenant-id',
      };
      const policyResult = evaluatePolicy({
        quote: quoteUnknownTenant,
        budgetLimitCents: 500000,
      });
      expect(policyResult.passed).toBe(false);
      const budgetCheck = policyResult.checks.find((c) => c.code === 'BUDGET_COMPLIANCE');
      expect(budgetCheck?.passed).toBe(false);
      expect(budgetCheck?.details?.orgBudgetLimitCents).toBe(0);
    });
  });

  describe('2. Multi-Tenant Supplier Ownership & Cross-Tenant Rejection (P1)', () => {
    it('accepts quote when supplier belongs to the quote organization (Tenant A with Tenant A supplier)', () => {
      const policyResult = evaluatePolicy({
        quote: {
          ...quoteMid,
          businessId: DEMO_BUSINESS.id,
          supplierId: supplierTenantA.id,
          supplierName: supplierTenantA.name,
        },
        budgetLimitCents: 500000,
      });

      const supplierCheck = policyResult.checks.find((c) => c.code === 'SUPPLIER_APPROVED');
      expect(supplierCheck?.passed).toBe(true);
      expect(supplierCheck?.message).toContain('authorized for business organization');
    });

    it('rejects quote with cross-tenant violation when Tenant A attempts to use Tenant B supplier', () => {
      const policyResult = evaluatePolicy({
        quote: {
          ...quoteMid,
          businessId: DEMO_BUSINESS.id,
          supplierId: supplierTenantB.id, // Atlas Cloud belongs to Sahara Cloud!
          supplierName: supplierTenantB.name,
        },
        budgetLimitCents: 500000,
      });

      expect(policyResult.passed).toBe(false);
      const supplierCheck = policyResult.checks.find((c) => c.code === 'SUPPLIER_APPROVED');
      expect(supplierCheck?.passed).toBe(false);
      expect(supplierCheck?.message).toContain('Cross-tenant supplier violation');
      expect(supplierCheck?.message).toContain('Purchases across organizational boundaries are strictly prohibited');
    });

    it('rejects quote with cross-tenant violation when Tenant B attempts to use Tenant A supplier', () => {
      const policyResult = evaluatePolicy({
        quote: {
          ...quoteMid,
          businessId: SECOND_TEST_BUSINESS.id,
          supplierId: supplierTenantA.id, // AfriTech belongs to Apex!
          supplierName: supplierTenantA.name,
        },
        budgetLimitCents: 500000,
      });

      expect(policyResult.passed).toBe(false);
      const supplierCheck = policyResult.checks.find((c) => c.code === 'SUPPLIER_APPROVED');
      expect(supplierCheck?.passed).toBe(false);
      expect(supplierCheck?.message).toContain('Cross-tenant supplier violation');
    });

    it('rejects quote with unknown supplier not in registry', () => {
      const policyResult = evaluatePolicy({
        quote: {
          ...quoteMid,
          supplierId: 'unregistered-fake-supplier-id',
        },
        budgetLimitCents: 500000,
      });

      expect(policyResult.passed).toBe(false);
      const supplierCheck = policyResult.checks.find((c) => c.code === 'SUPPLIER_APPROVED');
      expect(supplierCheck?.passed).toBe(false);
      expect(supplierCheck?.message).toContain('was not found in the approved supplier registry');
    });
  });

  describe('3. Policy Engine Interface Hardening & Automatic Ceiling Resolution', () => {
    it('automatically resolves authoritative organization ceiling when orgBudgetLimitCents is completely omitted', () => {
      // Create a $12,000 quote for Apex ($10,000 limit)
      const overCeilingQuote: Quote = {
        ...quoteMid,
        totalCents: 1200000,
      };

      // Call evaluatePolicy WITHOUT passing orgBudgetLimitCents
      const policyResult = evaluatePolicy({
        quote: overCeilingQuote,
        budgetLimitCents: 1500000, // Requester claimed $15,000 budget
      });

      expect(policyResult.passed).toBe(false);
      const budgetCheck = policyResult.checks.find((c) => c.code === 'BUDGET_COMPLIANCE');
      expect(budgetCheck?.passed).toBe(false);
      expect(budgetCheck?.message).toContain('exceeds the organization\'s authoritative budget ceiling');
      expect(budgetCheck?.message).toContain('$10,000.00');
    });

    it('processApprovalDecision enforces authoritative organization ceiling when orgBudgetLimitCents is omitted', () => {
      const overCeilingQuote: Quote = {
        ...quoteMid,
        totalCents: 1200000,
      };

      expect(() =>
        processApprovalDecision({
          quote: overCeilingQuote,
          approver,
          decision: 'approved',
          budgetLimitCents: 1500000,
          requesterId: DEMO_MEMBERS[0].userId,
        })
      ).toThrow(/exceeds the organization's authoritative budget ceiling/);
    });
  });

  describe('4. Authentication Error Sanitization & Diagnostics (CI Isolated Mock)', () => {
    it('returns sanitized authentication error and correlationId without leaking internal Supabase details', async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://wycykgykpbtschrydtld.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key-32-chars-minimum-here';

      // Mock Supabase client to simulate invalid/expired token without external WebSocket or network calls
      setSupabaseClientForTesting({
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: null },
            error: new Error('PGRST_JWT_EXPIRED: The access token has expired and signature is invalid'),
          }),
        },
      } as unknown as SupabaseClient);

      const req = new Request('http://localhost/api/procurement/quote', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: 'Bearer bad-malformed-or-expired-jwt-token-with-internal-stack',
        },
        body: JSON.stringify({ requestId: 'req-test' }),
      });

      const auth = await authorizeRequest(req);
      expect(auth.authorized).toBe(false);
      expect(auth.errorResponse).toBeDefined();
      expect(auth.errorResponse?.status).toBe(401);

      const json = await auth.errorResponse!.json();
      expect(json.error).toBe('Authentication failed: Invalid or expired session token.');
      expect(json.correlationId).toBeDefined();
      expect(typeof json.correlationId).toBe('string');
      // Must not leak internal Supabase error strings
      expect(json.error).not.toContain('PGRST');
      expect(json.error).not.toContain('JWT');
    });
  });

  describe('5. Rate Limiter Governance & Specification', () => {
    it('enforces sliding window per key and correctly reports retryAfter and remaining count', () => {
      const key = 'test-phase19-rate-limit';
      const limit = 3;
      const windowSec = 60;

      expect(checkRateLimit(key, limit, windowSec).allowed).toBe(true);
      expect(checkRateLimit(key, limit, windowSec).allowed).toBe(true);
      const third = checkRateLimit(key, limit, windowSec);
      expect(third.allowed).toBe(true);
      expect(third.remaining).toBe(0);

      const fourth = checkRateLimit(key, limit, windowSec);
      expect(fourth.allowed).toBe(false);
      expect(fourth.retryAfter).toBeGreaterThan(0);
      expect(fourth.limit).toBe(3);
    });
  });
});
