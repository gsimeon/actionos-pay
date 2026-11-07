import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID, randomBytes } from 'crypto';
import {
  getPayPalCredentials,
  getAccessToken,
  createPayPalOrder,
  capturePayPalOrder,
  verifyWebhookSignature,
} from '@/lib/paypal-service';
import { computeApprovalSignature } from '@/lib/approval-engine';
import { computeQuoteChecksum } from '@/lib/quote-engine';
import { DEMO_BUSINESS, DEMO_MEMBERS, DEMO_SUPPLIERS } from '@/lib/catalog';
import { Quote, Approval } from '@/lib/types';
import fs from 'fs';
import path from 'path';

// Load .env.local if present in development environment
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

describe('PayPal Sandbox Live External Acceptance Suite', () => {
  const creds = getPayPalCredentials();
  const hasLiveSandbox = Boolean(
    creds &&
      creds.clientId &&
      creds.clientSecret &&
      !creds.clientId.startsWith('your-') &&
      !creds.clientSecret.startsWith('your-')
  );

  const testQuoteId = randomUUID();
  const testRequestId = randomUUID();
  const testItems = [
    {
      id: randomUUID(),
      quoteId: testQuoteId,
      itemName: 'Test Enterprise Peripherals Bundle',
      sku: 'SKU-TEST-PERIPHERAL-1',
      quantity: 1,
      unitPriceCents: 10000,
      totalCents: 10000,
    },
  ];

  const calculatedChecksum = computeQuoteChecksum({
    requestId: testRequestId,
    version: 1,
    supplierId: DEMO_SUPPLIERS[0].id,
    totalCents: 11500,
    currency: 'USD',
    items: testItems,
  });

  const testQuote: Quote = {
    id: testQuoteId,
    requestId: testRequestId,
    businessId: DEMO_BUSINESS.id,
    supplierId: DEMO_SUPPLIERS[0].id,
    supplierName: DEMO_SUPPLIERS[0].name,
    version: 1,
    subtotalCents: 10000, // $100.00
    taxCents: 1000,       // $10.00
    shippingCents: 500,   // $5.00
    totalCents: 11500,    // $115.00
    currency: 'USD',
    checksumHash: calculatedChecksum,
    items: testItems,
    status: 'active',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    createdAt: new Date().toISOString(),
  };

  if (!process.env.APPROVAL_SIGNING_SECRET) {
    process.env.APPROVAL_SIGNING_SECRET = randomBytes(32).toString('hex');
  }

  const validSignature = computeApprovalSignature({
    quoteId: testQuote.id,
    quoteVersion: testQuote.version,
    quoteChecksum: testQuote.checksumHash,
    totalCents: testQuote.totalCents,
    currency: testQuote.currency,
    supplierId: testQuote.supplierId,
    approverId: DEMO_MEMBERS[1].userId,
    decision: 'approved',
  });

  const testApproval: Approval = {
    id: randomUUID(),
    quoteId: testQuote.id,
    businessId: DEMO_BUSINESS.id,
    approverId: DEMO_MEMBERS[1].userId,
    approverName: DEMO_MEMBERS[1].userName,
    approverRole: DEMO_MEMBERS[1].role,
    quoteVersion: testQuote.version,
    approvedTotalCents: testQuote.totalCents,
    approvedCurrency: testQuote.currency,
    approvedSupplierId: testQuote.supplierId,
    decision: 'approved',
    reason: 'Live Sandbox Acceptance Test Approval',
    digitalSignature: validSignature,
    createdAt: new Date().toISOString(),
  };

  it('verifies approval cryptographic binding before initiating payment', async () => {
    // Forged approval with mismatched total must fail immediately before any API call
    const forgedApproval: Approval = {
      ...testApproval,
      approvedTotalCents: 99999,
    };

    await expect(
      createPayPalOrder({
        quote: testQuote,
        approval: forgedApproval,
      })
    ).rejects.toThrow(/Approval is invalid or does not bind to this quote/);
  });

  if (hasLiveSandbox && creds) {
    it('authenticates against live PayPal Sandbox OAuth2 endpoint', async () => {
      const token = await getAccessToken(creds);
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(20);
    });

    it('creates an actual live PayPal Sandbox Order (Orders v2 API)', async () => {
      const idempotencyKey = randomUUID();
      const orderResult = await createPayPalOrder({
        quote: testQuote,
        approval: testApproval,
        idempotencyKey,
      });

      expect(orderResult.isSimulated).toBe(false);
      expect(orderResult.orderId).toBeDefined();
      expect(typeof orderResult.orderId).toBe('string');
      expect(orderResult.status).toBe('CREATED');
      expect(orderResult.approveUrl).toBeDefined();
      expect(orderResult.approveUrl).toContain('sandbox.paypal.com');

      // Assert payment attempt record
      expect(orderResult.paymentAttempt.providerOrderId).toBe(orderResult.orderId);
      expect(orderResult.paymentAttempt.amountCents).toBe(11500);
      expect(orderResult.paymentAttempt.currency).toBe('USD');
      expect(orderResult.paymentAttempt.status).toBe('created');
    });

    it('enforces idempotency on duplicate order creation with matching PayPal-Request-Id', async () => {
      const idempotencyKey = randomUUID();

      const order1 = await createPayPalOrder({
        quote: testQuote,
        approval: testApproval,
        idempotencyKey,
      });

      const order2 = await createPayPalOrder({
        quote: testQuote,
        approval: testApproval,
        idempotencyKey,
      });

      expect(order1.orderId).toBe(order2.orderId);
    });

    it('demonstrates live unapproved capture failure handling (ORDER_NOT_APPROVED) with guidance', async () => {
      // Create a fresh live order that has not yet been approved by buyer in sandbox UI
      const orderResult = await createPayPalOrder({
        quote: testQuote,
        approval: testApproval,
        idempotencyKey: randomUUID(),
      });

      // Attempting to capture an order that is not yet buyer-approved returns FAILED with ORDER_NOT_APPROVED
      const captureResult = await capturePayPalOrder({
        orderId: orderResult.orderId,
        paymentAttempt: orderResult.paymentAttempt,
      });

      expect(captureResult.status).toBe('FAILED');
      expect(captureResult.isSimulated).toBe(false);
      expect(captureResult.errorMessage).toContain('ORDER_NOT_APPROVED');
    });

    it('verifies live webhook signature validation engine rejects spoofed headers', async () => {
      process.env.PAYPAL_WEBHOOK_ID = 'WH-SANDBOX-TEST-ID';
      const fakeHeaders = {
        'paypal-auth-algo': 'SHA256withRSA',
        // Missing required cert-url and transmission-sig
        'paypal-transmission-id': 'test-trans-id-1',
      };

      const result = await verifyWebhookSignature({
        headers: fakeHeaders,
        body: JSON.stringify({ id: 'EVT-TEST', event_type: 'PAYMENT.CAPTURE.COMPLETED' }),
      });

      expect(result.verified).toBe(false);
      expect(result.reason).toContain('Missing required PayPal signature verification headers');
    });
  } else {
    const isStrictSandboxRun =
      process.env.npm_lifecycle_event === 'test:sandbox' ||
      process.env.STRICT_SANDBOX === 'true';

    if (isStrictSandboxRun) {
      it('strictly requires live PayPal Sandbox credentials when executed in sandbox mode', () => {
        throw new Error(
          'Live PayPal Sandbox Acceptance Failed: PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required. Simulated fallback is strictly prohibited in live sandbox acceptance mode.'
        );
      });
    } else {
      it('isolates simulated contract test when credentials are not configured in general CI test run', async () => {
        process.env.PAYPAL_ALLOW_SIMULATION = 'true';
        const orderResult = await createPayPalOrder({
          quote: testQuote,
          approval: testApproval,
        });

        expect(orderResult.isSimulated).toBe(true);
        expect(orderResult.orderId).toMatch(/^SIM-/);
        expect(orderResult.status).toBe('CREATED');
      });
    }
  }
});
