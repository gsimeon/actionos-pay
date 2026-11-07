import { NextResponse } from 'next/server';
import { processApprovalDecision } from '@/lib/approval-engine';
import { LedgerEngine } from '@/lib/ledger';
import { verifyQuoteIntegrity } from '@/lib/quote-engine';
import { authorizeRequest } from '@/lib/auth-guard';

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

    // Authorize caller against quote's business organization (requiring approver or admin role)
    const auth = await authorizeRequest(
      req,
      quote.businessId,
      ['approver', 'admin'],
      approverUserId,
      { requireExplicitUser: true }
    );
    if (!auth.authorized || !auth.member) {
      return auth.errorResponse!;
    }
    const approver = auth.member;

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
