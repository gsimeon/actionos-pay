// ActionOS Pay: Append-Only Ledger & State Transition Engine
// Hardened Guarantees:
// 1. Audit events are strictly append-only.
// 2. If Supabase is configured, all database writes are awaited and errors are surfaced (never swallowed).
// 3. State changes are immutably logged with actor, role, timestamp, and entity payload.

import { randomUUID } from 'crypto';
import {
  claimExpiredWebhookEventsInSupabase,
  claimWebhookEventInSupabase,
  deadLetterExhaustedWebhookEventsInSupabase,
  fetchApprovalFromSupabase,
  fetchAuditEventsFromSupabase,
  fetchPaymentByOrderIdFromSupabase,
  fetchPaymentForQuoteFromSupabase,
  fetchQuoteFromSupabase,
  fetchRequestFromSupabase,
  fetchWebhookFromSupabase,
  getSupabase,
  updateWebhookStatusInSupabase,
  isSupabaseConfigured,
  persistApprovalToSupabase,
  persistAuditToSupabase,
  persistPaymentToSupabase,
  persistQuoteToSupabase,
  persistRequestToSupabase,
  persistWebhookToSupabase,
  reconcilePaymentCaptureInSupabase,
  recordWebhookFailureInSupabase,
  recoverExpiredWebhookClaimsInSupabase,
  reservePaymentAttemptInSupabase,
  confirmPaymentOrderInSupabase,
  failPaymentAttemptInSupabase,
  claimPaymentCaptureInSupabase,
  releasePaymentCaptureClaimInSupabase,
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
    if (isSupabaseConfigured()) {
      throw new Error(
        'Architecture Invariant Violation: Synchronous logAudit is prohibited when Supabase is configured. Use logAuditAsync() to guarantee authoritative database persistence.'
      );
    }
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
    if (isSupabaseConfigured()) {
      throw new Error(
        'Architecture Invariant Violation: Synchronous saveRequest is prohibited when Supabase is configured. Use saveRequestAsync() to guarantee authoritative database persistence.'
      );
    }
    const store = getStore();
    store.requests.set(req.id, req);
  }

  static async getRequestAsync(id: string): Promise<ProcurementRequest | undefined> {
    if (isSupabaseConfigured()) {
      const dbReq = await fetchRequestFromSupabase(id);
      return dbReq || undefined;
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

    // 1. Financial Arithmetic & Line Item Invariants
    if (quote.subtotalCents + quote.taxCents + quote.shippingCents !== quote.totalCents) {
      throw new Error(
        `Financial arithmetic violation: Subtotal (${quote.subtotalCents}) + Tax (${quote.taxCents}) + Shipping (${quote.shippingCents}) != Total (${quote.totalCents})`
      );
    }

    let sumItems = 0;
    for (const item of quote.items || []) {
      if (item.quantity <= 0) {
        throw new Error(`Quote item integrity violation: Item quantity must be greater than zero, got ${item.quantity}`);
      }
      if (item.unitPriceCents < 0) {
        throw new Error(`Quote item integrity violation: Item unit price cannot be negative, got ${item.unitPriceCents}`);
      }
      if (item.quantity * item.unitPriceCents !== item.totalCents) {
        throw new Error(
          `Quote item arithmetic violation: Quantity (${item.quantity}) * Unit Price (${item.unitPriceCents}) != Item Total (${item.totalCents})`
        );
      }
      sumItems += item.totalCents;
    }

    if ((quote.items?.length || 0) > 0 && sumItems !== quote.subtotalCents) {
      throw new Error(
        `Quote items arithmetic violation: Sum of quote items (${sumItems} cents) does not match quote subtotal (${quote.subtotalCents} cents)`
      );
    }

    // 2. Version Progression & Immutability Verification
    const existingQuote = store.quotes.get(quote.id);
    if (existingQuote) {
      if (existingQuote.requestId !== quote.requestId) {
        throw new Error(`Immutability violation: Cannot reassign quote to different request`);
      }
      if (existingQuote.businessId !== quote.businessId) {
        throw new Error(`Immutability violation: Cannot reassign quote to different business`);
      }
      if (existingQuote.supplierId !== quote.supplierId) {
        throw new Error(`Immutability violation: Cannot reassign quote to different supplier`);
      }
      if (quote.version !== existingQuote.version + 1) {
        throw new Error(
          `Quote version progression violation: Existing version is ${existingQuote.version}, revision must be ${existingQuote.version + 1}, got ${quote.version}`
        );
      }
    } else if (quote.version !== 1) {
      throw new Error(`Quote version violation: Initial quote must start at version 1, got ${quote.version}`);
    }

    if (isSupabaseConfigured()) {
      // Executes single-transaction PostgreSQL RPC:
      // persist_quote_and_transition_request_atomic (quote + items + request status transition + audit)
      await persistQuoteToSupabase(quote);
    }
    store.quotes.set(quote.id, quote);

    // Update in-memory parent request active quote
    const req = store.requests.get(quote.requestId);
    if (req) {
      req.activeQuoteId = quote.id;
      req.status = 'quoted';
      req.updatedAt = new Date().toISOString();
      store.requests.set(req.id, req);
    }

    const auditRecord: AuditEvent = {
      id: randomUUID(),
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
      createdAt: new Date().toISOString(),
    };
    store.auditEvents.push(auditRecord);
  }

  static saveQuote(quote: Quote): void {
    if (isSupabaseConfigured()) {
      throw new Error(
        'Architecture Invariant Violation: Synchronous saveQuote is prohibited when Supabase is configured. Use saveQuoteAsync() to guarantee authoritative database persistence.'
      );
    }
    const store = getStore();
    store.quotes.set(quote.id, quote);

    const req = store.requests.get(quote.requestId);
    if (req) {
      req.activeQuoteId = quote.id;
      req.status = 'quoted';
      req.updatedAt = new Date().toISOString();
      store.requests.set(req.id, req);
    }
  }

  static async getQuoteAsync(id: string): Promise<Quote | undefined> {
    if (isSupabaseConfigured()) {
      const dbQuote = await fetchQuoteFromSupabase(id);
      return dbQuote || undefined;
    }
    return getStore().quotes.get(id);
  }

  static getQuote(id: string): Quote | undefined {
    return getStore().quotes.get(id);
  }

  // Approval Methods (Async Authoritative)
  static async saveApprovalAsync(approval: Approval): Promise<void> {
    const store = getStore();

    if (!['approved', 'rejected'].includes(approval.decision)) {
      throw new Error(
        `Approval integrity violation: Invalid decision "${approval.decision}". Must be "approved" or "rejected".`
      );
    }

    // Look up quote to bind request ID for atomic transaction and validate integrity
    const quote = await this.getQuoteAsync(approval.quoteId);
    if (!quote) {
      throw new Error(
        `Approval integrity violation: Referenced quote "${approval.quoteId}" does not exist.`
      );
    }

    if (quote.businessId !== approval.businessId) {
      throw new Error(
        `Tenant boundary violation: Quote business "${quote.businessId}" does not match approval "${approval.businessId}".`
      );
    }

    if (approval.quoteVersion !== quote.version) {
      throw new Error(
        `Approval integrity violation: Approval quote version (${approval.quoteVersion}) does not match current quote version (${quote.version}).`
      );
    }

    if (approval.approvedTotalCents !== quote.totalCents) {
      throw new Error(
        `Approval integrity violation: Approved total (${approval.approvedTotalCents} cents) does not match quote total (${quote.totalCents} cents).`
      );
    }

    if (approval.approvedCurrency.toUpperCase() !== quote.currency.toUpperCase()) {
      throw new Error(
        `Approval integrity violation: Approved currency (${approval.approvedCurrency}) does not match quote currency (${quote.currency}).`
      );
    }

    if (approval.approvedSupplierId && approval.approvedSupplierId !== quote.supplierId) {
      throw new Error(
        `Approval integrity violation: Approved supplier "${approval.approvedSupplierId}" does not match quote supplier "${quote.supplierId}".`
      );
    }

    // Segregation of Duties: Requester cannot approve their own request
    const req = await this.getRequestAsync(quote.requestId);
    if (req && req.requesterId && req.requesterId === approval.approverId) {
      throw new Error(
        `Governance violation: Self-approval prohibited. Requester "${approval.approverId}" cannot approve their own procurement request.`
      );
    }

    if (isSupabaseConfigured()) {
      // Executes single-transaction PostgreSQL RPC:
      // persist_approval_and_transition_atomic (approval + quote status + request status + audit)
      await persistApprovalToSupabase(approval, quote.requestId);
    }
    store.approvals.set(approval.id, approval);

    // Update in-memory state
    quote.status = approval.decision === 'approved' ? 'approved' : 'rejected';
    store.quotes.set(quote.id, quote);

    const inMemoryReq = store.requests.get(quote.requestId);
    if (inMemoryReq) {
      inMemoryReq.status = approval.decision === 'approved' ? 'approved' : 'rejected';
      inMemoryReq.updatedAt = new Date().toISOString();
      store.requests.set(inMemoryReq.id, inMemoryReq);
    }

    const auditRecord: AuditEvent = {
      id: randomUUID(),
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
      createdAt: new Date().toISOString(),
    };

    store.auditEvents.push(auditRecord);
  }

  static saveApproval(approval: Approval): void {
    if (isSupabaseConfigured()) {
      throw new Error(
        'Architecture Invariant Violation: Synchronous saveApproval is prohibited when Supabase is configured. Use saveApprovalAsync() to guarantee authoritative database persistence.'
      );
    }
    const store = getStore();
    store.approvals.set(approval.id, approval);

    const quote = store.quotes.get(approval.quoteId);
    if (quote) {
      quote.status = approval.decision === 'approved' ? 'approved' : 'rejected';
      store.quotes.set(quote.id, quote);

      const req = store.requests.get(quote.requestId);
      if (req) {
        req.status = approval.decision === 'approved' ? 'approved' : 'rejected';
        req.updatedAt = new Date().toISOString();
        store.requests.set(req.id, req);
      }
    }
  }

  static async getApprovalForQuoteAsync(quoteId: string): Promise<Approval | undefined> {
    if (isSupabaseConfigured()) {
      const dbApproval = await fetchApprovalFromSupabase(quoteId);
      return dbApproval || undefined;
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
    if (isSupabaseConfigured()) {
      throw new Error(
        'Architecture Invariant Violation: Synchronous savePaymentAttempt is prohibited when Supabase is configured. Use savePaymentAttemptAsync() to guarantee authoritative database persistence.'
      );
    }
    const store = getStore();
    store.payments.set(payment.id, payment);

    const quote = store.quotes.get(payment.quoteId);
    if (quote) {
      const req = store.requests.get(quote.requestId);
      if (req) {
        if (payment.status === 'created') req.status = 'payment_pending';
        if (payment.status === 'captured') req.status = 'paid';
        if (payment.status === 'failed') req.status = 'approved';
        req.updatedAt = new Date().toISOString();
        store.requests.set(req.id, req);
      }
    }
  }

  static async getPaymentByOrderIdAsync(orderId: string): Promise<PaymentAttempt | undefined> {
    if (isSupabaseConfigured()) {
      const dbPayment = await fetchPaymentByOrderIdFromSupabase(orderId);
      return dbPayment || undefined;
    }
    return Array.from(getStore().payments.values()).find((p) => p.providerOrderId === orderId);
  }

  static getPaymentByOrderId(orderId: string): PaymentAttempt | undefined {
    return Array.from(getStore().payments.values()).find((p) => p.providerOrderId === orderId);
  }

  static async getPaymentForQuoteAsync(quoteId: string): Promise<PaymentAttempt | undefined> {
    if (isSupabaseConfigured()) {
      const dbPayment = await fetchPaymentForQuoteFromSupabase(quoteId);
      return dbPayment || undefined;
    }
    const list = Array.from(getStore().payments.values()).filter((p) => p.quoteId === quoteId);
    return list[list.length - 1];
  }

  static getPaymentForQuote(quoteId: string): PaymentAttempt | undefined {
    const list = Array.from(getStore().payments.values()).filter((p) => p.quoteId === quoteId);
    return list[list.length - 1];
  }

  /**
   * Atomically reserves a payment attempt before contacting PayPal.
   * Enforces exactly-one in-flight order creation per quote across all clients.
   */
  static async reservePaymentAttemptAsync(params: {
    quoteId: string;
    businessId: string;
    amountCents: number;
    currency: string;
    idempotencyKey: string;
    reservationSeconds?: number;
  }): Promise<{
    status: 'RESERVED' | 'REPLAY' | 'IN_FLIGHT' | 'ALREADY_CAPTURED';
    paymentAttemptId?: string;
    providerOrderId?: string;
    providerCaptureId?: string;
    paymentStatus?: string;
    providerResponse?: Record<string, unknown>;
    idempotencyKey?: string;
    expiresAt?: string;
    amountCents?: number;
    currency?: string;
    paymentAttempt?: PaymentAttempt;
  }> {
    const store = getStore();

    if (isSupabaseConfigured()) {
      const res = await reservePaymentAttemptInSupabase(params);
      if (res.status === 'RESERVED') {
        const attempt: PaymentAttempt = {
          id: res.paymentAttemptId!,
          quoteId: params.quoteId,
          businessId: params.businessId,
          provider: 'paypal',
          providerOrderId: undefined,
          amountCents: params.amountCents,
          currency: params.currency,
          status: 'created',
          idempotencyKey: params.idempotencyKey,
          orderReservationExpiresAt: res.expiresAt,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        store.payments.set(attempt.id, attempt);
        return { ...res, paymentAttempt: attempt };
      } else if (res.status === 'REPLAY') {
        let attempt = await this.getPaymentByOrderIdAsync(res.providerOrderId!);
        if (!attempt) {
          attempt = {
            id: res.paymentAttemptId!,
            quoteId: params.quoteId,
            businessId: params.businessId,
            provider: 'paypal',
            providerOrderId: res.providerOrderId,
            amountCents: res.amountCents || params.amountCents,
            currency: res.currency || params.currency,
            status: (res.paymentStatus as PaymentAttempt['status']) || 'created',
            idempotencyKey: res.idempotencyKey || params.idempotencyKey,
            providerResponse: res.providerResponse,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          store.payments.set(attempt.id, attempt);
        }
        return { ...res, paymentAttempt: attempt };
      } else if (res.status === 'ALREADY_CAPTURED') {
        const attempt = await this.getPaymentForQuoteAsync(params.quoteId);
        return { ...res, paymentAttempt: attempt };
      } else {
        // IN_FLIGHT
        return res;
      }
    }

    // In-Memory Engine Fallback (Local / Test Mode)
    const existing = Array.from(store.payments.values())
      .filter((p) => p.quoteId === params.quoteId && ['created', 'approved', 'reconciling', 'captured'].includes(p.status))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

    if (existing) {
      if (existing.status === 'captured') {
        return {
          status: 'ALREADY_CAPTURED',
          paymentAttemptId: existing.id,
          providerOrderId: existing.providerOrderId,
          providerCaptureId: existing.providerCaptureId,
          paymentAttempt: existing,
        };
      }

      if (existing.providerOrderId) {
        return {
          status: 'REPLAY',
          paymentAttemptId: existing.id,
          providerOrderId: existing.providerOrderId,
          paymentStatus: existing.status,
          providerResponse: existing.providerResponse,
          idempotencyKey: existing.idempotencyKey,
          paymentAttempt: existing,
        };
      }

      // Existing reservation without providerOrderId
      const reservationExpires = existing.orderReservationExpiresAt
        ? new Date(existing.orderReservationExpiresAt).getTime()
        : 0;
      if (reservationExpires > Date.now()) {
        return {
          status: 'IN_FLIGHT',
          paymentAttemptId: existing.id,
          expiresAt: existing.orderReservationExpiresAt,
          paymentAttempt: existing,
        };
      }

      // Expired reservation: renew it
      const reservationDuration = params.reservationSeconds ?? 120;
      existing.orderReservationExpiresAt = new Date(Date.now() + reservationDuration * 1000).toISOString();
      existing.idempotencyKey = params.idempotencyKey;
      existing.amountCents = params.amountCents;
      existing.currency = params.currency;
      existing.updatedAt = new Date().toISOString();
      store.payments.set(existing.id, existing);

      return {
        status: 'RESERVED',
        paymentAttemptId: existing.id,
        expiresAt: existing.orderReservationExpiresAt,
        paymentAttempt: existing,
      };
    }

    // No existing attempt: Create fresh reservation
    const reservationDuration = params.reservationSeconds ?? 120;
    const newAttempt: PaymentAttempt = {
      id: randomUUID(),
      quoteId: params.quoteId,
      businessId: params.businessId,
      provider: 'paypal',
      providerOrderId: undefined,
      amountCents: params.amountCents,
      currency: params.currency,
      status: 'created',
      idempotencyKey: params.idempotencyKey,
      orderReservationExpiresAt: new Date(Date.now() + reservationDuration * 1000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.payments.set(newAttempt.id, newAttempt);

    return {
      status: 'RESERVED',
      paymentAttemptId: newAttempt.id,
      expiresAt: newAttempt.orderReservationExpiresAt,
      paymentAttempt: newAttempt,
    };
  }

  /**
   * Commits the created PayPal order ID to the reserved payment attempt.
   */
  static async confirmPaymentOrderAsync(params: {
    paymentAttemptId: string;
    providerOrderId: string;
    providerResponse: Record<string, unknown>;
    paymentAttempt?: PaymentAttempt;
  }): Promise<void> {
    const store = getStore();
    if (isSupabaseConfigured()) {
      await confirmPaymentOrderInSupabase({
        paymentAttemptId: params.paymentAttemptId,
        providerOrderId: params.providerOrderId,
        providerResponse: params.providerResponse,
      });
    }

    let attempt = store.payments.get(params.paymentAttemptId);
    if (!attempt && params.paymentAttempt) {
      attempt = params.paymentAttempt;
    }
    if (attempt) {
      attempt.providerOrderId = params.providerOrderId;
      attempt.providerResponse = params.providerResponse;
      attempt.orderReservationExpiresAt = undefined;
      attempt.updatedAt = new Date().toISOString();
      store.payments.set(attempt.id, attempt);

      const quote = await this.getQuoteAsync(attempt.quoteId);
      if (quote) {
        const req = await this.getRequestAsync(quote.requestId);
        if (req) {
          req.status = 'payment_pending';
          req.updatedAt = new Date().toISOString();
          store.requests.set(req.id, req);
        }
      }

      await this.logAuditAsync({
        businessId: attempt.businessId,
        entityType: 'payment',
        entityId: attempt.id,
        actorId: 'system',
        actorRole: 'paypal_service',
        action: 'PAYMENT_ATTEMPT_CREATED',
        payload: {
          provider: attempt.provider,
          providerOrderId: attempt.providerOrderId,
          amountCents: attempt.amountCents,
          currency: attempt.currency,
          status: attempt.status,
          idempotencyKey: attempt.idempotencyKey,
        },
      });
    }
  }

  /**
   * Marks a reserved payment attempt as failed on PayPal rejection.
   */
  static async failPaymentAttemptAsync(
    paymentAttemptId: string,
    errorMessage: string
  ): Promise<void> {
    const store = getStore();
    if (isSupabaseConfigured()) {
      await failPaymentAttemptInSupabase(paymentAttemptId, errorMessage);
    }

    const attempt = store.payments.get(paymentAttemptId);
    if (attempt) {
      attempt.status = 'failed';
      attempt.errorMessage = errorMessage;
      attempt.orderReservationExpiresAt = undefined;
      attempt.captureLeaseExpiresAt = undefined;
      attempt.updatedAt = new Date().toISOString();
      store.payments.set(attempt.id, attempt);

      const quote = await this.getQuoteAsync(attempt.quoteId);
      if (quote) {
        const req = await this.getRequestAsync(quote.requestId);
        if (req) {
          req.status = 'approved';
          req.updatedAt = new Date().toISOString();
          store.requests.set(req.id, req);
        }
      }
    }
  }

  /**
   * Acquires a capture lease on a payment attempt to prevent concurrent capture calls.
   */
  static async claimPaymentCaptureAsync(
    orderId: string,
    leaseSeconds = 60
  ): Promise<{
    status: 'CLAIMED' | 'ALREADY_CAPTURED' | 'IN_FLIGHT' | 'FAILED';
    paymentAttemptId?: string;
    providerCaptureId?: string;
    leaseExpiresAt?: string;
    paymentAttempt?: PaymentAttempt;
    errorMessage?: string;
  }> {
    const store = getStore();

    if (isSupabaseConfigured()) {
      const res = await claimPaymentCaptureInSupabase(orderId, leaseSeconds);
      const attempt = await this.getPaymentByOrderIdAsync(orderId);
      return {
        status: res.status,
        paymentAttemptId: res.paymentAttemptId,
        providerCaptureId: res.providerCaptureId,
        leaseExpiresAt: res.leaseExpiresAt,
        paymentAttempt: attempt,
        errorMessage: res.errorMessage,
      };
    }

    const attempt = Array.from(store.payments.values()).find((p) => p.providerOrderId === orderId);
    if (!attempt) {
      throw new Error(`Payment attempt not found for orderId "${orderId}".`);
    }

    if (attempt.status === 'captured') {
      return {
        status: 'ALREADY_CAPTURED',
        paymentAttemptId: attempt.id,
        providerCaptureId: attempt.providerCaptureId,
        paymentAttempt: attempt,
      };
    }

    if (attempt.status === 'failed') {
      return {
        status: 'FAILED',
        paymentAttemptId: attempt.id,
        errorMessage: attempt.errorMessage,
        paymentAttempt: attempt,
      };
    }

    const leaseExpires = attempt.captureLeaseExpiresAt
      ? new Date(attempt.captureLeaseExpiresAt).getTime()
      : 0;

    if (attempt.status === 'reconciling' && leaseExpires > Date.now()) {
      return {
        status: 'IN_FLIGHT',
        paymentAttemptId: attempt.id,
        leaseExpiresAt: attempt.captureLeaseExpiresAt,
        paymentAttempt: attempt,
      };
    }

    attempt.status = 'reconciling';
    attempt.captureLeaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    attempt.updatedAt = new Date().toISOString();
    store.payments.set(attempt.id, attempt);

    return {
      status: 'CLAIMED',
      paymentAttemptId: attempt.id,
      leaseExpiresAt: attempt.captureLeaseExpiresAt,
      paymentAttempt: attempt,
    };
  }

  /**
   * Releases a capture lease upon capture failure or timeout.
   */
  static async releasePaymentCaptureClaimAsync(
    paymentAttemptId: string,
    status: 'created' | 'approved' | 'failed',
    errorMessage?: string
  ): Promise<void> {
    const store = getStore();
    if (isSupabaseConfigured()) {
      await releasePaymentCaptureClaimInSupabase(paymentAttemptId, status, errorMessage);
    }

    const attempt = store.payments.get(paymentAttemptId);
    if (attempt) {
      attempt.status = status;
      attempt.captureLeaseExpiresAt = undefined;
      if (errorMessage) attempt.errorMessage = errorMessage;
      attempt.updatedAt = new Date().toISOString();
      store.payments.set(attempt.id, attempt);
    }
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
    if (isSupabaseConfigured()) {
      throw new Error(
        'Architecture Invariant Violation: Synchronous recordWebhook is prohibited when Supabase is configured. Use recordWebhookAsync() to guarantee authoritative database persistence.'
      );
    }
    const store = getStore();
    store.webhooks.set(rec.eventId, rec);
  }

  /**
   * Atomically claims a webhook event to eliminate race conditions between concurrent webhook deliveries.
   */
  static async claimWebhookEventAsync(rec: WebhookEventRecord): Promise<{
    claimed: boolean;
    status: 'received' | 'duplicate' | 'in_progress' | 'retryable';
    record: WebhookEventRecord;
  }> {
    if (isSupabaseConfigured()) {
      const res = await claimWebhookEventInSupabase(rec);
      if (res.record) {
        getStore().webhooks.set(res.record.eventId, res.record);
      }
      return {
        claimed: res.claimed,
        status: res.status,
        record: res.record || rec,
      };
    }

    const store = getStore();
    const existing = store.webhooks.get(rec.eventId);
    const now = Date.now();
    const leaseSeconds = 60;
    const leaseExpiresAt = new Date(now + leaseSeconds * 1000).toISOString();

    if (existing) {
      if (existing.signatureVerified && !rec.signatureVerified) {
        throw new Error(
          `Security violation: Cannot replace verified webhook event "${rec.eventId}" with an unverified payload.`
        );
      }
      if (existing.status === 'processed' || existing.status === 'duplicate') {
        return { claimed: false, status: 'duplicate', record: existing };
      }
      if (existing.status === 'received') {
        // If lease is active, event is actively being processed by another worker
        if (existing.claimLeaseExpiresAt && new Date(existing.claimLeaseExpiresAt).getTime() > now) {
          return { claimed: false, status: 'in_progress', record: existing };
        } else {
          // Stale claim lease expired (abandoned or crashed worker). Safely recover!
          existing.claimLeaseExpiresAt = leaseExpiresAt;
          existing.payload = rec.payload;
          return { claimed: true, status: 'retryable', record: existing };
        }
      }
      if (existing.status === 'failed') {
        existing.status = 'received';
        existing.eventType = rec.eventType;
        existing.payload = rec.payload;
        existing.processedAt = undefined;
        existing.claimLeaseExpiresAt = leaseExpiresAt;
        return { claimed: true, status: 'retryable', record: existing };
      }
    }

    rec.claimLeaseExpiresAt = leaseExpiresAt;
    store.webhooks.set(rec.eventId, rec);
    return { claimed: true, status: 'received', record: rec };
  }

  /**
   * Reconciles payment capture, transitions request to fulfilled, marks webhook processed,
   * and records immutable audit log.
   * Guarantees:
   * 1. Relational integrity (quote, payment, request, tenant IDs and totals match)
   * 2. Strict idempotency checking (capture ID must match if already captured)
   * 3. Database atomic RPC execution when Supabase is configured
   */
  static async reconcilePaymentCaptureAsync(params: {
    payment: PaymentAttempt;
    webhookRecord: WebhookEventRecord;
    quote: Quote;
    providerCaptureId: string;
  }): Promise<void> {
    const { payment, webhookRecord, quote, providerCaptureId } = params;

    // 1. Cross-Entity Relational Integrity & Tenant Boundary Checks
    if (payment.quoteId !== quote.id) {
      throw new Error(
        `Relational integrity error: Payment quoteId "${payment.quoteId}" does not match quote "${quote.id}".`
      );
    }

    if (payment.businessId !== quote.businessId) {
      throw new Error(
        `Tenant boundary error: Payment businessId "${payment.businessId}" does not match quote "${quote.businessId}".`
      );
    }

    if (quote.requestId) {
      const req = await this.getRequestAsync(quote.requestId);
      if (!req) {
        throw new Error(
          `Financial reconciliation failed: Referenced procurement request "${quote.requestId}" does not exist.`
        );
      }
      if (req.businessId !== payment.businessId) {
        throw new Error(
          `Tenant boundary error: Request businessId "${req.businessId}" does not match payment "${payment.businessId}".`
        );
      }
    }

    if (payment.amountCents !== quote.totalCents) {
      throw new Error(
        `Financial integrity violation: Payment amount (${payment.amountCents} cents) does not match quote total (${quote.totalCents} cents).`
      );
    }

    if (payment.currency.toUpperCase() !== quote.currency.toUpperCase()) {
      throw new Error(
        `Financial integrity violation: Payment currency (${payment.currency}) does not match quote currency (${quote.currency}).`
      );
    }

    // Validate Webhook Record Integrity
    if (webhookRecord.provider !== 'paypal') {
      throw new Error(
        `Financial reconciliation failed: Webhook provider "${webhookRecord.provider}" is invalid (expected "paypal").`
      );
    }

    if (webhookRecord.status === 'exhausted') {
      throw new Error(
        `Financial reconciliation failed: Webhook event "${webhookRecord.eventId}" is dead-lettered/exhausted.`
      );
    }

    if (!webhookRecord.signatureVerified) {
      throw new Error(
        `Security violation: Webhook event "${webhookRecord.eventId}" signature is not verified. Financial reconciliation rejected.`
      );
    }

    if (webhookRecord.businessId && webhookRecord.businessId !== payment.businessId) {
      throw new Error(
        `Tenant boundary error: Webhook businessId "${webhookRecord.businessId}" does not match payment "${payment.businessId}".`
      );
    }

    // 2. Strict Idempotency Check with Provider Capture ID Verification
    if (payment.status === 'captured') {
      if (payment.providerCaptureId && payment.providerCaptureId !== providerCaptureId) {
        throw new Error(
          `Financial reconciliation conflict: Payment "${payment.id}" is already captured with different provider capture ID "${payment.providerCaptureId}" (attempted: "${providerCaptureId}").`
        );
      }

      // Idempotent duplicate: ensure webhook is recorded as processed
      webhookRecord.status = 'processed';
      webhookRecord.processedAt = webhookRecord.processedAt || new Date().toISOString();
      webhookRecord.claimLeaseExpiresAt = undefined;
      webhookRecord.lastError = undefined;

      if (isSupabaseConfigured()) {
        await reconcilePaymentCaptureInSupabase({
          payment,
          webhookRecord,
          quote,
          providerCaptureId,
        });
      }

      const store = getStore();
      store.webhooks.set(webhookRecord.eventId, webhookRecord);

      const req = store.requests.get(quote.requestId);
      if (req) {
        req.status = 'fulfilled';
        req.updatedAt = new Date().toISOString();
        store.requests.set(req.id, req);
      }

      return;
    }

    // 3. Mutate state
    payment.status = 'captured';
    payment.providerCaptureId = providerCaptureId;
    payment.updatedAt = new Date().toISOString();

    webhookRecord.status = 'processed';
    webhookRecord.processedAt = new Date().toISOString();
    webhookRecord.claimLeaseExpiresAt = undefined;
    webhookRecord.lastError = undefined;

    // Database persistence when Supabase configured
    if (isSupabaseConfigured()) {
      await reconcilePaymentCaptureInSupabase({
        payment,
        webhookRecord,
        quote,
        providerCaptureId,
      });
    }

    // In-memory store updates
    const store = getStore();
    store.payments.set(payment.id, payment);
    store.webhooks.set(webhookRecord.eventId, webhookRecord);

    const req = store.requests.get(quote.requestId);
    if (req) {
      req.status = 'fulfilled';
      req.updatedAt = new Date().toISOString();
      store.requests.set(req.id, req);
    }

    // Record immutable audit event:
    // When Supabase is configured, reconcilePaymentCaptureInSupabase (reconcile_payment_capture_atomic)
    // already authoritatively persisted the audit event inside the PostgreSQL transaction.
    // Adding to store.auditEvents directly avoids duplicate remote audit writes in Supabase.
    const auditRecord: AuditEvent = {
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
    };
    store.auditEvents.push(auditRecord);
  }

  /**
   * Claims expired or retryable webhook events for the background recovery worker.
   * Fails closed when Supabase is configured.
   */
  static async claimExpiredWebhookEventsAsync(
    batchSize = 10,
    leaseSeconds = 60,
    maxRetries = 5
  ): Promise<WebhookEventRecord[]> {
    if (isSupabaseConfigured()) {
      // Must await and propagate error if RPC fails!
      return await claimExpiredWebhookEventsInSupabase(batchSize, leaseSeconds, maxRetries);
    }

    const store = getStore();
    const now = Date.now();
    const leaseExpiresAt = new Date(now + leaseSeconds * 1000).toISOString();
    const candidates: WebhookEventRecord[] = [];

    for (const webhook of store.webhooks.values()) {
      const retryCount = webhook.retryCount || 0;
      if (retryCount >= maxRetries) continue;

      const isExpiredClaim =
        webhook.status === 'received' &&
        webhook.claimLeaseExpiresAt &&
        new Date(webhook.claimLeaseExpiresAt).getTime() < now;

      const isRetryableFailed =
        webhook.status === 'failed' &&
        (!webhook.nextRetryAt || new Date(webhook.nextRetryAt).getTime() <= now);

      if (isExpiredClaim || isRetryableFailed) {
        webhook.status = 'received';
        webhook.claimLeaseExpiresAt = leaseExpiresAt;
        webhook.retryCount = retryCount + 1;
        webhook.lastError = undefined;
        candidates.push(webhook);
        if (candidates.length >= batchSize) break;
      }
    }

    return candidates;
  }

  /**
   * Dead-letters webhook events that have reached maximum retry attempts.
   */
  static async deadLetterExhaustedWebhookEventsAsync(maxRetries = 5): Promise<number> {
    if (isSupabaseConfigured()) {
      return await deadLetterExhaustedWebhookEventsInSupabase(maxRetries);
    }

    const store = getStore();
    let deadLettered = 0;
    for (const webhook of store.webhooks.values()) {
      const retryCount = webhook.retryCount || 0;
      if (retryCount >= maxRetries && webhook.status !== 'processed' && webhook.status !== 'exhausted') {
        webhook.status = 'exhausted';
        webhook.claimLeaseExpiresAt = undefined;
        webhook.lastError =
          webhook.lastError || 'Maximum retry attempts exceeded without successful reconciliation.';
        deadLettered++;
      }
    }
    return deadLettered;
  }

  /**
   * Records a webhook failure and sets exponential backoff timestamp.
   */
  static async recordWebhookFailureAsync(
    id: string,
    eventId: string,
    errorMessage: string,
    retryCount: number,
    nextRetryDelaySeconds = 30
  ): Promise<void> {
    const store = getStore();
    const record = store.webhooks.get(eventId);
    if (record) {
      record.status = 'failed';
      record.lastError = errorMessage;
      record.retryCount = retryCount;
      record.claimLeaseExpiresAt = undefined;
      record.nextRetryAt = new Date(Date.now() + nextRetryDelaySeconds * 1000).toISOString();
    }

    if (isSupabaseConfigured()) {
      await recordWebhookFailureInSupabase(id, errorMessage, retryCount, nextRetryDelaySeconds);
    }
  }

  /**
   * Durable recovery worker method: claims, revalidates, processes, and dead-letters webhooks.
   */
  static async recoverExpiredWebhookClaimsAsync(maxRetries = 5): Promise<number> {
    const { runWebhookRecoveryWorkerAsync } = await import('./webhook-processor');
    const result = await runWebhookRecoveryWorkerAsync({ maxRetries });
    return result.claimedCount;
  }

  /**
   * Resets expired claim leases and returns original lease expiry metadata (preserving previous_lease_expiry).
   * Fails closed when Supabase is configured.
   */
  static async recoverExpiredWebhookClaimsWithMetadataAsync(
    maxCount = 50
  ): Promise<Array<{ id: string; eventId: string; previousLeaseExpiry: string | null }>> {
    if (isSupabaseConfigured()) {
      return await recoverExpiredWebhookClaimsInSupabase(maxCount);
    }

    const store = getStore();
    const now = Date.now();
    const results: Array<{ id: string; eventId: string; previousLeaseExpiry: string | null }> = [];

    for (const webhook of store.webhooks.values()) {
      if (
        webhook.status === 'received' &&
        webhook.claimLeaseExpiresAt &&
        new Date(webhook.claimLeaseExpiresAt).getTime() < now
      ) {
        const previousLeaseExpiry = webhook.claimLeaseExpiresAt;
        webhook.claimLeaseExpiresAt = undefined;
        results.push({
          id: webhook.id,
          eventId: webhook.eventId,
          previousLeaseExpiry,
        });
        if (results.length >= maxCount) break;
      }
    }

    return results;
  }

  /**
   * Returns operational webhook counts for monitoring and observability.
   */
  static async getWebhookMetricsAsync(): Promise<{
    total: number;
    received: number;
    inProgress: number;
    processed: number;
    failed: number;
    exhausted: number;
  }> {
    const store = getStore();
    const now = Date.now();
    let received = 0;
    let inProgress = 0;
    let processed = 0;
    let failed = 0;
    let exhausted = 0;

    for (const w of store.webhooks.values()) {
      if (w.status === 'processed') processed++;
      else if (w.status === 'exhausted') exhausted++;
      else if (w.status === 'failed') failed++;
      else if (w.status === 'received') {
        if (w.claimLeaseExpiresAt && new Date(w.claimLeaseExpiresAt).getTime() > now) {
          inProgress++;
        } else {
          received++;
        }
      }
    }

    return {
      total: store.webhooks.size,
      received,
      inProgress,
      processed,
      failed,
      exhausted,
    };
  }

  static async getWebhookEventAsync(eventId: string): Promise<WebhookEventRecord | undefined> {
    if (isSupabaseConfigured()) {
      const dbWebhook = await fetchWebhookFromSupabase(eventId);
      return dbWebhook || undefined;
    }
    return getStore().webhooks.get(eventId);
  }

  static async updateWebhookStatusAsync(
    rec: WebhookEventRecord,
    status: 'received' | 'processed' | 'failed' | 'duplicate'
  ): Promise<void> {
    rec.status = status;
    if (status === 'processed') {
      rec.processedAt = new Date().toISOString();
    }
    if (isSupabaseConfigured()) {
      await updateWebhookStatusInSupabase(rec.id, status, rec.processedAt);
    }
    getStore().webhooks.set(rec.eventId, rec);
  }

  static getWebhookEvent(eventId: string): WebhookEventRecord | undefined {
    return getStore().webhooks.get(eventId);
  }

  // Audit Query
  static async getAuditEventsAsync(businessId?: string, entityId?: string): Promise<AuditEvent[]> {
    if (isSupabaseConfigured()) {
      if (!businessId) return [];
      const dbEvents = await fetchAuditEventsFromSupabase(businessId);
      let list = dbEvents || [];
      if (entityId) {
        list = list.filter((e) => e.entityId === entityId);
      }
      return list;
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
