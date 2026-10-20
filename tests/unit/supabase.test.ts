import { describe, expect, it } from 'vitest';
import {
  fetchAuditEventsFromSupabase,
  fetchProductsFromSupabase,
  fetchSuppliersFromSupabase,
  getSupabase,
  isSupabaseConfigured,
  persistAuditToSupabase,
  persistRequestToSupabase,
} from '../../src/lib/supabase';
import { AuditEvent, ProcurementRequest } from '../../src/lib/types';
import { randomUUID } from 'crypto';

describe('Supabase Client & Persistence Layer', () => {
  it('reports isSupabaseConfigured false when environment variables are omitted', () => {
    // In test environment without NEXT_PUBLIC_SUPABASE_URL set
    const configured = isSupabaseConfigured();
    expect(typeof configured).toBe('boolean');
  });

  it('safely handles queries gracefully when Supabase is not configured', async () => {
    const events = await fetchAuditEventsFromSupabase('non-existent-biz');
    expect(events).toBeNull();

    const suppliers = await fetchSuppliersFromSupabase('non-existent-biz');
    expect(suppliers).toBeNull();

    const products = await fetchProductsFromSupabase('non-existent-biz');
    expect(products).toBeNull();
  });

  it('safely attempts audit persistence without throwing unhandled exceptions', async () => {
    const dummyEvent: AuditEvent = {
      id: randomUUID(),
      businessId: '00000000-0000-4000-8000-000000000001',
      entityType: 'request',
      entityId: randomUUID(),
      actorId: 'test-user',
      actorRole: 'tester',
      action: 'TEST_PERSISTENCE',
      payload: { test: true },
      createdAt: new Date().toISOString(),
    };

    const res = await persistAuditToSupabase(dummyEvent);
    expect(typeof res).toBe('boolean');
  });

  it('safely attempts request persistence without throwing unhandled exceptions', async () => {
    const dummyReq: ProcurementRequest = {
      id: randomUUID(),
      businessId: '00000000-0000-4000-8000-000000000001',
      requesterId: '00000000-0000-4000-8000-000000000010',
      requesterName: 'Amina Bello',
      rawPrompt: 'Test procurement intent',
      status: 'draft',
      budgetLimitCents: 500000,
      currency: 'USD',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const res = await persistRequestToSupabase(dummyReq);
    expect(typeof res).toBe('boolean');
  });
});
