import { NextResponse } from 'next/server';
import { LedgerEngine } from '@/lib/ledger';
import { verifyWebhookSignature } from '@/lib/paypal-service';
import { WebhookEventRecord } from '@/lib/types';
import { processWebhookEventRecordAsync } from '@/lib/webhook-processor';
import { randomUUID } from 'crypto';

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    const headers: Record<string, string> = {};
    req.headers.forEach((val, key) => {
      headers[key.toLowerCase()] = val;
    });

    // 1. Mandatory Security Verification: Webhook Signature Check
    const verification = await verifyWebhookSignature({
      headers,
      body: rawBody,
    });

    if (!verification.verified) {
      return NextResponse.json(
        { error: 'Invalid webhook signature.', reason: verification.reason },
        { status: 400 }
      );
    }

    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: 'Invalid JSON payload.' }, { status: 400 });
    }

    if (!payload.id || typeof payload.id !== 'string' || !payload.id.trim()) {
      return NextResponse.json(
        { error: 'Webhook payload invalid: missing event id (payload.id).' },
        { status: 400 }
      );
    }
    const eventId = payload.id.trim();
    const eventType = (payload.event_type as string) || 'UNKNOWN_EVENT';

    // 2. Conflict-Safe Atomic Webhook Claim & Idempotency Check
    const initialWebhookRecord: WebhookEventRecord = {
      id: randomUUID(),
      provider: 'paypal',
      eventId,
      eventType,
      signatureVerified: true,
      payload,
      status: 'received',
      createdAt: new Date().toISOString(),
    };

    const claimResult = await LedgerEngine.claimWebhookEventAsync(initialWebhookRecord);
    if (!claimResult.claimed) {
      if (claimResult.status === 'in_progress') {
        // Return 429 with Retry-After so PayPal continues retry sequence instead of acknowledging prematurely
        return NextResponse.json(
          {
            error: 'Webhook event is actively being processed by another worker lease.',
            eventId,
            status: 'in_progress',
          },
          {
            status: 429,
            headers: { 'Retry-After': '10' },
          }
        );
      }

      return NextResponse.json(
        { message: 'Duplicate webhook event ignored.', eventId, status: 'duplicate' },
        { status: 200 }
      );
    }

    const webhookRecord = claimResult.record;

    // 3. Process, validate, and atomically reconcile the webhook record
    const result = await processWebhookEventRecordAsync(webhookRecord);
    if (!result.success) {
      return NextResponse.json(
        { error: result.error, eventId },
        { status: result.status }
      );
    }

    return NextResponse.json({
      success: true,
      status: 'processed',
      eventId,
      eventType,
      payment: result.payment,
    });
  } catch (error: unknown) {
    const correlationId = randomUUID();
    console.error(`[Correlation ID: ${correlationId}] Error in /api/paypal/webhook:`, error);
    return NextResponse.json(
      {
        error: 'An unexpected internal error occurred while processing PayPal webhook.',
        correlationId,
      },
      { status: 500 }
    );
  }
}
