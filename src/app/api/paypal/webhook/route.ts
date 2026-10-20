import { NextResponse } from 'next/server';
import { LedgerEngine } from '@/lib/ledger';
import { verifyWebhookSignature } from '@/lib/paypal-service';
import { randomUUID } from 'crypto';

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    const headers: Record<string, string> = {};
    req.headers.forEach((val, key) => {
      headers[key.toLowerCase()] = val;
    });

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

    const eventId = (payload.id as string) || `SIM-EVT-${randomUUID().slice(0, 8)}`;
    const eventType = (payload.event_type as string) || 'UNKNOWN_EVENT';

    // Idempotency check: deduplicate event IDs
    const existing = LedgerEngine.getWebhookEvent(eventId);
    if (existing) {
      return NextResponse.json(
        { message: 'Duplicate webhook event ignored.', eventId, status: 'duplicate' },
        { status: 200 }
      );
    }

    LedgerEngine.recordWebhook({
      id: randomUUID(),
      provider: 'paypal',
      eventId,
      eventType,
      signatureVerified: true,
      payload,
      status: 'processed',
      processedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    // Handle order completion events
    if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
      const resource = payload.resource as Record<string, unknown> | undefined;
      const customId = resource?.custom_id as string | undefined;
      const orderId = (resource?.supplementary_data as Record<string, unknown>)?.related_ids as
        | Record<string, unknown>
        | undefined;
      const actualOrderId = (orderId?.order_id as string) || (resource?.id as string);

      if (actualOrderId) {
        const payment = LedgerEngine.getPaymentByOrderId(actualOrderId);
        if (payment && payment.status !== 'captured') {
          payment.status = 'captured';
          payment.updatedAt = new Date().toISOString();
          LedgerEngine.savePaymentAttempt(payment);
        }
      }
    }

    return NextResponse.json({
      success: true,
      status: 'processed',
      eventId,
      eventType,
    });
  } catch (error: unknown) {
    console.error('Error in /api/paypal/webhook:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
