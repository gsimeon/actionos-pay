import { NextResponse } from 'next/server';
import { LedgerEngine } from '@/lib/ledger';
import { capturePayPalOrder } from '@/lib/paypal-service';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { orderId } = body as { orderId: string };

    if (!orderId) {
      return NextResponse.json({ error: 'orderId is required.' }, { status: 400 });
    }

    const paymentAttempt = LedgerEngine.getPaymentByOrderId(orderId);
    if (!paymentAttempt) {
      return NextResponse.json(
        { error: `Payment attempt not found for orderId "${orderId}".` },
        { status: 404 }
      );
    }

    const result = await capturePayPalOrder({
      orderId,
      paymentAttempt,
    });

    LedgerEngine.savePaymentAttempt(result.paymentAttempt);

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
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
