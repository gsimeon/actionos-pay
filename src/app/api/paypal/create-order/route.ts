import { NextResponse } from 'next/server';
import { LedgerEngine } from '@/lib/ledger';
import { createPayPalOrder } from '@/lib/paypal-service';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { quoteId } = body as { quoteId: string };

    if (!quoteId) {
      return NextResponse.json({ error: 'quoteId is required.' }, { status: 400 });
    }

    const quote = LedgerEngine.getQuote(quoteId);
    if (!quote) {
      return NextResponse.json({ error: `Quote "${quoteId}" not found.` }, { status: 404 });
    }

    const approval = LedgerEngine.getApprovalForQuote(quoteId);
    if (!approval) {
      return NextResponse.json(
        { error: 'Cannot create PayPal order: Quote has not been approved.' },
        { status: 400 }
      );
    }

    if (approval.decision !== 'approved') {
      return NextResponse.json(
        { error: 'Cannot create PayPal order: Quote was rejected.' },
        { status: 400 }
      );
    }

    const result = await createPayPalOrder({
      quote,
      approval,
    });

    LedgerEngine.savePaymentAttempt(result.paymentAttempt);

    return NextResponse.json({
      success: true,
      orderId: result.orderId,
      status: result.status,
      approveUrl: result.approveUrl,
      paymentAttempt: result.paymentAttempt,
      isSimulated: result.isSimulated,
    });
  } catch (error: unknown) {
    console.error('Error in /api/paypal/create-order:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
