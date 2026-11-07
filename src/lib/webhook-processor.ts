// ActionOS Pay: Authoritative Webhook Event Processor & Revalidation Engine
// Shared by real-time webhook delivery and durable background recovery workers
// Guarantees:
// 1. Independent cryptographic approval binding verification
// 2. Strict minor-unit currency and amount reconciliation
// 3. Mandatory provider capture identifier verification
// 4. Atomic multi-entity database reconciliation

import { verifyApprovalBinding } from './approval-engine';
import { parseAmountToMinorUnits } from './currency';
import { LedgerEngine } from './ledger';
import { PaymentAttempt, WebhookEventRecord } from './types';

export interface WebhookProcessingResult {
  success: boolean;
  error?: string;
  status: number;
  payment?: PaymentAttempt;
}

/**
 * Validates, re-verifies, and reconciles a webhook event record.
 * Designed for idempotent invocation from real-time endpoints and recovery workers.
 */
export async function processWebhookEventRecordAsync(
  webhookRecord: WebhookEventRecord
): Promise<WebhookProcessingResult> {
  const eventId = webhookRecord.eventId;
  const eventType = webhookRecord.eventType;
  const payload = webhookRecord.payload;
  const resource = payload.resource as Record<string, unknown> | undefined;

  // 1. Payment Capture Completed: Strict payload verification, amount reconciliation, and quote approval
  if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
    if (!resource) {
      await LedgerEngine.updateWebhookStatusAsync(webhookRecord, 'failed');
      return {
        success: false,
        error: 'Webhook payload invalid: missing resource object.',
        status: 400,
      };
    }

    // Verify provider capture status is explicitly COMPLETED
    if (resource.status !== 'COMPLETED') {
      await LedgerEngine.updateWebhookStatusAsync(webhookRecord, 'failed');
      return {
        success: false,
        error: `Webhook capture status is "${resource.status}", expected "COMPLETED".`,
        status: 400,
      };
    }

    // Mandatory Provider Capture Identifier Check: Missing or empty capture ID is strictly rejected
    const providerCaptureId = (resource.id as string | undefined)?.trim();
    if (!providerCaptureId) {
      await LedgerEngine.updateWebhookStatusAsync(webhookRecord, 'failed');
      return {
        success: false,
        error: 'Webhook payload invalid: missing provider capture identifier (resource.id).',
        status: 400,
      };
    }

    // Strict Amount Verification: Missing or non-numeric amount is rejected
    const resourceAmount = (resource.amount as { value?: string; currency_code?: string }) || {};
    if (
      !resourceAmount.value ||
      isNaN(parseFloat(resourceAmount.value)) ||
      parseFloat(resourceAmount.value) <= 0
    ) {
      await LedgerEngine.updateWebhookStatusAsync(webhookRecord, 'failed');
      return {
        success: false,
        error: 'Webhook payload invalid: missing or non-positive capture amount.',
        status: 400,
      };
    }

    if (!resourceAmount.currency_code) {
      await LedgerEngine.updateWebhookStatusAsync(webhookRecord, 'failed');
      return {
        success: false,
        error: 'Webhook payload invalid: missing capture currency.',
        status: 400,
      };
    }

    const relatedIds = (resource.supplementary_data as Record<string, unknown> | undefined)?.related_ids as
      | Record<string, unknown>
      | undefined;
    const actualOrderId = relatedIds?.order_id as string | undefined;

    if (!actualOrderId || typeof actualOrderId !== 'string' || !actualOrderId.trim()) {
      await LedgerEngine.updateWebhookStatusAsync(webhookRecord, 'failed');
      return {
        success: false,
        error:
          'Webhook payload invalid: missing order reference in resource.supplementary_data.related_ids.order_id.',
        status: 400,
      };
    }

    const payment = await LedgerEngine.getPaymentByOrderIdAsync(actualOrderId);
    if (!payment) {
      await LedgerEngine.updateWebhookStatusAsync(webhookRecord, 'failed');
      return {
        success: false,
        error: `Payment record not found for order reference "${actualOrderId}".`,
        status: 404,
      };
    }

    // Reconcile exact minor units and currency against approved payment using currency-aware precision
    const webhookCurrency = resourceAmount.currency_code;
    const webhookCents = parseAmountToMinorUnits(resourceAmount.value, webhookCurrency);

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

      return {
        success: false,
        error: 'Webhook amount reconciliation mismatch. Payment marked failed.',
        status: 400,
      };
    }

    // Verify underlying quote exists
    const quote = await LedgerEngine.getQuoteAsync(payment.quoteId);
    if (!quote) {
      payment.status = 'failed';
      payment.errorMessage = `Reconciliation error: Underlying quote "${payment.quoteId}" not found.`;
      payment.updatedAt = new Date().toISOString();
      await LedgerEngine.savePaymentAttemptAsync(payment);
      await LedgerEngine.updateWebhookStatusAsync(webhookRecord, 'failed');

      return {
        success: false,
        error: `Cannot complete payment: Quote "${payment.quoteId}" not found.`,
        status: 400,
      };
    }

    // Verify underlying quote has approved decision
    const approval = await LedgerEngine.getApprovalForQuoteAsync(payment.quoteId);
    if (!approval || approval.decision !== 'approved') {
      payment.status = 'failed';
      payment.errorMessage = 'Reconciliation error: Underlying quote lacks verified approval.';
      payment.updatedAt = new Date().toISOString();
      await LedgerEngine.savePaymentAttemptAsync(payment);
      await LedgerEngine.updateWebhookStatusAsync(webhookRecord, 'failed');

      return {
        success: false,
        error: 'Cannot complete payment: Quote is not approved.',
        status: 400,
      };
    }

    // Independent cryptographic binding verification: verify HMAC signature, checksum, terms
    const bindingResult = verifyApprovalBinding(approval, quote);
    if (!bindingResult.valid) {
      payment.status = 'failed';
      payment.errorMessage = `Reconciliation error: Approval cryptographic binding verification failed: ${bindingResult.reasons.join('; ')}`;
      payment.updatedAt = new Date().toISOString();
      await LedgerEngine.savePaymentAttemptAsync(payment);
      await LedgerEngine.updateWebhookStatusAsync(webhookRecord, 'failed');

      await LedgerEngine.logAuditAsync({
        businessId: payment.businessId,
        entityType: 'approval',
        entityId: approval.id,
        actorId: 'paypal_webhook',
        actorRole: 'external_gateway',
        action: 'WEBHOOK_APPROVAL_BINDING_FAILED',
        payload: {
          eventId,
          quoteId: quote.id,
          reasons: bindingResult.reasons,
        },
      });

      return {
        success: false,
        error: `Cannot complete payment: Approval cryptographic binding verification failed. Reasons: ${bindingResult.reasons.join('; ')}`,
        status: 400,
      };
    }

    // Atomic reconciliation: mark payment captured, transition request to fulfilled, mark webhook processed
    await LedgerEngine.reconcilePaymentCaptureAsync({
      payment,
      webhookRecord,
      quote,
      providerCaptureId,
    });

    return {
      success: true,
      status: 200,
      payment,
    };
  }

  // 2. Payment Denied / Declined / Failed: Mark attempt failed
  if (
    eventType === 'PAYMENT.CAPTURE.DENIED' ||
    eventType === 'PAYMENT.CAPTURE.DECLINED' ||
    eventType === 'CHECKOUT.ORDER.VOIDED'
  ) {
    const relatedIds = (resource?.supplementary_data as Record<string, unknown> | undefined)?.related_ids as
      | Record<string, unknown>
      | undefined;
    const actualOrderId = (relatedIds?.order_id as string) || (resource?.id as string);

    if (actualOrderId) {
      const payment = await LedgerEngine.getPaymentByOrderIdAsync(actualOrderId);
      if (payment) {
        payment.status = 'failed';
        payment.errorMessage = `PayPal payment ${eventType}: ${resource?.status_details || 'Declined by financial institution.'}`;
        payment.updatedAt = new Date().toISOString();
        await LedgerEngine.savePaymentAttemptAsync(payment);
      }
    }

    await LedgerEngine.updateWebhookStatusAsync(webhookRecord, 'processed');
    return { success: true, status: 200 };
  }

  // 3. Other Events: Mark processed idempotently
  await LedgerEngine.updateWebhookStatusAsync(webhookRecord, 'processed');
  return { success: true, status: 200 };
}

