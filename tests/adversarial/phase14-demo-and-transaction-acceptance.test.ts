import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { capturePayPalOrder } from '@/lib/paypal-service';
import { getApprovalSigningSecret, PUBLIC_DEMO_SIGNING_SECRET } from '@/lib/approval-engine';
import { parseProcurementIntent } from '@/lib/ai-planner';
import { PaymentAttempt } from '@/lib/types';

describe('Phase 14: Final Demo & Transaction Acceptance Invariants', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
    process.env.APP_MODE = 'demo';
    process.env.APPROVAL_SIGNING_SECRET = 'a-secure-custom-test-signing-secret-that-is-32-chars-long';
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('Defense-in-Depth: Security Checks Precede Replay in capturePayPalOrder', () => {
    it('throws in production when capturing simulated order even if status is already "captured"', async () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = 'production';

      const alreadyCapturedAttempt: PaymentAttempt = {
        id: randomUUID(),
        quoteId: randomUUID(),
        businessId: 'biz-1',
        provider: 'paypal',
        providerOrderId: 'SIM-DEMO-ORD-ALREADY-CAPTURED',
        providerCaptureId: 'SIM-DEMO-CAP-OLD',
        amountCents: 50000,
        currency: 'USD',
        status: 'captured',
        idempotencyKey: 'idem-captured-prod',
        providerResponse: { is_simulated: true },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await expect(
        capturePayPalOrder({
          orderId: 'SIM-DEMO-ORD-ALREADY-CAPTURED',
          paymentAttempt: alreadyCapturedAttempt,
        })
      ).rejects.toThrow('Production Security Invariant: Simulated payment orders cannot be captured in production.');
    });

    it('throws with real credentials when capturing simulated order even if status is already "captured"', async () => {
      process.env.PAYPAL_CLIENT_ID = 'live-client-id-xyz';
      process.env.PAYPAL_CLIENT_SECRET = 'live-client-secret-xyz';
      process.env.PAYPAL_ENV = 'sandbox';

      const alreadyCapturedAttempt: PaymentAttempt = {
        id: randomUUID(),
        quoteId: randomUUID(),
        businessId: 'biz-1',
        provider: 'paypal',
        providerOrderId: 'SIM-DEMO-ORD-ALREADY-CAPTURED-2',
        providerCaptureId: 'SIM-DEMO-CAP-OLD-2',
        amountCents: 50000,
        currency: 'USD',
        status: 'captured',
        idempotencyKey: 'idem-captured-creds',
        providerResponse: { is_simulated: true },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await expect(
        capturePayPalOrder({
          orderId: 'SIM-DEMO-ORD-ALREADY-CAPTURED-2',
          paymentAttempt: alreadyCapturedAttempt,
        })
      ).rejects.toThrow('Security Invariant: Simulated orders cannot be captured when real PayPal credentials are configured.');
    });
  });

  describe('Configuration Hardening: Public Demo Signing Secret Lockdown', () => {
    it('permits public demo key in local offline demo mode', () => {
      process.env.APPROVAL_SIGNING_SECRET = PUBLIC_DEMO_SIGNING_SECRET;
      (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;

      const secret = getApprovalSigningSecret();
      expect(secret).toBe(PUBLIC_DEMO_SIGNING_SECRET);
    });

    it('rejects public demo key in production mode with fail-closed error', () => {
      process.env.APPROVAL_SIGNING_SECRET = PUBLIC_DEMO_SIGNING_SECRET;
      (process.env as Record<string, string | undefined>).NODE_ENV = 'production';

      expect(() => getApprovalSigningSecret()).toThrow(
        'Security Invariant: The public demo signing secret from .env.example is permitted ONLY in local zero-config demo mode'
      );
    });

    it('rejects public demo key when live Supabase is configured', () => {
      process.env.APPROVAL_SIGNING_SECRET = PUBLIC_DEMO_SIGNING_SECRET;
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://prod-company.supabase.co';

      expect(() => getApprovalSigningSecret()).toThrow(
        'Security Invariant: The public demo signing secret from .env.example is permitted ONLY in local zero-config demo mode'
      );
    });
  });

  describe('AI Planner: Source Attribution and Model Configuration', () => {
    it('returns plannerSource="deterministic" when AI_API_KEY is not configured', async () => {
      delete process.env.AI_API_KEY;
      delete process.env.GEMINI_API_KEY;

      const plan = await parseProcurementIntent('Order 2 Dell XPS 15 laptops from AfriTech');
      expect(plan.plannerSource).toBe('deterministic');
      expect(plan.plannerModel).toBe('deterministic-catalogue-parser');
      expect(plan.items.length).toBeGreaterThanOrEqual(1);
    });
  });
});

