import { NextResponse } from 'next/server';
import { evaluatePolicy } from '@/lib/policy-engine';
import { calculateQuote, QuoteInputItem } from '@/lib/quote-engine';
import { LedgerEngine } from '@/lib/ledger';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { requestId, supplierId, items } = body as {
      requestId: string;
      supplierId: string;
      items: QuoteInputItem[];
    };

    if (!requestId || !supplierId || !items || !Array.isArray(items) || items.length === 0) {
      return NextResponse.json(
        { error: 'Missing required fields: requestId, supplierId, and non-empty items array.' },
        { status: 400 }
      );
    }

    const procurementRequest = LedgerEngine.getRequest(requestId);
    if (!procurementRequest) {
      return NextResponse.json({ error: `Request "${requestId}" not found.` }, { status: 404 });
    }

    const quote = calculateQuote({
      requestId,
      businessId: procurementRequest.businessId,
      supplierId,
      items,
    });

    const policyResult = evaluatePolicy({
      quote,
      budgetLimitCents: procurementRequest.budgetLimitCents,
      requesterId: procurementRequest.requesterId,
    });

    LedgerEngine.saveQuote(quote);
    LedgerEngine.logAudit({
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
    console.error('Error in /api/procurement/quote:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
