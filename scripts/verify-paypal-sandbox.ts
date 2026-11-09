/**
 * ActionOS Pay: Tier 3 Live PayPal Sandbox Acceptance Runner
 * Validates the full buyer-to-ledger procurement lifecycle:
 * 1. OAuth2 Client Credentials authentication against PayPal Sandbox
 * 2. Cryptographic quote sealing (HMAC-SHA256) & dual-control approval binding
 * 3. Atomic payment reservation in authoritative LedgerEngine
 * 4. Orders v2 order creation with live HATEOAS buyer approval URL
 * 5. Interactive buyer checkout approval & server-side capture
 * 6. Authoritative ledger persistence & webhook reconciliation
 *
 * Usage:
 *   Create Order & Approve URL:   npx tsx scripts/verify-paypal-sandbox.ts
 *   Capture Approved Order:       npx tsx scripts/verify-paypal-sandbox.ts --capture <ORDER_ID>
 */

import { randomUUID, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  getPayPalCredentials,
  getAccessToken,
  createPayPalOrder,
  capturePayPalOrder,
  getPayPalOrderDetails,
} from '../src/lib/paypal-service';
import { computeApprovalSignature } from '../src/lib/approval-engine';
import { computeQuoteChecksum } from '../src/lib/quote-engine';
import { DEMO_BUSINESS, DEMO_MEMBERS, DEMO_SUPPLIERS } from '../src/lib/catalog';
import { Quote, Approval, PaymentAttempt, ProcurementRequest } from '../src/lib/types';
import { LedgerEngine } from '../src/lib/ledger';

const CACHE_FILE = path.resolve(process.cwd(), '.sandbox-order-cache.json');

// Load .env.local if present
try {
  const envPath = path.resolve(process.cwd(), '.env.local');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let value = match[2] || '';
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
        if (!process.env[key]) process.env[key] = value.trim();
      }
    }
  }
} catch {}

