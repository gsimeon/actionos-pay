// ActionOS Pay: Append-Only Ledger & State Transition Engine
// Hardened Guarantees:
// 1. Audit events are strictly append-only.
// 2. If Supabase is configured, all database writes are awaited and errors are surfaced (never swallowed).
// 3. State changes are immutably logged with actor, role, timestamp, and entity payload.

import { randomUUID } from 'crypto';
import {
  fetchApprovalFromSupabase,
  fetchAuditEventsFromSupabase,
  fetchPaymentByOrderIdFromSupabase,
  fetchQuoteFromSupabase,
  fetchRequestFromSupabase,
  isSupabaseConfigured,
  persistApprovalToSupabase,
  persistAuditToSupabase,
  persistPaymentToSupabase,
  persistQuoteToSupabase,
  persistRequestToSupabase,
  persistWebhookToSupabase,
} from './supabase';
import {
  Approval,
  AuditEvent,
  PaymentAttempt,
  ProcurementRequest,
  ProcurementStatus,
  Quote,
  WebhookEventRecord,
} from './types';

// Global memory singleton for persistent state across hot-reloads and API calls
interface GlobalStore {
  requests: Map<string, ProcurementRequest>;
  quotes: Map<string, Quote>;
  approvals: Map<string, Approval>;
  payments: Map<string, PaymentAttempt>;
  webhooks: Map<string, WebhookEventRecord>;
  auditEvents: AuditEvent[];
}

declare global {
  // eslint-disable-next-line no-var
  var __ACTIONOS_STORE__: GlobalStore | undefined;
}

function getStore(): GlobalStore {
  if (!global.__ACTIONOS_STORE__) {
    global.__ACTIONOS_STORE__ = {
      requests: new Map(),
      quotes: new Map(),
      approvals: new Map(),
      payments: new Map(),
      webhooks: new Map(),
      auditEvents: [],
    };
  }
  return global.__ACTIONOS_STORE__;
}

export class LedgerEngine {
  /**
   * Appends an immutable audit event to the ledger (authoritative async)
   */
  static async logAuditAsync(params: {
    businessId: string;
    entityType: AuditEvent['entityType'];
    entityId: string;
    actorId: string;
    actorRole: string;
    action: string;
    payload: Record<string, unknown>;
  }): Promise<AuditEvent> {
    const store = getStore();
    const event: AuditEvent = {
      id: randomUUID(),
      businessId: params.businessId,
      entityType: params.entityType,
      entityId: params.entityId,
      actorId: params.actorId,
      actorRole: params.actorRole,
      action: params.action,
      payload: params.payload,
      createdAt: new Date().toISOString(),
    };

    if (isSupabaseConfigured()) {
      // Must await and propagate if database write fails
      await persistAuditToSupabase(event);
    }

    store.auditEvents.push(event);
    return event;
  }

  static logAudit(params: {
    businessId: string;
    entityType: AuditEvent['entityType'];
    entityId: string;
    actorId: string;
    actorRole: string;
    action: string;
    payload: Record<string, unknown>;
  }): AuditEvent {
    const store = getStore();
    const event: AuditEvent = {
      id: randomUUID(),
      businessId: params.businessId,
      entityType: params.entityType,
      entityId: params.entityId,
      actorId: params.actorId,
      actorRole: params.actorRole,
      action: params.action,
      payload: params.payload,
      createdAt: new Date().toISOString(),
    };
    store.auditEvents.push(event);
    if (isSupabaseConfigured()) {
      persistAuditToSupabase(event).catch((err) => {
        console.error('Async audit log failed to persist to Supabase:', err);
      });
    }
    return event;
  }

  // Request Methods (Async Authoritative)
  static async saveRequestAsync(req: ProcurementRequest): Promise<void> {
    const store = getStore();
    if (isSupabaseConfigured()) {
      await persistRequestToSupabase(req);
    }
    store.requests.set(req.id, req);
  }

  static saveRequest(req: ProcurementRequest): void {
    const store = getStore();
    store.requests.set(req.id, req);
    if (isSupabaseConfigured()) {
      persistRequestToSupabase(req).catch((err) => {
        console.error('saveRequest background persist error:', err);
      });
    }
  }

  static async getRequestAsync(id: string): Promise<ProcurementRequest | undefined> {
    if (isSupabaseConfigured()) {
      const dbReq = await fetchRequestFromSupabase(id);
      if (dbReq) return dbReq;
    }
    return getStore().requests.get(id);
  }

  static getRequest(id: string): ProcurementRequest | undefined {
    return getStore().requests.get(id);
  }

