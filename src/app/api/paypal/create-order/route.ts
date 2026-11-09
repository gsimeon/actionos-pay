import { NextResponse } from 'next/server';
import { verifyApprovalBinding } from '@/lib/approval-engine';
import { LedgerEngine } from '@/lib/ledger';
import { createPayPalOrder } from '@/lib/paypal-service';
import { verifyQuoteIntegrity } from '@/lib/quote-engine';
import { authorizeRequest } from '@/lib/auth-guard';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { quoteId, callerUserId } = body as { quoteId: string; callerUserId?: string };

    if (!quoteId) {
      return NextResponse.json({ error: 'quoteId is required.' }, { status: 400 });
    }

    // Authoritative lookup from database/ledger
    const quote = await LedgerEngine.getQuoteAsync(quoteId);
    if (!quote) {
      return NextResponse.json({ error: `Quote "${quoteId}" not found.` }, { status: 404 });
    }

    // Authorize caller against quote's business organization
    const auth = await authorizeRequest(
      req,
      quote.businessId,
      ['requester', 'approver', 'admin'],
      callerUserId
    );
    if (!auth.authorized) {
      return auth.errorResponse!;
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

    const stableIdempotencyKey = `order-${quote.id}-v${quote.version}`;

    // Atomic Pre-Reservation: Reserve quote in database/ledger before contacting PayPal
    const reservation = await LedgerEngine.reservePaymentAttemptAsync({
      quoteId: quote.id,
      businessId: quote.businessId,
      amountCents: quote.totalCents,
      currency: quote.currency,
      idempotencyKey: stableIdempotencyKey,
      reservationSeconds: 120,
    });

    if (reservation.status === 'ALREADY_CAPTURED') {
      return NextResponse.json(
        {
          error: 'Cannot create PayPal order: Quote has already been paid and captured.',
          paymentAttempt: reservation.paymentAttempt,
        },
        { status: 400 }
      );
    }

    if (reservation.status === 'REPLAY') {
      const existingPayment = reservation.paymentAttempt;
      const providerLinks = (existingPayment?.providerResponse as Record<string, unknown> | undefined)?.links;
      const approveLink =
        (Array.isArray(providerLinks)
          ? providerLinks.find((l: { rel?: string; href?: string }) => l?.rel === 'approve')?.href
          : undefined) ||
        (reservation.providerOrderId?.startsWith('SIM-')
          ? `https://www.sandbox.paypal.com/checkoutnow?token=${reservation.providerOrderId}`
          : undefined);

      return NextResponse.json({
        success: true,
        orderId: reservation.providerOrderId,
        status: (reservation.paymentStatus || 'CREATED').toUpperCase(),
        approveUrl: approveLink,
        paymentAttempt: existingPayment,
        isSimulated: Boolean(existingPayment?.providerResponse?.is_simulated),
        isReplay: true,
      });
    }

    if (reservation.status === 'IN_FLIGHT') {
      return NextResponse.json(
        {
          error: 'Order creation is currently in progress for this quote. Please retry shortly.',
        },
        {
          status: 429,
          headers: { 'Retry-After': '3' },
        }
      );
    }

    // Reservation successfully acquired: This process owns PayPal order creation
    let result;
    try {
      result = await createPayPalOrder({
        quote,
        approval,
        idempotencyKey: stableIdempotencyKey,
      });
    } catch (orderErr: unknown) {
      const errMsg = orderErr instanceof Error ? orderErr.message : String(orderErr);
      if (reservation.paymentAttemptId) {
        await LedgerEngine.failPaymentAttemptAsync(reservation.paymentAttemptId, errMsg);
      }
      throw orderErr;
    }

    // Authoritative confirmation: Commit provider order ID to the reserved record
    await LedgerEngine.confirmPaymentOrderAsync({
      paymentAttemptId: reservation.paymentAttemptId!,
      providerOrderId: result.orderId,
      providerResponse: result.paymentAttempt.providerResponse || {},
      paymentAttempt: result.paymentAttempt,
    });

    return NextResponse.json({
      success: true,
      orderId: result.orderId,
      status: result.status,
      approveUrl: result.approveUrl,
      paymentAttempt: {
        ...result.paymentAttempt,
        id: reservation.paymentAttemptId || result.paymentAttempt.id,
      },
      isSimulated: result.isSimulated,
    });
  } catch (error: unknown) {
    console.error('Error in /api/paypal/create-order:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
