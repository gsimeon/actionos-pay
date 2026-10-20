import { NextResponse } from 'next/server';
import { parseProcurementIntent } from '@/lib/ai-planner';
import { DEMO_BUSINESS, DEMO_MEMBERS } from '@/lib/catalog';
import { LedgerEngine } from '@/lib/ledger';
import { ProcurementRequest } from '@/lib/types';
import { randomUUID } from 'crypto';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { prompt, budgetLimitCents, requesterId } = body;

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return NextResponse.json({ error: 'Prompt must be a non-empty string.' }, { status: 400 });
    }

    const requester =
      DEMO_MEMBERS.find((m) => m.userId === requesterId) ||
      DEMO_MEMBERS.find((m) => m.role === 'requester') ||
      DEMO_MEMBERS[0];

    const plan = await parseProcurementIntent(
      prompt.trim(),
      budgetLimitCents || DEMO_BUSINESS.budgetLimitCents
    );

    const requestId = randomUUID();
    const procurementRequest: ProcurementRequest = {
      id: requestId,
      businessId: DEMO_BUSINESS.id,
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

    LedgerEngine.saveRequest(procurementRequest);
    LedgerEngine.logAudit({
      businessId: DEMO_BUSINESS.id,
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
