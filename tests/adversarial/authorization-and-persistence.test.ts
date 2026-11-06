import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import { POST as approveRoute } from '@/app/api/procurement/approve/route';
import { POST as webhookRoute } from '@/app/api/paypal/webhook/route';
import { POST as createOrderRoute } from '@/app/api/paypal/create-order/route';
import { LedgerEngine } from '@/lib/ledger';
import { computeQuoteChecksum } from '@/lib/quote-engine';
import {
  computeApprovalSignature,
  getApprovalSigningSecret,
  verifyApprovalBinding,
  safeTimingCompareHex,
} from '@/lib/approval-engine';
import { Quote, ProcurementRequest, PaymentAttempt, Approval } from '@/lib/types';
import { persistRequestToSupabase, resetSupabaseClientForTesting } from '@/lib/supabase';
import { DEMO_MEMBERS } from '@/lib/catalog';

describe('Adversarial Authorization, Webhook Fraud & Persistence Tests', () => {
  const testBusinessId = '00000000-0000-4000-8000-000000000001';
  const requesterMember = DEMO_MEMBERS[0]; // Amina Bello (requester)
  const approverMember = DEMO_MEMBERS[1];  // Chidi Okonkwo (approver, limit: $15,000 / 1,500,000 cents)

  const mockRequest: ProcurementRequest = {
    id: 'req-adv-001',
    businessId: testBusinessId,
    requesterId: requesterMember.userId,
    requesterName: requesterMember.userName,
    rawPrompt: 'Need 2 Dell monitors',
    structuredPlan: {
      items: [{ productName: 'Dell Monitor', quantity: 2, estimatedUnitPriceCents: 50000 }],
      budgetLimitCents: 200000,
      currency: 'USD',
      confidenceScore: 0.95,
      clarificationNeeded: false,
      clarificationQuestions: [],
      summary: '2 Monitors',
    },
    status: 'draft',
    budgetLimitCents: 200000,
    currency: 'USD',
    clarificationQuestions: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const validQuote: Quote = {
    id: 'quote-adv-001',
    requestId: 'req-adv-001',
    businessId: testBusinessId,
    supplierId: '00000000-0000-4000-8000-000000000100',
    supplierName: 'AfriTech Solutions Hub',
    version: 1,
    subtotalCents: 100000,
    taxCents: 8000,
    shippingCents: 1500,
    totalCents: 109500,
    currency: 'USD',
    checksumHash: '',
    status: 'active',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    createdAt: new Date().toISOString(),
    items: [
      {
        id: 'item-1',
        quoteId: 'quote-adv-001',
        itemName: 'Dell Monitor',
        sku: 'DELL-U2723QE',
        quantity: 2,
        unitPriceCents: 50000,
        totalCents: 100000,
      },
    ],
  };
  validQuote.checksumHash = computeQuoteChecksum({
    requestId: validQuote.requestId,
    version: validQuote.version,
    supplierId: validQuote.supplierId,
    totalCents: validQuote.totalCents,
    currency: validQuote.currency,
    items: validQuote.items,
  });

  beforeEach(async () => {
    LedgerEngine.reset();
    await LedgerEngine.saveRequestAsync(mockRequest);
    await LedgerEngine.saveQuoteAsync(validQuote);
  });

  describe('Authorization Boundary & Approver Gate', () => {
    it('rejects anonymous or missing approverUserId with 401', async () => {
      const req = new Request('http://localhost/api/procurement/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteId: validQuote.id,
          decision: 'approved',
        }),
      });

      const res = await approveRoute(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toContain('approverUserId is required');
    });

    it('rejects an unverified or forged approver user ID with 403', async () => {
      const req = new Request('http://localhost/api/procurement/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteId: validQuote.id,
          decision: 'approved',
          approverUserId: 'usr-forged-hacker-99',
        }),
      });

      const res = await approveRoute(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toContain('could not be verified');
    });

    it('rejects a user with requester role attempting to approve with 403', async () => {
      const req = new Request('http://localhost/api/procurement/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteId: validQuote.id,
          decision: 'approved',
          approverUserId: requesterMember.userId, // Amina has role 'requester'
        }),
      });

      const res = await approveRoute(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toContain("holds role \"requester\"");
    });

    it('requires Bearer token when Supabase is configured and rejects missing token with 401', async () => {
      const oldUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      try {
        process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://wycykgykpbtschrydtld.supabase.co';
        process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-supabase-service-role-key-for-auth-testing-32-chars';
        resetSupabaseClientForTesting();

        const req = new Request('http://localhost/api/procurement/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            quoteId: validQuote.id,
            decision: 'approved',
            approverUserId: approverMember.userId,
          }),
        });

        const res = await approveRoute(req);
        expect(res.status).toBe(401);
        const json = await res.json();
        expect(json.error).toContain('Bearer session token is required when Supabase is configured');
      } finally {
        if (oldUrl) process.env.NEXT_PUBLIC_SUPABASE_URL = oldUrl;
        else delete process.env.NEXT_PUBLIC_SUPABASE_URL;
        if (oldKey) process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey;
        else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
        resetSupabaseClientForTesting();
      }
    });

    it('rejects cross-tenant approval with 403 (enforces business boundary without hardcoded bypasses)', async () => {
      const rogueMember = {
        ...approverMember,
        userId: 'usr-cross-tenant-chidi',
        businessId: '00000000-0000-4000-8000-999999999999', // Different business tenant!
      };
      DEMO_MEMBERS.push(rogueMember);
      try {
        const req = new Request('http://localhost/api/procurement/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            quoteId: validQuote.id,
            decision: 'approved',
            approverUserId: rogueMember.userId,
          }),
        });

        const res = await approveRoute(req);
        expect(res.status).toBe(403);
        const json = await res.json();
        expect(json.error).toContain('does not belong to business');
      } finally {
        const idx = DEMO_MEMBERS.findIndex((m) => m.userId === rogueMember.userId);
        if (idx !== -1) DEMO_MEMBERS.splice(idx, 1);
      }
    });

    it('rejects self-approval for purchases over $500 (Segregation of Duties)', async () => {
      // Create request where approver Chidi is also the requester
      const selfReq: ProcurementRequest = {
        ...mockRequest,
        id: 'req-self-appr',
        requesterId: approverMember.userId,
      };
      const selfQuote: Quote = {
        ...validQuote,
        id: 'quote-self-appr',
        requestId: 'req-self-appr',
        totalCents: 85000, // $850.00 > $500 threshold
      };
      selfQuote.checksumHash = computeQuoteChecksum({
        requestId: selfQuote.requestId,
        version: selfQuote.version,
        supplierId: selfQuote.supplierId,
        totalCents: selfQuote.totalCents,
        currency: selfQuote.currency,
        items: selfQuote.items,
      });

      await LedgerEngine.saveRequestAsync(selfReq);
      await LedgerEngine.saveQuoteAsync(selfQuote);

      const req = new Request('http://localhost/api/procurement/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteId: selfQuote.id,
          decision: 'approved',
          approverUserId: approverMember.userId, // Same as requester
        }),
      });

      const res = await approveRoute(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('Self-approval violation');
    });

    it('rejects approval when quote total exceeds approver delegated limit', async () => {
      // Chidi has limit of $15,000 (1,500,000 cents). Create a $20,000 quote.
      const bigQuote: Quote = {
        ...validQuote,
        id: 'quote-big-limit',
        totalCents: 2000000,
      };
      bigQuote.checksumHash = computeQuoteChecksum({
        requestId: bigQuote.requestId,
        version: bigQuote.version,
        supplierId: bigQuote.supplierId,
        totalCents: bigQuote.totalCents,
        currency: bigQuote.currency,
        items: bigQuote.items,
      });

      await LedgerEngine.saveQuoteAsync(bigQuote);

      const req = new Request('http://localhost/api/procurement/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteId: bigQuote.id,
          decision: 'approved',
          approverUserId: approverMember.userId,
        }),
      });

      const res = await approveRoute(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('exceeds approver\'s delegated spending threshold');
    });
  });

  describe('Quote Integrity & Tamper Resistance', () => {
    it('rejects approval if quote checksum does not match contents', async () => {
      const tamperedQuote: Quote = {
        ...validQuote,
        id: 'quote-tampered-1',
        checksumHash: 'tampered-sha256-hash-value',
      };
      await LedgerEngine.saveQuoteAsync(tamperedQuote);

      const req = new Request('http://localhost/api/procurement/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteId: tamperedQuote.id,
          decision: 'approved',
          approverUserId: approverMember.userId,
        }),
      });

      const res = await approveRoute(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('Quote cryptographic checksum failed');
    });

    it('generates HMAC secret-backed signature and rejects forged signatures', () => {
      const validHmacSig = computeApprovalSignature({
        quoteId: validQuote.id,
        quoteVersion: validQuote.version,
        quoteChecksum: validQuote.checksumHash,
        totalCents: validQuote.totalCents,
        currency: validQuote.currency,
        supplierId: validQuote.supplierId,
        approverId: approverMember.userId,
        decision: 'approved',
      });

      // Signature with wrong secret
      const forgedSig = computeApprovalSignature(
        {
          quoteId: validQuote.id,
          quoteVersion: validQuote.version,
          quoteChecksum: validQuote.checksumHash,
          totalCents: validQuote.totalCents,
          currency: validQuote.currency,
          supplierId: validQuote.supplierId,
          approverId: approverMember.userId,
          decision: 'approved',
        },
        'unauthorized-attacker-secret'
      );

      expect(validHmacSig).not.toBe(forgedSig);
      expect(validHmacSig).toHaveLength(64);
    });

    it('throws error when APPROVAL_SIGNING_SECRET is missing or < 32 characters', () => {
      const oldSecret = process.env.APPROVAL_SIGNING_SECRET;
      const oldRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      try {
        delete process.env.APPROVAL_SIGNING_SECRET;
        delete process.env.SUPABASE_SERVICE_ROLE_KEY;
        expect(() => getApprovalSigningSecret()).toThrow('Dedicated APPROVAL_SIGNING_SECRET');

        process.env.APPROVAL_SIGNING_SECRET = 'too-short';
        expect(() => getApprovalSigningSecret()).toThrow('Dedicated APPROVAL_SIGNING_SECRET');
      } finally {
        if (oldSecret) process.env.APPROVAL_SIGNING_SECRET = oldSecret;
        if (oldRoleKey) process.env.SUPABASE_SERVICE_ROLE_KEY = oldRoleKey;
      }
    });

    it('strictly rejects legacy unkeyed SHA-256 signatures in verifyApprovalBinding', () => {
      const payload = [
        validQuote.id,
        validQuote.version,
        validQuote.checksumHash,
        validQuote.totalCents,
        validQuote.currency,
        validQuote.supplierId,
        approverMember.userId,
        'approved',
      ].join('::');
      const legacySha256 = createHash('sha256').update(payload).digest('hex');

      const legacyApproval: Approval = {
        id: 'appr-legacy-sha256',
        quoteId: validQuote.id,
        businessId: validQuote.businessId,
        approverId: approverMember.userId,
        approverName: approverMember.userName,
        approverRole: 'approver',
        quoteVersion: validQuote.version,
        approvedTotalCents: validQuote.totalCents,
        approvedCurrency: validQuote.currency,
        approvedSupplierId: validQuote.supplierId,
        decision: 'approved',
        digitalSignature: legacySha256, // Legacy unkeyed SHA-256
        createdAt: new Date().toISOString(),
      };

      const verification = verifyApprovalBinding(legacyApproval, validQuote);
      expect(verification.valid).toBe(false);
      expect(
        verification.reasons.some((r) => r.includes('Legacy unkeyed SHA-256 signatures are prohibited'))
      ).toBe(true);
    });

    it('uses constant-time comparison for approval signatures', () => {
      expect(safeTimingCompareHex('abcdef012345', 'abcdef012345')).toBe(true);
      expect(safeTimingCompareHex('abcdef012345', 'abcdef012346')).toBe(false);
      expect(safeTimingCompareHex('abcdef012345', 'abcd')).toBe(false);
      expect(safeTimingCompareHex('', '')).toBe(false);
    });

    it('rejects order creation if approval signature does not bind to quote', async () => {
      const forgedApproval: Approval = {
        id: 'appr-forged-1',
        quoteId: validQuote.id,
        businessId: validQuote.businessId,
        approverId: approverMember.userId,
        approverName: approverMember.userName,
        approverRole: 'approver',
        quoteVersion: 1,
        approvedTotalCents: 500, // Forged total!
        approvedCurrency: 'USD',
        approvedSupplierId: validQuote.supplierId,
        decision: 'approved',
        digitalSignature: 'forged-signature',
        createdAt: new Date().toISOString(),
      };
      await LedgerEngine.saveApprovalAsync(forgedApproval);

      const req = new Request('http://localhost/api/paypal/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quoteId: validQuote.id }),
      });

      const res = await createOrderRoute(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('Approval does not bind to current quote terms');
    });
  });

  describe('Webhook Reconciliation & Anti-Fraud', () => {
    it('rejects webhook with tampered amount and marks payment failed', async () => {
      // Add approved quote and approval
      const approval: Approval = {
        id: 'appr-recon-1',
        quoteId: validQuote.id,
        businessId: validQuote.businessId,
        approverId: approverMember.userId,
        approverName: approverMember.userName,
        approverRole: 'approver',
        quoteVersion: validQuote.version,
        approvedTotalCents: validQuote.totalCents,
        approvedCurrency: validQuote.currency,
        approvedSupplierId: validQuote.supplierId,
        decision: 'approved',
        digitalSignature: computeApprovalSignature({
          quoteId: validQuote.id,
          quoteVersion: validQuote.version,
          quoteChecksum: validQuote.checksumHash,
          totalCents: validQuote.totalCents,
          currency: validQuote.currency,
          supplierId: validQuote.supplierId,
          approverId: approverMember.userId,
          decision: 'approved',
        }),
        createdAt: new Date().toISOString(),
      };
      await LedgerEngine.saveApprovalAsync(approval);

      const payment: PaymentAttempt = {
        id: 'pay-webhook-test-1',
        quoteId: validQuote.id,
        businessId: validQuote.businessId,
        provider: 'paypal',
        providerOrderId: 'ORD-PP-RECON-1',
        amountCents: 109500, // Expected $1,095.00
        currency: 'USD',
        status: 'created',
        idempotencyKey: 'idem-recon-1',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await LedgerEngine.savePaymentAttemptAsync(payment);

      // Webhook payload claims payment succeeded but with only $1.00 (100 cents)
      const webhookPayload = {
        id: 'WH-EVT-UNDERPAY-1',
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: {
          id: 'CAP-EVT-UNDERPAY-1',
          status: 'COMPLETED',
          supplementary_data: {
            related_ids: { order_id: 'ORD-PP-RECON-1' },
          },
          amount: {
            value: '1.00', // Fraudulent underpayment!
            currency_code: 'USD',
          },
        },
      };

      const req = new Request('http://localhost/api/paypal/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'paypal-transmission-sig': 'valid-simulation-sig-12345',
        },
        body: JSON.stringify(webhookPayload),
      });

      const res = await webhookRoute(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('Webhook amount reconciliation mismatch');

      // Verify payment was NOT marked captured and instead marked failed
      const updatedPayment = LedgerEngine.getPaymentByOrderId('ORD-PP-RECON-1');
      expect(updatedPayment?.status).toBe('failed');
      expect(updatedPayment?.errorMessage).toContain('Reconciliation mismatch');
    });

    it('deduplicates webhook events idempotently without double-processing', async () => {
      const eventId = 'WH-EVT-IDEMP-001';
      const webhookPayload = {
        id: eventId,
        event_type: 'CHECKOUT.ORDER.COMPLETED',
        resource: { id: 'some-resource-id' },
      };

      // First webhook post
      const req1 = new Request('http://localhost/api/paypal/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'paypal-transmission-sig': 'valid-simulation-sig-12345',
        },
        body: JSON.stringify(webhookPayload),
      });
      const res1 = await webhookRoute(req1);
      expect(res1.status).toBe(200);
      const json1 = await res1.json();
      expect(json1.status).toBe('processed');

      // Duplicate webhook post with same eventId
      const req2 = new Request('http://localhost/api/paypal/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'paypal-transmission-sig': 'valid-simulation-sig-12345',
        },
        body: JSON.stringify(webhookPayload),
      });
      const res2 = await webhookRoute(req2);
      expect(res2.status).toBe(200);
      const json2 = await res2.json();
      expect(json2.status).toBe('duplicate');
      expect(json2.message).toContain('Duplicate webhook event ignored');
    });

    it('rejects capture webhook when amount or currency is missing or invalid', async () => {
      const eventId = 'WH-EVT-MISSING-AMT-1';
      const invalidWebhookPayload = {
        id: eventId,
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: {
          id: 'CAP-MISSING-AMT-1',
          status: 'COMPLETED',
          supplementary_data: {
            related_ids: { order_id: 'ORD-PP-RECON-1' },
          },
          // missing amount object!
        },
      };

      const req = new Request('http://localhost/api/paypal/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'paypal-transmission-sig': 'valid-simulation-sig-12345',
        },
        body: JSON.stringify(invalidWebhookPayload),
      });

      const res = await webhookRoute(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('missing or non-positive capture amount');

      // Verify webhook record was marked 'failed', not 'processed'
      const record = await LedgerEngine.getWebhookEventAsync(eventId);
      expect(record?.status).toBe('failed');
    });

    it('allows retry for previously failed webhook events without treating as duplicate', async () => {
      const eventId = 'WH-EVT-RETRYABLE-1';

      // 1. First attempt fails due to missing amount
      const failedPayload = {
        id: eventId,
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: {
          id: 'CAP-RETRY-1',
          status: 'COMPLETED',
          supplementary_data: { related_ids: { order_id: 'ORD-NON-EXISTENT' } },
          amount: { value: '0', currency_code: 'USD' },
        },
      };

      const req1 = new Request('http://localhost/api/paypal/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'paypal-transmission-sig': 'valid-simulation-sig-12345',
        },
        body: JSON.stringify(failedPayload),
      });
      const res1 = await webhookRoute(req1);
      expect(res1.status).toBe(400);

      // 2. Verified failed status in ledger
      const record = await LedgerEngine.getWebhookEventAsync(eventId);
      expect(record?.status).toBe('failed');

      // 3. Retry with corrected non-capture event can re-process and succeed
      const correctedPayload = {
        id: eventId,
        event_type: 'CHECKOUT.ORDER.COMPLETED',
        resource: { id: 'ORD-CORRECTED-1' },
      };
      const req2 = new Request('http://localhost/api/paypal/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'paypal-transmission-sig': 'valid-simulation-sig-12345',
        },
        body: JSON.stringify(correctedPayload),
      });
      const res2 = await webhookRoute(req2);
      expect(res2.status).toBe(200);
      const json2 = await res2.json();
      expect(json2.status).toBe('processed');
    });

    it('webhook rejects payment capture if approval cryptographic binding fails', async () => {
      const tamperedApproval: Approval = {
        id: 'appr-tampered-binding',
        quoteId: validQuote.id,
        businessId: validQuote.businessId,
        approverId: approverMember.userId,
        approverName: approverMember.userName,
        approverRole: 'approver',
        quoteVersion: validQuote.version,
        approvedTotalCents: validQuote.totalCents,
        approvedCurrency: validQuote.currency,
        approvedSupplierId: validQuote.supplierId,
        decision: 'approved',
        digitalSignature: 'bad-digital-signature-value-invalid-hmac-1234567890',
        createdAt: new Date().toISOString(),
      };
      await LedgerEngine.saveApprovalAsync(tamperedApproval);

      const payment: PaymentAttempt = {
        id: 'pay-webhook-tamper-test',
        quoteId: validQuote.id,
        businessId: validQuote.businessId,
        provider: 'paypal',
        providerOrderId: 'ORD-PP-TAMPER-1',
        amountCents: validQuote.totalCents,
        currency: 'USD',
        status: 'created',
        idempotencyKey: 'idem-tamper-1',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await LedgerEngine.savePaymentAttemptAsync(payment);

      const webhookPayload = {
        id: 'WH-EVT-TAMPER-TEST-1',
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: {
          id: 'CAP-EVT-TAMPER-1',
          status: 'COMPLETED',
          supplementary_data: {
            related_ids: { order_id: 'ORD-PP-TAMPER-1' },
          },
          amount: {
            value: (validQuote.totalCents / 100).toFixed(2),
            currency_code: 'USD',
          },
        },
      };

      const req = new Request('http://localhost/api/paypal/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'paypal-transmission-sig': 'valid-simulation-sig-12345',
        },
        body: JSON.stringify(webhookPayload),
      });

      const res = await webhookRoute(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('Approval cryptographic binding verification failed');

      const updatedPayment = await LedgerEngine.getPaymentByOrderIdAsync('ORD-PP-TAMPER-1');
      expect(updatedPayment?.status).toBe('failed');
      expect(updatedPayment?.errorMessage).toContain('Approval cryptographic binding verification failed');
    });

    it('atomically reconciles captured payment and marks request fulfilled', async () => {
      const validApproval: Approval = {
        id: 'appr-atomic-good',
        quoteId: validQuote.id,
        businessId: validQuote.businessId,
        approverId: approverMember.userId,
        approverName: approverMember.userName,
        approverRole: 'approver',
        quoteVersion: validQuote.version,
        approvedTotalCents: validQuote.totalCents,
        approvedCurrency: validQuote.currency,
        approvedSupplierId: validQuote.supplierId,
        decision: 'approved',
        digitalSignature: computeApprovalSignature({
          quoteId: validQuote.id,
          quoteVersion: validQuote.version,
          quoteChecksum: validQuote.checksumHash,
          totalCents: validQuote.totalCents,
          currency: validQuote.currency,
          supplierId: validQuote.supplierId,
          approverId: approverMember.userId,
          decision: 'approved',
        }),
        createdAt: new Date().toISOString(),
      };
      await LedgerEngine.saveApprovalAsync(validApproval);

      const payment: PaymentAttempt = {
        id: 'pay-atomic-good-1',
        quoteId: validQuote.id,
        businessId: validQuote.businessId,
        provider: 'paypal',
        providerOrderId: 'ORD-PP-ATOMIC-1',
        amountCents: validQuote.totalCents,
        currency: 'USD',
        status: 'created',
        idempotencyKey: 'idem-atomic-1',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await LedgerEngine.savePaymentAttemptAsync(payment);

      const webhookPayload = {
        id: 'WH-EVT-ATOMIC-GOOD-1',
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: {
          id: 'CAP-EVT-ATOMIC-1',
          status: 'COMPLETED',
          supplementary_data: {
            related_ids: { order_id: 'ORD-PP-ATOMIC-1' },
          },
          amount: {
            value: (validQuote.totalCents / 100).toFixed(2),
            currency_code: 'USD',
          },
        },
      };

      const req = new Request('http://localhost/api/paypal/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'paypal-transmission-sig': 'valid-simulation-sig-12345',
        },
        body: JSON.stringify(webhookPayload),
      });

      const res = await webhookRoute(req);
      expect(res.status).toBe(200);

      const updatedPayment = await LedgerEngine.getPaymentByOrderIdAsync('ORD-PP-ATOMIC-1');
      expect(updatedPayment?.status).toBe('captured');
      expect(updatedPayment?.providerCaptureId).toBe('CAP-EVT-ATOMIC-1');

      const updatedReq = await LedgerEngine.getRequestAsync(mockRequest.id);
      expect(updatedReq?.status).toBe('fulfilled');

      const webhookRec = await LedgerEngine.getWebhookEventAsync('WH-EVT-ATOMIC-GOOD-1');
      expect(webhookRec?.status).toBe('processed');
    });
  });

  describe('Supabase Error Surfacing', () => {
    it('surfaces database errors when Supabase is configured and a write fails', async () => {
      const oldUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      try {
        process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fake-supabase-project.supabase.co';
        process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key-that-will-fail-network-call-32chars';
        resetSupabaseClientForTesting();

        // When Supabase is configured, failed initialization or write must throw, never swallow
        await expect(persistRequestToSupabase(mockRequest)).rejects.toThrow();
      } finally {
        if (oldUrl) process.env.NEXT_PUBLIC_SUPABASE_URL = oldUrl;
        else delete process.env.NEXT_PUBLIC_SUPABASE_URL;
        if (oldKey) process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey;
        else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
        resetSupabaseClientForTesting();
      }
    });

    it('rejects synchronous persistence calls when Supabase is configured', () => {
      const oldUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      try {
        process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://wycykgykpbtschrydtld.supabase.co';
        process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key-32-chars-minimum-here';
        expect(() => LedgerEngine.saveRequest(mockRequest)).toThrow(
          'Synchronous saveRequest is prohibited when Supabase is configured'
        );
        expect(() => LedgerEngine.saveQuote(validQuote)).toThrow(
          'Synchronous saveQuote is prohibited when Supabase is configured'
        );
      } finally {
        if (oldUrl) process.env.NEXT_PUBLIC_SUPABASE_URL = oldUrl;
        else delete process.env.NEXT_PUBLIC_SUPABASE_URL;
        if (oldKey) process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey;
        else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
        resetSupabaseClientForTesting();
      }
    });
  });
});
