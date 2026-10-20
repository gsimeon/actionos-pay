import { NextResponse } from 'next/server';
import { processApprovalDecision } from '@/lib/approval-engine';
import { DEMO_MEMBERS } from '@/lib/catalog';
import { LedgerEngine } from '@/lib/ledger';
import { verifyQuoteIntegrity } from '@/lib/quote-engine';

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

    // Server-side identity verification: Approver identity MUST be explicitly provided and verified
    if (!approverUserId) {
      return NextResponse.json(
        { error: 'approverUserId is required. Anonymous or unauthenticated approvals are prohibited.' },
        { status: 401 }
      );
    }

    const approver = DEMO_MEMBERS.find((m) => m.userId === approverUserId);
    if (!approver) {
      return NextResponse.json(
        { error: `Approver identity "${approverUserId}" could not be verified in organization records.` },
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

    // Fetch authoritative quote from database/ledger
    const quote = await LedgerEngine.getQuoteAsync(quoteId);
    if (!quote) {
      return NextResponse.json({ error: `Quote "${quoteId}" not found.` }, { status: 404 });
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
