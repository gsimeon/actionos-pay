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

    // 2. Database-Backed Deduplication & Idempotency Check
    const existing = await LedgerEngine.getWebhookEventAsync(eventId);
    if (existing && (existing.status === 'processed' || existing.status === 'duplicate')) {
      return NextResponse.json(
        { message: 'Duplicate webhook event ignored.', eventId, status: 'duplicate' },
        { status: 200 }
      );
    }

    // Initialize or re-activate webhook record with 'received' state
    let webhookRecord = existing;
    if (!webhookRecord) {
      webhookRecord = {
        id: randomUUID(),
        provider: 'paypal',
        eventId,
        eventType,
        signatureVerified: true,
        payload,
        status: 'received',
        createdAt: new Date().toISOString(),
      };
      await LedgerEngine.recordWebhookAsync(webhookRecord);
    } else {
      await LedgerEngine.updateWebhookStatusAsync(webhookRecord, 'received');
    }

    const resource = payload.resource as Record<string, unknown> | undefined;

    // 3. Payment Capture Completed: Strict payload verification, amount reconciliation, and quote approval
    if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
      if (!resource) {
        await LedgerEngine.updateWebhookStatusAsync(webhookRecord, 'failed');
        return NextResponse.json(
          { error: 'Webhook payload invalid: missing resource object.', eventId },
          { status: 400 }
        );
      }

      // Verify provider capture status is explicitly COMPLETED
      if (resource.status !== 'COMPLETED') {
        await LedgerEngine.updateWebhookStatusAsync(webhookRecord, 'failed');
        return NextResponse.json(
          { error: `Webhook capture status is "${resource.status}", expected "COMPLETED".`, eventId },
          { status: 400 }
        );
      }

      // Strict Amount Verification: Missing or non-numeric amount is rejected
      const resourceAmount = (resource.amount as { value?: string; currency_code?: string }) || {};
      if (
        !resourceAmount.value ||
        isNaN(parseFloat(resourceAmount.value)) ||
        parseFloat(resourceAmount.value) <= 0
      ) {
        await LedgerEngine.updateWebhookStatusAsync(webhookRecord, 'failed');
        return NextResponse.json(
          { error: 'Webhook payload invalid: missing or non-positive capture amount.', eventId },
          { status: 400 }
        );
      }

      if (!resourceAmount.currency_code) {
        await LedgerEngine.updateWebhookStatusAsync(webhookRecord, 'failed');
        return NextResponse.json(
          { error: 'Webhook payload invalid: missing capture currency.', eventId },
          { status: 400 }
        );
      }

      const relatedIds = (resource.supplementary_data as Record<string, unknown> | undefined)?.related_ids as
        | Record<string, unknown>
        | undefined;
      const actualOrderId = (relatedIds?.order_id as string) || (resource.id as string);

      if (!actualOrderId) {
        await LedgerEngine.updateWebhookStatusAsync(webhookRecord, 'failed');
        return NextResponse.json(
          { error: 'Webhook payload invalid: missing order reference in resource.', eventId },
          { status: 400 }
        );
      }

      const payment = await LedgerEngine.getPaymentByOrderIdAsync(actualOrderId);
      if (!payment) {
        await LedgerEngine.updateWebhookStatusAsync(webhookRecord, 'failed');
        return NextResponse.json(
          { error: `Payment record not found for order reference "${actualOrderId}".`, eventId },
          { status: 404 }
        );
      }

      // Reconcile exact minor unit cents and currency against approved payment
      const webhookCents = Math.round(parseFloat(resourceAmount.value) * 100);
      const webhookCurrency = resourceAmount.currency_code;

      if (webhookCents !== payment.amountCents || webhookCurrency !== payment.currency) {
        payment.status = 'failed';
        payment.errorMessage = `Reconciliation mismatch: Webhook reported ${webhookCents} ${webhookCurrency}, but approved payment was ${payment.amountCents} ${payment.currency}.`;
        payment.updatedAt = new Date().toISOString();
        await LedgerEngine.savePaymentAttemptAsync(payment);
        await LedgerEngine.updateWebhookStatusAsync(webhookRecord, 'failed');

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

      // Verify underlying quote and explicit approval
      const approval = await LedgerEngine.getApprovalForQuoteAsync(payment.quoteId);
      if (!approval || approval.decision !== 'approved') {
        payment.status = 'failed';
        payment.errorMessage = 'Reconciliation error: Underlying quote lacks verified approval.';
        payment.updatedAt = new Date().toISOString();
        await LedgerEngine.savePaymentAttemptAsync(payment);
        await LedgerEngine.updateWebhookStatusAsync(webhookRecord, 'failed');

        return NextResponse.json(
          { error: 'Cannot complete payment: Quote is not approved.', eventId },
          { status: 400 }
        );
      }

      // Mark payment captured and transition request state
      if (payment.status !== 'captured') {
        payment.status = 'captured';
        payment.providerCaptureId = (resource.id as string) || payment.providerCaptureId;
        payment.updatedAt = new Date().toISOString();
        await LedgerEngine.savePaymentAttemptAsync(payment);
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

    // Mark webhook event fully processed only AFTER successful reconciliation
    await LedgerEngine.updateWebhookStatusAsync(webhookRecord, 'processed');

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
