import { NextResponse } from 'next/server';
import { LedgerEngine } from '@/lib/ledger';
import { capturePayPalOrder, getPayPalCredentials } from '@/lib/paypal-service';
import { authorizeRequest } from '@/lib/auth-guard';
import { randomUUID } from 'crypto';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { orderId, callerUserId } = body as { orderId: string; callerUserId?: string };

    if (!orderId) {
      return NextResponse.json({ error: 'orderId is required.' }, { status: 400 });
    }

    // Authoritative lookup from database/ledger
    const paymentAttempt = await LedgerEngine.getPaymentByOrderIdAsync(orderId);
    if (!paymentAttempt) {
      return NextResponse.json(
        { error: `Payment attempt not found for orderId "${orderId}".` },
        { status: 404 }
      );
    }

    // Security Invariants: Prohibit simulated order capture in production or when PayPal credentials exist
    const isSimulatedOrder =
      orderId.startsWith('SIM-DEMO-ORD-') ||
      orderId.startsWith('ORDER-SANDBOX-') ||
      Boolean(paymentAttempt.providerResponse?.is_simulated);

    if (process.env.NODE_ENV === 'production' && isSimulatedOrder) {
      return NextResponse.json(
        { error: 'Production Security Invariant: Simulated payment orders cannot be captured in production.' },
        { status: 403 }
      );
    }

    if (getPayPalCredentials() && isSimulatedOrder) {
      return NextResponse.json(
        { error: 'Security Invariant: Simulated orders cannot be captured when real PayPal credentials are configured.' },
        { status: 403 }
      );
    }

    // Authorize caller against payment's business organization
    const auth = await authorizeRequest(
      req,
      paymentAttempt.businessId,
      ['requester', 'approver', 'admin'],
      callerUserId
    );
    if (!auth.authorized) {
      return auth.errorResponse!;
    }

    // Atomic Capture Claim: Acquire lease to prevent concurrent capture execution
    const claim = await LedgerEngine.claimPaymentCaptureAsync(orderId, 60);

    if (claim.status === 'ALREADY_CAPTURED') {
      const verifiedCaptureId = (claim.providerCaptureId || paymentAttempt.providerCaptureId)?.trim();
      if (!verifiedCaptureId || verifiedCaptureId === 'ALREADY_CAPTURED') {
        return NextResponse.json(
          {
            success: false,
            error: 'Financial Integrity Error: Captured payment lacks verified provider capture ID.',
            status: 'FAILED',
          },
          { status: 500 }
        );
      }

      return NextResponse.json({
        success: true,
        captureId: verifiedCaptureId,
        status: 'COMPLETED',
        paymentAttempt: claim.paymentAttempt || paymentAttempt,
        isSimulated: Boolean(claim.paymentAttempt?.providerResponse?.is_simulated || paymentAttempt.providerResponse?.is_simulated),
        isReplay: true,
      });
    }

    if (claim.status === 'IN_FLIGHT') {
      return NextResponse.json(
        {
          error: 'Payment capture is currently being processed for this order. Please retry in a few seconds.',
        },
        {
          status: 429,
          headers: { 'Retry-After': '5' },
        }
      );
    }

    if (claim.status === 'FAILED') {
      return NextResponse.json(
        {
          success: false,
          error: claim.errorMessage || paymentAttempt.errorMessage || 'Payment capture previously failed.',
          status: 'FAILED',
          paymentAttempt: claim.paymentAttempt || paymentAttempt,
        },
        { status: 402 }
      );
    }

    const activeAttempt = claim.paymentAttempt || paymentAttempt;
    const stableCaptureIdempotencyKey = `capture-${activeAttempt.id}-${orderId}`;

    let result;
    try {
      result = await capturePayPalOrder({
        orderId,
        paymentAttempt: activeAttempt,
        idempotencyKey: stableCaptureIdempotencyKey,
      });
    } catch (captureErr: unknown) {
      const errMsg = captureErr instanceof Error ? captureErr.message : String(captureErr);
      await LedgerEngine.releasePaymentCaptureClaimAsync(activeAttempt.id, 'approved', errMsg);
      throw captureErr;
    }

    // If capture failed, release lease, record failure and return 402
    if (result.status === 'FAILED') {
      await LedgerEngine.releasePaymentCaptureClaimAsync(activeAttempt.id, 'failed', result.errorMessage);
      return NextResponse.json(
        {
          success: false,
          error: result.errorMessage || result.paymentAttempt.errorMessage || 'PayPal capture failed or rejected by provider.',
          status: 'FAILED',
          paymentAttempt: result.paymentAttempt,
          isSimulated: result.isSimulated,
        },
        { status: 402 }
      );
    }

    // Authoritatively persist successfully captured payment attempt
    await LedgerEngine.savePaymentAttemptAsync(result.paymentAttempt);

    return NextResponse.json({
      success: true,
      captureId: result.captureId,
      status: result.status,
      paymentAttempt: result.paymentAttempt,
      isSimulated: result.isSimulated,
    });
  } catch (error: unknown) {
    const correlationId = randomUUID();
    console.error(`[Correlation ID: ${correlationId}] Error in /api/paypal/capture-order:`, error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      {
        error: message.includes('Integrity') || message.includes('Security') || message.includes('not found')
          ? message
          : 'Payment capture failed due to an upstream gateway error. Please try again.',
        correlationId,
      },
      { status: 502 }
    );
  }
}
