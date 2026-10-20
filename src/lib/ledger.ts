// ActionOS Pay: Append-Only Ledger & State Transition Engine
// Invariant: Audit events are append-only.
// State changes must be recorded with actor, role, timestamp, and entity payload.

import { randomUUID } from 'crypto';
import {
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
   * Appends an immutable audit event to the ledger
   */
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
    persistAuditToSupabase(event).catch(() => {});
    return event;
  }

  // Request Methods
  static saveRequest(req: ProcurementRequest): void {
    const store = getStore();
    store.requests.set(req.id, req);
    persistRequestToSupabase(req).catch(() => {});
  }

  static getRequest(id: string): ProcurementRequest | undefined {
    return getStore().requests.get(id);
  }

  static getAllRequests(): ProcurementRequest[] {
    return Array.from(getStore().requests.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  static updateRequestStatus(id: string, status: ProcurementStatus, actorId = 'system', actorRole = 'system'): void {
    const store = getStore();
    const req = store.requests.get(id);
    if (!req) throw new Error(`Request not found: ${id}`);
    const oldStatus = req.status;
    req.status = status;
    req.updatedAt = new Date().toISOString();
    store.requests.set(id, req);
    persistRequestToSupabase(req).catch(() => {});

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

  // Quote Methods
  static saveQuote(quote: Quote, actorId = 'system', actorRole = 'quote_engine'): void {
    const store = getStore();
    store.quotes.set(quote.id, quote);
    persistQuoteToSupabase(quote).catch(() => {});

    // Update parent request active quote
    const req = store.requests.get(quote.requestId);
    if (req) {
      req.activeQuoteId = quote.id;
      req.status = 'quoted';
      req.updatedAt = new Date().toISOString();
      store.requests.set(req.id, req);
      persistRequestToSupabase(req).catch(() => {});
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

  static getQuote(id: string): Quote | undefined {
    return getStore().quotes.get(id);
  }

  // Approval Methods
  static saveApproval(approval: Approval): void {
    const store = getStore();
    store.approvals.set(approval.id, approval);
    persistApprovalToSupabase(approval).catch(() => {});

    // Update quote status
    const quote = store.quotes.get(approval.quoteId);
    if (quote) {
      quote.status = approval.decision === 'approved' ? 'approved' : 'rejected';
      store.quotes.set(quote.id, quote);
      persistQuoteToSupabase(quote).catch(() => {});

      // Update request status
      const req = store.requests.get(quote.requestId);
      if (req) {
        req.status = approval.decision === 'approved' ? 'approved' : 'rejected';
        req.updatedAt = new Date().toISOString();
        store.requests.set(req.id, req);
        persistRequestToSupabase(req).catch(() => {});
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

  static getApprovalForQuote(quoteId: string): Approval | undefined {
    const list = Array.from(getStore().approvals.values()).filter((a) => a.quoteId === quoteId);
    return list[list.length - 1];
  }

  // Payment Methods
  static savePaymentAttempt(payment: PaymentAttempt): void {
    const store = getStore();
    store.payments.set(payment.id, payment);
    persistPaymentToSupabase(payment).catch(() => {});

    // If order created or captured, transition request status
    const quote = store.quotes.get(payment.quoteId);
    if (quote) {
      const req = store.requests.get(quote.requestId);
      if (req) {
        if (payment.status === 'created') req.status = 'payment_pending';
        if (payment.status === 'captured') req.status = 'paid';
        req.updatedAt = new Date().toISOString();
        store.requests.set(req.id, req);
        persistRequestToSupabase(req).catch(() => {});
      }
    }

    this.logAudit({
      businessId: payment.businessId,
      entityType: 'payment',
      entityId: payment.id,
      actorId: 'system',
      actorRole: 'paypal_service',
      action: payment.status === 'captured' ? 'PAYMENT_CAPTURED' : 'PAYMENT_ATTEMPT_CREATED',
      payload: {
        provider: payment.provider,
        providerOrderId: payment.providerOrderId,
        providerCaptureId: payment.providerCaptureId,
        amountCents: payment.amountCents,
        currency: payment.currency,
        status: payment.status,
        idempotencyKey: payment.idempotencyKey,
      },
    });
  }

  static getPaymentByOrderId(orderId: string): PaymentAttempt | undefined {
    return Array.from(getStore().payments.values()).find((p) => p.providerOrderId === orderId);
  }

  static getPaymentForQuote(quoteId: string): PaymentAttempt | undefined {
    const list = Array.from(getStore().payments.values()).filter((p) => p.quoteId === quoteId);
    return list[list.length - 1];
  }

  // Webhook Methods
  static recordWebhook(rec: WebhookEventRecord): void {
    const store = getStore();
    store.webhooks.set(rec.eventId, rec);
    persistWebhookToSupabase(rec).catch(() => {});

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

  // Reset / Clear state (useful for tests or demo resets)
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
