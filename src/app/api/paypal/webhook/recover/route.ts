import { NextResponse } from 'next/server';
import { authorizeRequest } from '@/lib/auth-guard';
import { LedgerEngine } from '@/lib/ledger';
import { runWebhookRecoveryWorkerAsync } from '@/lib/webhook-processor';

/**
 * GET /api/paypal/webhook/recover
 * Returns operational metrics on active, pending, failed, and dead-lettered webhook claims.
 * Protected: Requires CRON_SECRET, MONITORING_SECRET, or an authenticated admin / finance approver session.
 */
export async function GET(req: Request) {
  try {
    const request = req;
    // 1. Authorization: CRON_SECRET, MONITORING_SECRET, or Admin / Approver Session
    const cronSecret = process.env.CRON_SECRET;
    const monitoringSecret = process.env.MONITORING_SECRET;
    const authHeader = request.headers.get('authorization') || '';
    const cronHeader = request.headers.get('x-cron-secret') || '';
    const monitoringHeader = request.headers.get('x-monitoring-secret') || '';

    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

    const isSecretAuthorized =
      (cronSecret && (cronHeader === cronSecret || bearerToken === cronSecret)) ||
      (monitoringSecret && (monitoringHeader === monitoringSecret || bearerToken === monitoringSecret));

    if (!isSecretAuthorized) {
      const auth = await authorizeRequest(request, undefined, ['admin', 'approver'], undefined, {
        requireExplicitUser: true,
      });
      if (!auth.authorized) {
        return (
          auth.errorResponse ||
          NextResponse.json(
            { error: 'Unauthorized metrics access. Valid monitoring secret or admin session required.' },
            { status: 401 }
          )
        );
      }
    }

    const metrics = await LedgerEngine.getWebhookMetricsAsync();
    return NextResponse.json({
      success: true,
      metrics,
    });
  } catch (error: unknown) {
    console.error('Error in GET /api/paypal/webhook/recover:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/paypal/webhook/recover
 * Durable background worker trigger to recover expired leases, process retryable webhooks,
 * and dead-letter exhausted events.
 */
export async function POST(req: Request) {
  try {
    // 1. Worker Authorization: CRON_SECRET or Admin Session
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers.get('authorization') || '';
    const cronHeader = req.headers.get('x-cron-secret') || '';

    const isCronAuthorized =
      cronSecret &&
      (cronHeader === cronSecret ||
        (authHeader.startsWith('Bearer ') && authHeader.slice(7).trim() === cronSecret));

    if (!isCronAuthorized) {
      // Fallback: Verify admin session
      const auth = await authorizeRequest(req, undefined, ['admin'], undefined, {
        requireExplicitUser: true,
      });
      if (!auth.authorized) {
        return auth.errorResponse || NextResponse.json({ error: 'Unauthorized worker invocation.' }, { status: 401 });
      }
    }

    const body = await req.json().catch(() => ({}));
    const batchSize = typeof body.batchSize === 'number' ? body.batchSize : 10;
    const leaseSeconds = typeof body.leaseSeconds === 'number' ? body.leaseSeconds : 60;
    const maxRetries = typeof body.maxRetries === 'number' ? body.maxRetries : 5;
    const strict = body.strict === true;

    // 2. Execute Durable Recovery Worker
    const summary = await runWebhookRecoveryWorkerAsync({
      batchSize,
      leaseSeconds,
      maxRetries,
    });

    const statusCode = strict && (summary.failedCount > 0 || summary.deadLetteredCount > 0) ? 422 : 200;

    return NextResponse.json(
      {
        ...summary,
        message: `Recovery worker executed. Claimed: ${summary.claimedCount}, Processed: ${summary.processedCount}, Failed: ${summary.failedCount}, Dead-lettered: ${summary.deadLetteredCount}.`,
      },
      { status: statusCode }
    );
  } catch (error: unknown) {
    console.error('Error in POST /api/paypal/webhook/recover:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
