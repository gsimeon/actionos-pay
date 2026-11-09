// ActionOS Pay: PayPal Orders v2 Sandbox Integration & Hardened Verification Engine
// Invariants:
// 1. Order amounts are generated strictly from the approved quote record (never client-supplied).
// 2. Orders cannot be created without a valid, cryptographically-bound approval.
// 3. If real PayPal credentials exist, failures must NEVER fall through to simulated success.
// 4. Captures use server-generated idempotency keys to prevent duplicate billing.
// 5. Webhook events are cryptographically verified and deduplicated.

import { randomUUID } from 'crypto';
import { verifyApprovalBinding } from './approval-engine';
import { centsToDecimalString } from './currency';
import { Approval, PaymentAttempt, Quote } from './types';

export interface PayPalCredentials {
  clientId: string;
  clientSecret: string;
  env: 'sandbox' | 'live';
}

export function isPlaceholder(val?: string | null): boolean {
  if (!val) return true;
  const lower = val.trim().toLowerCase();
  return (
    lower === '' ||
    lower.startsWith('your-') ||
    lower.includes('your-paypal') ||
    lower.includes('placeholder')
  );
}

export function validatePayPalEnv(rawEnv?: string | null): 'sandbox' | 'live' {
  if (!rawEnv) return 'sandbox';
  const normalized = rawEnv.trim().toLowerCase();
  if (normalized === 'sandbox' || normalized === 'live') {
    return normalized;
  }
  throw new Error(
    `Invalid PAYPAL_ENV configuration: "${rawEnv}". Allowed values are strictly "sandbox" or "live".`
  );
}

export function getPayPalCredentials(): PayPalCredentials | null {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  if (isPlaceholder(clientId) || isPlaceholder(clientSecret)) return null;

  const env = validatePayPalEnv(process.env.PAYPAL_ENV);
  return {
    clientId,
    clientSecret,
    env,
  };
}

export function isSimulationAllowed(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  const creds = getPayPalCredentials();
  if (creds) return false; // When real credentials exist, simulation is strictly disallowed
  return (
    process.env.APP_MODE === 'demo' ||
    process.env.NODE_ENV === 'test' ||
    process.env.PAYPAL_ALLOW_SIMULATION === 'true'
  );
}

