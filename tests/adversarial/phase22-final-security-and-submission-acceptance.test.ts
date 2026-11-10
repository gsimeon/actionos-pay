import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { LedgerEngine } from '@/lib/ledger';
import { evaluatePolicyAsync } from '@/lib/policy-engine';
import { processApprovalDecisionAsync } from '@/lib/approval-engine';
import { calculateQuoteAsync, computeQuoteChecksum } from '@/lib/quote-engine';
import { DEMO_BUSINESS, SECOND_TEST_BUSINESS, DEMO_MEMBERS } from '@/lib/catalog';
import { resetSupabaseClientForTesting, setSupabaseClientForTesting } from '@/lib/supabase';
import { Quote } from '@/lib/types';
import type { SupabaseClient } from '@supabase/supabase-js';

describe('Phase 22: Final Security, Policy Engine Consistency & Authoritative Persistence', () => {
  const originalEnv = { ...process.env };
  const approver = DEMO_MEMBERS[1]; // Chidi Okonkwo (VP Finance, $15,000 threshold)

  beforeEach(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
    process.env.APP_MODE = 'demo';
    process.env.APPROVAL_SIGNING_SECRET = 'a-secure-custom-test-signing-secret-that-is-32-chars-long';
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
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

  describe('1. Authoritative Supabase Persistence — In-Memory Fallback Lockdown (P1)', () => {
    it('returns undefined when a request is not in Supabase, even if seeded in local memory', async () => {
      // 1. Seed item in local in-memory store
      const memoryRequest = {
        id: 'req-memory-only-123',
        businessId: DEMO_BUSINESS.id,
        requesterId: DEMO_MEMBERS[0].userId,
        requesterName: DEMO_MEMBERS[0].userName,
        rawPrompt: 'Local memory request',
        status: 'draft' as const,
        budgetLimitCents: 500000,
        currency: 'USD',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      LedgerEngine.saveRequest(memoryRequest);
      expect(LedgerEngine.getRequest('req-memory-only-123')).toBeDefined();

      // 2. Enable Supabase mode
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://wycykgykpbtschrydtld.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key-32-chars-minimum-here';

      // Mock Supabase returning null (record not in database)
      setSupabaseClientForTesting({
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
        }),
      } as unknown as SupabaseClient);

      // In Supabase mode, getRequestAsync MUST return undefined (NEVER fall back to local memory!)
      const result = await LedgerEngine.getRequestAsync('req-memory-only-123');
      expect(result).toBeUndefined();
    });

    it('returns undefined when a quote is not in Supabase, even if seeded in local memory', async () => {
      // 1. Seed quote in local memory
      const memoryQuote: Quote = {
        id: 'quote-memory-only-456',
        requestId: 'req-1',
        businessId: DEMO_BUSINESS.id,
        supplierId: 'supp-1',
        supplierName: 'Test Supp',
        version: 1,
        items: [],
        subtotalCents: 10000,
        taxCents: 750,
        shippingCents: 4500,
        totalCents: 15250,
        currency: 'USD',
        checksumHash: 'abc',
        status: 'active',
        expiresAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      };
      LedgerEngine.saveQuote(memoryQuote);
      expect(LedgerEngine.getQuote('quote-memory-only-456')).toBeDefined();

      // 2. Enable Supabase mode
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://wycykgykpbtschrydtld.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key-32-chars-minimum-here';

      setSupabaseClientForTesting({
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
        }),
      } as unknown as SupabaseClient);

      const result = await LedgerEngine.getQuoteAsync('quote-memory-only-456');
      expect(result).toBeUndefined();
    });

    it('returns undefined when an approval or payment attempt is not in Supabase, even if seeded in local memory', async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://wycykgykpbtschrydtld.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key-32-chars-minimum-here';

      setSupabaseClientForTesting({
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                limit: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                }),
              }),
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
        }),
      } as unknown as SupabaseClient);

      const approval = await LedgerEngine.getApprovalForQuoteAsync('quote-missing-in-db');
      expect(approval).toBeUndefined();

      const paymentByOrder = await LedgerEngine.getPaymentByOrderIdAsync('order-missing-in-db');
      expect(paymentByOrder).toBeUndefined();

      const paymentByQuote = await LedgerEngine.getPaymentForQuoteAsync('quote-missing-in-db');
      expect(paymentByQuote).toBeUndefined();
    });
  });

  describe('2. Authoritative Policy Engine Consistency for Database-Only Suppliers (P1)', () => {
    it('successfully evaluates policy for an approved supplier that exists ONLY in Supabase database', async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://wycykgykpbtschrydtld.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key-32-chars-minimum-here';

      const dbOnlySupplierId = '00000000-0000-4000-8000-000000009999'; // Not in DEMO_SUPPLIERS!

      const mockDbSupplier = {
        id: dbOnlySupplierId,
        business_id: DEMO_BUSINESS.id,
        name: 'Database Exclusive Cloud Systems',
        code: 'SUP-DB-EXCL',
        is_approved: true,
        risk_rating: 'low',
        country: 'US',
        contact_email: 'exclusive@dbsystems.com',
      };

      setSupabaseClientForTesting({
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'suppliers') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({ data: mockDbSupplier, error: null }),
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
          return {};
        }),
      } as unknown as SupabaseClient);

      const dbQuote: Quote = {
        id: 'quote-db-only-1',
        requestId: 'req-db-only-1',
        businessId: DEMO_BUSINESS.id,
        supplierId: dbOnlySupplierId,
        supplierName: 'Database Exclusive Cloud Systems',
        version: 1,
        items: [
          {
            id: 'item-1',
            quoteId: 'quote-db-only-1',
            itemName: 'Database Workstation',
            quantity: 1,
            unitPriceCents: 300000,
            totalCents: 300000,
          },
        ],
        subtotalCents: 300000,
        taxCents: 22500,
        shippingCents: 4500,
        totalCents: 327000, // $3,270.00
        currency: 'USD',
        checksumHash: '',
        status: 'active',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        createdAt: new Date().toISOString(),
      };
      dbQuote.checksumHash = computeQuoteChecksum({
        requestId: dbQuote.requestId,
        version: dbQuote.version,
        supplierId: dbQuote.supplierId,
        totalCents: dbQuote.totalCents,
        currency: dbQuote.currency,
        items: dbQuote.items,
      });

      // Evaluate asynchronously using authoritative resolver
      const policyResult = await evaluatePolicyAsync({
        quote: dbQuote,
        budgetLimitCents: 500000,
        requesterId: DEMO_MEMBERS[0].userId,
        approver,
      });

      expect(policyResult.passed).toBe(true);
      const supplierCheck = policyResult.checks.find((c) => c.code === 'SUPPLIER_APPROVED');
      expect(supplierCheck?.passed).toBe(true);
      expect(supplierCheck?.message).toContain('Database Exclusive Cloud Systems');
      expect(supplierCheck?.message).toContain('verified, active, and authorized');
    });

    it('rejects policy evaluation for an unapproved database-only supplier', async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://wycykgykpbtschrydtld.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key-32-chars-minimum-here';

      const unapprovedDbSupplierId = '00000000-0000-4000-8000-000000008888';

      const mockUnapprovedSupplier = {
        id: unapprovedDbSupplierId,
        business_id: DEMO_BUSINESS.id,
        name: 'Untrusted Grey Market DB Supplier',
        code: 'SUP-UNTRUSTED',
        is_approved: false, // NOT APPROVED
        risk_rating: 'high',
        country: 'US',
        contact_email: 'grey@untrusted.com',
      };

      setSupabaseClientForTesting({
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'suppliers') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({ data: mockUnapprovedSupplier, error: null }),
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
          return {};
        }),
      } as unknown as SupabaseClient);

      const unapprovedQuote: Quote = {
        id: 'quote-unapproved-db',
        requestId: 'req-unapproved-db',
        businessId: DEMO_BUSINESS.id,
        supplierId: unapprovedDbSupplierId,
        supplierName: 'Untrusted Grey Market DB Supplier',
        version: 1,
        items: [],
        subtotalCents: 100000,
        taxCents: 0,
        shippingCents: 0,
        totalCents: 100000,
        currency: 'USD',
        checksumHash: 'hash-unapproved',
        status: 'active',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        createdAt: new Date().toISOString(),
      };

      const policyResult = await evaluatePolicyAsync({
        quote: unapprovedQuote,
        budgetLimitCents: 500000,
      });

      expect(policyResult.passed).toBe(false);
      const supplierCheck = policyResult.checks.find((c) => c.code === 'SUPPLIER_APPROVED');
      expect(supplierCheck?.passed).toBe(false);
      expect(supplierCheck?.message).toContain('NOT an approved vendor');
    });

    it('executes end-to-end quote approval for database-only supplier via processApprovalDecisionAsync', async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://wycykgykpbtschrydtld.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key-32-chars-minimum-here';

      const validSupplierId = '00000000-0000-4000-8000-000000007777';

      setSupabaseClientForTesting({
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'suppliers') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({
                      data: {
                        id: validSupplierId,
                        business_id: DEMO_BUSINESS.id,
                        name: 'Verified Supabase Partner Ltd',
                        code: 'SUP-SUPA-PARTNER',
                        is_approved: true,
                        risk_rating: 'low',
                      },
                      error: null,
                    }),
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
          return {};
        }),
      } as unknown as SupabaseClient);

      const quote: Quote = {
        id: 'quote-partner-1',
        requestId: 'req-partner-1',
        businessId: DEMO_BUSINESS.id,
        supplierId: validSupplierId,
        supplierName: 'Verified Supabase Partner Ltd',
        version: 1,
        items: [
          {
            id: 'item-partner-1',
            quoteId: 'quote-partner-1',
            itemName: 'Server Equipment',
            quantity: 1,
            unitPriceCents: 200000,
            totalCents: 200000,
          },
        ],
        subtotalCents: 200000,
        taxCents: 15000,
        shippingCents: 4500,
        totalCents: 219500,
        currency: 'USD',
        checksumHash: '',
        status: 'active',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        createdAt: new Date().toISOString(),
      };
      quote.checksumHash = computeQuoteChecksum({
        requestId: quote.requestId,
        version: quote.version,
        supplierId: quote.supplierId,
        totalCents: quote.totalCents,
        currency: quote.currency,
        items: quote.items,
      });

      const { approval, policyResult } = await processApprovalDecisionAsync({
        quote,
        approver,
        decision: 'approved',
        reason: 'Approved for Q4 equipment expansion',
        budgetLimitCents: 500000,
        requesterId: DEMO_MEMBERS[0].userId,
      });

      expect(policyResult.passed).toBe(true);
      expect(approval.decision).toBe('approved');
      expect(approval.approvedSupplierId).toBe(validSupplierId);
      expect(approval.digitalSignature).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('3. GitHub License Detection & Submission Compliance (P2)', () => {
    it('verifies LICENSE file contains standard OSI-compliant MIT text with full disclaimer', () => {
      const licensePath = join(process.cwd(), 'LICENSE');
      const licenseContent = readFileSync(licensePath, 'utf8');

      expect(licenseContent).toContain('MIT License');
      expect(licenseContent).toContain('Permission is hereby granted, free of charge');
      expect(licenseContent).toContain('AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM');
      expect(licenseContent).toContain('OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.');
    });
  });
});
