import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DEMO_BUSINESS,
  SECOND_TEST_BUSINESS,
  DEMO_MEMBERS,
  DEMO_SUPPLIERS,
  DEMO_PRODUCTS,
  getBusinessById,
  getBusinessBudgetLimitCents,
  resolveAuthoritativeBusinessBudgetLimitAsync,
  resolveAuthoritativeSupplierAsync,
  resolveAuthoritativeProductAsync,
} from '@/lib/catalog';
import { calculateQuoteAsync } from '@/lib/quote-engine';
import { authorizeRequest } from '@/lib/auth-guard';
import { resetSupabaseClientForTesting, setSupabaseClientForTesting } from '@/lib/supabase';
import type { SupabaseClient } from '@supabase/supabase-js';

describe('Phase 21: Hackathon Release Acceptance, Server-Side Tenant Boundary & Database Catalogue', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
    process.env.APP_MODE = 'demo';
    process.env.APPROVAL_SIGNING_SECRET = 'a-secure-custom-test-signing-secret-that-is-32-chars-long';
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    resetSupabaseClientForTesting();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetSupabaseClientForTesting();
    vi.restoreAllMocks();
  });

  describe('1. Missing Organisation ID Fail-Closed Invariants (P1-C)', () => {
    it('returns zero budget authority when organisation ID is undefined, empty, or whitespace', async () => {
      // In local demo mode
      expect(getBusinessBudgetLimitCents(undefined)).toBe(0);
      expect(getBusinessBudgetLimitCents('')).toBe(0);
      expect(getBusinessBudgetLimitCents('   ')).toBe(0);
      expect(getBusinessById(undefined)).toBeUndefined();
      expect(getBusinessById('')).toBeUndefined();

      // In async authoritative resolver
      expect(await resolveAuthoritativeBusinessBudgetLimitAsync(undefined)).toBe(0);
      expect(await resolveAuthoritativeBusinessBudgetLimitAsync('')).toBe(0);
      expect(await resolveAuthoritativeBusinessBudgetLimitAsync('   ')).toBe(0);
    });

    it('returns zero budget authority in Supabase mode when organisation ID is missing', async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://wycykgykpbtschrydtld.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key-32-chars-minimum-here';

      expect(await resolveAuthoritativeBusinessBudgetLimitAsync(undefined)).toBe(0);
      expect(await resolveAuthoritativeBusinessBudgetLimitAsync('')).toBe(0);
      expect(await resolveAuthoritativeBusinessBudgetLimitAsync('   ')).toBe(0);
    });
  });

  describe('2. Cross-Tenant Authorization & Privilege Boundary Enforcement (P1-A)', () => {
    it('rejects cross-tenant operation when user from Tenant A attempts to act on Tenant B with 403 Forbidden', async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://wycykgykpbtschrydtld.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key-32-chars-minimum-here';

      const userTenantAId = '00000000-0000-4000-8000-000000000010'; // Amina Bello (Apex Innovations)

      // Mock Supabase: JWT confirms user identity, but user has NO membership in Tenant B (Sahara Cloud)
      setSupabaseClientForTesting({
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: { id: userTenantAId, email: 'amina@apexafrica.co' } },
            error: null,
          }),
        },
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockImplementation((col: string, val: string) => {
              return {
                eq: vi.fn().mockImplementation((col2: string, val2: string) => {
                  return {
                    maybeSingle: vi.fn().mockImplementation(async () => {
                      // If querying for Tenant B, user does not exist in Tenant B
                      if (val2 === SECOND_TEST_BUSINESS.id || val === SECOND_TEST_BUSINESS.id) {
                        return { data: null, error: null };
                      }
                      return {
                        data: {
                          id: 'membership-1',
                          business_id: DEMO_BUSINESS.id,
                          user_id: userTenantAId,
                          user_name: 'Amina Bello',
                          user_email: 'amina@apexafrica.co',
                          role: 'requester',
                          is_active: true,
                          approval_limit_cents: 250000,
                        },
                        error: null,
                      };
                    }),
                  };
                }),
              };
            }),
          }),
        }),
      } as unknown as SupabaseClient);

      // Caller attempts to execute operation against Tenant B (Sahara Cloud)
      const req = new Request('http://localhost/api/procurement/quote', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-jwt-token-for-amina',
          'x-business-id': SECOND_TEST_BUSINESS.id, // Targeting Sahara Cloud!
        },
      });

      const auth = await authorizeRequest(req, SECOND_TEST_BUSINESS.id, ['requester']);
      expect(auth.authorized).toBe(false);
      expect(auth.errorResponse?.status).toBe(403);

      const body = await auth.errorResponse?.json();
      expect(body.error).toContain('could not be verified in organization records');
    });

    it('rejects cross-tenant operation in demo mode when demo header belongs to a different tenant', async () => {
      // In demo mode without Supabase, verify tenant boundary checking
      const req = new Request('http://localhost/api/procurement/quote', {
        method: 'POST',
        headers: {
          'x-demo-user-id': DEMO_MEMBERS[0].userId, // Amina Bello (Apex)
        },
      });

      // Target organization is Sahara Cloud
      const auth = await authorizeRequest(req, SECOND_TEST_BUSINESS.id, ['requester']);
      expect(auth.authorized).toBe(false);
      expect(auth.errorResponse?.status).toBe(403);

      const body = await auth.errorResponse?.json();
      expect(body.error).toContain('does not belong to business');
      expect(body.error).toContain('Cross-tenant operations are strictly prohibited');
    });
  });

  describe('3. Database-Backed Authoritative Catalogue Resolution (P1-B)', () => {
    it('resolves supplier and product from database scoped to tenant in Supabase mode', async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://wycykgykpbtschrydtld.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key-32-chars-minimum-here';

      const mockSupplier = {
        id: 'supp-db-1',
        business_id: DEMO_BUSINESS.id,
        name: 'Database Hardware Ltd',
        code: 'SUP-DB-HW',
        is_approved: true,
        risk_rating: 'low',
        country: 'US',
        contact_email: 'orders@dbhardware.com',
      };

      const mockProduct = {
        id: 'prod-db-1',
        business_id: DEMO_BUSINESS.id,
        supplier_id: 'supp-db-1',
        sku: 'LAP-DB-01',
        name: 'Enterprise Precision Workstation',
        description: 'Database loaded high-perf workstation',
        category: 'Laptops',
        unit_price_cents: 250000,
        currency: 'USD',
        in_stock: true,
      };

      setSupabaseClientForTesting({
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'suppliers') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({ data: mockSupplier, error: null }),
                  }),
                }),
              }),
            };
          }
          if (table === 'products') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  ilike: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({ data: mockProduct, error: null }),
                  }),
                  eq: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({ data: mockProduct, error: null }),
                  }),
                }),
              }),
            };
          }
          return {};
        }),
      } as unknown as SupabaseClient);

      const supplier = await resolveAuthoritativeSupplierAsync(DEMO_BUSINESS.id, 'supp-db-1');
      expect(supplier).toBeDefined();
      expect(supplier?.name).toBe('Database Hardware Ltd');
      expect(supplier?.businessId).toBe(DEMO_BUSINESS.id);

      const product = await resolveAuthoritativeProductAsync(DEMO_BUSINESS.id, { sku: 'LAP-DB-01' });
      expect(product).toBeDefined();
      expect(product?.name).toBe('Enterprise Precision Workstation');
      expect(product?.unitPriceCents).toBe(250000);
      expect(product?.businessId).toBe(DEMO_BUSINESS.id);
    });

    it('fails closed when product or supplier does not exist in the database for the given tenant', async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://wycykgykpbtschrydtld.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key-32-chars-minimum-here';

      setSupabaseClientForTesting({
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
              ilike: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }),
          }),
        }),
      } as unknown as SupabaseClient);

      const supplier = await resolveAuthoritativeSupplierAsync(DEMO_BUSINESS.id, 'non-existent-supp');
      expect(supplier).toBeUndefined();

      const product = await resolveAuthoritativeProductAsync(DEMO_BUSINESS.id, { sku: 'NON-EXISTENT-SKU' });
      expect(product).toBeUndefined();
    });

    it('calculates deterministic quote with cryptographic checksum using calculateQuoteAsync', async () => {
      const supplier = DEMO_SUPPLIERS[0];
      const product = DEMO_PRODUCTS.find((p) => p.supplierId === supplier.id)!;

      const quote = await calculateQuoteAsync({
        requestId: 'req-async-001',
        businessId: DEMO_BUSINESS.id,
        supplierId: supplier.id,
        items: [{ sku: product.sku, quantity: 2 }],
      });

      expect(quote).toBeDefined();
      expect(quote.status).toBe('active');
      expect(quote.checksumHash).toMatch(/^[a-f0-9]{64}$/);
      expect(quote.items[0].unitPriceCents).toBe(product.unitPriceCents);
      expect(quote.items[0].totalCents).toBe(product.unitPriceCents * 2);
    });

    it('rejects quote creation if product is out of stock', async () => {
      const supplier = DEMO_SUPPLIERS[0];

      // Temporary mock product that is out of stock
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://wycykgykpbtschrydtld.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key-32-chars-minimum-here';

      setSupabaseClientForTesting({
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'suppliers') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({
                      data: {
                        id: supplier.id,
                        business_id: DEMO_BUSINESS.id,
                        name: supplier.name,
                        code: supplier.code,
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
          if (table === 'products') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  ilike: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({
                      data: {
                        id: 'prod-out-of-stock',
                        business_id: DEMO_BUSINESS.id,
                        supplier_id: supplier.id,
                        sku: 'LAP-OUT-OF-STOCK',
                        name: 'Rare Workstation',
                        unit_price_cents: 100000,
                        in_stock: false, // OUT OF STOCK!
                      },
                      error: null,
                    }),
                  }),
                }),
              }),
            };
          }
          return {};
        }),
      } as unknown as SupabaseClient);

      await expect(
        calculateQuoteAsync({
          requestId: 'req-async-oos',
          businessId: DEMO_BUSINESS.id,
          supplierId: supplier.id,
          items: [{ sku: 'LAP-OUT-OF-STOCK', quantity: 1 }],
        })
      ).rejects.toThrow('is currently out of stock');
    });

    it('rejects quote creation if supplier is unapproved', async () => {
      const unapprovedSupplier = DEMO_SUPPLIERS.find((s) => !s.isApproved)!;

      await expect(
        calculateQuoteAsync({
          requestId: 'req-async-unapproved',
          businessId: DEMO_BUSINESS.id,
          supplierId: unapprovedSupplier.id,
          items: [{ sku: 'LAP-SHAD-GREY01', quantity: 1 }],
        })
      ).rejects.toThrow('is not approved for procurement');
    });
  });
});
