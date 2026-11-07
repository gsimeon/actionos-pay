import { NextResponse } from 'next/server';
import { authorizeRequest } from '@/lib/auth-guard';
import { LedgerEngine } from '@/lib/ledger';
import { runWebhookRecoveryWorkerAsync } from '@/lib/webhook-processor';

/**
 * GET /api/paypal/webhook/recover
 * Returns operational metrics on active, pending, failed, and dead-lettered webhook claims.
 */
export async function GET() {
  try {
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
      // Fallback: Verify admin session if Supabase is configured
      const auth = await authorizeRequest(req, undefined, ['admin']);
      if (!auth.authorized) {
        return auth.errorResponse || NextResponse.json({ error: 'Unauthorized worker invocation.' }, { status: 401 });
      }
    }

    const body = await req.json().catch(() => ({}));
    const batchSize = typeof body.batchSize === 'number' ? body.batchSize : 10;
    const leaseSeconds = typeof body.leaseSeconds === 'number' ? body.leaseSeconds : 60;
    const maxRetries = typeof body.maxRetries === 'number' ? body.maxRetries : 5;

    // 2. Execute Durable Recovery Worker
    const summary = await runWebhookRecoveryWorkerAsync({
      batchSize,
      leaseSeconds,
      maxRetries,
    });

    return NextResponse.json({
      ...summary,
      message: `Recovery worker executed. Claimed: ${summary.claimedCount}, Processed: ${summary.processedCount}, Failed: ${summary.failedCount}, Dead-lettered: ${summary.deadLetteredCount}.`,
    });
  } catch (error: unknown) {
    console.error('Error in POST /api/paypal/webhook/recover:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
