import { NextResponse } from 'next/server';
import { LedgerEngine } from '@/lib/ledger';
import {
  capturePayPalOrder,
  getPayPalCredentials,
  getPayPalOrderDetails,
  verifyOrderFinancialIntegrity,
  verifyCaptureFinancialIntegrity,
} from '@/lib/paypal-service';
import { authorizeRequest } from '@/lib/auth-guard';
import { randomUUID } from 'crypto';
import { PaymentAttempt } from '@/lib/types';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { orderId, callerUserId } = body as { orderId: string; callerUserId?: string };

    if (!orderId) {
      return NextResponse.json({ error: 'orderId is required.' }, { status: 400 });
    }

    // Security Invariants: Prohibit simulated order IDs immediately in production or when PayPal credentials exist
    const isSimulatedOrderId =
      orderId.startsWith('SIM-DEMO-ORD-') ||
      orderId.startsWith('ORDER-SANDBOX-');

    if (process.env.NODE_ENV === 'production' && isSimulatedOrderId) {
      return NextResponse.json(
        { error: 'Production Security Invariant: Simulated payment orders cannot be captured in production.' },
        { status: 403 }
      );
    }

    const creds = getPayPalCredentials();
    if (creds && isSimulatedOrderId) {
      return NextResponse.json(
        { error: 'Security Invariant: Simulated orders cannot be captured when real PayPal credentials are configured.' },
        { status: 403 }
      );
    }

    // 1. Authenticate caller first (fail-closed before database lookup to prevent timing attacks & ID enumeration)
    const auth = await authorizeRequest(
      req,
      undefined,
      ['requester', 'approver', 'admin'],
      callerUserId
    );
    if (!auth.authorized) {
      return auth.errorResponse!;
    }

    // 2. Authoritative lookup from database/ledger
    const paymentAttempt = await LedgerEngine.getPaymentByOrderIdAsync(orderId);
    if (!paymentAttempt) {
      return NextResponse.json(
        { error: `Payment attempt not found for orderId "${orderId}".` },
        { status: 404 }
      );
    }

    // 3. Verify tenant boundary: Caller must belong to the same business organization as the payment
    if (auth.member && auth.member.businessId !== paymentAttempt.businessId) {
      return NextResponse.json(
        {
          error: `User "${auth.member.userId}" does not belong to business "${paymentAttempt.businessId}". Cross-tenant operations are strictly prohibited.`,
        },
        { status: 403 }
      );
    }

    // Prohibit stored simulated attempts in production or when PayPal credentials exist
    const isStoredSimulated = Boolean(paymentAttempt.providerResponse?.is_simulated);
    if (process.env.NODE_ENV === 'production' && isStoredSimulated) {
      return NextResponse.json(
        { error: 'Production Security Invariant: Simulated payment orders cannot be captured in production.' },
        { status: 403 }
      );
    }

    if (creds && isStoredSimulated) {
      return NextResponse.json(
        { error: 'Security Invariant: Simulated orders cannot be captured when real PayPal credentials are configured.' },
        { status: 403 }
      );
    }

    const isSimulatedOrder = isSimulatedOrderId || isStoredSimulated;

    // 4. Atomic Capture Claim: Acquire lease to prevent concurrent capture execution
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

    // 5. Live PayPal Order Pre-Capture Verification & Graceful Reconciliation (when real PayPal credentials exist)
    if (creds && !isSimulatedOrder) {
      let liveOrder: Record<string, unknown>;
      try {
        liveOrder = await getPayPalOrderDetails(orderId);
      } catch (err: unknown) {
        const fetchMsg = err instanceof Error ? err.message : String(err);
        await LedgerEngine.releasePaymentCaptureClaimAsync(activeAttempt.id, 'failed', fetchMsg);
        return NextResponse.json(
          {
            error: `Failed to verify PayPal order state prior to capture: ${fetchMsg}`,
          },
          { status: 502 }
        );
      }

      // Verify financial and quote binding integrity of the live PayPal order
      const orderIntegrity = verifyOrderFinancialIntegrity(liveOrder, activeAttempt);
      if (!orderIntegrity.valid) {
        await LedgerEngine.releasePaymentCaptureClaimAsync(
          activeAttempt.id,
          'failed',
          orderIntegrity.error
        );
        return NextResponse.json(
          {
            success: false,
            error: `Financial Integrity Violation: ${orderIntegrity.error}`,
            status: 'FAILED',
          },
          { status: 400 }
        );
      }

      const liveStatus = String(liveOrder.status || '').toUpperCase();

      // Graceful reconciliation: If order was already COMPLETED on PayPal (e.g. earlier capture or webhook)
      if (liveStatus === 'COMPLETED') {
        const captures = orderIntegrity.captures;
        const captureObj = captures && captures.length > 0 ? captures[0] : undefined;
        const captureCheck = verifyCaptureFinancialIntegrity(captureObj, activeAttempt);

        if (!captureCheck.valid || !captureCheck.captureId) {
          await LedgerEngine.releasePaymentCaptureClaimAsync(
            activeAttempt.id,
            'failed',
            'Order is COMPLETED on PayPal but lacks a valid verified capture record.'
          );
          return NextResponse.json(
            {
              success: false,
              error: `Financial Integrity Error: Completed PayPal order lacks valid capture details: ${captureCheck.error || 'No capture ID found'}.`,
              status: 'FAILED',
            },
            { status: 500 }
          );
        }

        const reconciledAttempt: PaymentAttempt = {
          ...activeAttempt,
          status: 'captured',
          providerCaptureId: captureCheck.captureId,
          providerResponse: liveOrder,
          updatedAt: new Date().toISOString(),
        };
        await LedgerEngine.savePaymentAttemptAsync(reconciledAttempt);

        return NextResponse.json({
          success: true,
          captureId: captureCheck.captureId,
          status: 'COMPLETED',
          paymentAttempt: reconciledAttempt,
          isSimulated: false,
          isReplay: true,
        });
      }

      // Require payer approval before attempting capture
      if (liveStatus !== 'APPROVED') {
        await LedgerEngine.releasePaymentCaptureClaimAsync(
          activeAttempt.id,
          'failed',
          `Order status is "${liveStatus}". Payer must approve the order on PayPal before capture.`
        );
        return NextResponse.json(
          {
            success: false,
            error: `Order cannot be captured: PayPal order status is "${liveStatus}". Payer must approve the order on PayPal before capture.`,
            status: 'FAILED',
          },
          { status: 400 }
        );
      }
    }

    // 6. Execute PayPal Capture API
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
