import { NextResponse } from 'next/server';
import { verifyApprovalBinding } from '@/lib/approval-engine';
import { LedgerEngine } from '@/lib/ledger';
import { createPayPalOrder } from '@/lib/paypal-service';
import { verifyQuoteIntegrity } from '@/lib/quote-engine';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { quoteId } = body as { quoteId: string };

    if (!quoteId) {
      return NextResponse.json({ error: 'quoteId is required.' }, { status: 400 });
    }

    // Authoritative lookup from database/ledger
    const quote = await LedgerEngine.getQuoteAsync(quoteId);
    if (!quote) {
      return NextResponse.json({ error: `Quote "${quoteId}" not found.` }, { status: 404 });
    }

    // Expiry check
    if (new Date(quote.expiresAt).getTime() <= Date.now()) {
      return NextResponse.json(
        { error: 'Cannot create PayPal order: Quote has expired. A fresh quote must be prepared.' },
        { status: 400 }
      );
    }

    // Quote cryptographic integrity verification
    if (!verifyQuoteIntegrity(quote)) {
      return NextResponse.json(
        { error: 'Cannot create PayPal order: Quote checksum verification failed (terms or prices tampered).' },
        { status: 400 }
      );
    }

    // Authoritative approval lookup
    const approval = await LedgerEngine.getApprovalForQuoteAsync(quoteId);
    if (!approval) {
      return NextResponse.json(
        { error: 'Cannot create PayPal order: Quote has not been approved.' },
        { status: 400 }
      );
    }

    if (approval.decision !== 'approved') {
      return NextResponse.json(
        { error: `Cannot create PayPal order: Quote was ${approval.decision}.` },
        { status: 400 }
      );
    }

    // Cryptographic binding verification
    const binding = verifyApprovalBinding(approval, quote);
    if (!binding.valid) {
      return NextResponse.json(
        {
          error: `Cannot create PayPal order: Approval does not bind to current quote terms. Reasons: ${binding.reasons.join('; ')}`,
        },
        { status: 400 }
      );
    }

    const result = await createPayPalOrder({
      quote,
      approval,
    });

    // Authoritative persistence
    await LedgerEngine.savePaymentAttemptAsync(result.paymentAttempt);

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
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
