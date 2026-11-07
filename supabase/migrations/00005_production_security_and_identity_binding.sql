-- ActionOS Pay: Migration 00005 - Production Security, Identity Binding & Privilege Lockdown
-- Addresses Phase 9 Enterprise Security & Governance Hardening:
-- 1. Cryptographically binds database approval identity to the authenticated session actor (auth.uid()).
-- 2. Prevents approver impersonation inside PostgreSQL transactions.
-- 3. Sets explicit search_path (public, auth, pg_temp) and SECURITY DEFINER on all financial stored procedures.
-- 4. Validates tenant membership for authenticated callers on quote persistence.
-- 5. Revokes execution privileges on all financial RPCs from PUBLIC and anon roles (Least Privilege Principle).
-- 6. Restricts payment reconciliation and webhook claiming strictly to service_role.

-- Function 0: Secure auth_user_business_ids with explicit search_path
CREATE OR REPLACE FUNCTION auth_user_business_ids()
RETURNS TABLE (business_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
  SELECT business_id FROM memberships WHERE user_id = auth.uid();
$$;


-- Function 1: persist_quote_and_transition_request_atomic
-- Enforces tenant membership verification for authenticated caller and explicit search_path
CREATE OR REPLACE FUNCTION persist_quote_and_transition_request_atomic(
  p_quote JSONB,
  p_items JSONB,
  p_request_id UUID,
  p_business_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_session_user_id UUID := auth.uid();
  v_quote_id UUID := (p_quote->>'id')::UUID;
  v_supplier_id UUID := (p_quote->>'supplier_id')::UUID;
  v_request procurement_requests%ROWTYPE;
  v_supplier suppliers%ROWTYPE;
  v_existing_quote quotes%ROWTYPE;
  v_product products%ROWTYPE;
  v_subtotal BIGINT := (p_quote->>'subtotal_cents')::BIGINT;
  v_tax BIGINT := COALESCE((p_quote->>'tax_cents')::BIGINT, 0);
  v_shipping BIGINT := COALESCE((p_quote->>'shipping_cents')::BIGINT, 0);
  v_total BIGINT := (p_quote->>'total_cents')::BIGINT;
  v_version INT := (p_quote->>'version')::INT;
  v_sum_items_total BIGINT := 0;
  v_item_rec JSONB;
  v_item_qty INT;
  v_item_unit_price BIGINT;
  v_item_total BIGINT;
  v_item_product_id UUID;
  v_rows_affected INT;
BEGIN
  -- 0. Authenticated Caller Identity & Tenant Membership Verification
  IF v_session_user_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM memberships
      WHERE business_id = p_business_id AND user_id = v_session_user_id
    ) THEN
      RAISE EXCEPTION 'Authorization failure: Authenticated caller % is not an active member of business %',
        v_session_user_id, p_business_id;
    END IF;
  END IF;

  -- 1. Validate tenant & request parameter consistency
  IF (p_quote->>'business_id')::UUID IS DISTINCT FROM p_business_id THEN
    RAISE EXCEPTION 'Tenant boundary violation: Quote business % does not match parameter business %',
      p_quote->>'business_id', p_business_id;
  END IF;

  IF p_request_id IS NOT NULL AND (p_quote->>'request_id')::UUID IS DISTINCT FROM p_request_id THEN
    RAISE EXCEPTION 'Relational integrity violation: Quote request ID % does not match expected %',
      p_quote->>'request_id', p_request_id;
  END IF;

  -- 2. Validate Supplier: Existence, Business Ownership, and Approval Status
  SELECT * INTO v_supplier FROM suppliers WHERE id = v_supplier_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Supplier integrity violation: Referenced supplier % does not exist', v_supplier_id;
  END IF;

  IF v_supplier.business_id IS DISTINCT FROM p_business_id THEN
    RAISE EXCEPTION 'Tenant boundary violation: Supplier % belongs to business %, not %',
      v_supplier_id, v_supplier.business_id, p_business_id;
  END IF;

  IF v_supplier.is_approved IS NOT TRUE THEN
    RAISE EXCEPTION 'Supplier governance violation: Supplier "%" (ID %) is not approved for procurement',
      v_supplier.name, v_supplier_id;
  END IF;

  -- 3. Validate Quote Financial Arithmetic: subtotal + tax + shipping = total
  IF (v_subtotal + v_tax + v_shipping) != v_total THEN
    RAISE EXCEPTION 'Financial arithmetic mismatch: subtotal (% cents) + tax (% cents) + shipping (% cents) != total (% cents)',
      v_subtotal, v_tax, v_shipping, v_total;
  END IF;

  -- 4. Validate Line Items Consistency and Math
  IF p_items IS NOT NULL AND jsonb_array_length(p_items) > 0 THEN
    FOR v_item_rec IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
      v_item_qty := (v_item_rec->>'quantity')::INT;
      v_item_unit_price := (v_item_rec->>'unit_price_cents')::BIGINT;
      v_item_total := (v_item_rec->>'total_cents')::BIGINT;

      IF v_item_qty <= 0 THEN
        RAISE EXCEPTION 'Item integrity violation: Quantity must be greater than zero for item "%"',
          v_item_rec->>'item_name';
      END IF;

      IF v_item_unit_price < 0 THEN
        RAISE EXCEPTION 'Item integrity violation: Unit price cannot be negative for item "%"',
          v_item_rec->>'item_name';
      END IF;

      IF (v_item_qty::BIGINT * v_item_unit_price) != v_item_total THEN
        RAISE EXCEPTION 'Item arithmetic mismatch: quantity (%) * unit_price (% cents) != total (% cents) for item "%"',
          v_item_qty, v_item_unit_price, v_item_total, v_item_rec->>'item_name';
      END IF;

      -- Validate catalogue product linkage if product_id is provided
      IF v_item_rec->>'product_id' IS NOT NULL THEN
        v_item_product_id := (v_item_rec->>'product_id')::UUID;
        SELECT * INTO v_product FROM products WHERE id = v_item_product_id FOR SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Product integrity violation: Referenced product % does not exist', v_item_product_id;
        END IF;

        IF v_product.business_id IS DISTINCT FROM p_business_id THEN
          RAISE EXCEPTION 'Tenant boundary violation: Product % belongs to business %, not %',
            v_item_product_id, v_product.business_id, p_business_id;
        END IF;

        IF v_product.supplier_id IS DISTINCT FROM v_supplier_id THEN
          RAISE EXCEPTION 'Supplier boundary violation: Product % belongs to supplier %, but quote is from %',
            v_item_product_id, v_product.supplier_id, v_supplier_id;
        END IF;
      END IF;

      v_sum_items_total := v_sum_items_total + v_item_total;
    END LOOP;

    -- Validate that sum of items equals quote subtotal
    IF v_sum_items_total != v_subtotal THEN
      RAISE EXCEPTION 'Financial arithmetic mismatch: Sum of item totals (% cents) does not match quote subtotal (% cents)',
        v_sum_items_total, v_subtotal;
    END IF;
  ELSE
    IF v_subtotal != 0 THEN
      RAISE EXCEPTION 'Financial arithmetic mismatch: Quote subtotal is % cents but line items are empty',
        v_subtotal;
    END IF;
  END IF;

  -- 5. Lock and validate existing quote if updating (versioning and immutability controls)
  SELECT * INTO v_existing_quote FROM quotes WHERE id = v_quote_id FOR UPDATE;
  IF FOUND THEN
    -- Verify immutability of core structural relationships
    IF v_existing_quote.business_id IS DISTINCT FROM p_business_id THEN
      RAISE EXCEPTION 'Immutability violation: Cannot transfer quote % to a different business (from % to %)',
        v_quote_id, v_existing_quote.business_id, p_business_id;
    END IF;

    IF v_existing_quote.request_id IS DISTINCT FROM p_request_id THEN
      RAISE EXCEPTION 'Immutability violation: Cannot rebind quote % to a different request (from % to %)',
        v_quote_id, v_existing_quote.request_id, p_request_id;
    END IF;

    IF v_existing_quote.supplier_id IS DISTINCT FROM v_supplier_id THEN
      RAISE EXCEPTION 'Immutability violation: Cannot change supplier for quote % (from % to %)',
        v_quote_id, v_existing_quote.supplier_id, v_supplier_id;
    END IF;

    -- Prevent modifying finalized quotes
    IF v_existing_quote.status IN ('approved', 'rejected') THEN
      RAISE EXCEPTION 'Immutability violation: Quote % is in final status "%" and cannot be modified',
        v_quote_id, v_existing_quote.status;
    END IF;

    -- Verify version progression: new version must equal current version + 1
    IF v_version != (v_existing_quote.version + 1) THEN
      RAISE EXCEPTION 'Version progression violation: New quote version % must be exactly current version % + 1',
        v_version, v_existing_quote.version;
    END IF;

    -- Clean out stale line items before rewriting revision items
    DELETE FROM quote_items WHERE quote_id = v_quote_id;
  ELSE
    -- Initial quote creation must start at version 1
    IF v_version != 1 THEN
      RAISE EXCEPTION 'Version initialization violation: Initial quote version must be 1, got %', v_version;
    END IF;
  END IF;

  -- 6. Lock and validate procurement request if present
  IF p_request_id IS NOT NULL THEN
    SELECT * INTO v_request FROM procurement_requests WHERE id = p_request_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Relational integrity violation: Procurement request % does not exist', p_request_id;
    END IF;

    IF v_request.business_id IS DISTINCT FROM p_business_id THEN
      RAISE EXCEPTION 'Tenant boundary violation: Request business % does not match parameter %',
        v_request.business_id, p_business_id;
    END IF;

    IF v_request.status NOT IN ('open', 'quoted', 'pending_approval', 'draft') THEN
      RAISE EXCEPTION 'Invalid state transition: Cannot attach quote to request in status "%"', v_request.status;
    END IF;
  END IF;

  -- 7. Upsert quote
  INSERT INTO quotes (
    id,
    request_id,
    business_id,
    supplier_id,
    supplier_name,
    version,
    subtotal_cents,
    tax_cents,
    shipping_cents,
    total_cents,
    currency,
    checksum_hash,
    status,
    expires_at,
    created_at
  ) VALUES (
    v_quote_id,
    p_request_id,
    p_business_id,
    v_supplier_id,
    p_quote->>'supplier_name',
    v_version,
    v_subtotal,
    v_tax,
    v_shipping,
    v_total,
    p_quote->>'currency',
    p_quote->>'checksum_hash',
    p_quote->>'status',
    (p_quote->>'expires_at')::TIMESTAMPTZ,
    (p_quote->>'created_at')::TIMESTAMPTZ
  )
  ON CONFLICT (id) DO UPDATE SET
    version = EXCLUDED.version,
    subtotal_cents = EXCLUDED.subtotal_cents,
    tax_cents = EXCLUDED.tax_cents,
    shipping_cents = EXCLUDED.shipping_cents,
    total_cents = EXCLUDED.total_cents,
    checksum_hash = EXCLUDED.checksum_hash,
    status = EXCLUDED.status,
    expires_at = EXCLUDED.expires_at;

  -- 8. Insert quote items
  IF p_items IS NOT NULL AND jsonb_array_length(p_items) > 0 THEN
    INSERT INTO quote_items (id, quote_id, product_id, item_name, sku, quantity, unit_price_cents, total_cents)
    SELECT
      (item->>'id')::UUID,
      v_quote_id,
      CASE WHEN item->>'product_id' IS NOT NULL THEN (item->>'product_id')::UUID ELSE NULL END,
      item->>'item_name',
      item->>'sku',
      (item->>'quantity')::INT,
      (item->>'unit_price_cents')::BIGINT,
      (item->>'total_cents')::BIGINT
    FROM jsonb_array_elements(p_items) AS item;
  END IF;

  -- 9. Transition procurement request status to 'quoted' and bind active quote
  IF p_request_id IS NOT NULL THEN
    UPDATE procurement_requests
    SET status = 'quoted',
        active_quote_id = v_quote_id,
        updated_at = now()
    WHERE id = p_request_id
      AND business_id = p_business_id;

    GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
    IF v_rows_affected != 1 THEN
      RAISE EXCEPTION 'Failed to update procurement request %: expected 1 row, got %', p_request_id, v_rows_affected;
    END IF;
  END IF;

  -- 10. Record transactional audit event
  INSERT INTO audit_events (
    id, business_id, entity_type, entity_id, actor_id, actor_role, action, payload, created_at
  ) VALUES (
    gen_random_uuid(),
    p_business_id,
    'quote',
    v_quote_id::TEXT,
    COALESCE(v_session_user_id::TEXT, 'quote_engine'),
    CASE WHEN v_session_user_id IS NOT NULL THEN 'authenticated_user' ELSE 'system_calculator' END,
    'QUOTE_CALCULATED_AND_BOUND',
    jsonb_build_object(
      'quoteId', v_quote_id,
      'requestId', p_request_id,
      'version', v_version,
      'totalCents', v_total,
      'currency', p_quote->>'currency'
    ),
    now()
  );

  RETURN true;
END;
$$;


-- Function 2: persist_approval_and_transition_atomic
-- Enforces:
-- 1. Identity binding to auth.uid() (prevents caller from approving as another member)
-- 2. SECURITY DEFINER with fixed search_path = public, auth, pg_temp
-- 3. Approver membership, authorized role, spending limit, and segregation-of-duties
CREATE OR REPLACE FUNCTION persist_approval_and_transition_atomic(
  p_approval JSONB,
  p_quote_id UUID,
  p_request_id UUID,
  p_business_id UUID,
  p_decision TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_session_user_id UUID := auth.uid();
  v_approval_id UUID := (p_approval->>'id')::UUID;
  v_approver_id UUID := (p_approval->>'approver_id')::UUID;
  v_quote quotes%ROWTYPE;
  v_request procurement_requests%ROWTYPE;
  v_member memberships%ROWTYPE;
  v_quote_status TEXT := p_decision;
  v_request_status TEXT := p_decision;
  v_rows_affected INT;
BEGIN
  -- 0. Identity Binding: Verify that the authenticated session actor matches submitted approver_id
  IF v_session_user_id IS NOT NULL AND v_session_user_id IS DISTINCT FROM v_approver_id THEN
    RAISE EXCEPTION 'Authorization failure: Authenticated session actor % cannot approve or reject quote on behalf of approver %',
      v_session_user_id, v_approver_id;
  END IF;

  -- 1. Validate decision value
  IF p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Approval integrity violation: Invalid decision "%". Must be "approved" or "rejected"', p_decision;
  END IF;

  IF (p_approval->>'decision') IS DISTINCT FROM p_decision THEN
    RAISE EXCEPTION 'Approval integrity violation: Payload decision "%" does not match transition decision "%"',
      p_approval->>'decision', p_decision;
  END IF;

  -- 2. Lock and validate quote
  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Approval integrity violation: Referenced quote % does not exist', p_quote_id;
  END IF;

  IF v_quote.business_id IS DISTINCT FROM p_business_id THEN
    RAISE EXCEPTION 'Tenant boundary violation: Quote business % does not match approval business %',
      v_quote.business_id, p_business_id;
  END IF;

  IF (p_approval->>'quote_id')::UUID IS DISTINCT FROM p_quote_id THEN
    RAISE EXCEPTION 'Approval integrity violation: Payload quote ID % does not match expected quote %',
      p_approval->>'quote_id', p_quote_id;
  END IF;

  IF (p_approval->>'business_id')::UUID IS DISTINCT FROM p_business_id THEN
    RAISE EXCEPTION 'Tenant boundary violation: Payload business ID % does not match expected %',
      p_approval->>'business_id', p_business_id;
  END IF;

  -- 3. Verify quote version match
  IF (p_approval->>'quote_version')::INT IS DISTINCT FROM v_quote.version THEN
    RAISE EXCEPTION 'Approval integrity violation: Approval quote version % does not match current quote version %',
      p_approval->>'quote_version', v_quote.version;
  END IF;

  -- 4. Verify approved amount and currency match quote
  IF (p_approval->>'approved_total_cents')::BIGINT != v_quote.total_cents THEN
    RAISE EXCEPTION 'Approval integrity violation: Approved amount % cents does not match quote total % cents',
      (p_approval->>'approved_total_cents')::BIGINT, v_quote.total_cents;
  END IF;

  IF UPPER(p_approval->>'approved_currency') != UPPER(v_quote.currency) THEN
    RAISE EXCEPTION 'Approval integrity violation: Approved currency "%" does not match quote currency "%"',
      p_approval->>'approved_currency', v_quote.currency;
  END IF;

  -- 5. Verify approved supplier matches quote
  IF (p_approval->>'approved_supplier_id')::UUID IS DISTINCT FROM v_quote.supplier_id THEN
    RAISE EXCEPTION 'Approval integrity violation: Approved supplier ID % does not match quote supplier %',
      p_approval->>'approved_supplier_id', v_quote.supplier_id;
  END IF;

  -- 6. Verify quote is in a state eligible for approval (Concurrency & Race-Condition Guard)
  IF v_quote.status NOT IN ('active', 'pending_approval', 'quoted') THEN
    RAISE EXCEPTION 'Invalid state transition: Quote % is in status "%" which cannot be transitioned by approval',
      p_quote_id, v_quote.status;
  END IF;

  -- 7. Lock and validate procurement request if present
  IF p_request_id IS NOT NULL THEN
    IF v_quote.request_id IS DISTINCT FROM p_request_id THEN
      RAISE EXCEPTION 'Relational integrity violation: Quote request ID % does not match expected %',
        v_quote.request_id, p_request_id;
    END IF;

    SELECT * INTO v_request FROM procurement_requests WHERE id = p_request_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Approval integrity violation: Referenced procurement request % does not exist', p_request_id;
    END IF;

    IF v_request.business_id IS DISTINCT FROM p_business_id THEN
      RAISE EXCEPTION 'Tenant boundary violation: Procurement request business % does not match %',
        v_request.business_id, p_business_id;
    END IF;

    IF v_request.status NOT IN ('open', 'quoted', 'pending_approval', 'draft') THEN
      RAISE EXCEPTION 'Invalid state transition: Procurement request % is in status "%" which cannot be transitioned by approval',
        p_request_id, v_request.status;
    END IF;
  END IF;

  -- 8. Approver Membership, Authority & Segregation-of-Duties (Dual Control) Validation
  SELECT * INTO v_member FROM memberships
  WHERE business_id = p_business_id AND user_id = v_approver_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Authorization failure: Approver % is not an active member of business %',
      v_approver_id, p_business_id;
  END IF;

  IF v_member.role NOT IN ('approver', 'admin') THEN
    RAISE EXCEPTION 'Authorization failure: Member % has role "%" which is unauthorized to approve quotes (must be approver or admin)',
      v_approver_id, v_member.role;
  END IF;

  IF v_member.approval_limit_cents < v_quote.total_cents THEN
    RAISE EXCEPTION 'Authorization failure: Quote total (% cents) exceeds member % approval limit of % cents',
      v_quote.total_cents, v_approver_id, v_member.approval_limit_cents;
  END IF;

  IF p_request_id IS NOT NULL AND v_request.requester_id IS NOT NULL AND v_approver_id = v_request.requester_id THEN
    RAISE EXCEPTION 'Governance violation: Self-approval prohibited. Requester % cannot approve their own procurement request %',
      v_approver_id, p_request_id;
  END IF;

  -- 9. Insert approval record
  INSERT INTO approvals (
    id, quote_id, business_id, approver_id, approver_name, approver_role,
    quote_version, approved_total_cents, approved_currency, approved_supplier_id,
    decision, reason, digital_signature, created_at
  ) VALUES (
    v_approval_id,
    p_quote_id,
    p_business_id,
    v_approver_id,
    p_approval->>'approver_name',
    p_approval->>'approver_role',
    (p_approval->>'quote_version')::INT,
    (p_approval->>'approved_total_cents')::BIGINT,
    p_approval->>'approved_currency',
    (p_approval->>'approved_supplier_id')::UUID,
    p_decision,
    p_approval->>'reason',
    p_approval->>'digital_signature',
    (p_approval->>'created_at')::TIMESTAMPTZ
  );

  -- 10. Update quote status atomically
  UPDATE quotes
  SET status = v_quote_status
  WHERE id = p_quote_id
    AND business_id = p_business_id;

  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  IF v_rows_affected != 1 THEN
    RAISE EXCEPTION 'Failed to update quote status %: expected 1 row, got %', p_quote_id, v_rows_affected;
  END IF;

  -- 11. Update procurement request status atomically if present
  IF p_request_id IS NOT NULL THEN
    UPDATE procurement_requests
    SET status = v_request_status,
        updated_at = now()
    WHERE id = p_request_id;

    GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
    IF v_rows_affected != 1 THEN
      RAISE EXCEPTION 'Failed to update procurement request status %: expected 1 row, got %', p_request_id, v_rows_affected;
    END IF;
  END IF;

  -- 12. Record transactional audit event
  INSERT INTO audit_events (
    id, business_id, entity_type, entity_id, actor_id, actor_role, action, payload, created_at
  ) VALUES (
    gen_random_uuid(),
    p_business_id,
    'approval',
    v_approval_id::TEXT,
    v_approver_id::TEXT,
    p_approval->>'approver_role',
    CASE WHEN p_decision = 'approved' THEN 'QUOTE_APPROVED' ELSE 'QUOTE_REJECTED' END,
    jsonb_build_object(
      'approvalId', v_approval_id,
      'quoteId', p_quote_id,
      'requestId', p_request_id,
      'decision', p_decision,
      'approverId', v_approver_id,
      'reason', p_approval->>'reason'
    ),
    now()
  );

  RETURN true;
END;
$$;


-- Function 3: reconcile_payment_capture_atomic
-- Enforces:
-- 1. Cryptographic signature verification check
-- 2. Strict capture idempotency and conflict rejection
-- 3. SECURITY DEFINER with fixed search_path = public, auth, pg_temp
CREATE OR REPLACE FUNCTION reconcile_payment_capture_atomic(
  p_payment_id UUID,
  p_provider_capture_id TEXT,
  p_webhook_id UUID,
  p_quote_id UUID,
  p_request_id UUID,
  p_business_id UUID,
  p_amount_cents BIGINT,
  p_currency TEXT,
  p_event_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_payment payment_attempts%ROWTYPE;
  v_quote quotes%ROWTYPE;
  v_request procurement_requests%ROWTYPE;
  v_webhook webhook_events%ROWTYPE;
  v_rows_affected INT;
BEGIN
  -- 1. Lock and validate payment attempt
  SELECT * INTO v_payment FROM payment_attempts WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial reconciliation failed: Payment attempt % does not exist', p_payment_id;
  END IF;

  IF v_payment.business_id IS DISTINCT FROM p_business_id THEN
    RAISE EXCEPTION 'Tenant boundary violation: Payment business ID % does not match expected %',
      v_payment.business_id, p_business_id;
  END IF;

  -- 2. Lock and validate quote
  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial reconciliation failed: Referenced quote % does not exist', p_quote_id;
  END IF;

  IF v_quote.business_id IS DISTINCT FROM p_business_id THEN
    RAISE EXCEPTION 'Tenant boundary violation: Quote business ID % does not match expected %',
      v_quote.business_id, p_business_id;
  END IF;

  -- 3. Verify payment-to-quote binding
  IF v_payment.quote_id IS DISTINCT FROM p_quote_id THEN
    RAISE EXCEPTION 'Relational integrity violation: Payment quote ID % does not match expected %',
      v_payment.quote_id, p_quote_id;
  END IF;

  -- 4. Verify financial amount and currency match approved quote exactly
  IF v_quote.total_cents != p_amount_cents THEN
    RAISE EXCEPTION 'Financial reconciliation failed: Webhook amount % cents does not match quote total % cents',
      p_amount_cents, v_quote.total_cents;
  END IF;

  IF UPPER(v_quote.currency) != UPPER(p_currency) THEN
    RAISE EXCEPTION 'Financial reconciliation failed: Webhook currency % does not match quote currency %',
      p_currency, v_quote.currency;
  END IF;

  -- 5. Lock and validate webhook event record
  SELECT * INTO v_webhook FROM webhook_events WHERE id = p_webhook_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial reconciliation failed: Referenced webhook event % does not exist', p_webhook_id;
  END IF;

  -- Require cryptographic signature verification
  IF v_webhook.signature_verified IS NOT TRUE THEN
    RAISE EXCEPTION 'Security violation: Webhook event % cannot be reconciled because signature is unverified',
      p_webhook_id;
  END IF;

  -- 6. Lock and validate procurement request if present
  IF p_request_id IS NOT NULL THEN
    IF v_quote.request_id IS DISTINCT FROM p_request_id THEN
      RAISE EXCEPTION 'Relational integrity violation: Quote request ID % does not match expected %',
        v_quote.request_id, p_request_id;
    END IF;

    SELECT * INTO v_request FROM procurement_requests WHERE id = p_request_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Financial reconciliation failed: Referenced procurement request % does not exist', p_request_id;
    END IF;

    IF v_request.business_id IS DISTINCT FROM p_business_id THEN
      RAISE EXCEPTION 'Tenant boundary violation: Procurement request business ID % does not match expected %',
        v_request.business_id, p_business_id;
    END IF;
  END IF;

  -- 7. Idempotency Check & Conflicting Capture Guard
  IF v_payment.status = 'captured' THEN
    IF v_payment.provider_capture_id = p_provider_capture_id THEN
      -- Identical capture ID already processed: return true idempotently
      RETURN true;
    ELSE
      -- Different capture ID on already-captured payment indicates conflict or fraud!
      RAISE EXCEPTION 'Reconciliation conflict: Payment % is already captured under provider ID %, conflicting capture % rejected',
        p_payment_id, v_payment.provider_capture_id, p_provider_capture_id;
    END IF;
  END IF;

  -- 8. Reconcile Payment Attempt
  UPDATE payment_attempts
  SET status = 'captured',
      provider_capture_id = p_provider_capture_id,
      amount_cents = p_amount_cents,
      currency = p_currency,
      updated_at = now()
  WHERE id = p_payment_id;

  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  IF v_rows_affected != 1 THEN
    RAISE EXCEPTION 'Failed to update payment_attempts %: expected 1 row, got %', p_payment_id, v_rows_affected;
  END IF;

  -- 9. Reconcile Webhook Event
  UPDATE webhook_events
  SET status = 'processed',
      claim_lease_expires_at = NULL,
      updated_at = now()
  WHERE id = p_webhook_id;

  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  IF v_rows_affected != 1 THEN
    RAISE EXCEPTION 'Failed to update webhook_events %: expected 1 row, got %', p_webhook_id, v_rows_affected;
  END IF;

  -- 10. Reconcile Procurement Request Status to 'fulfilled'
  IF p_request_id IS NOT NULL THEN
    UPDATE procurement_requests
    SET status = 'fulfilled',
        updated_at = now()
    WHERE id = p_request_id;

    GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
    IF v_rows_affected != 1 THEN
      RAISE EXCEPTION 'Failed to update procurement request % to completed: expected 1 row, got %', p_request_id, v_rows_affected;
    END IF;
  END IF;

  -- 11. Transactional Audit Event
  INSERT INTO audit_events (
    id, business_id, entity_type, entity_id, actor_id, actor_role, action, payload, created_at
  ) VALUES (
    gen_random_uuid(),
    p_business_id,
    'payment',
    p_payment_id::TEXT,
    'paypal_webhook',
    'external_gateway',
    'PAYMENT_CAPTURED_AND_RECONCILED',
    jsonb_build_object(
      'eventId', p_event_id,
      'amountCents', p_amount_cents,
      'currency', p_currency,
      'providerCaptureId', p_provider_capture_id,
      'quoteId', p_quote_id,
      'requestId', p_request_id
    ),
    now()
  );

  RETURN true;
END;
$$;


-- Function 4: claim_webhook_event
-- Enforces:
-- 1. Atomic lease contention & worker recovery
-- 2. SECURITY DEFINER with fixed search_path = public, auth, pg_temp
CREATE OR REPLACE FUNCTION claim_webhook_event(
  p_id UUID,
  p_provider TEXT,
  p_event_id TEXT,
  p_event_type TEXT,
  p_payload JSONB,
  p_signature_verified BOOLEAN DEFAULT true,
  p_lease_seconds INT DEFAULT 60
)
RETURNS TABLE (
  claimed BOOLEAN,
  claim_status TEXT,
  event_row webhook_events
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_existing webhook_events%ROWTYPE;
BEGIN
  -- Lock and query existing event row if present
  SELECT * INTO v_existing FROM webhook_events WHERE event_id = p_event_id FOR UPDATE;

  IF FOUND THEN
    -- Invariant: An existing verified event must NEVER be overwritten by an unverified claim
    IF v_existing.signature_verified IS TRUE AND p_signature_verified IS NOT TRUE THEN
      RAISE EXCEPTION 'Security violation: Attempted to claim verified event % with unverified payload', p_event_id;
    END IF;

    IF v_existing.status = 'processed' THEN
      RETURN QUERY SELECT false, 'already_processed'::TEXT, v_existing;
      RETURN;
    ELSIF v_existing.status = 'received' THEN
      -- Active worker lease check: prevent concurrent worker double-processing
      IF v_existing.claim_lease_expires_at IS NOT NULL AND v_existing.claim_lease_expires_at > now() THEN
        RETURN QUERY SELECT false, 'active_claim_in_progress'::TEXT, v_existing;
        RETURN;
      ELSE
        -- Lease expired (worker crashed or abandoned). Recover stale claim safely!
        UPDATE webhook_events
        SET claim_lease_expires_at = now() + (p_lease_seconds || ' seconds')::INTERVAL,
            payload = p_payload,
            signature_verified = CASE WHEN v_existing.signature_verified THEN true ELSE p_signature_verified END
        WHERE id = v_existing.id
        RETURNING * INTO v_existing;

        RETURN QUERY SELECT true, 'recovered'::TEXT, v_existing;
        RETURN;
      END IF;
    ELSIF v_existing.status = 'failed' THEN
      -- Retryable failed event: allow re-claim
      UPDATE webhook_events
      SET status = 'received',
          claim_lease_expires_at = now() + (p_lease_seconds || ' seconds')::INTERVAL,
          payload = p_payload,
          signature_verified = CASE WHEN v_existing.signature_verified THEN true ELSE p_signature_verified END
        WHERE id = v_existing.id
      RETURNING * INTO v_existing;

      RETURN QUERY SELECT true, 'retried'::TEXT, v_existing;
      RETURN;
    ELSE
      RETURN QUERY SELECT false, v_existing.status, v_existing;
      RETURN;
    END IF;
  END IF;

  -- Insert new claimed event with active lease TTL
  INSERT INTO webhook_events (
    id, provider, event_id, event_type, payload, signature_verified, status, claim_lease_expires_at, created_at
  ) VALUES (
    p_id, p_provider, p_event_id, p_event_type, p_payload, p_signature_verified, 'received',
    now() + (p_lease_seconds || ' seconds')::INTERVAL, now()
  )
  RETURNING * INTO v_existing;

  RETURN QUERY SELECT true, 'claimed'::TEXT, v_existing;
END;
$$;


-- =========================================================================================
-- SQL FUNCTION SECURITY & PRIVILEGE LOCKDOWN (Least Privilege Principle)
-- =========================================================================================

-- Compatibility: Ensure Supabase roles exist on standalone PostgreSQL environments
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END $$;

-- 1. Revoke all execution privileges from untrusted roles (PUBLIC and anon)
REVOKE ALL ON FUNCTION auth_user_business_ids() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION persist_quote_and_transition_request_atomic(JSONB, JSONB, UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION persist_approval_and_transition_atomic(JSONB, UUID, UUID, UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION reconcile_payment_capture_atomic(UUID, TEXT, UUID, UUID, UUID, UUID, BIGINT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION claim_webhook_event(UUID, TEXT, TEXT, TEXT, JSONB, BOOLEAN, INT) FROM PUBLIC, anon;

-- 2. Grant execution for user-facing workflows to authenticated members and backend service_role
GRANT EXECUTE ON FUNCTION auth_user_business_ids() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION persist_quote_and_transition_request_atomic(JSONB, JSONB, UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION persist_approval_and_transition_atomic(JSONB, UUID, UUID, UUID, TEXT) TO authenticated, service_role;

-- 3. Restrict critical financial reconciliation and webhook claiming strictly to service_role (engine only)
GRANT EXECUTE ON FUNCTION reconcile_payment_capture_atomic(UUID, TEXT, UUID, UUID, UUID, UUID, BIGINT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION claim_webhook_event(UUID, TEXT, TEXT, TEXT, JSONB, BOOLEAN, INT) TO service_role;
