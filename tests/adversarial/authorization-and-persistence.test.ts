import { describe, it, expect, beforeEach } from 'vitest';
import { POST as approveRoute } from '@/app/api/procurement/approve/route';
import { POST as webhookRoute } from '@/app/api/paypal/webhook/route';
import { POST as createOrderRoute } from '@/app/api/paypal/create-order/route';
import { LedgerEngine } from '@/lib/ledger';
import { computeQuoteChecksum } from '@/lib/quote-engine';
import { computeApprovalSignature } from '@/lib/approval-engine';
import { Quote, ProcurementRequest, PaymentAttempt, Approval } from '@/lib/types';
import { persistRequestToSupabase } from '@/lib/supabase';
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

  beforeEach(() => {
    LedgerEngine.reset();
    LedgerEngine.saveRequest(mockRequest);
    LedgerEngine.saveQuote(validQuote);
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

      LedgerEngine.saveRequest(selfReq);
      LedgerEngine.saveQuote(selfQuote);

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

      LedgerEngine.saveQuote(bigQuote);

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
      LedgerEngine.saveQuote(tamperedQuote);

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
      LedgerEngine.saveApproval(forgedApproval);

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
      LedgerEngine.saveApproval(approval);

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
      LedgerEngine.savePaymentAttempt(payment);

      // Webhook payload claims payment succeeded but with only $1.00 (100 cents)
      const webhookPayload = {
        id: 'WH-EVT-UNDERPAY-1',
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: {
          id: 'CAP-EVT-UNDERPAY-1',
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
  });

  describe('Supabase Error Surfacing', () => {
    it('surfaces database errors when Supabase is configured and a write fails', async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fake-supabase-project.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';

      // Attempting persist with invalid mock connection will fail network / throw
      await expect(persistRequestToSupabase(mockRequest)).rejects.toThrow();
    });
  });
});