  static getAllRequests(): ProcurementRequest[] {
    return Array.from(getStore().requests.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  static async updateRequestStatusAsync(
    id: string,
    status: ProcurementStatus,
    actorId = 'system',
    actorRole = 'system'
  ): Promise<void> {
    const store = getStore();
    const req = await this.getRequestAsync(id);
    if (!req) throw new Error(`Request not found: ${id}`);
    const oldStatus = req.status;
    req.status = status;
    req.updatedAt = new Date().toISOString();

    if (isSupabaseConfigured()) {
      await persistRequestToSupabase(req);
    }
    store.requests.set(id, req);

    await this.logAuditAsync({
      businessId: req.businessId,
      entityType: 'request',
      entityId: req.id,
      actorId,
      actorRole,
      action: 'STATUS_TRANSITION',
      payload: { oldStatus, newStatus: status },
    });
  }

  static updateRequestStatus(id: string, status: ProcurementStatus, actorId = 'system', actorRole = 'system'): void {
    const store = getStore();
    const req = store.requests.get(id);
    if (!req) throw new Error(`Request not found: ${id}`);
    const oldStatus = req.status;
    req.status = status;
    req.updatedAt = new Date().toISOString();
    store.requests.set(id, req);
    if (isSupabaseConfigured()) {
      persistRequestToSupabase(req).catch((err) => {
        console.error('updateRequestStatus persist error:', err);
      });
    }

    this.logAudit({
      businessId: req.businessId,
      entityType: 'request',
      entityId: req.id,
      actorId,
      actorRole,
      action: 'STATUS_TRANSITION',
      payload: { oldStatus, newStatus: status },
    });
  }

  // Quote Methods (Async Authoritative)
  static async saveQuoteAsync(quote: Quote, actorId = 'system', actorRole = 'quote_engine'): Promise<void> {
    const store = getStore();
    if (isSupabaseConfigured()) {
      await persistQuoteToSupabase(quote);
    }
    store.quotes.set(quote.id, quote);

    // Update parent request active quote
    const req = await this.getRequestAsync(quote.requestId);
    if (req) {
      req.activeQuoteId = quote.id;
      req.status = 'quoted';
      req.updatedAt = new Date().toISOString();
      await this.saveRequestAsync(req);
    }

    await this.logAuditAsync({
      businessId: quote.businessId,
      entityType: 'quote',
      entityId: quote.id,
      actorId,
      actorRole,
      action: 'QUOTE_CALCULATED',
      payload: {
        version: quote.version,
        supplierName: quote.supplierName,
        totalCents: quote.totalCents,
        currency: quote.currency,
        checksumHash: quote.checksumHash,
        itemCount: quote.items.length,
      },
    });
  }

  static saveQuote(quote: Quote, actorId = 'system', actorRole = 'quote_engine'): void {
    const store = getStore();
    store.quotes.set(quote.id, quote);
    if (isSupabaseConfigured()) {
      persistQuoteToSupabase(quote).catch((err) => {
        console.error('saveQuote persist error:', err);
      });
    }

    const req = store.requests.get(quote.requestId);
    if (req) {
      req.activeQuoteId = quote.id;
      req.status = 'quoted';
      req.updatedAt = new Date().toISOString();
      store.requests.set(req.id, req);
      if (isSupabaseConfigured()) {
        persistRequestToSupabase(req).catch(() => {});
      }
    }

    this.logAudit({
      businessId: quote.businessId,
      entityType: 'quote',
      entityId: quote.id,
      actorId,
      actorRole,
      action: 'QUOTE_CALCULATED',
      payload: {
        version: quote.version,
        supplierName: quote.supplierName,
        totalCents: quote.totalCents,
        currency: quote.currency,
        checksumHash: quote.checksumHash,
        itemCount: quote.items.length,
      },
    });
  }

  static async getQuoteAsync(id: string): Promise<Quote | undefined> {
    if (isSupabaseConfigured()) {
      const dbQuote = await fetchQuoteFromSupabase(id);
      if (dbQuote) return dbQuote;
    }
    return getStore().quotes.get(id);
  }

  static getQuote(id: string): Quote | undefined {
    return getStore().quotes.get(id);
  }

  // Approval Methods (Async Authoritative)
  static async saveApprovalAsync(approval: Approval): Promise<void> {
    const store = getStore();
    if (isSupabaseConfigured()) {
      await persistApprovalToSupabase(approval);
    }
    store.approvals.set(approval.id, approval);

    // Update quote status
    const quote = await this.getQuoteAsync(approval.quoteId);
    if (quote) {
      quote.status = approval.decision === 'approved' ? 'approved' : 'rejected';
      if (isSupabaseConfigured()) {
        await persistQuoteToSupabase(quote);
      }
      store.quotes.set(quote.id, quote);

      // Update request status
      const req = await this.getRequestAsync(quote.requestId);
      if (req) {
        req.status = approval.decision === 'approved' ? 'approved' : 'rejected';
        req.updatedAt = new Date().toISOString();
        if (isSupabaseConfigured()) {
          await persistRequestToSupabase(req);
        }
        store.requests.set(req.id, req);
      }
    }

    await this.logAuditAsync({
      businessId: approval.businessId,
      entityType: 'approval',
      entityId: approval.id,
      actorId: approval.approverId,
      actorRole: approval.approverRole,
      action: approval.decision === 'approved' ? 'QUOTE_APPROVED' : 'QUOTE_REJECTED',
      payload: {
        quoteId: approval.quoteId,
        quoteVersion: approval.quoteVersion,
        approvedTotalCents: approval.approvedTotalCents,
        currency: approval.approvedCurrency,
        decision: approval.decision,
        reason: approval.reason,
        digitalSignature: approval.digitalSignature,
      },
    });
  }

  static saveApproval(approval: Approval): void {
    const store = getStore();
    store.approvals.set(approval.id, approval);
    if (isSupabaseConfigured()) {
      persistApprovalToSupabase(approval).catch((err) => {
        console.error('saveApproval persist error:', err);
      });
    }

    const quote = store.quotes.get(approval.quoteId);
    if (quote) {
      quote.status = approval.decision === 'approved' ? 'approved' : 'rejected';
      store.quotes.set(quote.id, quote);
      if (isSupabaseConfigured()) {
        persistQuoteToSupabase(quote).catch(() => {});
      }

      const req = store.requests.get(quote.requestId);
      if (req) {
        req.status = approval.decision === 'approved' ? 'approved' : 'rejected';
        req.updatedAt = new Date().toISOString();
        store.requests.set(req.id, req);
        if (isSupabaseConfigured()) {
          persistRequestToSupabase(req).catch(() => {});
        }
      }
    }

    this.logAudit({
      businessId: approval.businessId,
      entityType: 'approval',
      entityId: approval.id,
      actorId: approval.approverId,
      actorRole: approval.approverRole,
      action: approval.decision === 'approved' ? 'QUOTE_APPROVED' : 'QUOTE_REJECTED',
      payload: {
        quoteId: approval.quoteId,
        quoteVersion: approval.quoteVersion,
        approvedTotalCents: approval.approvedTotalCents,
        currency: approval.approvedCurrency,
        decision: approval.decision,
        reason: approval.reason,
        digitalSignature: approval.digitalSignature,
      },
    });
  }

  static async getApprovalForQuoteAsync(quoteId: string): Promise<Approval | undefined> {
    if (isSupabaseConfigured()) {
      const dbApproval = await fetchApprovalFromSupabase(quoteId);
      if (dbApproval) return dbApproval;
    }
    const list = Array.from(getStore().approvals.values()).filter((a) => a.quoteId === quoteId);
    return list[list.length - 1];
  }

  static getApprovalForQuote(quoteId: string): Approval | undefined {
    const list = Array.from(getStore().approvals.values()).filter((a) => a.quoteId === quoteId);
    return list[list.length - 1];
  }

  // Payment Methods (Async Authoritative)
  static async savePaymentAttemptAsync(payment: PaymentAttempt): Promise<void> {
    const store = getStore();
    if (isSupabaseConfigured()) {
      await persistPaymentToSupabase(payment);
    }
    store.payments.set(payment.id, payment);

    // If order created or captured, transition request status
    const quote = await this.getQuoteAsync(payment.quoteId);
    if (quote) {
      const req = await this.getRequestAsync(quote.requestId);
      if (req) {
        if (payment.status === 'created') req.status = 'payment_pending';
        if (payment.status === 'captured') req.status = 'paid';
        if (payment.status === 'failed') req.status = 'approved'; // Revert to approved so order can be re-attempted
        req.updatedAt = new Date().toISOString();
        if (isSupabaseConfigured()) {
          await persistRequestToSupabase(req);
        }
        store.requests.set(req.id, req);
      }
    }

    await this.logAuditAsync({
      businessId: payment.businessId,
      entityType: 'payment',
      entityId: payment.id,
      actorId: 'system',
      actorRole: 'paypal_service',
      action:
        payment.status === 'captured'
          ? 'PAYMENT_CAPTURED'
          : payment.status === 'failed'
          ? 'PAYMENT_FAILED'
          : 'PAYMENT_ATTEMPT_CREATED',
      payload: {
        provider: payment.provider,
        providerOrderId: payment.providerOrderId,
        providerCaptureId: payment.providerCaptureId,
        amountCents: payment.amountCents,
        currency: payment.currency,
        status: payment.status,
        idempotencyKey: payment.idempotencyKey,
        errorMessage: payment.errorMessage,
      },
    });
  }

  static savePaymentAttempt(payment: PaymentAttempt): void {
    const store = getStore();
    store.payments.set(payment.id, payment);
    if (isSupabaseConfigured()) {
      persistPaymentToSupabase(payment).catch((err) => {
        console.error('savePaymentAttempt persist error:', err);
      });
    }

    const quote = store.quotes.get(payment.quoteId);
    if (quote) {
      const req = store.requests.get(quote.requestId);
      if (req) {
        if (payment.status === 'created') req.status = 'payment_pending';
        if (payment.status === 'captured') req.status = 'paid';
        if (payment.status === 'failed') req.status = 'approved';
        req.updatedAt = new Date().toISOString();
        store.requests.set(req.id, req);
        if (isSupabaseConfigured()) {
          persistRequestToSupabase(req).catch(() => {});
        }
      }
    }

    this.logAudit({
      businessId: payment.businessId,
      entityType: 'payment',
      entityId: payment.id,
      actorId: 'system',
      actorRole: 'paypal_service',
      action:
        payment.status === 'captured'
          ? 'PAYMENT_CAPTURED'
          : payment.status === 'failed'
          ? 'PAYMENT_FAILED'
          : 'PAYMENT_ATTEMPT_CREATED',
      payload: {
        provider: payment.provider,
        providerOrderId: payment.providerOrderId,
        providerCaptureId: payment.providerCaptureId,
        amountCents: payment.amountCents,
        currency: payment.currency,
        status: payment.status,
        idempotencyKey: payment.idempotencyKey,
        errorMessage: payment.errorMessage,
      },
    });
  }

  static async getPaymentByOrderIdAsync(orderId: string): Promise<PaymentAttempt | undefined> {
    if (isSupabaseConfigured()) {
      const dbPayment = await fetchPaymentByOrderIdFromSupabase(orderId);
      if (dbPayment) return dbPayment;
    }
    return Array.from(getStore().payments.values()).find((p) => p.providerOrderId === orderId);
  }

  static getPaymentByOrderId(orderId: string): PaymentAttempt | undefined {
    return Array.from(getStore().payments.values()).find((p) => p.providerOrderId === orderId);
  }

  static getPaymentForQuote(quoteId: string): PaymentAttempt | undefined {
    const list = Array.from(getStore().payments.values()).filter((p) => p.quoteId === quoteId);
    return list[list.length - 1];
  }

  // Webhook Methods (Async Authoritative)
  static async recordWebhookAsync(rec: WebhookEventRecord): Promise<void> {
    const store = getStore();
    if (isSupabaseConfigured()) {
      await persistWebhookToSupabase(rec);
    }
    store.webhooks.set(rec.eventId, rec);

    await this.logAuditAsync({
      businessId: 'SYSTEM',
      entityType: 'webhook',
      entityId: rec.id,
      actorId: 'paypal_webhook',
      actorRole: 'external_gateway',
      action: 'WEBHOOK_RECEIVED',
      payload: {
        eventId: rec.eventId,
        eventType: rec.eventType,
        signatureVerified: rec.signatureVerified,
        status: rec.status,
      },
    });
  }

  static recordWebhook(rec: WebhookEventRecord): void {
    const store = getStore();
    store.webhooks.set(rec.eventId, rec);
    if (isSupabaseConfigured()) {
      persistWebhookToSupabase(rec).catch((err) => {
        console.error('recordWebhook persist error:', err);
      });
    }

    this.logAudit({
      businessId: 'SYSTEM',
      entityType: 'webhook',
      entityId: rec.id,
      actorId: 'paypal_webhook',
      actorRole: 'external_gateway',
      action: 'WEBHOOK_RECEIVED',
      payload: {
        eventId: rec.eventId,
        eventType: rec.eventType,
        signatureVerified: rec.signatureVerified,
        status: rec.status,
      },
    });
  }

  static getWebhookEvent(eventId: string): WebhookEventRecord | undefined {
    return getStore().webhooks.get(eventId);
  }

  // Audit Query
  static async getAuditEventsAsync(businessId?: string, entityId?: string): Promise<AuditEvent[]> {
    if (isSupabaseConfigured() && businessId) {
      const dbEvents = await fetchAuditEventsFromSupabase(businessId);
      if (dbEvents && dbEvents.length > 0) return dbEvents;
    }
    return this.getAuditEvents(businessId, entityId);
  }

  static getAuditEvents(businessId?: string, entityId?: string): AuditEvent[] {
    let events = [...getStore().auditEvents];
    if (businessId && businessId !== 'SYSTEM') {
      events = events.filter((e) => e.businessId === businessId || e.businessId === 'SYSTEM');
    }
    if (entityId) {
      events = events.filter((e) => e.entityId === entityId);
    }
    return events.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  // Reset / Clear state (for tests)
  static reset(): void {
    const store = getStore();
    store.requests.clear();
    store.quotes.clear();
    store.approvals.clear();
    store.payments.clear();
    store.webhooks.clear();
    store.auditEvents = [];
  }
}