function getBaseUrl(creds: PayPalCredentials): string {
  return creds.env === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

/**
 * Retrieves PayPal OAuth2 Access Token using client credentials
 */
export async function getAccessToken(creds: PayPalCredentials): Promise<string> {
  const auth = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
  const res = await fetch(`${getBaseUrl(creds)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`PayPal auth failed (HTTP ${res.status}): ${errorText}`);
  }

  const data = await res.json();
  return data.access_token;
}

export interface CreateOrderResult {
  orderId: string;
  status: string;
  paymentAttempt: PaymentAttempt;
  approveUrl?: string;
  isSimulated: boolean;
}

/**
 * Creates a PayPal Order strictly from the approved quote record.
 * Refuses execution if approval is invalid or modified.
 * Never silently simulates if real credentials are configured.
 */
export async function createPayPalOrder(params: {
  quote: Quote;
  approval: Approval;
  idempotencyKey?: string;
}): Promise<CreateOrderResult> {
  const { quote, approval, idempotencyKey = `order-${params.quote.id}-v${params.quote.version}` } = params;

  // 1. Mandatory Security Invariant: Verify Approval Binding
  const bindingCheck = verifyApprovalBinding(approval, quote);
  if (!bindingCheck.valid) {
    throw new Error(
      `Cannot create PayPal order: Approval is invalid or does not bind to this quote. Reasons: ${bindingCheck.reasons.join('; ')}`
    );
  }

  const creds = getPayPalCredentials();
  const valueDecimal = centsToDecimalString(quote.totalCents);
  const subtotalDecimal = centsToDecimalString(quote.subtotalCents);
  const taxDecimal = centsToDecimalString(quote.taxCents);
  const shippingDecimal = centsToDecimalString(quote.shippingCents);

  // 2. Real PayPal API Flow (when credentials are provided)
  if (creds) {
    const token = await getAccessToken(creds);
    const payload = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: quote.id,
          custom_id: `v${quote.version}::${approval.id}`,
          description: `ActionOS Pay: ${quote.supplierName} (Quote v${quote.version})`,
          amount: {
            currency_code: quote.currency,
            value: valueDecimal,
            breakdown: {
              item_total: {
                currency_code: quote.currency,
                value: subtotalDecimal,
              },
              tax_total: {
                currency_code: quote.currency,
                value: taxDecimal,
              },
              shipping: {
                currency_code: quote.currency,
                value: shippingDecimal,
              },
            },
          },
          items: quote.items.map((i) => ({
            name: i.itemName,
            unit_amount: {
              currency_code: quote.currency,
              value: centsToDecimalString(i.unitPriceCents),
            },
            quantity: i.quantity.toString(),
            sku: i.sku || undefined,
          })),
        },
      ],
      application_context: {
        brand_name: 'ActionOS Pay',
        landing_page: 'NO_PREFERENCE',
        user_action: 'PAY_NOW',
      },
    };

    const res = await fetch(`${getBaseUrl(creds)}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': idempotencyKey,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errorText = await res.text();
      // Crucial: Throw real error immediately. NEVER fall back to simulated success!
      throw new Error(`PayPal order creation failed (HTTP ${res.status}): ${errorText}`);
    }

    const orderData = await res.json();
    const approveLink = orderData.links?.find((l: { rel: string; href: string }) => l.rel === 'approve')?.href;

    const paymentAttempt: PaymentAttempt = {
      id: randomUUID(),
      quoteId: quote.id,
      businessId: quote.businessId,
      provider: 'paypal',
      providerOrderId: orderData.id,
      amountCents: quote.totalCents,
      currency: quote.currency,
      status: 'created',
      idempotencyKey,
      providerResponse: orderData,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    return {
      orderId: orderData.id,
      status: orderData.status,
      paymentAttempt,
      approveUrl: approveLink,
      isSimulated: false,
    };
  }

  // 3. Isolated Demo/Test Simulation (only when credentials are not configured)
  if (!isSimulationAllowed()) {
    throw new Error('PayPal credentials missing and simulation mode is disabled.');
  }

  const simulatedOrderId = `SIM-DEMO-ORD-${randomUUID().slice(0, 8).toUpperCase()}`;
  const paymentAttempt: PaymentAttempt = {
    id: randomUUID(),
    quoteId: quote.id,
    businessId: quote.businessId,
    provider: 'paypal',
    providerOrderId: simulatedOrderId,
    amountCents: quote.totalCents,
    currency: quote.currency,
    status: 'created',
    idempotencyKey,
    providerResponse: {
      id: simulatedOrderId,
      status: 'CREATED',
      intent: 'CAPTURE',
      gross_amount: { currency_code: quote.currency, value: valueDecimal },
      is_simulated: true,
      mode: 'DEMO_SANDBOX_SIMULATION',
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  return {
    orderId: simulatedOrderId,
    status: 'CREATED',
    paymentAttempt,
    approveUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${simulatedOrderId}`,
    isSimulated: true,
  };
}

export interface CaptureOrderResult {
  captureId: string;
  status: 'COMPLETED' | 'FAILED' | 'PENDING';
  paymentAttempt: PaymentAttempt;
  isSimulated: boolean;
  errorMessage?: string;
}

/**
 * Captures an approved PayPal order server-side with idempotency.
 * Never silently turns real capture failures into simulated success.
 */
export async function capturePayPalOrder(params: {
  orderId: string;
  paymentAttempt: PaymentAttempt;
  idempotencyKey?: string;
}): Promise<CaptureOrderResult> {
  const {
    orderId,
    paymentAttempt,
    idempotencyKey = `capture-${params.paymentAttempt.id}-${params.orderId}`,
  } = params;

  // Check state machine: already captured
  if (paymentAttempt.status === 'captured') {
    return {
      captureId: paymentAttempt.providerCaptureId || 'ALREADY_CAPTURED',
      status: 'COMPLETED',
      paymentAttempt,
      isSimulated: Boolean(paymentAttempt.providerResponse?.is_simulated),
    };
  }

  const creds = getPayPalCredentials();
  const isSimulatedOrder =
    orderId.startsWith('SIM-DEMO-ORD-') ||
    orderId.startsWith('ORDER-SANDBOX-') ||
    Boolean(paymentAttempt.providerResponse?.is_simulated);

  // Security Invariants for Simulated Payments:
  // 1. In production, simulated orders can NEVER be captured under any circumstances.
  if (process.env.NODE_ENV === 'production' && isSimulatedOrder) {
    throw new Error('Production Security Invariant: Simulated payment orders cannot be captured in production.');
  }

  // 2. When real PayPal credentials exist, simulated captures are strictly prohibited.
  if (creds && isSimulatedOrder) {
    throw new Error('Security Invariant: Simulated orders cannot be captured when real PayPal credentials are configured.');
  }

  // 3. Simulated capture requires explicit simulation permission.
  if (isSimulatedOrder && !isSimulationAllowed()) {
    throw new Error('Simulation Invariant: Simulated payment capture is prohibited when simulation mode is disabled.');
  }

  // 1. Real PayPal API Capture
  if (creds && !isSimulatedOrder) {
    try {
      const token = await getAccessToken(creds);
      const res = await fetch(`${getBaseUrl(creds)}/v2/checkout/orders/${orderId}/capture`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'PayPal-Request-Id': idempotencyKey,
        },
      });

      if (!res.ok) {
        const errorText = await res.text();
        const failedAttempt: PaymentAttempt = {
          ...paymentAttempt,
          status: 'failed',
          errorMessage: `PayPal capture failed (HTTP ${res.status}): ${errorText}`,
          updatedAt: new Date().toISOString(),
        };

        // Explicitly fail: DO NOT simulate success!
        return {
          captureId: '',
          status: 'FAILED',
          paymentAttempt: failedAttempt,
          isSimulated: false,
          errorMessage: failedAttempt.errorMessage,
        };
      }

      const captureData = await res.json();
      const captureObj = captureData.purchase_units?.[0]?.payments?.captures?.[0];
      const captureId = captureObj?.id || `CAP-${randomUUID().slice(0, 8)}`;
      const isCompleted = captureObj?.status === 'COMPLETED';

      const updatedAttempt: PaymentAttempt = {
        ...paymentAttempt,
        providerCaptureId: captureId,
        status: isCompleted ? 'captured' : 'reconciling',
        providerResponse: captureData,
        updatedAt: new Date().toISOString(),
      };

      return {
        captureId,
        status: isCompleted ? 'COMPLETED' : 'PENDING',
        paymentAttempt: updatedAttempt,
        isSimulated: false,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const failedAttempt: PaymentAttempt = {
        ...paymentAttempt,
        status: 'failed',
        errorMessage: message,
        updatedAt: new Date().toISOString(),
      };
      return {
        captureId: '',
        status: 'FAILED',
        paymentAttempt: failedAttempt,
        isSimulated: false,
        errorMessage: message,
      };
    }
  }

  // 2. Simulated Capture (for local demos/tests without PayPal credentials)
  if (!isSimulationAllowed()) {
    throw new Error('PayPal credentials missing and simulation mode is disabled.');
  }

  const simulatedCaptureId = `SIM-DEMO-CAP-${randomUUID().slice(0, 8).toUpperCase()}`;
  const updatedAttempt: PaymentAttempt = {
    ...paymentAttempt,
    providerCaptureId: simulatedCaptureId,
    status: 'captured',
    providerResponse: {
      ...(paymentAttempt.providerResponse || {}),
      capture_id: simulatedCaptureId,
      status: 'COMPLETED',
      captured_at: new Date().toISOString(),
      is_simulated: true,
      mode: 'DEMO_SANDBOX_SIMULATION',
    },
    updatedAt: new Date().toISOString(),
  };

  return {
    captureId: simulatedCaptureId,
    status: 'COMPLETED',
    paymentAttempt: updatedAttempt,
    isSimulated: true,
  };
}

/**
 * Validates a PayPal webhook event signature strictly.
 * Security Invariants:
 * 1. Live or production environments strictly prohibit mock signatures and simulation.
 * 2. In any non-demo deployment, real PayPal credentials and PAYPAL_WEBHOOK_ID are mandatory.
 *    Missing configuration FAILS CLOSED immediately.
 * 3. Mock signatures are permitted ONLY when APP_MODE=demo AND NODE_ENV !== 'production' AND PAYPAL_ENV !== 'live'.
 */
export async function verifyWebhookSignature(params: {
  headers: Record<string, string>;
  body: string;
}): Promise<{ verified: boolean; reason?: string }> {
  const creds = getPayPalCredentials();
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  const isProduction = process.env.NODE_ENV === 'production';
  const isLiveEnv = creds?.env === 'live' || process.env.PAYPAL_ENV === 'live' || process.env.PAYPAL_ENV === 'production';
  const isDemoExplicitlyAllowed = process.env.APP_MODE === 'demo';

  const hasRealWebhookId = Boolean(webhookId && !isPlaceholder(webhookId));

  // 1. Mandatory Security Gate: If real credentials exist, PAYPAL_WEBHOOK_ID is mandatory.
  // Mock verification is strictly PROHIBITED whenever real PayPal credentials are present.
  if (creds && !hasRealWebhookId) {
    return {
      verified: false,
      reason:
        'Security Fail-Closed: Real PayPal credentials (PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET) are configured but PAYPAL_WEBHOOK_ID is missing or placeholder. Mock verification is prohibited when PayPal credentials are configured.',
    };
  }

  // 2. Mandatory Security Gate: Live, production, or non-demo mode require real credentials & webhook ID
  if (isProduction || isLiveEnv || !isDemoExplicitlyAllowed) {
    if (!creds || !hasRealWebhookId) {
      return {
        verified: false,
        reason:
          'Security Fail-Closed: Real PayPal credentials (PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET) and PAYPAL_WEBHOOK_ID are mandatory for webhook verification. Live production or non-demo environment strictly prohibits mock signature verification.',
      };
    }
  }

  // 3. Real cryptographic verification via PayPal API (when real credentials and webhook ID are present)
  if (creds && hasRealWebhookId) {
    const requiredHeaders = [
      'paypal-auth-algo',
      'paypal-cert-url',
      'paypal-transmission-id',
      'paypal-transmission-sig',
      'paypal-transmission-time',
    ];
    const missing = requiredHeaders.filter((h) => !params.headers[h]);
    if (missing.length > 0) {
      return {
        verified: false,
        reason: `Missing required PayPal signature verification headers: ${missing.join(', ')}`,
      };
    }

    try {
      const token = await getAccessToken(creds);
      const verifyPayload = {
        auth_algo: params.headers['paypal-auth-algo'],
        cert_url: params.headers['paypal-cert-url'],
        transmission_id: params.headers['paypal-transmission-id'],
        transmission_sig: params.headers['paypal-transmission-sig'],
        transmission_time: params.headers['paypal-transmission-time'],
        webhook_id: webhookId,
        webhook_event: JSON.parse(params.body),
      };

      const res = await fetch(`${getBaseUrl(creds)}/v1/notifications/verify-webhook-signature`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(verifyPayload),
      });

      if (!res.ok) {
        return { verified: false, reason: `PayPal verification service returned HTTP ${res.status}` };
      }

      const data = await res.json();
      return {
        verified: data.verification_status === 'SUCCESS',
        reason: data.verification_status,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { verified: false, reason: `PayPal verification service unavailable: ${message}` };
    }
  }

  // 4. Demo Mock Verification Gate:
  // Strictly permitted ONLY when:
  // - NO real PayPal credentials exist (!creds)
  // - APP_MODE === 'demo'
  // - NODE_ENV !== 'production'
  // - creds?.env !== 'live'
  if (creds || !isDemoExplicitlyAllowed || isProduction || isLiveEnv) {
    return {
      verified: false,
      reason: 'Live production, non-demo, or credential-configured environment strictly prohibits mock signature verification.',
    };
  }

  // Demo mode: check signature token
  const sig =
    params.headers['paypal-transmission-sig'] ||
    params.headers['x-mock-sandbox-signature'];

  if (sig && sig.length >= 8 && !sig.toLowerCase().includes('invalid')) {
    return { verified: true, reason: 'Sandbox demo test signature verified' };
  }

  return {
    verified: false,
    reason: 'Signature header missing or rejected by verification policy.',
  };
}