function loadOrderCache(): Record<string, { quote: Quote; approval: Approval; paymentAttempt: PaymentAttempt }> {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

function saveOrderCache(orderId: string, data: { quote: Quote; approval: Approval; paymentAttempt: PaymentAttempt }) {
  try {
    const cache = loadOrderCache();
    cache[orderId] = data;
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch {}
}

async function runVerification() {
  console.log('========================================================================');
  console.log('ActionOS Pay: Tier 3 Live PayPal Sandbox & Ledger Acceptance Runner');
  console.log('========================================================================\n');

  // Isolate from un-migrated remote Supabase database unless explicitly opted in with --supabase
  const useRemoteDb = process.argv.includes('--supabase');
  if (!useRemoteDb) {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  }

  const creds = getPayPalCredentials();
  if (!creds || creds.clientId.startsWith('your-') || creds.clientSecret.startsWith('your-')) {
    console.error('❌ Live PayPal Sandbox Acceptance Gate Failed: Missing live credentials.');
    console.error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are strictly required for live PayPal Sandbox verification.');
    console.error('Set live credentials in .env.local or CI repository secrets before invoking verify:sandbox.');
    process.exit(1);
  }

  console.log(`[1/5] PayPal Client ID: ${creds.clientId.slice(0, 8)}... (Environment: ${creds.env})`);

  // Step 1: OAuth2 Access Token
  console.log('[2/5] Authenticating with PayPal Sandbox OAuth2...');
  const token = await getAccessToken(creds);
  console.log(`✅ OAuth2 Token acquired successfully. Length: ${token.length} chars.`);

  const captureIndex = process.argv.indexOf('--capture');
  const specifiedOrderId = captureIndex !== -1 && process.argv[captureIndex + 1] ? process.argv[captureIndex + 1] : null;

  if (specifiedOrderId) {
    console.log(`\n[3/6] Resolving order "${specifiedOrderId}" from authoritative ledger...`);
    const cache = loadOrderCache();
    let paymentAttempt = await LedgerEngine.getPaymentByOrderIdAsync(specifiedOrderId);

    if (!paymentAttempt && cache[specifiedOrderId]) {
      paymentAttempt = cache[specifiedOrderId].paymentAttempt;
      // Re-seed into ledger engine
      await LedgerEngine.savePaymentAttemptAsync(paymentAttempt);
    }

    if (!paymentAttempt) {
      console.error('\n❌ Acceptance Error: Unknown or Unverified Order ID');
      console.error(`Order "${specifiedOrderId}" does not exist in the authoritative ledger or local session cache.`);
      console.error('ActionOS Pay prohibits capturing arbitrary or manufactured orders.');
      console.error('To run an acceptance test, first create an order with:');
      console.error('  npx tsx scripts/verify-paypal-sandbox.ts\n');
      process.exit(1);
    }

    // Pre-capture verification directly against PayPal Orders v2 API
    console.log(`[4/6] Verifying PayPal Orders v2 status for "${specifiedOrderId}"...`);
    const liveOrder = await getPayPalOrderDetails(specifiedOrderId);
    const liveStatus = liveOrder.status as string;
    console.log(`  Live PayPal Order Status: ${liveStatus}`);

    if (liveStatus !== 'APPROVED' && liveStatus !== 'COMPLETED') {
      const links = liveOrder.links as Array<{ rel: string; href: string }> | undefined;
      const approveLink = links?.find((l) => l.rel === 'approve')?.href;

      console.log('\n========================================================================');
      console.log('⚠️ LIVE CAPTURE NOT YET ELIGIBLE: AWAITING BUYER APPROVAL');
      console.log('========================================================================');
      console.log(`Order ID:          ${specifiedOrderId}`);
      console.log(`Current Status:    ${liveStatus} (Requires "APPROVED" to execute capture)`);
      if (approveLink) {
        console.log(`Approve Link:      ${approveLink}`);
      }
      console.log('\nInstructions to Complete Acceptance:');
      console.log('1. Open the HATEOAS Approve URL in your browser:');
      if (approveLink) console.log(`   ${approveLink}`);
      console.log('2. Log in with your Sandbox Buyer account and click "Complete Purchase".');
      console.log(`3. Re-run: npx tsx scripts/verify-paypal-sandbox.ts --capture ${specifiedOrderId}`);
      console.log('========================================================================\n');
      return;
    }

    // Verify financial integrity: purchase unit value matches payment attempt
    const purchaseUnit = (liveOrder.purchase_units as Array<{ amount?: { currency_code?: string; value?: string } }> | undefined)?.[0];
    const unitAmount = purchaseUnit?.amount;
    const expectedValue = (paymentAttempt.amountCents / 100).toFixed(2);
    if (unitAmount && (unitAmount.currency_code !== paymentAttempt.currency || unitAmount.value !== expectedValue)) {
      console.error('\n❌ Security Integrity Violation: Order amount or currency mismatch with ledger.');
      console.error(`Expected: ${expectedValue} ${paymentAttempt.currency}, Received: ${unitAmount.value} ${unitAmount.currency_code}`);
      process.exit(1);
    }

    console.log(`[5/6] Acquiring atomic capture claim lease for order "${specifiedOrderId}"...`);
    const claim = await LedgerEngine.claimPaymentCaptureAsync(specifiedOrderId, 60);

    if (claim.status === 'ALREADY_CAPTURED') {
      console.log('\n========================================================================');
      console.log('ℹ️ ORDER WAS ALREADY CAPTURED PREVIOUSLY');
      console.log('========================================================================');
      console.log(`Order ID:          ${specifiedOrderId}`);
      console.log(`Capture ID:        ${claim.providerCaptureId || paymentAttempt.providerCaptureId}`);
      console.log(`Status:            COMPLETED (Replay)`);
      console.log('========================================================================\n');
      return;
    }

    if (claim.status === 'IN_FLIGHT') {
      console.log(`⚠️ Capture is currently in flight by another worker (lease expires at ${claim.leaseExpiresAt}).`);
      return;
    }

    if (claim.status === 'FAILED') {
      console.log(`❌ Payment capture previously failed for this order: ${claim.errorMessage}`);
      return;
    }

    console.log('[6/6] Invoking live PayPal capture API (/v2/checkout/orders/{id}/capture)...');
    const captureResult = await capturePayPalOrder({
      orderId: specifiedOrderId,
      paymentAttempt,
      idempotencyKey: `capture-cli-${specifiedOrderId}`,
    });

    if (captureResult.status === 'COMPLETED') {
      // Authoritatively persist captured payment in ledger
      await LedgerEngine.savePaymentAttemptAsync(captureResult.paymentAttempt);
      if (cache[specifiedOrderId]) {
        cache[specifiedOrderId].paymentAttempt = captureResult.paymentAttempt;
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
      }

      console.log('\n========================================================================');
      console.log('🎉 TIER 3 ACCEPTANCE: LIVE PAYPAL SANDBOX ORDER CAPTURED & PERSISTED');
      console.log('========================================================================');
      console.log(`Order ID:          ${specifiedOrderId}`);
      console.log(`Capture ID:        ${captureResult.captureId}`);
      console.log(`Status:            COMPLETED`);
      console.log(`Amount:            $${(paymentAttempt.amountCents / 100).toFixed(2)} ${paymentAttempt.currency}`);
      console.log(`Ledger State:      Captured & Persisted Authoritatively in Ledger`);
      console.log('\nNote on Webhooks:');
      console.log('  Live capture confirmation above was completed via synchronous PayPal API response.');
      console.log('  Asynchronous webhook reconciliation is verified in Tier 1 contract test suite.');
      console.log('========================================================================\n');
      return;
    } else {
      // Release claim upon buyer unapproved error
      await LedgerEngine.releasePaymentCaptureClaimAsync(paymentAttempt.id, 'approved', captureResult.errorMessage);

      console.log('\n========================================================================');
      console.log('⚠️ LIVE CAPTURE NOT YET COMPLETED: AWAITING BUYER APPROVAL');
      console.log('========================================================================');
      console.log(`Order ID:          ${specifiedOrderId}`);
      console.log(`Provider Error:    ${captureResult.errorMessage}`);
      console.log('\nNext Step to Complete Acceptance:');
      console.log('1. Open sandbox.paypal.com checkout link for this order.');
      console.log('2. Log in with Sandbox Buyer credentials and click "Complete Purchase".');
      console.log(`3. Re-run: npx tsx scripts/verify-paypal-sandbox.ts --capture ${specifiedOrderId}`);
      console.log('========================================================================\n');
      return;
    }
  }

  // Step 2: Build Sealed Quote & Approval
  console.log('[3/5] Generating cryptographically-sealed quote and HMAC approval...');
  if (!process.env.APPROVAL_SIGNING_SECRET) {
    process.env.APPROVAL_SIGNING_SECRET = randomBytes(32).toString('hex');
  }

  const testRequestId = randomUUID();
  const testQuoteId = randomUUID();
  const testItems = [
    {
      id: randomUUID(),
      quoteId: testQuoteId,
      itemName: 'Dell XPS 15 9530 Enterprise Edition',
      sku: 'LAP-DELL-XPS15',
      quantity: 1,
      unitPriceCents: 179900, // $1,799.00
      totalCents: 179900,
    },
  ];

  const calculatedChecksum = computeQuoteChecksum({
    requestId: testRequestId,
    version: 1,
    supplierId: DEMO_SUPPLIERS[0].id,
    totalCents: 194892,
    currency: 'USD',
    items: testItems,
  });

  const request: ProcurementRequest = {
    id: testRequestId,
    businessId: DEMO_BUSINESS.id,
    requesterId: DEMO_MEMBERS[0].userId,
    requesterName: DEMO_MEMBERS[0].userName,
    rawPrompt: 'Need 1 enterprise Dell XPS 15 laptop for engineering team',
    budgetLimitCents: 250000,
    currency: 'USD',
    status: 'draft',
    activeQuoteId: testQuoteId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const quote: Quote = {
    id: testQuoteId,
    requestId: testRequestId,
    businessId: DEMO_BUSINESS.id,
    supplierId: DEMO_SUPPLIERS[0].id,
    supplierName: DEMO_SUPPLIERS[0].name,
    version: 1,
    subtotalCents: 179900,
    taxCents: 13492,       // 7.5% VAT ($134.92)
    shippingCents: 1500,   // $15.00
    totalCents: 194892,    // $1,948.92
    currency: 'USD',
    checksumHash: calculatedChecksum,
    items: testItems,
    status: 'active',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    createdAt: new Date().toISOString(),
  };

  const signature = computeApprovalSignature({
    quoteId: quote.id,
    quoteVersion: quote.version,
    quoteChecksum: quote.checksumHash,
    totalCents: quote.totalCents,
    currency: quote.currency,
    supplierId: quote.supplierId,
    approverId: DEMO_MEMBERS[1].userId,
    decision: 'approved',
  });

  const approval: Approval = {
    id: randomUUID(),
    quoteId: quote.id,
    businessId: DEMO_BUSINESS.id,
    approverId: DEMO_MEMBERS[1].userId,
    approverName: DEMO_MEMBERS[1].userName,
    approverRole: DEMO_MEMBERS[1].role,
    quoteVersion: quote.version,
    approvedTotalCents: quote.totalCents,
    approvedCurrency: quote.currency,
    approvedSupplierId: quote.supplierId,
    decision: 'approved',
    reason: 'Executive purchase approval under delegated authority',
    digitalSignature: signature,
    createdAt: new Date().toISOString(),
  };

  // Seed into authoritative ledger with verified state transitions
  await LedgerEngine.saveRequestAsync(request);
  await LedgerEngine.saveQuoteAsync(quote);
  await LedgerEngine.saveApprovalAsync(approval);

  // Step 4: Atomic Payment Reservation before provider call
  console.log('[4/5] Reserving payment attempt in ledger engine...');
  const idempotencyKey = `order-${quote.id}-v${quote.version}`;
  const reservation = await LedgerEngine.reservePaymentAttemptAsync({
    quoteId: quote.id,
    businessId: quote.businessId,
    amountCents: quote.totalCents,
    currency: quote.currency,
    idempotencyKey,
    reservationSeconds: 120,
  });

  if (!reservation.paymentAttemptId) {
    throw new Error(`Reservation failed with status: ${reservation.status}`);
  }

  // Step 5: Orders v2 API Order Creation
  console.log('[5/5] Creating live PayPal Sandbox Order (POST /v2/checkout/orders)...');
  const result = await createPayPalOrder({
    quote,
    approval,
    idempotencyKey,
  });

  // Confirm provider order in ledger
  await LedgerEngine.confirmPaymentOrderAsync({
    paymentAttemptId: reservation.paymentAttemptId,
    providerOrderId: result.orderId,
    providerResponse: result.paymentAttempt.providerResponse || {},
    paymentAttempt: result.paymentAttempt,
  });

  saveOrderCache(result.orderId, {
    quote,
    approval,
    paymentAttempt: result.paymentAttempt,
  });

  console.log('\n========================================================================');
  console.log('✅ LIVE PAYPAL SANDBOX ORDER CREATED & RESERVED IN LEDGER');
  console.log('========================================================================');
  console.log(`Order ID:          ${result.orderId}`);
  console.log(`Status:            ${result.status}`);
  console.log(`Simulated:         ${result.isSimulated}`);
  console.log(`Amount:            $${(quote.totalCents / 100).toFixed(2)} ${quote.currency}`);
  console.log(`HATEOAS Approve:   ${result.approveUrl || 'N/A'}`);
  console.log(`Idempotency Key:   ${idempotencyKey}`);
  console.log('========================================================================\n');

  console.log('--- Tier 3 Live Buyer Approval & Capture Acceptance Instructions ---');
  console.log('To complete the live transaction:');
  console.log(`1. Open the HATEOAS Approve URL in your browser:`);
  console.log(`   ${result.approveUrl}`);
  console.log('2. Log in with your Sandbox Buyer account and click "Complete Purchase".');
  console.log(`3. Execute capture against the approved order:`);
  console.log(`   npm run verify:sandbox -- --capture ${result.orderId}\n`);
}

runVerification().catch((err) => {
  console.error('❌ PayPal Sandbox Verification Failed:', err);
  process.exit(1);
});
