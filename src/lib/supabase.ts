// ActionOS Pay: Supabase Client & Database Persistence Layer
// Connects to Supabase PostgreSQL with Row Level Security (RLS) support
// Falls back gracefully to memory store if credentials are not configured.

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  Approval,
  AuditEvent,
  PaymentAttempt,
  ProcurementRequest,
  Product,
  Quote,
  Supplier,
  WebhookEventRecord,
} from './types';

let cachedSupabase: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (cachedSupabase) return cachedSupabase;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !key) {
    return null;
  }

  try {
    cachedSupabase = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
    return cachedSupabase;
  } catch (err) {
    console.warn('Failed to initialize Supabase client:', err);
    return null;
  }
}

export const isSupabaseConfigured = (): boolean => {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      (process.env.SUPABASE_SERVICE_ROLE_KEY ||
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
        process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)
  );
};

/**
 * Persists an immutable audit event to Supabase
 */
export async function persistAuditToSupabase(event: AuditEvent): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;

  try {
    const { error } = await supabase.from('audit_events').insert({
      id: event.id,
      business_id: event.businessId,
      entity_type: event.entityType,
      entity_id: event.entityId,
      actor_id: event.actorId,
      actor_role: event.actorRole,
      action: event.action,
      payload: event.payload,
      created_at: event.createdAt,
    });

    if (error) {
      console.warn('Supabase persistAudit error:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Failed to persist audit event to Supabase:', err);
    return false;
  }
}

/**
 * Persists a procurement request to Supabase
 */
export async function persistRequestToSupabase(req: ProcurementRequest): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;

  try {
    const { error } = await supabase.from('procurement_requests').upsert({
      id: req.id,
      business_id: req.businessId,
      requester_id: req.requesterId,
      requester_name: req.requesterName,
      raw_prompt: req.rawPrompt,
      structured_plan: req.structuredPlan,
      status: req.status,
      budget_limit_cents: req.budgetLimitCents,
      currency: req.currency,
      clarification_questions: req.clarificationQuestions || null,
      created_at: req.createdAt,
      updated_at: req.updatedAt,
    });

    if (error) {
      console.warn('Supabase persistRequest error:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Failed to persist request to Supabase:', err);
    return false;
  }
}

/**
 * Persists a quote and its items to Supabase
 */
export async function persistQuoteToSupabase(quote: Quote): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;

  try {
    const { error: quoteErr } = await supabase.from('quotes').upsert({
      id: quote.id,
      request_id: quote.requestId,
      business_id: quote.businessId,
      supplier_id: quote.supplierId,
      supplier_name: quote.supplierName,
      version: quote.version,
      subtotal_cents: quote.subtotalCents,
      tax_cents: quote.taxCents,
      shipping_cents: quote.shippingCents,
      total_cents: quote.totalCents,
      currency: quote.currency,
      checksum_hash: quote.checksumHash,
      status: quote.status,
      expires_at: quote.expiresAt,
      created_at: quote.createdAt,
    });

    if (quoteErr) {
      console.warn('Supabase persistQuote error:', quoteErr.message);
      return false;
    }

    if (quote.items && quote.items.length > 0) {
      const itemsPayload = quote.items.map((i) => ({
        id: i.id,
        quote_id: quote.id,
        product_id: i.productId || null,
        item_name: i.itemName,
        sku: i.sku || null,
        quantity: i.quantity,
        unit_price_cents: i.unitPriceCents,
        total_cents: i.totalCents,
      }));

      const { error: itemsErr } = await supabase.from('quote_items').upsert(itemsPayload);
      if (itemsErr) {
        console.warn('Supabase persistQuoteItems error:', itemsErr.message);
      }
    }

    return true;
  } catch (err) {
    console.warn('Failed to persist quote to Supabase:', err);
    return false;
  }
}

/**
 * Persists an approval record to Supabase
 */
