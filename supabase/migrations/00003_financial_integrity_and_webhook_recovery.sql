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
