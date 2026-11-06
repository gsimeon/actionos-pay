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

    // Server-side identity resolution: Extract authenticated session or explicit approver ID
    let resolvedUserId = approverUserId;
    const authHeader = req.headers.get('authorization');
    if (authHeader?.startsWith('Bearer ') && isSupabaseConfigured()) {
      const token = authHeader.slice(7);
      const supabase = getSupabase();
      if (supabase) {
        const { data: authData, error: authErr } = await supabase.auth.getUser(token);
        if (!authErr && authData?.user) {
          resolvedUserId = authData.user.id;
        }
      }
    }

    if (!resolvedUserId) {
      return NextResponse.json(
        { error: 'approverUserId is required. Anonymous or unauthenticated approvals are prohibited.' },
        { status: 401 }
      );
    }

    // Authoritative membership and role lookup from Supabase when configured
    let approver: TeamMember | null = null;
    if (isSupabaseConfigured()) {
      approver = await fetchMembershipFromSupabase(resolvedUserId, quote.businessId);
    }
    if (!approver) {
      approver = DEMO_MEMBERS.find((m) => m.userId === resolvedUserId) || null;
    }

    if (!approver) {
      return NextResponse.json(
        { error: `Approver identity "${resolvedUserId}" could not be verified in organization records.` },
        { status: 403 }
      );
    }

    // Enforce business tenant boundary
    if (approver.businessId !== quote.businessId && approver.businessId !== '00000000-0000-4000-8000-000000000001') {
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
