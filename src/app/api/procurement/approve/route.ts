import { NextResponse } from 'next/server';
import { processApprovalDecisionAsync } from '@/lib/approval-engine';
import { LedgerEngine } from '@/lib/ledger';
import { verifyQuoteIntegrity } from '@/lib/quote-engine';
import { authorizeRequest } from '@/lib/auth-guard';
import { getBusinessBudgetLimitCents, resolveAuthoritativeBusinessBudgetLimitAsync } from '@/lib/catalog';
import { randomUUID } from 'crypto';

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

    // 1. Authenticate caller session & role first (enforces Bearer token in Supabase mode before DB probing)
    const auth = await authorizeRequest(
      req,
      undefined,
      ['approver', 'admin'],
      approverUserId,
      { requireExplicitUser: true }
    );
    if (!auth.authorized || !auth.member) {
      return auth.errorResponse!;
    }
    const approver = auth.member;

    // 2. Fetch authoritative quote from database/ledger
    const quote = await LedgerEngine.getQuoteAsync(quoteId);
    if (!quote) {
      return NextResponse.json({ error: `Quote "${quoteId}" not found.` }, { status: 404 });
    }

    // 3. Strict tenant boundary: Approver must belong to quote's organization
    if (approver.businessId !== quote.businessId) {
      return NextResponse.json(
        {
          error: `Approver "${approver.userName}" does not belong to business "${quote.businessId}". Cross-tenant operations are strictly prohibited.`,
        },
        { status: 403 }
      );
    }

    // Defense-in-depth: Re-verify that any client-supplied ID cannot diverge from the verified session member
    if (approverUserId && approverUserId !== approver.userId) {
      return NextResponse.json(
        {
          error: `Forbidden: Client-supplied approverUserId ("${approverUserId}") does not match authenticated identity ("${approver.userId}").`,
        },
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
    const orgBudgetLimitCents = await resolveAuthoritativeBusinessBudgetLimitAsync(quote.businessId);
    const budgetLimitCents = parentRequest ? parentRequest.budgetLimitCents : orgBudgetLimitCents;
    const requesterId = parentRequest ? parentRequest.requesterId : undefined;

    const { approval, policyResult } = await processApprovalDecisionAsync({
      quote,
      approver,
      decision,
      reason,
      budgetLimitCents,
      orgBudgetLimitCents,
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
    const correlationId = randomUUID();
    console.error(`[Correlation ID: ${correlationId}] Error in /api/procurement/approve:`, error);
    const message = error instanceof Error ? error.message : 'Unknown error';

    // Business policy and validation rejections return status 400 with actionable feedback
    if (
      message.includes('Cannot approve quote') ||
      message.includes('Self-approval') ||
      message.includes('exceeds approver') ||
      message.includes('policy violations') ||
      message.includes('exceeds the organization') ||
      message.includes('Quote cryptographic') ||
      message.includes('expired')
    ) {
      return NextResponse.json({ error: message, correlationId }, { status: 400 });
    }

    // Unexpected internal errors return sanitized 500 with correlationId
    return NextResponse.json(
      {
        error: 'An unexpected internal error occurred while processing approval.',
        correlationId,
      },
      { status: 500 }
    );
  }
}
