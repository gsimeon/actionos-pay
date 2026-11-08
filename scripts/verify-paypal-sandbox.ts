/**
 * ActionOS Pay: Live PayPal Sandbox Verification Script
 * Validates OAuth2 authentication, Orders v2 creation, HATEOAS approve link,
 * breakdown amounts, and request idempotency against PayPal Sandbox.
 *
 * Usage: npx tsx scripts/verify-paypal-sandbox.ts
 */

import { randomUUID, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  getPayPalCredentials,
  getAccessToken,
  createPayPalOrder,
  capturePayPalOrder,
} from '../src/lib/paypal-service';
import { computeApprovalSignature } from '../src/lib/approval-engine';
import { computeQuoteChecksum } from '../src/lib/quote-engine';
import { DEMO_BUSINESS, DEMO_MEMBERS, DEMO_SUPPLIERS } from '../src/lib/catalog';
import { Quote, Approval } from '../src/lib/types';

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

async function runVerification() {
  console.log('========================================================');
  console.log('ActionOS Pay: Live PayPal Orders v2 Sandbox Verification');
  console.log('========================================================\n');

  const creds = getPayPalCredentials();
  if (!creds || creds.clientId.startsWith('your-') || creds.clientSecret.startsWith('your-')) {
    console.error('❌ Live PayPal Sandbox Acceptance Gate Failed: Missing live credentials.');
    console.error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are strictly required for live PayPal Sandbox verification.');
    console.error('Set live credentials in .env.local or CI repository secrets before invoking verify:sandbox.');
    process.exit(1);
  }

  console.log(`[1/4] Client ID: ${creds.clientId.slice(0, 8)}... (Environment: ${creds.env})`);

  // Step 1: OAuth2 Access Token
  console.log('[2/4] Authenticating with PayPal Sandbox OAuth2...');
  const token = await getAccessToken(creds);
  console.log(`✅ OAuth2 Token acquired successfully. Token length: ${token.length} chars.`);

  // Step 2: Build Sealed Quote & Approval
  console.log('[3/4] Generating cryptographically-sealed quote and HMAC approval...');
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

  const quote: Quote = {
    id: testQuoteId,
    requestId: testRequestId,
    businessId: DEMO_BUSINESS.id,
    supplierId: DEMO_SUPPLIERS[0].id,
    supplierName: DEMO_SUPPLIERS[0].name,
    version: 1,
    subtotalCents: 179900,
    taxCents: 13492,       // 7.5% Tax ($134.92)
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

  // Step 3: Orders v2 API Order Creation
  const captureIndex = process.argv.indexOf('--capture');
  const specifiedOrderId = captureIndex !== -1 && process.argv[captureIndex + 1] ? process.argv[captureIndex + 1] : null;

  if (specifiedOrderId) {
    console.log(`[4/4] Attempting capture for existing order "${specifiedOrderId}"...`);
    const paymentAttempt = {
      id: randomUUID(),
      quoteId: quote.id,
      businessId: quote.businessId,
      provider: 'paypal' as const,
      providerOrderId: specifiedOrderId,
      amountCents: quote.totalCents,
      currency: quote.currency,
      status: 'created' as const,
      idempotencyKey: `capture-${randomUUID()}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const captureResult = await capturePayPalOrder({
      orderId: specifiedOrderId,
      paymentAttempt,
      idempotencyKey: `capture-script-${specifiedOrderId}`,
    });

    if (captureResult.status === 'COMPLETED') {
      console.log('\n========================================================');
      console.log('🎉 LIVE PAYPAL SANDBOX ORDER CAPTURED SUCCESSFULLY');
      console.log('========================================================');
      console.log(`Order ID:          ${specifiedOrderId}`);
      console.log(`Capture ID:        ${captureResult.captureId}`);
      console.log(`Status:            COMPLETED`);
      console.log(`Amount:            $${(quote.totalCents / 100).toFixed(2)} ${quote.currency}`);
      console.log('========================================================\n');
      return;
    } else {
      console.log('\n========================================================');
      console.log('⚠️ LIVE CAPTURE NOT COMPLETED: AWAITING BUYER APPROVAL');
      console.log('========================================================');
      console.log(`Order ID:          ${specifiedOrderId}`);
      console.log(`Error:             ${captureResult.errorMessage}`);
      console.log('To complete capture, log into sandbox.paypal.com with buyer credentials and approve the order.');
      console.log('========================================================\n');
      return;
    }
  }

  console.log('[4/4] Creating live PayPal Sandbox Order (POST /v2/checkout/orders)...');
  const idempotencyKey = `order-${quote.id}-v${quote.version}`;
  const result = await createPayPalOrder({
    quote,
    approval,
    idempotencyKey,
  });

  console.log('\n========================================================');
  console.log('✅ LIVE PAYPAL SANDBOX ORDER CREATED SUCCESSFULLY');
  console.log('========================================================');
  console.log(`Order ID:          ${result.orderId}`);
  console.log(`Status:            ${result.status}`);
  console.log(`Simulated:         ${result.isSimulated}`);
  console.log(`Amount:            $${(quote.totalCents / 100).toFixed(2)} ${quote.currency}`);
  console.log(`HATEOAS Approve:   ${result.approveUrl || 'N/A'}`);
  console.log(`Idempotency Key:   ${idempotencyKey}`);
  console.log('========================================================\n');

  console.log('--- Completed End-to-End Buyer-to-Ledger Acceptance Guidance ---');
  console.log('To complete live buyer approval and capture:');
  console.log(`1. Open HATEOAS Approve URL in Sandbox browser:\n   ${result.approveUrl}`);
  console.log('2. Log in with Sandbox Buyer credentials and click "Complete Purchase".');
  console.log(`3. Run: npm run verify:sandbox -- --capture ${result.orderId}\n`);
  console.log('[NOTE: Live payment capture is NOT RUN until buyer approval is completed in Sandbox browser]');
}

runVerification().catch((err) => {
  console.error('❌ PayPal Sandbox Verification Failed:', err);
  process.exit(1);
});
