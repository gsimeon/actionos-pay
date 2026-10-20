import { NextResponse } from 'next/server';
import { DEMO_BUSINESS, DEMO_MEMBERS, DEMO_PRODUCTS, DEMO_SUPPLIERS } from '@/lib/catalog';
import { LedgerEngine } from '@/lib/ledger';
import { fetchAuditEventsFromSupabase, isSupabaseConfigured } from '@/lib/supabase';

export async function GET() {
  try {
    const requests = LedgerEngine.getAllRequests();
    let auditEvents = LedgerEngine.getAuditEvents();

    const isConnected = isSupabaseConfigured();
    if (isConnected) {
      const supabaseEvents = await fetchAuditEventsFromSupabase(DEMO_BUSINESS.id);
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

    return NextResponse.json({
      success: true,
      business: DEMO_BUSINESS,
      members: DEMO_MEMBERS,
      suppliers: DEMO_SUPPLIERS,
      products: DEMO_PRODUCTS,
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
