import { NextResponse } from 'next/server';
import { DEMO_BUSINESS, DEMO_MEMBERS, DEMO_PRODUCTS, DEMO_SUPPLIERS } from '@/lib/catalog';
import { LedgerEngine } from '@/lib/ledger';
import { fetchAuditEventsFromSupabase, isSupabaseConfigured } from '@/lib/supabase';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const requestedBusinessId =
      url.searchParams.get('businessId') ||
      req.headers.get('x-business-id') ||
      DEMO_BUSINESS.id;

    let requests = LedgerEngine.getAllRequests();
    if (requestedBusinessId) {
      requests = requests.filter((r) => r.businessId === requestedBusinessId);
    }

    let auditEvents = LedgerEngine.getAuditEvents(requestedBusinessId);

    const isConnected = isSupabaseConfigured();
    if (isConnected) {
      const supabaseEvents = await fetchAuditEventsFromSupabase(requestedBusinessId);
      if (supabaseEvents && supabaseEvents.length > 0) {
        // Merge Supabase events with any local events, deduplicated by id
        const eventMap = new Map();
        for (const e of [...auditEvents, ...supabaseEvents]) {
          eventMap.set(e.id, e);
        }
        auditEvents = Array.from(eventMap.values()).sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
      }
    }

    const business =
      requestedBusinessId === DEMO_BUSINESS.id
        ? DEMO_BUSINESS
        : {
            id: requestedBusinessId,
            name: `Organization ${requestedBusinessId.slice(0, 8)}`,
            slug: `org-${requestedBusinessId.slice(0, 8)}`,
            defaultCurrency: 'USD',
            budgetLimitCents: 1000000,
            createdAt: new Date().toISOString(),
          };

    return NextResponse.json({
      success: true,
      business,
      members: DEMO_MEMBERS.filter(
        (m) => m.businessId === requestedBusinessId || requestedBusinessId === DEMO_BUSINESS.id
      ),
      suppliers: DEMO_SUPPLIERS.filter(
        (s) => s.businessId === requestedBusinessId || requestedBusinessId === DEMO_BUSINESS.id
      ),
      products: DEMO_PRODUCTS.filter(
        (p) => p.businessId === requestedBusinessId || requestedBusinessId === DEMO_BUSINESS.id
      ),
      requests,
      auditEvents,
      isSupabaseConnected: isConnected,
    });
  } catch (error: unknown) {
    console.error('Error in /api/procurement/state:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { action } = body as { action?: string };

    if (action === 'reset') {
      LedgerEngine.reset();
      return NextResponse.json({ success: true, message: 'Ledger and procurement state reset.' });
    }

    return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
  } catch (error: unknown) {
    console.error('Error in POST /api/procurement/state:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
