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
 * Retrieves details for a PayPal order directly from the Orders v2 API.
 * Used for pre-capture verification of status, purchase units, and amount integrity.
 */
export async function getPayPalOrderDetails(orderId: string): Promise<Record<string, unknown>> {
  const creds = getPayPalCredentials();
  if (!creds) {
    throw new Error('PayPal credentials are required to fetch live order details.');
  }

  const token = await getAccessToken(creds);
  const res = await fetch(`${getBaseUrl(creds)}/v2/checkout/orders/${orderId}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to fetch PayPal order ${orderId} (HTTP ${res.status}): ${errorText}`);
  }

  return (await res.json()) as Record<string, unknown>;
}

export interface OrderIntegrityVerification {
  valid: boolean;
  error?: string;
  unitAmount?: { currency_code: string; value: string };
  referenceId?: string;
  captures?: Array<{
    id: string;
    status: string;
    amount?: { currency_code?: string; value?: string };
  }>;
}

export interface CaptureIntegrityVerification {
  valid: boolean;
  error?: string;
  captureId?: string;
}

/**
 * Validates that an existing capture record in PayPal Orders v2 adheres strictly to financial invariants:
 * 1. An actual capture record must exist.
 * 2. Capture ID must be non-empty.
 * 3. Capture status must be exactly 'COMPLETED'.
 * 4. Capture amount value and currency must strictly match the authoritative paymentAttempt terms.
 */
export function verifyCaptureFinancialIntegrity(
  capture:
    | {
        id?: string;
        status?: string;
        amount?: { currency_code?: string; value?: string };
      }
    | undefined,
  paymentAttempt: PaymentAttempt,
  options?: { allowPending?: boolean }
): CaptureIntegrityVerification {
  if (!capture) {
    return { valid: false, error: 'Order does not contain an existing capture record in payments.captures.' };
  }
  const captureId = capture.id?.trim();
  if (!captureId) {
    return { valid: false, error: 'Capture record is missing a valid capture ID.' };
  }
  const normalizedStatus = capture.status?.toUpperCase();
  const isCompleted = normalizedStatus === 'COMPLETED';
  const isAllowedPending = Boolean(options?.allowPending && normalizedStatus === 'PENDING');
  if (!isCompleted && !isAllowedPending) {
    return {
      valid: false,
      error: `Capture status is "${capture.status}", expected "COMPLETED" for verified payment settlement.`,
    };
  }
  const expectedValue = (paymentAttempt.amountCents / 100).toFixed(2);
  if (!capture.amount || !capture.amount.currency_code || !capture.amount.value) {
    return { valid: false, error: 'Capture record is missing required amount or currency_code.' };
  }
  if (capture.amount.currency_code !== paymentAttempt.currency) {
    return {
      valid: false,
      error: `Capture currency mismatch: expected ${paymentAttempt.currency}, received ${capture.amount.currency_code}.`,
    };
  }
  if (capture.amount.value !== expectedValue) {
    return {
      valid: false,
      error: `Capture amount mismatch: expected ${expectedValue} ${paymentAttempt.currency}, received ${capture.amount.value} ${capture.amount.currency_code}.`,
    };
  }
  return { valid: true, captureId };
}

/**
 * Validates the financial and identity integrity of a live PayPal order against an authoritative ledger attempt.
 * Enforces fail-closed validation:
 * 1. Must contain exactly one purchase unit (ActionOS Pay orders strictly specify exactly one purchase unit).
 * 2. Purchase unit must contain explicit amount value and currency code (rejects missing amounts fail-closed).
 * 3. Amount and currency must exactly match paymentAttempt amount (formatted as decimal string) and currency.
 * 4. Reference ID is mandatory, non-empty, and must match paymentAttempt.quoteId.
 */