export async function persistApprovalToSupabase(approval: Approval): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;

  try {
    const { error } = await supabase.from('approvals').insert({
      id: approval.id,
      quote_id: approval.quoteId,
      business_id: approval.businessId,
      approver_id: approval.approverId,
      approver_name: approval.approverName,
      approver_role: approval.approverRole,
      quote_version: approval.quoteVersion,
      approved_total_cents: approval.approvedTotalCents,
      approved_currency: approval.approvedCurrency,
      approved_supplier_id: approval.approvedSupplierId,
      decision: approval.decision,
      reason: approval.reason || null,
      digital_signature: approval.digitalSignature,
      created_at: approval.createdAt,
    });

    if (error) {
      console.warn('Supabase persistApproval error:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Failed to persist approval to Supabase:', err);
    return false;
  }
}

/**
 * Persists a payment attempt to Supabase
 */
export async function persistPaymentToSupabase(payment: PaymentAttempt): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;

  try {
    const { error } = await supabase.from('payment_attempts').upsert({
      id: payment.id,
      quote_id: payment.quoteId,
      business_id: payment.businessId,
      provider: payment.provider,
      provider_order_id: payment.providerOrderId || null,
      provider_capture_id: payment.providerCaptureId || null,
      amount_cents: payment.amountCents,
      currency: payment.currency,
      status: payment.status,
      idempotency_key: payment.idempotencyKey,
      provider_response: payment.providerResponse || null,
      error_message: payment.errorMessage || null,
      created_at: payment.createdAt,
      updated_at: payment.updatedAt,
    });

    if (error) {
      console.warn('Supabase persistPayment error:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Failed to persist payment to Supabase:', err);
    return false;
  }
}

/**
 * Persists a webhook event to Supabase
 */
export async function persistWebhookToSupabase(webhook: WebhookEventRecord): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;

  try {
    const { error } = await supabase.from('webhook_events').upsert({
      id: webhook.id,
      provider: webhook.provider,
      event_id: webhook.eventId,
      event_type: webhook.eventType,
      signature_verified: webhook.signatureVerified,
      payload: webhook.payload,
      status: webhook.status,
      processed_at: webhook.processedAt || null,
      created_at: webhook.createdAt,
    });

    if (error) {
      console.warn('Supabase persistWebhook error:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Failed to persist webhook to Supabase:', err);
    return false;
  }
}

/**
 * Fetches recent audit events from Supabase for a tenant
 */
export async function fetchAuditEventsFromSupabase(businessId: string): Promise<AuditEvent[] | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from('audit_events')
      .select('*')
      .eq('business_id', businessId)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error || !data) {
      console.warn('Supabase fetchAuditEvents error:', error?.message);
      return null;
    }

    return data.map((d) => ({
      id: d.id,
      businessId: d.business_id,
      entityType: d.entity_type,
      entityId: d.entity_id,
      actorId: d.actor_id,
      actorRole: d.actor_role,
      action: d.action,
      payload: d.payload,
      createdAt: d.created_at,
    }));
  } catch (err) {
    console.warn('Failed to fetch audit events from Supabase:', err);
    return null;
  }
}

/**
 * Fetches catalogue suppliers from Supabase
 */
export async function fetchSuppliersFromSupabase(businessId: string): Promise<Supplier[] | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from('suppliers')
      .select('*')
      .eq('business_id', businessId);

    if (error || !data) return null;

    return data.map((s) => ({
      id: s.id,
      businessId: s.business_id,
      name: s.name,
      code: s.code,
      isApproved: s.is_approved,
      riskRating: s.risk_rating,
      country: s.country,
      contactEmail: s.contact_email,
    }));
  } catch (err) {
    return null;
  }
}

/**
 * Fetches catalogue products from Supabase
 */
export async function fetchProductsFromSupabase(businessId: string): Promise<Product[] | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('business_id', businessId);

    if (error || !data) return null;

    return data.map((p) => ({
      id: p.id,
      businessId: p.business_id,
      supplierId: p.supplier_id,
      sku: p.sku,
      name: p.name,
      description: p.description,
      category: p.category,
      unitPriceCents: Number(p.unit_price_cents),
      currency: p.currency,
      inStock: p.in_stock,
    }));
  } catch (err) {
    return null;
  }
}
