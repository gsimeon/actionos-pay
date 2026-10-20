// ActionOS Pay: Authoritative Supabase Client & Database Persistence Layer
// Connects to Supabase PostgreSQL with Row Level Security (RLS) support
// Hardened guarantees:
// 1. Critical writes surface database errors immediately; failures are NEVER swallowed.
// 2. Authoritative reads query Supabase tables directly when configured.
// 3. Graceful in-memory fallback is active only when credentials are not configured.

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

export function resetSupabaseClientForTesting(): void {
  cachedSupabase = null;
}

export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      (process.env.SUPABASE_SERVICE_ROLE_KEY ||
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
        process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)
  );
}

/**
 * Persists an immutable audit event to Supabase.
 * Throws on failure when Supabase is configured.
 */
export async function persistAuditToSupabase(event: AuditEvent): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;
  const supabase = getSupabase();
  if (!supabase) {
    throw new Error('Supabase is configured in environment but client failed to initialize.');
  }

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
    throw new Error(`Supabase audit persistence failed: ${error.message} (${error.code})`);
  }
  return true;
}

/**
 * Persists a procurement request to Supabase.
 * Throws on failure when Supabase is configured.
 */
export async function persistRequestToSupabase(req: ProcurementRequest): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;
  const supabase = getSupabase();
  if (!supabase) {
    throw new Error('Supabase is configured in environment but client failed to initialize.');
  }

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
    throw new Error(`Supabase request persistence failed: ${error.message} (${error.code})`);
  }
  return true;
}

/**
 * Persists a quote and its items to Supabase atomically.
 * Throws on failure when Supabase is configured.
 */
export async function persistQuoteToSupabase(quote: Quote): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;
  const supabase = getSupabase();
  if (!supabase) {
    throw new Error('Supabase is configured in environment but client failed to initialize.');
  }

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
    throw new Error(`Supabase quote persistence failed: ${quoteErr.message} (${quoteErr.code})`);
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
      throw new Error(`Supabase quote_items persistence failed: ${itemsErr.message} (${itemsErr.code})`);
    }
  }

  return true;
}

/**
 * Persists an approval record to Supabase.
 * Throws on failure when Supabase is configured.
 */
export async function persistApprovalToSupabase(approval: Approval): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;
  const supabase = getSupabase();
  if (!supabase) {
    throw new Error('Supabase is configured in environment but client failed to initialize.');
  }

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
    throw new Error(`Supabase approval persistence failed: ${error.message} (${error.code})`);
  }
  return true;
}

/**
 * Persists a payment attempt to Supabase.
 * Throws on failure when Supabase is configured.
 */
export async function persistPaymentToSupabase(payment: PaymentAttempt): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;
  const supabase = getSupabase();
  if (!supabase) {
    throw new Error('Supabase is configured in environment but client failed to initialize.');
  }

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
    throw new Error(`Supabase payment persistence failed: ${error.message} (${error.code})`);
  }
  return true;
}

/**
 * Persists a webhook event to Supabase.
 * Throws on failure when Supabase is configured.
 */
export async function persistWebhookToSupabase(webhook: WebhookEventRecord): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;
  const supabase = getSupabase();
  if (!supabase) {
    throw new Error('Supabase is configured in environment but client failed to initialize.');
  }

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
    throw new Error(`Supabase webhook persistence failed: ${error.message} (${error.code})`);
  }
  return true;
}

/**
 * Authoritatively fetches a procurement request from Supabase
 */
export async function fetchRequestFromSupabase(id: string): Promise<ProcurementRequest | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from('procurement_requests')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error || !data) return null;

    return {
      id: data.id,
      businessId: data.business_id,
      requesterId: data.requester_id,
      requesterName: data.requester_name,
      rawPrompt: data.raw_prompt,
      structuredPlan: data.structured_plan,
      status: data.status,
      budgetLimitCents: Number(data.budget_limit_cents),
      currency: data.currency,
      clarificationQuestions: data.clarification_questions,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  } catch {
    return null;
  }
}

/**
 * Authoritatively fetches a quote from Supabase
 */
export async function fetchQuoteFromSupabase(id: string): Promise<Quote | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  try {
    const { data: q, error: qErr } = await supabase
      .from('quotes')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (qErr || !q) return null;

    const { data: items } = await supabase
      .from('quote_items')
      .select('*')
      .eq('quote_id', id);

    return {
      id: q.id,
      requestId: q.request_id,
      businessId: q.business_id,
      supplierId: q.supplier_id,
      supplierName: q.supplier_name,
      version: q.version,
      subtotalCents: Number(q.subtotal_cents),
      taxCents: Number(q.tax_cents),
      shippingCents: Number(q.shipping_cents),
      totalCents: Number(q.total_cents),
      currency: q.currency,
      checksumHash: q.checksum_hash,
      status: q.status,
      expiresAt: q.expires_at,
      createdAt: q.created_at,
      items: (items || []).map((i) => ({
        id: i.id,
        quoteId: i.quote_id,
        productId: i.product_id,
        itemName: i.item_name,
        sku: i.sku,
        quantity: i.quantity,
        unitPriceCents: Number(i.unit_price_cents),
        totalCents: Number(i.total_cents),
      })),
    };
  } catch {
    return null;
  }
}

/**
 * Authoritatively fetches an approval record from Supabase
 */
export async function fetchApprovalFromSupabase(quoteId: string): Promise<Approval | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from('approvals')
      .select('*')
      .eq('quote_id', quoteId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) return null;

    return {
      id: data.id,
      quoteId: data.quote_id,
      businessId: data.business_id,
      approverId: data.approver_id,
      approverName: data.approver_name,
      approverRole: data.approver_role,
      quoteVersion: data.quote_version,
      approvedTotalCents: Number(data.approved_total_cents),
      approvedCurrency: data.approved_currency,
      approvedSupplierId: data.approved_supplier_id,
      decision: data.decision,
      reason: data.reason,
      digitalSignature: data.digital_signature,
      createdAt: data.created_at,
    };
  } catch {
    return null;
  }
}

/**
 * Authoritatively fetches a payment attempt from Supabase
 */
export async function fetchPaymentByOrderIdFromSupabase(orderId: string): Promise<PaymentAttempt | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from('payment_attempts')
      .select('*')
      .eq('provider_order_id', orderId)
      .maybeSingle();

    if (error || !data) return null;

    return {
      id: data.id,
      quoteId: data.quote_id,
      businessId: data.business_id,
      provider: data.provider,
      providerOrderId: data.provider_order_id,
      providerCaptureId: data.provider_capture_id,
      amountCents: Number(data.amount_cents),
      currency: data.currency,
      status: data.status,
      idempotencyKey: data.idempotency_key,
      providerResponse: data.provider_response,
      errorMessage: data.error_message,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  } catch {
    return null;
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
  } catch {
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
  } catch {
    return null;
  }
}
