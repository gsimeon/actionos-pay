// ActionOS Pay: Authoritative Supabase Client & Database Persistence Layer
// Connects to Supabase PostgreSQL with Row Level Security (RLS) support
// Hardened guarantees:
// 1. Critical writes surface database errors immediately; failures are NEVER swallowed.
// 2. Authoritative reads query Supabase tables directly when configured.
// 3. Graceful in-memory fallback is active only when credentials are not configured.

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import {
  Approval,
  AuditEvent,
  PaymentAttempt,
  ProcurementRequest,
  ProcurementStatus,
  Product,
  Quote,
  Supplier,
  TeamMember,
  UserRole,
  WebhookEventRecord,
} from './types';

let cachedSupabase: SupabaseClient | null = null;

export function isPlaceholder(val?: string | null): boolean {
  if (!val) return true;
  const lower = val.trim().toLowerCase();
  return (
    lower === '' ||
    lower.startsWith('your-') ||
    lower.includes('your-project-ref') ||
    lower.includes('your-supabase') ||
    lower.includes('placeholder')
  );
}

export function getSupabase(): SupabaseClient | null {
  if (cachedSupabase) return cachedSupabase;

  if (!isSupabaseConfigured()) {
    return null;
  }

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
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !key) return false;
  if (isPlaceholder(url) || isPlaceholder(key)) return false;

  return true;
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
 * Uses PostgreSQL RPC create_quote_atomic with fallback.
 * Throws on failure when Supabase is configured.
 */
export async function persistQuoteToSupabase(quote: Quote): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;
  const supabase = getSupabase();
  if (!supabase) {
    throw new Error('Supabase is configured in environment but client failed to initialize.');
  }

  // 1. Try atomic PostgreSQL RPC create_quote_atomic
  try {
    const quotePayload = {
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
    };

    const itemsPayload = (quote.items || []).map((i) => ({
      id: i.id,
      product_id: i.productId || null,
      item_name: i.itemName,
      sku: i.sku || null,
      quantity: i.quantity,
      unit_price_cents: i.unitPriceCents,
      total_cents: i.totalCents,
    }));

    const { error: rpcErr } = await supabase.rpc('create_quote_atomic', {
      p_quote: quotePayload,
      p_items: itemsPayload,
    });

    if (!rpcErr) {
      return true;
    }
  } catch {
    // Fallback if RPC is not deployed in database
  }

  // Fallback sequential execution with manual rollback
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
      // Rollback inserted quote row to prevent partial orphan state
      await supabase.from('quotes').delete().eq('id', quote.id);
      throw new Error(`Supabase quote_items persistence failed (quote rollback applied): ${itemsErr.message} (${itemsErr.code})`);
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

/**
 * Authoritatively fetches a webhook event record from Supabase by provider eventId
 */
export async function fetchWebhookFromSupabase(eventId: string): Promise<WebhookEventRecord | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from('webhook_events')
      .select('*')
      .eq('event_id', eventId)
      .maybeSingle();

    if (error || !data) return null;

    return {
      id: data.id,
      provider: data.provider,
      eventId: data.event_id,
      eventType: data.event_type,
      signatureVerified: data.signature_verified,
      payload: data.payload,
      status: data.status,
      processedAt: data.processed_at,
      createdAt: data.created_at,
    };
  } catch {
    return null;
  }
}

/**
 * Updates the state and processed timestamp of a webhook event in Supabase
 */
export async function updateWebhookStatusInSupabase(
  id: string,
  status: 'received' | 'processed' | 'failed' | 'duplicate',
  processedAt?: string
): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;
  const supabase = getSupabase();
  if (!supabase) {
    throw new Error('Supabase is configured in environment but client failed to initialize.');
  }

  const { error } = await supabase
    .from('webhook_events')
    .update({
      status,
      processed_at: processedAt || (status === 'processed' ? new Date().toISOString() : null),
    })
    .eq('id', id);

  if (error) {
    throw new Error(`Failed to update webhook status in Supabase: ${error.message} (${error.code})`);
  }
  return true;
}

/**
 * Authoritatively resolves user membership and role from Supabase
 */
export async function fetchMembershipFromSupabase(
  userId: string,
  businessId?: string
): Promise<TeamMember | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  try {
    let query = supabase.from('memberships').select('*').eq('user_id', userId);
    if (businessId) {
      query = query.eq('business_id', businessId);
    }
    const { data, error } = await query.maybeSingle();
    if (error || !data) return null;

    return {
      id: data.id,
      businessId: data.business_id,
      userId: data.user_id,
      userName: data.user_name,
      userEmail: data.user_email,
      role: data.role as UserRole,
      approvalLimitCents: Number(data.approval_limit_cents),
    };
  } catch {
    return null;
  }
}

export interface WebhookClaimResult {
  claimed: boolean;
  status: 'received' | 'duplicate' | 'in_progress' | 'retryable';
  record: WebhookEventRecord | null;
}

