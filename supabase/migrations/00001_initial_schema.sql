-- ActionOS Pay: Initial Schema Migration
-- Establishes businesses, memberships, catalogue, procurement requests,
-- quotes, quote items, approvals, payment attempts, webhooks and append-only audit events.

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Businesses (Tenants)
CREATE TABLE IF NOT EXISTS businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  default_currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  budget_limit_cents BIGINT NOT NULL DEFAULT 1000000, -- $10,000.00 limit
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Memberships (User association and roles within a business)
CREATE TABLE IF NOT EXISTS memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  user_name TEXT NOT NULL,
  user_email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('requester', 'approver', 'admin', 'auditor')),
  approval_limit_cents BIGINT NOT NULL DEFAULT 1000000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(business_id, user_id)
);

-- 3. Suppliers (Approved & unapproved vendor registry)
CREATE TABLE IF NOT EXISTS suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  is_approved BOOLEAN NOT NULL DEFAULT false,
  risk_rating TEXT NOT NULL DEFAULT 'low' CHECK (risk_rating IN ('low', 'medium', 'high', 'restricted')),
  country VARCHAR(2) NOT NULL DEFAULT 'US',
  contact_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Products (Catalogue items priced in integer minor units)
CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,
  unit_price_cents BIGINT NOT NULL CHECK (unit_price_cents >= 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  in_stock BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(business_id, sku)
);

-- 5. Procurement Requests
CREATE TABLE IF NOT EXISTS procurement_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  requester_id UUID NOT NULL,
  requester_name TEXT NOT NULL,
  raw_prompt TEXT NOT NULL,
  structured_plan JSONB,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'clarification_needed', 'quoted', 'pending_approval', 'approved', 'rejected', 'payment_pending', 'paid', 'fulfilled', 'cancelled')
  ),
  budget_limit_cents BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  clarification_questions JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6. Quotes (Immutable versioned quotes)
CREATE TABLE IF NOT EXISTS quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES procurement_requests(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  supplier_name TEXT NOT NULL,
  version INT NOT NULL DEFAULT 1,
  subtotal_cents BIGINT NOT NULL CHECK (subtotal_cents >= 0),
  tax_cents BIGINT NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  shipping_cents BIGINT NOT NULL DEFAULT 0 CHECK (shipping_cents >= 0),
  total_cents BIGINT NOT NULL CHECK (total_cents >= 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  checksum_hash TEXT NOT NULL, -- SHA-256 seal of quote content & pricing
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'approved', 'rejected', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(request_id, version)
);

-- 7. Quote Items
CREATE TABLE IF NOT EXISTS quote_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id),
  item_name TEXT NOT NULL,
  sku TEXT,
  quantity INT NOT NULL CHECK (quantity > 0),
  unit_price_cents BIGINT NOT NULL CHECK (unit_price_cents >= 0),
  total_cents BIGINT NOT NULL CHECK (total_cents >= 0)
);

-- 8. Approvals (Cryptographically bound approval records)
CREATE TABLE IF NOT EXISTS approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  approver_id UUID NOT NULL,
  approver_name TEXT NOT NULL,
  approver_role TEXT NOT NULL,
  quote_version INT NOT NULL,
  approved_total_cents BIGINT NOT NULL,
  approved_currency VARCHAR(3) NOT NULL,
  approved_supplier_id UUID NOT NULL REFERENCES suppliers(id),
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason TEXT,
  digital_signature TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 9. Payment Attempts (PayPal Orders & Capture tracking)
CREATE TABLE IF NOT EXISTS payment_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'paypal' CHECK (provider IN ('paypal')),
  provider_order_id TEXT,
  provider_capture_id TEXT,
  amount_cents BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'approved', 'captured', 'failed', 'reconciling')),
  idempotency_key TEXT UNIQUE NOT NULL,
  provider_response JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 10. Webhook Events (Idempotent, deduplicated provider events)
CREATE TABLE IF NOT EXISTS webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL DEFAULT 'paypal',
  event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL,
  signature_verified BOOLEAN NOT NULL DEFAULT false,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'duplicate', 'failed')),
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 11. Audit Events (Append-only immutable audit trail)
CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for performance & audit lookups
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_business ON memberships(business_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_business ON suppliers(business_id);
CREATE INDEX IF NOT EXISTS idx_products_business ON products(business_id);
CREATE INDEX IF NOT EXISTS idx_products_supplier ON products(supplier_id);
CREATE INDEX IF NOT EXISTS idx_requests_business ON procurement_requests(business_id);
CREATE INDEX IF NOT EXISTS idx_quotes_request ON quotes(request_id);
CREATE INDEX IF NOT EXISTS idx_quotes_business ON quotes(business_id);
CREATE INDEX IF NOT EXISTS idx_approvals_quote ON approvals(quote_id);
CREATE INDEX IF NOT EXISTS idx_approvals_business ON approvals(business_id);
CREATE INDEX IF NOT EXISTS idx_payments_quote ON payment_attempts(quote_id);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payment_attempts(provider_order_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_business ON audit_events(business_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_entity ON audit_events(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_event_id ON webhook_events(event_id);

-- Row Level Security (RLS)
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE procurement_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;

-- Helper to fetch user's accessible businesses
CREATE OR REPLACE FUNCTION auth_user_business_ids()
RETURNS TABLE (business_id UUID) AS $$
  SELECT business_id FROM memberships WHERE user_id = auth.uid();
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Tenant Isolation Policies
CREATE POLICY "Tenant isolation for businesses" ON businesses
  FOR ALL USING (id IN (SELECT auth_user_business_ids()));

CREATE POLICY "Tenant isolation for memberships" ON memberships
  FOR ALL USING (business_id IN (SELECT auth_user_business_ids()));

CREATE POLICY "Tenant isolation for suppliers" ON suppliers
  FOR ALL USING (business_id IN (SELECT auth_user_business_ids()));

CREATE POLICY "Tenant isolation for products" ON products
  FOR ALL USING (business_id IN (SELECT auth_user_business_ids()));

CREATE POLICY "Tenant isolation for requests" ON procurement_requests
  FOR ALL USING (business_id IN (SELECT auth_user_business_ids()));

CREATE POLICY "Tenant isolation for quotes" ON quotes
  FOR ALL USING (business_id IN (SELECT auth_user_business_ids()));

CREATE POLICY "Tenant isolation for quote items" ON quote_items
  FOR ALL USING (quote_id IN (SELECT id FROM quotes WHERE business_id IN (SELECT auth_user_business_ids())));

CREATE POLICY "Tenant isolation for approvals" ON approvals
  FOR ALL USING (business_id IN (SELECT auth_user_business_ids()));

CREATE POLICY "Tenant isolation for payments" ON payment_attempts
  FOR ALL USING (business_id IN (SELECT auth_user_business_ids()));

CREATE POLICY "Tenant isolation for audit events" ON audit_events
  FOR SELECT USING (business_id IN (SELECT auth_user_business_ids()));

-- Audit table is append-only: prevent update and delete
CREATE POLICY "Audit events insert only" ON audit_events
  FOR INSERT WITH CHECK (business_id IN (SELECT auth_user_business_ids()));
