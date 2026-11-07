import { NextResponse } from 'next/server';
import { LedgerEngine } from '@/lib/ledger';
import { capturePayPalOrder } from '@/lib/paypal-service';
import { authorizeRequest } from '@/lib/auth-guard';

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

    // Idempotency check: If already successfully captured, return completed state without recharging
    if (paymentAttempt.status === 'captured') {
      return NextResponse.json({
        success: true,
        captureId: paymentAttempt.providerCaptureId || 'ALREADY_CAPTURED',
        status: 'COMPLETED',
        paymentAttempt,
        isSimulated: Boolean(paymentAttempt.providerResponse?.is_simulated),
      });
    }

    const result = await capturePayPalOrder({
      orderId,
      paymentAttempt,
    });

    // Authoritatively persist updated payment attempt
    await LedgerEngine.savePaymentAttemptAsync(result.paymentAttempt);

    // If capture failed, return explicit payment failure status - NEVER simulate or claim success!
    if (result.status === 'FAILED') {
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

    return NextResponse.json({
      success: true,
      captureId: result.captureId,
      status: result.status,
      paymentAttempt: result.paymentAttempt,
      isSimulated: result.isSimulated,
    });
  } catch (error: unknown) {
    console.error('Error in /api/paypal/capture-order:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
