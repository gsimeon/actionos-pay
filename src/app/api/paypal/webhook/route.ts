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

    const eventId = (payload.id as string) || `SIM-EVT-${randomUUID().slice(0, 8)}`;
    const eventType = (payload.event_type as string) || 'UNKNOWN_EVENT';

    // 2. Deduplication & Idempotency Check
    const existing = LedgerEngine.getWebhookEvent(eventId);
    if (existing) {
      return NextResponse.json(
        { message: 'Duplicate webhook event ignored.', eventId, status: 'duplicate' },
        { status: 200 }
      );
    }

    // Record webhook authoritatively
    await LedgerEngine.recordWebhookAsync({
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

    const resource = payload.resource as Record<string, unknown> | undefined;

    // 3. Payment Capture Completed: Reconcile amount, currency, and quote approval
    if (eventType === 'PAYMENT.CAPTURE.COMPLETED' && resource) {
      const relatedIds = (resource.supplementary_data as Record<string, unknown> | undefined)?.related_ids as
        | Record<string, unknown>
        | undefined;
      const actualOrderId = (relatedIds?.order_id as string) || (resource.id as string);

      if (actualOrderId) {
        const payment = await LedgerEngine.getPaymentByOrderIdAsync(actualOrderId);
        if (payment) {
          // Reconcile amount and currency
          const resourceAmount = (resource.amount as { value?: string; currency_code?: string }) || {};
          const webhookCents = resourceAmount.value ? Math.round(parseFloat(resourceAmount.value) * 100) : null;
          const webhookCurrency = resourceAmount.currency_code;

          if (
            webhookCents !== null &&
            (webhookCents !== payment.amountCents || (webhookCurrency && webhookCurrency !== payment.currency))
          ) {
            // Mismatch: DO NOT mark paid!
            payment.status = 'failed';
            payment.errorMessage = `Reconciliation mismatch: Webhook reported ${webhookCents} ${webhookCurrency}, but approved payment was ${payment.amountCents} ${payment.currency}.`;
            payment.updatedAt = new Date().toISOString();
            await LedgerEngine.savePaymentAttemptAsync(payment);

            await LedgerEngine.logAuditAsync({
              businessId: payment.businessId,
              entityType: 'payment',
              entityId: payment.id,
              actorId: 'paypal_webhook',
              actorRole: 'external_gateway',
              action: 'WEBHOOK_AMOUNT_MISMATCH',
              payload: {
                eventId,
                expectedCents: payment.amountCents,
                receivedCents: webhookCents,
                expectedCurrency: payment.currency,
                receivedCurrency: webhookCurrency,
              },
            });

            return NextResponse.json(
              { error: 'Webhook amount reconciliation mismatch. Payment marked failed.', eventId },
              { status: 400 }
            );
          }

          // Verify underlying quote and approval
          const approval = await LedgerEngine.getApprovalForQuoteAsync(payment.quoteId);
          if (!approval || approval.decision !== 'approved') {
            payment.status = 'failed';
            payment.errorMessage = 'Reconciliation error: Underlying quote lacks verified approval.';
            payment.updatedAt = new Date().toISOString();
            await LedgerEngine.savePaymentAttemptAsync(payment);

            return NextResponse.json(
              { error: 'Cannot complete payment: Quote is not approved.', eventId },
              { status: 400 }
            );
          }

          // Successfully reconciled and verified
          if (payment.status !== 'captured') {
            payment.status = 'captured';
            payment.providerCaptureId = (resource.id as string) || payment.providerCaptureId;
            payment.updatedAt = new Date().toISOString();
            await LedgerEngine.savePaymentAttemptAsync(payment);
          }
        }
      }
    }

    // 4. Payment Denied / Declined / Failed: Mark attempt failed
    if (
      (eventType === 'PAYMENT.CAPTURE.DENIED' ||
        eventType === 'PAYMENT.CAPTURE.DECLINED' ||
        eventType === 'CHECKOUT.ORDER.VOIDED') &&
      resource
    ) {
      const relatedIds = (resource.supplementary_data as Record<string, unknown> | undefined)?.related_ids as
        | Record<string, unknown>
        | undefined;
      const actualOrderId = (relatedIds?.order_id as string) || (resource.id as string);

      if (actualOrderId) {
        const payment = await LedgerEngine.getPaymentByOrderIdAsync(actualOrderId);
        if (payment && payment.status !== 'captured') {
          payment.status = 'failed';
          const reason =
            (resource.status_details as { reason?: string } | undefined)?.reason ||
            `PayPal event ${eventType} indicated capture failure.`;
          payment.errorMessage = reason;
          payment.updatedAt = new Date().toISOString();
          await LedgerEngine.savePaymentAttemptAsync(payment);
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