export interface WebhookRecoverySummary {
  success: boolean;
  claimedCount: number;
  processedCount: number;
  failedCount: number;
  deadLetteredCount: number;
  errors: string[];
}

/**
 * Durable recovery worker: claims expired/retryable webhooks, revalidates them,
 * executes reconciliation, manages retry backoff, and dead-letters exhausted events.
 */
export async function runWebhookRecoveryWorkerAsync(options?: {
  batchSize?: number;
  leaseSeconds?: number;
  maxRetries?: number;
}): Promise<WebhookRecoverySummary> {
  const batchSize = options?.batchSize || 10;
  const leaseSeconds = options?.leaseSeconds || 60;
  const maxRetries = options?.maxRetries || 5;

  // 1. Dead-letter exhausted events exceeding max retries
  const deadLetteredCount = await LedgerEngine.deadLetterExhaustedWebhookEventsAsync(maxRetries);

  // 2. Claim expired or retryable events (fails closed if Supabase configured and RPC fails)
  const candidates = await LedgerEngine.claimExpiredWebhookEventsAsync(
    batchSize,
    leaseSeconds,
    maxRetries
  );

  let processedCount = 0;
  let failedCount = 0;
  const errors: string[] = [];

  for (const webhook of candidates) {
    try {
      const result = await processWebhookEventRecordAsync(webhook);
      if (result.success) {
        processedCount++;
      } else {
        failedCount++;
        const errorMsg = result.error || 'Reconciliation failed';
        errors.push(`Event ${webhook.eventId}: ${errorMsg}`);
        const currentRetries = webhook.retryCount || 1;
        const delaySeconds = Math.min(300, 30 * Math.pow(2, currentRetries - 1));
        await LedgerEngine.recordWebhookFailureAsync(
          webhook.id,
          webhook.eventId,
          errorMsg,
          currentRetries,
          delaySeconds
        );
      }
    } catch (err: unknown) {
      failedCount++;
      const errorMsg = err instanceof Error ? err.message : 'Unknown exception';
      errors.push(`Event ${webhook.eventId}: ${errorMsg}`);
      const currentRetries = webhook.retryCount || 1;
      const delaySeconds = Math.min(300, 30 * Math.pow(2, currentRetries - 1));
      await LedgerEngine.recordWebhookFailureAsync(
        webhook.id,
        webhook.eventId,
        errorMsg,
        currentRetries,
        delaySeconds
      );
    }
  }

  return {
    success: true,
    claimedCount: candidates.length,
    processedCount,
    failedCount,
    deadLetteredCount,
    errors,
  };
}
