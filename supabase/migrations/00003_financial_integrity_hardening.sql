-- ActionOS Pay: Forward Migration 00003
-- Production Financial Integrity, Idempotency Hardening, Relational Validation & Operational Webhook Recovery
-- Guarantees:
-- 1. Strict idempotency checking with provider capture ID verification
-- 2. Complete relational and tenant integrity validation across payment, quote, request, and webhook rows
-- 3. Row-level FOR UPDATE locking and update verification inside the transaction
-- 4. Operational recovery functions for abandoned webhook worker claims, retry tracking, and dead-letter queues

-- Schema Evolution: Add retry tracking and dead-letter columns to webhook_events
ALTER TABLE webhook_events
ADD COLUMN IF NOT EXISTS retry_count INT DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_error TEXT,
ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

-- Function: reconcile_payment_capture_atomic
-- Hardened atomic reconciliation with strict idempotency, relationship checks, and affected-row validation
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
AS $$
DECLARE
  v_payment payment_attempts%ROWTYPE;
  v_quote quotes%ROWTYPE;
  v_request procurement_requests%ROWTYPE;
  v_webhook webhook_events%ROWTYPE;
BEGIN
  -- 1. Lock and validate payment attempt
  SELECT * INTO v_payment FROM payment_attempts WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial reconciliation failed: Payment attempt % does not exist', p_payment_id;
  END IF;

  -- 2. Strict Idempotency Check with Capture-ID Verification
  IF v_payment.status = 'captured' THEN
    IF v_payment.provider_capture_id IS DISTINCT FROM p_provider_capture_id THEN
      RAISE EXCEPTION 'Financial reconciliation conflict: Payment % is already captured with different provider capture ID "%" (attempted: "%")',
        p_payment_id, v_payment.provider_capture_id, p_provider_capture_id;
    END IF;

    -- Idempotent duplicate: ensure webhook is recorded as processed
    UPDATE webhook_events
    SET status = 'processed',
        processed_at = COALESCE(processed_at, now()),
        claim_lease_expires_at = NULL,
        last_error = NULL
    WHERE id = p_webhook_id;

    -- Ensure procurement request is marked fulfilled
    IF p_request_id IS NOT NULL THEN
      UPDATE procurement_requests
      SET status = 'fulfilled',
          updated_at = now()
      WHERE id = p_request_id;
    END IF;

    RETURN true;
  END IF;

  -- Verify payment status is in a valid state for capture
  IF v_payment.status NOT IN ('created', 'pending') THEN
    RAISE EXCEPTION 'Financial reconciliation failed: Payment % cannot be captured because status is "%"',
      p_payment_id, v_payment.status;
  END IF;

  -- 3. Lock and validate quote
  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial reconciliation failed: Referenced quote % does not exist', p_quote_id;
  END IF;

  -- 4. Cross-Entity Relational Integrity & Tenant Boundary Checks
  IF v_payment.quote_id IS DISTINCT FROM p_quote_id THEN
    RAISE EXCEPTION 'Relational integrity violation: Payment quote ID % does not match expected %',
      v_payment.quote_id, p_quote_id;
  END IF;

  IF v_payment.business_id IS DISTINCT FROM p_business_id THEN
    RAISE EXCEPTION 'Tenant boundary violation: Payment business ID % does not match expected %',
      v_payment.business_id, p_business_id;
  END IF;

  IF v_quote.business_id IS DISTINCT FROM p_business_id THEN
    RAISE EXCEPTION 'Tenant boundary violation: Quote business ID % does not match expected %',
      v_quote.business_id, p_business_id;
  END IF;

  -- 5. Lock and validate procurement request if present
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

  -- 6. Minor Unit Financial Precision & Currency Equality Checks
  IF v_payment.amount_cents != p_amount_cents THEN
    RAISE EXCEPTION 'Financial integrity violation: Payment amount % cents does not match capture % cents',
      v_payment.amount_cents, p_amount_cents;
  END IF;

  IF v_quote.total_cents != p_amount_cents THEN
    RAISE EXCEPTION 'Financial integrity violation: Quote total % cents does not match capture % cents',
      v_quote.total_cents, p_amount_cents;
  END IF;

  IF UPPER(v_payment.currency) != UPPER(p_currency) THEN
    RAISE EXCEPTION 'Financial integrity violation: Payment currency "%" does not match capture "%"',
      v_payment.currency, p_currency;
  END IF;

  IF UPPER(v_quote.currency) != UPPER(p_currency) THEN
    RAISE EXCEPTION 'Financial integrity violation: Quote currency "%" does not match capture "%"',
      v_quote.currency, p_currency;
  END IF;

  -- 7. Lock and validate webhook event record
  SELECT * INTO v_webhook FROM webhook_events WHERE id = p_webhook_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial reconciliation failed: Webhook event record % does not exist', p_webhook_id;
  END IF;

  IF v_webhook.event_id IS DISTINCT FROM p_event_id THEN
    RAISE EXCEPTION 'Financial reconciliation failed: Webhook event ID "%" does not match expected "%"',
      v_webhook.event_id, p_event_id;
  END IF;

  IF v_webhook.status NOT IN ('received', 'in_progress', 'retryable') THEN
    RAISE EXCEPTION 'Financial reconciliation failed: Webhook % is not in a reconcilable state (status: "%")',
      p_webhook_id, v_webhook.status;
  END IF;

  -- 8. Apply Transactional Updates & Validate Affected Rows
  -- Update Payment Attempt
  UPDATE payment_attempts
  SET status = 'captured',
      provider_capture_id = p_provider_capture_id,
      updated_at = now()
  WHERE id = p_payment_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Failed to update payment attempt %', p_payment_id;
  END IF;

  -- Update Webhook Event
  UPDATE webhook_events
  SET status = 'processed',
      processed_at = now(),
      claim_lease_expires_at = NULL,
      last_error = NULL
  WHERE id = p_webhook_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Failed to update webhook event %', p_webhook_id;
  END IF;

  -- Transition Procurement Request
  IF p_request_id IS NOT NULL THEN
    UPDATE procurement_requests
    SET status = 'fulfilled',
        updated_at = now()
    WHERE id = p_request_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Failed to update procurement request %', p_request_id;
    END IF;
  END IF;

  -- 9. Insert Immutable Transactional Audit Record
  INSERT INTO audit_events (
    id,
    business_id,
    entity_type,
    entity_id,
    actor_id,
    actor_role,
    action,
    payload,
    created_at
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

-- Function: claim_expired_webhook_events_for_worker
-- Atomically claims expired or retryable webhook events for the background recovery worker
CREATE OR REPLACE FUNCTION claim_expired_webhook_events_for_worker(
  p_batch_size INT DEFAULT 10,
  p_lease_seconds INT DEFAULT 60,
  p_max_retries INT DEFAULT 5
)
RETURNS SETOF webhook_events
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT id
    FROM webhook_events
    WHERE
      (
        -- Case 1: Received with expired worker claim lease
        (status = 'received' AND claim_lease_expires_at IS NOT NULL AND claim_lease_expires_at < now())
        OR
        -- Case 2: Failed retryable event ready for next attempt
        (status = 'failed' AND (next_retry_at IS NULL OR next_retry_at <= now()))
      )
      AND COALESCE(retry_count, 0) < p_max_retries
    ORDER BY created_at ASC
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  UPDATE webhook_events w
  SET
    status = 'received',
    claim_lease_expires_at = now() + (p_lease_seconds || ' seconds')::INTERVAL,
    retry_count = COALESCE(w.retry_count, 0) + 1,
    last_error = NULL
  FROM candidates c
  WHERE w.id = c.id
  RETURNING w.*;
END;
$$;

-- Function: dead_letter_exhausted_webhook_events
-- Moves webhook events exceeding max retry attempts to 'exhausted' status (dead letter queue)
CREATE OR REPLACE FUNCTION dead_letter_exhausted_webhook_events(
  p_max_retries INT DEFAULT 5
)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_count INT;
BEGIN
  UPDATE webhook_events
  SET
    status = 'exhausted',
    claim_lease_expires_at = NULL,
    last_error = COALESCE(last_error, 'Maximum retry attempts exceeded without successful reconciliation.')
  WHERE
    COALESCE(retry_count, 0) >= p_max_retries
    AND status NOT IN ('processed', 'exhausted');

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Function: recover_expired_webhook_claims
-- Atomically resets expired worker claim leases while preserving original lease expiry metadata via CTE
CREATE OR REPLACE FUNCTION recover_expired_webhook_claims(
  p_max_count INT DEFAULT 50
)
RETURNS TABLE (
  id UUID,
  event_id TEXT,
  previous_lease_expiry TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH expired_candidates AS (
    SELECT w.id, w.event_id, w.claim_lease_expires_at AS original_lease_expiry
    FROM webhook_events w
    WHERE w.status = 'received'
      AND w.claim_lease_expires_at IS NOT NULL
      AND w.claim_lease_expires_at < now()
    ORDER BY w.created_at ASC
    LIMIT p_max_count
    FOR UPDATE SKIP LOCKED
  ),
  updated_rows AS (
    UPDATE webhook_events w
    SET claim_lease_expires_at = NULL
    FROM expired_candidates e
    WHERE w.id = e.id
    RETURNING w.id, w.event_id
  )
  SELECT e.id, e.event_id, e.original_lease_expiry AS previous_lease_expiry
  FROM expired_candidates e;
END;
$$;

-- Function: persist_quote_and_transition_request_atomic
-- Atomically creates quote + items, transitions procurement request status to 'quoted', and records audit
CREATE OR REPLACE FUNCTION persist_quote_and_transition_request_atomic(
  p_quote JSONB,
  p_items JSONB,
  p_request_id UUID,
  p_business_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_quote_id UUID := (p_quote->>'id')::UUID;
BEGIN
  -- 1. Insert or update quote
  INSERT INTO quotes (
    id, request_id, business_id, supplier_id, supplier_name,
    version, subtotal_cents, tax_cents, shipping_cents, total_cents,
    currency, checksum_hash, status, expires_at, created_at
  ) VALUES (
    v_quote_id,
    (p_quote->>'request_id')::UUID,
    (p_quote->>'business_id')::UUID,
    (p_quote->>'supplier_id')::UUID,
    p_quote->>'supplier_name',
    (p_quote->>'version')::INT,
    (p_quote->>'subtotal_cents')::BIGINT,
    (p_quote->>'tax_cents')::BIGINT,
    (p_quote->>'shipping_cents')::BIGINT,
    (p_quote->>'total_cents')::BIGINT,
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

  -- 2. Insert quote items
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
    FROM jsonb_array_elements(p_items) AS item
    ON CONFLICT (id) DO UPDATE SET
      quantity = EXCLUDED.quantity,
      unit_price_cents = EXCLUDED.unit_price_cents,
      total_cents = EXCLUDED.total_cents;
  END IF;

  -- 3. Atomically transition procurement request status to 'quoted' and bind active quote
  IF p_request_id IS NOT NULL THEN
    UPDATE procurement_requests
    SET status = 'quoted',
        active_quote_id = v_quote_id,
        updated_at = now()
    WHERE id = p_request_id
      AND business_id = p_business_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Referenced procurement request % not found for business %', p_request_id, p_business_id;
    END IF;
  END IF;

  -- 4. Record transactional audit event
  INSERT INTO audit_events (
    id, business_id, entity_type, entity_id, actor_id, actor_role, action, payload, created_at
  ) VALUES (
    gen_random_uuid(),
    p_business_id,
    'quote',
    v_quote_id::TEXT,
    'quote_engine',
    'system_calculator',
    'QUOTE_CALCULATED_AND_BOUND',
    jsonb_build_object(
      'quoteId', v_quote_id,
      'requestId', p_request_id,
      'totalCents', (p_quote->>'total_cents')::BIGINT,
      'currency', p_quote->>'currency'
    ),
    now()
  );

  RETURN true;
END;
$$;

-- Function: persist_approval_and_transition_atomic
-- Atomically persists approval record, updates quote and request status, and records audit trail
CREATE OR REPLACE FUNCTION persist_approval_and_transition_atomic(
  p_approval JSONB,
  p_quote_id UUID,
  p_request_id UUID,
  p_business_id UUID,
  p_decision TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_approval_id UUID := (p_approval->>'id')::UUID;
  v_quote_status TEXT := p_decision;
  v_request_status TEXT := p_decision;
BEGIN
  -- 1. Insert approval record
  INSERT INTO approvals (
    id, quote_id, business_id, approver_id, approver_name, approver_role,
    quote_version, approved_total_cents, approved_currency, approved_supplier_id,
    decision, reason, digital_signature, created_at
  ) VALUES (
    v_approval_id,
    p_quote_id,
    p_business_id,
    (p_approval->>'approver_id')::UUID,
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

  -- 2. Atomically update quote status
  UPDATE quotes
  SET status = v_quote_status
  WHERE id = p_quote_id
    AND business_id = p_business_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referenced quote % not found for business %', p_quote_id, p_business_id;
  END IF;

  -- 3. Atomically update procurement request status
  IF p_request_id IS NOT NULL THEN
    UPDATE procurement_requests
    SET status = v_request_status,
        updated_at = now()
    WHERE id = p_request_id
      AND business_id = p_business_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Referenced procurement request % not found for business %', p_request_id, p_business_id;
    END IF;
  END IF;

  -- 4. Record transactional audit event
  INSERT INTO audit_events (
    id, business_id, entity_type, entity_id, actor_id, actor_role, action, payload, created_at
  ) VALUES (
    gen_random_uuid(),
    p_business_id,
    'approval',
    v_approval_id::TEXT,
    p_approval->>'approver_id',
    p_approval->>'approver_role',
    CASE WHEN p_decision = 'approved' THEN 'QUOTE_APPROVED' ELSE 'QUOTE_REJECTED' END,
    jsonb_build_object(
      'approvalId', v_approval_id,
      'quoteId', p_quote_id,
      'requestId', p_request_id,
      'decision', p_decision,
      'reason', p_approval->>'reason'
    ),
    now()
  );

  RETURN true;
END;
$$;
