import { NextResponse } from 'next/server';
import { DEMO_BUSINESS, DEMO_MEMBERS, DEMO_PRODUCTS, DEMO_SUPPLIERS } from '@/lib/catalog';
import { LedgerEngine } from '@/lib/ledger';
import { fetchAuditEventsFromSupabase, isSupabaseConfigured } from '@/lib/supabase';
import { authorizeRequest } from '@/lib/auth-guard';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const requestedBusinessId =
      url.searchParams.get('businessId') ||
      req.headers.get('x-business-id') ||
      undefined;

    // Strict tenant authorization guard: Require authenticated session and verify business membership
    const auth = await authorizeRequest(
      req,
      requestedBusinessId,
      ['requester', 'approver', 'admin'],
      undefined,
      {
        requireExplicitUser: true,
        errorMessage: 'Authentication required. Anonymous access to organization state is prohibited.',
      }
    );

    if (!auth.authorized) {
      return auth.errorResponse!;
    }

    const businessId = auth.member?.businessId || requestedBusinessId || DEMO_BUSINESS.id;

    let requests = LedgerEngine.getAllRequests();
    requests = requests.filter((r) => r.businessId === businessId);

    let auditEvents = LedgerEngine.getAuditEvents(businessId);

    const isConnected = isSupabaseConfigured();
    if (isConnected) {
      const supabaseEvents = await fetchAuditEventsFromSupabase(businessId);
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
      businessId === DEMO_BUSINESS.id
        ? DEMO_BUSINESS
        : {
            id: businessId,
            name: `Organization ${businessId.slice(0, 8)}`,
            slug: `org-${businessId.slice(0, 8)}`,
            defaultCurrency: 'USD',
            budgetLimitCents: 1000000,
            createdAt: new Date().toISOString(),
          };

    return NextResponse.json({
      success: true,
      business,
      members: DEMO_MEMBERS.filter(
        (m) => m.businessId === businessId || businessId === DEMO_BUSINESS.id
      ),
      suppliers: DEMO_SUPPLIERS.filter(
        (s) => s.businessId === businessId || businessId === DEMO_BUSINESS.id
      ),
      products: DEMO_PRODUCTS.filter(
        (p) => p.businessId === businessId || businessId === DEMO_BUSINESS.id
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
    const isProduction = process.env.NODE_ENV === 'production';
    const isDemoExplicitlyAllowed = process.env.APP_MODE === 'demo' || !isProduction;

    // Strict Production Gate: Reset action is prohibited outside explicitly enabled demo mode
    if (isProduction && !isDemoExplicitlyAllowed) {
      return NextResponse.json(
        { error: 'Prohibited: State reset is disabled in production environment.' },
        { status: 403 }
      );
    }

    // Require admin role for state reset
    const auth = await authorizeRequest(
      req,
      undefined,
      ['admin'],
      undefined,
      {
        requireExplicitUser: true,
        errorMessage: 'Authentication required. Anonymous state reset is prohibited.',
      }
    );

    if (!auth.authorized) {
      return auth.errorResponse!;
    }

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