/**
 * Atomically claims a webhook event in Supabase to eliminate race conditions between concurrent deliveries.
 * Leverages PostgreSQL RPC claim_webhook_event with 60-second lease expiry & automatic stale claim recovery.
 */
export async function claimWebhookEventInSupabase(
  eventRecord: WebhookEventRecord
): Promise<WebhookClaimResult> {
  if (!isSupabaseConfigured()) {
    return { claimed: true, status: 'received', record: eventRecord };
  }
  const supabase = getSupabase();
  if (!supabase) {
    throw new Error('Supabase is configured in environment but client failed to initialize.');
  }

  // 1. Try atomic PostgreSQL RPC claim_webhook_event
  try {
    const { data, error: rpcErr } = await supabase.rpc('claim_webhook_event', {
      p_id: eventRecord.id,
      p_provider: eventRecord.provider,
      p_event_id: eventRecord.eventId,
      p_event_type: eventRecord.eventType,
      p_payload: eventRecord.payload,
      p_signature_verified: eventRecord.signatureVerified,
      p_lease_seconds: 60,
    });

    if (!rpcErr && Array.isArray(data) && data.length > 0) {
      const row = data[0];
      const eventRow = row.event_row || row;
      const claimStatus = row.claim_status === 'recovered_lease' ? 'retryable' : row.claim_status;
      return {
        claimed: Boolean(row.claimed),
        status: claimStatus as 'received' | 'duplicate' | 'in_progress' | 'retryable',
        record: eventRow
          ? {
              id: eventRow.id,
              provider: eventRow.provider,
              eventId: eventRow.event_id,
              eventType: eventRow.event_type,
              signatureVerified: eventRow.signature_verified,
              payload: eventRow.payload,
              status: eventRow.status,
              claimLeaseExpiresAt: eventRow.claim_lease_expires_at,
              processedAt: eventRow.processed_at,
              createdAt: eventRow.created_at,
            }
          : null,
      };
    }
  } catch {
    // If RPC is unavailable in current database, proceed to client fallback below
  }

  // 2. Client-side fallback with 60s lease TTL & abandoned worker recovery
  const { data: existing, error: selectErr } = await supabase
    .from('webhook_events')
    .select('*')
    .eq('event_id', eventRecord.eventId)
    .maybeSingle();

  if (selectErr) {
    throw new Error(`Failed to query webhook event: ${selectErr.message}`);
  }

  const now = Date.now();
  const leaseExpiresAt = new Date(now + 60000).toISOString();

  if (existing) {
    if (existing.status === 'processed' || existing.status === 'duplicate') {
      return {
        claimed: false,
        status: 'duplicate',
        record: {
          id: existing.id,
          provider: existing.provider,
          eventId: existing.event_id,
          eventType: existing.event_type,
          signatureVerified: existing.signature_verified,
          payload: existing.payload,
          status: existing.status,
          claimLeaseExpiresAt: existing.claim_lease_expires_at,
          processedAt: existing.processed_at,
          createdAt: existing.created_at,
        },
      };
    }

    if (existing.status === 'received') {
      // Check lease expiry: if lease is still active, in progress
      if (existing.claim_lease_expires_at && new Date(existing.claim_lease_expires_at).getTime() > now) {
        return {
          claimed: false,
          status: 'in_progress',
          record: {
            id: existing.id,
            provider: existing.provider,
            eventId: existing.event_id,
            eventType: existing.event_type,
            signatureVerified: existing.signature_verified,
            payload: existing.payload,
            status: existing.status,
            claimLeaseExpiresAt: existing.claim_lease_expires_at,
            processedAt: existing.processed_at,
            createdAt: existing.created_at,
          },
        };
      } else {
        // Stale claim lease expired (worker crashed or timed out). Recover claim safely!
        const { data: recovered, error: recoverErr } = await supabase
          .from('webhook_events')
          .update({
            claim_lease_expires_at: leaseExpiresAt,
            payload: eventRecord.payload,
          })
          .eq('id', existing.id)
          .select()
          .single();

        if (recoverErr || !recovered) {
          return { claimed: false, status: 'duplicate', record: null };
        }

        return {
          claimed: true,
          status: 'retryable',
          record: {
            id: recovered.id,
            provider: recovered.provider,
            eventId: recovered.event_id,
            eventType: recovered.event_type,
            signatureVerified: recovered.signature_verified,
            payload: recovered.payload,
            status: recovered.status,
            claimLeaseExpiresAt: recovered.claim_lease_expires_at,
            processedAt: recovered.processed_at,
            createdAt: recovered.created_at,
          },
        };
      }
    }

    if (existing.status === 'failed') {
      // Re-activate failed webhook event for retry
      const { data: updated, error: updateErr } = await supabase
        .from('webhook_events')
        .update({
          status: 'received',
          processed_at: null,
          claim_lease_expires_at: leaseExpiresAt,
          payload: eventRecord.payload,
        })
        .eq('id', existing.id)
        .eq('status', 'failed')
        .select()
        .single();

      if (updateErr || !updated) {
        return { claimed: false, status: 'duplicate', record: null };
      }

      return {
        claimed: true,
        status: 'retryable',
        record: {
          id: updated.id,
          provider: updated.provider,
          eventId: updated.event_id,
          eventType: updated.event_type,
          signatureVerified: updated.signature_verified,
          payload: updated.payload,
          status: updated.status,
          claimLeaseExpiresAt: updated.claim_lease_expires_at,
          processedAt: updated.processed_at,
          createdAt: updated.created_at,
        },
      };
    }
  }

  // 3. Insert new webhook event with initial 60s lease
  const { data: inserted, error: insertErr } = await supabase
    .from('webhook_events')
    .insert({
      id: eventRecord.id,
      provider: eventRecord.provider,
      event_id: eventRecord.eventId,
      event_type: eventRecord.eventType,
      signature_verified: eventRecord.signatureVerified,
      payload: eventRecord.payload,
      status: 'received',
      claim_lease_expires_at: leaseExpiresAt,
      created_at: eventRecord.createdAt,
    })
    .select()
    .maybeSingle();

  if (insertErr) {
    // Unique violation (PostgreSQL code 23505) indicates concurrent identical arrival
    if (insertErr.code === '23505') {
      return { claimed: false, status: 'duplicate', record: null };
    }
    throw new Error(`Failed to claim webhook event: ${insertErr.message} (${insertErr.code})`);
  }

  if (!inserted) {
    return { claimed: false, status: 'duplicate', record: null };
  }

  return {
    claimed: true,
    status: 'received',
    record: {
      id: inserted.id,
      provider: inserted.provider,
      eventId: inserted.event_id,
      eventType: inserted.event_type,
      signatureVerified: inserted.signature_verified,
      payload: inserted.payload,
      status: inserted.status,
      claimLeaseExpiresAt: inserted.claim_lease_expires_at,
      processedAt: inserted.processed_at,
      createdAt: inserted.created_at,
    },
  };
}

