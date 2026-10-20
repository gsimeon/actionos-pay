// ActionOS Pay: Core TypeScript Types & Domain Interfaces

export type ProcurementStatus =
  | 'draft'
  | 'clarification_needed'
  | 'quoted'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'payment_pending'
  | 'paid'
  | 'fulfilled'
  | 'cancelled';

export type QuoteStatus = 'active' | 'superseded' | 'approved' | 'rejected' | 'expired';

export type PaymentStatus = 'created' | 'approved' | 'captured' | 'failed' | 'reconciling';

export type UserRole = 'requester' | 'approver' | 'admin' | 'auditor';

export interface Business {
  id: string;
  name: string;
  slug: string;
  defaultCurrency: string;
  budgetLimitCents: number;
  createdAt: string;
}

export interface TeamMember {
  id: string;
  businessId: string;
  userId: string;
  userName: string;
  userEmail: string;
  role: UserRole;
  approvalLimitCents: number;
}

export interface Supplier {
  id: string;
  businessId: string;
  name: string;
  code: string;
  isApproved: boolean;
  riskRating: 'low' | 'medium' | 'high' | 'restricted';
  country: string;
  contactEmail?: string;
}

export interface Product {
  id: string;
  businessId: string;
  supplierId: string;
  sku: string;
  name: string;
  description: string;
  category: string;
  unitPriceCents: number; // Integer minor units (e.g. 179900 = $1,799.00)
  currency: string;
  inStock: boolean;
}

export interface PlanItem {
  sku?: string;
  matchedProductId?: string;
  productName: string;
  description?: string;
  quantity: number;
  estimatedUnitPriceCents?: number;
  suggestedSupplierId?: string;
  suggestedSupplierName?: string;
}

export interface StructuredPlan {
  summary: string;
  justification?: string;
  currency: string;
  budgetLimitCents: number;
  items: PlanItem[];
  clarificationNeeded: boolean;
  clarificationQuestions?: string[];
  suggestedSupplierId?: string;
  confidenceScore: number; // 0.0 - 1.0
}

export interface QuoteItem {
  id: string;
  quoteId: string;
  productId?: string;
  sku?: string;
  itemName: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
}

export interface Quote {
  id: string;
  requestId: string;
  businessId: string;
  supplierId: string;
  supplierName: string;
  version: number;
  items: QuoteItem[];
  subtotalCents: number;
  taxCents: number;
  shippingCents: number;
  totalCents: number;
  currency: string;
  checksumHash: string; // SHA-256 seal of the quote terms
  status: QuoteStatus;
  expiresAt: string;
  createdAt: string;
}

export interface PolicyCheckItem {
  code: string;
  name: string;
  passed: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface PolicyEvaluationResult {
  passed: boolean;
  checks: PolicyCheckItem[];
  violations: string[];
}

export interface Approval {
  id: string;
  quoteId: string;
  businessId: string;
  approverId: string;
  approverName: string;
  approverRole: UserRole;
  quoteVersion: number;
  approvedTotalCents: number;
  approvedCurrency: string;
  approvedSupplierId: string;
  decision: 'approved' | 'rejected';
  reason?: string;
  digitalSignature: string; // Cryptographic verification seal
  createdAt: string;
}

export interface PaymentAttempt {
  id: string;
  quoteId: string;
  businessId: string;
  provider: 'paypal';
  providerOrderId?: string;
  providerCaptureId?: string;
  amountCents: number;
  currency: string;
  status: PaymentStatus;
  idempotencyKey: string;
  providerResponse?: Record<string, unknown>;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEvent {
  id: string;
  businessId: string;
  entityType: 'request' | 'quote' | 'approval' | 'payment' | 'webhook' | 'policy';
  entityId: string;
  actorId: string;
  actorRole: string;
  action: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface WebhookEventRecord {
  id: string;
  provider: 'paypal';
  eventId: string;
  eventType: string;
  signatureVerified: boolean;
  payload: Record<string, unknown>;
  status: 'received' | 'processed' | 'duplicate' | 'failed';
  processedAt?: string;
  createdAt: string;
}

export interface ProcurementRequest {
  id: string;
  businessId: string;
  requesterId: string;
  requesterName: string;
  rawPrompt: string;
  structuredPlan?: StructuredPlan;
  status: ProcurementStatus;
  budgetLimitCents: number;
  currency: string;
  activeQuoteId?: string;
  clarificationQuestions?: string[];
  createdAt: string;
  updatedAt: string;
}
