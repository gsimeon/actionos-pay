import { NextResponse } from 'next/server';
import { parseProcurementIntent } from '@/lib/ai-planner';
import { DEMO_BUSINESS } from '@/lib/catalog';
import { LedgerEngine } from '@/lib/ledger';
import { ProcurementRequest } from '@/lib/types';
import { authorizeRequest } from '@/lib/auth-guard';
import { randomUUID } from 'crypto';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { prompt, budgetLimitCents, requesterId } = body;

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return NextResponse.json({ error: 'Prompt must be a non-empty string.' }, { status: 400 });
    }

    const requestedBusinessId =
      (body.businessId as string | undefined) ||
      req.headers.get('x-business-id') ||
      undefined;

    // Authorization & Dynamic Tenant Boundary Enforcement
    const auth = await authorizeRequest(
      req,
      requestedBusinessId,
      ['requester', 'approver', 'admin'],
      requesterId
    );
    if (!auth.authorized || !auth.member) {
      return auth.errorResponse!;
    }
    const requester = auth.member;
    const businessId = requester.businessId;

    const plan = await parseProcurementIntent(
      prompt.trim(),
      budgetLimitCents || DEMO_BUSINESS.budgetLimitCents
    );

    const requestId = randomUUID();
    const procurementRequest: ProcurementRequest = {
      id: requestId,
      businessId,
      requesterId: requester.userId,
      requesterName: requester.userName,
      rawPrompt: prompt.trim(),
      structuredPlan: plan,
      status: plan.clarificationNeeded ? 'clarification_needed' : 'draft',
      budgetLimitCents: plan.budgetLimitCents,
      currency: plan.currency,
      clarificationQuestions: plan.clarificationQuestions,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Authoritative asynchronous persistence to Supabase & Ledger
    await LedgerEngine.saveRequestAsync(procurementRequest);

    await LedgerEngine.logAuditAsync({
      businessId,
      entityType: 'request',
      entityId: requestId,
      actorId: requester.userId,
      actorRole: requester.role,
      action: 'REQUEST_CREATED',
      payload: {
        rawPrompt: prompt,
        extractedSummary: plan.summary,
        budgetLimitCents: plan.budgetLimitCents,
        confidenceScore: plan.confidenceScore,
        clarificationNeeded: plan.clarificationNeeded,
      },
    });

    return NextResponse.json({
      success: true,
      request: procurementRequest,
      plan,
    });
  } catch (error: unknown) {
    console.error('Error in /api/procurement/plan:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