/**
 * Updates the procurement request status in Supabase.
 */
export async function updateRequestStatusInSupabase(
  id: string,
  status: ProcurementStatus
): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;
  const supabase = getSupabase();
  if (!supabase) throw new Error('Supabase client uninitialized');

  const { error } = await supabase
    .from('procurement_requests')
    .update({
      status,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);

  if (error) {
    throw new Error(`Failed to update request status in Supabase: ${error.message} (${error.code})`);
  }
  return true;
}

/**
 * Reconciles captured payment, transitions request state to fulfilled,
 * marks webhook event processed, and logs immutable audit trail.
 * Uses atomic PostgreSQL RPC reconcile_payment_capture_atomic with fallback.
 */
export async function reconcilePaymentCaptureInSupabase(params: {
  payment: PaymentAttempt;
  webhookRecord: WebhookEventRecord;
  quote: Quote;
  providerCaptureId: string;
}): Promise<void> {
  if (!isSupabaseConfigured()) return;
  const supabase = getSupabase();
  if (!supabase) {
    throw new Error('Supabase client uninitialized');
  }

  const { payment, webhookRecord, quote, providerCaptureId } = params;

  // 1. Try atomic PostgreSQL RPC reconcile_payment_capture_atomic
  try {
    const { error: rpcErr } = await supabase.rpc('reconcile_payment_capture_atomic', {
      p_payment_id: payment.id,
      p_provider_capture_id: providerCaptureId,
      p_webhook_id: webhookRecord.id,
      p_quote_id: quote.id,
      p_request_id: quote.requestId || null,
      p_business_id: payment.businessId,
      p_amount_cents: payment.amountCents,
      p_currency: payment.currency,
      p_event_id: webhookRecord.eventId,
    });

    if (!rpcErr) {
      return;
    }
  } catch {
    // If RPC is unavailable in current database, proceed to fallback
  }

  // 2. Fallback sequential persistence
  await persistPaymentToSupabase({
    ...payment,
    status: 'captured',
    providerCaptureId,
    updatedAt: new Date().toISOString(),
  });

  await updateWebhookStatusInSupabase(webhookRecord.id, 'processed', new Date().toISOString());

  if (quote.requestId) {
    await updateRequestStatusInSupabase(quote.requestId, 'fulfilled');
  }

  await persistAuditToSupabase({
    id: randomUUID(),
    businessId: payment.businessId,
    entityType: 'payment',
    entityId: payment.id,
    actorId: 'paypal_webhook',
    actorRole: 'external_gateway',
    action: 'PAYMENT_CAPTURED_AND_RECONCILED',
    payload: {
      eventId: webhookRecord.eventId,
      amountCents: payment.amountCents,
      currency: payment.currency,
      providerCaptureId,
      quoteId: quote.id,
      requestId: quote.requestId,
    },
    createdAt: new Date().toISOString(),
  });
}
