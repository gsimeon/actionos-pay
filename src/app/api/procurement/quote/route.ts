import { NextResponse } from 'next/server';
import { evaluatePolicy } from '@/lib/policy-engine';
import { calculateQuoteAsync, QuoteInputItem } from '@/lib/quote-engine';
import { LedgerEngine } from '@/lib/ledger';
import { authorizeRequest } from '@/lib/auth-guard';
import { getBusinessBudgetLimitCents, resolveAuthoritativeBusinessBudgetLimitAsync } from '@/lib/catalog';
import { randomUUID } from 'crypto';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { requestId, supplierId, items, callerUserId } = body as {
      requestId: string;
      supplierId: string;
      items: QuoteInputItem[];
      callerUserId?: string;
    };

    if (!requestId || !supplierId || !items || !Array.isArray(items) || items.length === 0) {
      return NextResponse.json(
        { error: 'Missing required fields: requestId, supplierId, and non-empty items array.' },
        { status: 400 }
      );
    }

    // Authoritative lookup from database/ledger
    const procurementRequest = await LedgerEngine.getRequestAsync(requestId);
    if (!procurementRequest) {
      return NextResponse.json({ error: `Request "${requestId}" not found.` }, { status: 404 });
    }

    // Authorize caller against request's business organization
    const auth = await authorizeRequest(
      req,
      procurementRequest.businessId,
      ['requester', 'approver', 'admin'],
      callerUserId
    );
    if (!auth.authorized) {
      return auth.errorResponse!;
    }

    const orgBudgetLimitCents = await resolveAuthoritativeBusinessBudgetLimitAsync(procurementRequest.businessId);

    const quote = await calculateQuoteAsync({
      requestId,
      businessId: procurementRequest.businessId,
      supplierId,
      items,
    });

    const policyResult = evaluatePolicy({
      quote,
      budgetLimitCents: procurementRequest.budgetLimitCents,
      orgBudgetLimitCents,
      requesterId: procurementRequest.requesterId,
    });

    // Authoritative asynchronous persistence to Supabase & Ledger
    await LedgerEngine.saveQuoteAsync(quote);

    await LedgerEngine.logAuditAsync({
      businessId: quote.businessId,
      entityType: 'policy',
      entityId: quote.id,
      actorId: 'policy_engine',
      actorRole: 'automated_rule_checker',
      action: policyResult.passed ? 'POLICY_PASSED' : 'POLICY_VIOLATION_DETECTED',
      payload: {
        passed: policyResult.passed,
        violations: policyResult.violations,
        checks: policyResult.checks.map((c) => ({ code: c.code, passed: c.passed })),
      },
    });

    return NextResponse.json({
      success: true,
      quote,
      policyResult,
    });
  } catch (error: unknown) {
    const correlationId = randomUUID();
    console.error(`[Correlation ID: ${correlationId}] Error in /api/procurement/quote:`, error);
    const message = error instanceof Error ? error.message : 'Unknown error';

    if (
      message.includes('items array') ||
      message.includes('not found') ||
      message.includes('Missing required') ||
      message.includes('Invalid')
    ) {
      return NextResponse.json({ error: message, correlationId }, { status: 400 });
    }

    return NextResponse.json(
      {
        error: 'An unexpected internal error occurred while calculating quote or verifying guardrails.',
        correlationId,
      },
      { status: 500 }
    );
  }
}
