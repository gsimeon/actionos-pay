import { NextResponse } from 'next/server';
import { processApprovalDecision } from '@/lib/approval-engine';
import { DEMO_MEMBERS } from '@/lib/catalog';
import { LedgerEngine } from '@/lib/ledger';

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

    const quote = LedgerEngine.getQuote(quoteId);
    if (!quote) {
      return NextResponse.json({ error: `Quote "${quoteId}" not found.` }, { status: 404 });
    }

    const parentRequest = LedgerEngine.getRequest(quote.requestId);
    const budgetLimitCents = parentRequest ? parentRequest.budgetLimitCents : 1000000;
    const requesterId = parentRequest ? parentRequest.requesterId : undefined;

    // Resolve approver
    const approver =
      DEMO_MEMBERS.find((m) => m.userId === approverUserId) ||
      DEMO_MEMBERS.find((m) => m.role === 'approver') ||
      DEMO_MEMBERS[1];

    const { approval, policyResult } = processApprovalDecision({
      quote,
      approver,
      decision,
      reason,
      budgetLimitCents,
      requesterId,
    });

    LedgerEngine.saveApproval(approval);

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
