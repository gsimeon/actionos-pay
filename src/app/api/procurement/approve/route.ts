import { NextResponse } from 'next/server';
import { processApprovalDecision } from '@/lib/approval-engine';
import { DEMO_MEMBERS } from '@/lib/catalog';
import { LedgerEngine } from '@/lib/ledger';
import { verifyQuoteIntegrity } from '@/lib/quote-engine';
import { fetchMembershipFromSupabase, getSupabase, isSupabaseConfigured } from '@/lib/supabase';
import { TeamMember } from '@/lib/types';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { quoteId, decision, reason, approverUserId } = body as {
      quoteId: string;
      decision: 'approved' | 'rejected';
      reason?: string;
      approverUserId?: string;
    };

    if (!quoteId || !decision || !['approved', 'rejected'].includes(decision)) {
      return NextResponse.json(
        { error: 'quoteId and a valid decision ("approved" | "rejected") are required.' },
        { status: 400 }
      );
    }

    // Fetch authoritative quote first to verify tenant scope
    const quote = await LedgerEngine.getQuoteAsync(quoteId);
    if (!quote) {
      return NextResponse.json({ error: `Quote "${quoteId}" not found.` }, { status: 404 });
    }

    let approver: TeamMember | null = null;

    if (isSupabaseConfigured()) {
      // Production Mode: Mandatory Supabase Auth session & authoritative membership lookup
      const authHeader = req.headers.get('authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return NextResponse.json(
          { error: 'approverUserId is required. Anonymous or unauthenticated approvals are prohibited. Bearer session token is required when Supabase is configured.' },
          { status: 401 }
        );
      }

      const token = authHeader.slice(7).trim();
      if (!token) {
        return NextResponse.json(
          { error: 'Empty bearer session token provided.' },
          { status: 401 }
        );
      }

      const supabase = getSupabase();
      if (!supabase) {
        return NextResponse.json(
          { error: 'Supabase authentication service unavailable.' },
          { status: 503 }
        );
      }

      const { data: authData, error: authErr } = await supabase.auth.getUser(token);
      if (authErr || !authData?.user) {
        return NextResponse.json(
          { error: `Authentication failed: ${authErr?.message || 'Invalid or expired session token.'}` },
          { status: 401 }
        );
      }

      const authenticatedUserId = authData.user.id;

      // Reject attempts to spoof approverUserId if supplied in request body
      if (approverUserId && approverUserId !== authenticatedUserId) {
        return NextResponse.json(
          { error: `Forbidden: Client-supplied approverUserId ("${approverUserId}") does not match authenticated user session ("${authenticatedUserId}").` },
          { status: 403 }
        );
      }

      // Mandatory database membership resolution
      approver = await fetchMembershipFromSupabase(authenticatedUserId, quote.businessId);
      if (!approver) {
        return NextResponse.json(
          { error: `Approver identity "${authenticatedUserId}" could not be verified in organization records.` },
          { status: 403 }
        );
      }
    } else {
      // Demo Mode: Local member lookup (active only when Supabase is not configured)
      if (!approverUserId) {
        return NextResponse.json(
          { error: 'approverUserId is required. Anonymous or unauthenticated approvals are prohibited.' },
          { status: 401 }
        );
      }

      approver = DEMO_MEMBERS.find((m) => m.userId === approverUserId) || null;
      if (!approver) {
        return NextResponse.json(
          { error: `Approver identity "${approverUserId}" could not be verified in organization records.` },
          { status: 403 }
        );
      }
    }

    // Strict business tenant boundary enforcement (no hard-coded exceptions)
    if (approver.businessId !== quote.businessId) {
      return NextResponse.json(
        { error: `Approver "${approver.userName}" does not belong to business "${quote.businessId}".` },
        { status: 403 }
      );
    }

    // Role-based authorization gate
    if (approver.role !== 'approver' && approver.role !== 'admin') {
      return NextResponse.json(
        { error: `User "${approver.userName}" holds role "${approver.role}". Only 'approver' or 'admin' roles can grant procurement approval.` },
        { status: 403 }
      );
    }

    // Quote status and expiry guardrails
    if (quote.status === 'rejected' || quote.status === 'expired') {
      return NextResponse.json(
        { error: `Cannot process quote: quote status is "${quote.status}".` },
        { status: 400 }
      );
    }

    if (new Date(quote.expiresAt).getTime() <= Date.now()) {
      return NextResponse.json(
        { error: 'Quote has expired. A fresh quote must be prepared before approval.' },
        { status: 400 }
      );
    }

    // Quote checksum verification
    if (!verifyQuoteIntegrity(quote)) {
      return NextResponse.json(
        { error: 'Quote cryptographic checksum failed: terms, items, or prices were altered.' },
        { status: 400 }
      );
    }

    const parentRequest = await LedgerEngine.getRequestAsync(quote.requestId);
    const budgetLimitCents = parentRequest ? parentRequest.budgetLimitCents : 1000000;
    const requesterId = parentRequest ? parentRequest.requesterId : undefined;

    const { approval, policyResult } = processApprovalDecision({
      quote,
      approver,
      decision,
      reason,
      budgetLimitCents,
      requesterId,
    });

    // Authoritative persistence to Supabase and Ledger
    await LedgerEngine.saveApprovalAsync(approval);

    return NextResponse.json({
      success: true,
      approval,
      policyResult,
    });
  } catch (error: unknown) {
    console.error('Error in /api/procurement/approve:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