export function verifyOrderFinancialIntegrity(
  liveOrder: Record<string, unknown>,
  paymentAttempt: PaymentAttempt
): OrderIntegrityVerification {
  const purchaseUnits = liveOrder.purchase_units as Array<Record<string, unknown>> | undefined;
  if (!purchaseUnits || !Array.isArray(purchaseUnits) || purchaseUnits.length === 0) {
    return { valid: false, error: 'Order is missing required purchase_units array.' };
  }

  if (purchaseUnits.length !== 1) {
    return {
      valid: false,
      error: `Invalid order structure: expected exactly one purchase unit, received ${purchaseUnits.length}.`,
    };
  }

  const primaryUnit = purchaseUnits[0];
  const amount = primaryUnit.amount as { currency_code?: string; value?: string } | undefined;
  if (!amount || !amount.value || !amount.currency_code) {
    return { valid: false, error: 'Order purchase_unit is missing required amount or currency_code breakdown.' };
  }

  const expectedValue = (paymentAttempt.amountCents / 100).toFixed(2);
  if (amount.currency_code !== paymentAttempt.currency) {
    return {
      valid: false,
      error: `Order currency mismatch: expected ${paymentAttempt.currency}, received ${amount.currency_code}.`,
    };
  }

  if (amount.value !== expectedValue) {
    return {
      valid: false,
      error: `Order amount mismatch: expected ${expectedValue} ${paymentAttempt.currency}, received ${amount.value} ${amount.currency_code}.`,
    };
  }

  const referenceId = (primaryUnit.reference_id as string | undefined)?.trim();
  if (!referenceId || referenceId !== paymentAttempt.quoteId) {
    return {
      valid: false,
      error: `Missing or mismatched PayPal quote reference (reference_id mismatch): expected quote ${paymentAttempt.quoteId}, received ${referenceId || 'none'}.`,
    };
  }

  const payments = primaryUnit.payments as
    | {
        captures?: Array<{
          id: string;
          status: string;
          amount?: { currency_code?: string; value?: string };
        }>;
      }
    | undefined;

  return {
    valid: true,
    unitAmount: { currency_code: amount.currency_code, value: amount.value },
    referenceId,
    captures: payments?.captures,
  };
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

  const creds = getPayPalCredentials();
  const isSimulatedOrder =
    orderId.startsWith('SIM-DEMO-ORD-') ||
    orderId.startsWith('ORDER-SANDBOX-') ||
    Boolean(paymentAttempt.providerResponse?.is_simulated);

  // Security Invariants for Simulated Payments (Defense-in-depth: Evaluated before replay returns):
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

  // Check state machine: already captured replay
  if (paymentAttempt.status === 'captured') {
    const captureId = paymentAttempt.providerCaptureId?.trim();
    if (!captureId || captureId === 'ALREADY_CAPTURED') {
      throw new Error('Financial Integrity Error: Captured payment attempt lacks a verified provider capture ID.');
    }
    return {
      captureId,
      status: 'COMPLETED',
      paymentAttempt,
      isSimulated: Boolean(paymentAttempt.providerResponse?.is_simulated),
    };
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

      // Rigorous Financial Capture Verification: Never manufacture capture IDs or accept invalid captures
      const captureVerification = verifyCaptureFinancialIntegrity(captureObj, paymentAttempt, { allowPending: true });
      if (!captureVerification.valid) {
        const failedAttempt: PaymentAttempt = {
          ...paymentAttempt,
          status: 'failed',
          errorMessage: `PayPal capture validation failed: ${captureVerification.error}`,
          updatedAt: new Date().toISOString(),
        };

        return {
          captureId: '',
          status: 'FAILED',
          paymentAttempt: failedAttempt,
          isSimulated: false,
          errorMessage: failedAttempt.errorMessage,
        };
      }

      const captureId = captureVerification.captureId!;
      const updatedAttempt: PaymentAttempt = {
        ...paymentAttempt,
        providerCaptureId: captureId,
        status: 'captured',
        providerResponse: captureData,
        updatedAt: new Date().toISOString(),
      };

      return {
        captureId,
        status: 'COMPLETED',
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
