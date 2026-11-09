-- =========================================================================================
-- ActionOS Pay: Migration 00008 - Atomic Payment Reservation & Capture Claim Hardening
-- =========================================================================================
-- Phase 12 Guarantees:
-- 1. Adds reservation and capture lease columns to payment_attempts
-- 2. Stored procedure: reserve_payment_attempt_atomic (Enforces exactly-one in-flight order creation per quote)
-- 3. Stored procedure: confirm_payment_order_atomic (Commits provider order id to reserved attempt)
-- 4. Stored procedure: fail_payment_attempt_atomic (Marks reserved attempt failed on provider rejection)
-- 5. Stored procedure: claim_payment_capture_atomic (Mutual exclusion on simultaneous capture attempts)
-- 6. Stored procedure: release_payment_capture_claim_atomic (Safe release on capture timeout or error)
-- 7. Full service_role privilege grant & public/anon/authenticated revocation
-- =========================================================================================

-- 1. Schema Extensions
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS order_reservation_expires_at TIMESTAMPTZ;
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS capture_lease_expires_at TIMESTAMPTZ;

-- 2. Stored Procedure: reserve_payment_attempt_atomic
CREATE OR REPLACE FUNCTION reserve_payment_attempt_atomic(
  p_quote_id UUID,
  p_business_id UUID,
  p_amount_cents BIGINT,
  p_currency TEXT,
  p_idempotency_key TEXT,
  p_reservation_seconds INT DEFAULT 120
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_quote quotes%ROWTYPE;
  v_existing payment_attempts%ROWTYPE;
  v_new_attempt payment_attempts%ROWTYPE;
BEGIN
  -- Strict Engine Privilege Lockdown
  IF current_user IN ('anon', 'authenticated')
     OR session_user IN ('anon', 'authenticated')
     OR COALESCE(current_setting('role', true), '') IN ('anon', 'authenticated')
     OR COALESCE(current_setting('request.jwt.claim.role', true), '') IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'Authorization failure: Function reserve_payment_attempt_atomic can only be executed by service_role';
  END IF;

  -- 1. Input Validation
  IF p_quote_id IS NULL THEN
    RAISE EXCEPTION 'Parameter p_quote_id is mandatory';
  END IF;

  IF p_business_id IS NULL THEN
    RAISE EXCEPTION 'Parameter p_business_id is mandatory';
  END IF;

  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive, got %', p_amount_cents;
  END IF;

  IF p_currency IS NULL OR length(trim(p_currency)) != 3 THEN
    RAISE EXCEPTION 'Currency must be 3-character ISO code, got "%"', p_currency;
  END IF;

  -- 2. Row Lock & Validate Quote
  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referenced quote % does not exist', p_quote_id;
  END IF;

  IF v_quote.business_id IS DISTINCT FROM p_business_id THEN
    RAISE EXCEPTION 'Tenant boundary violation: Quote business % does not match expected %',
      v_quote.business_id, p_business_id;
  END IF;

  IF v_quote.status != 'approved' THEN
    RAISE EXCEPTION 'Payment reservation failed: Quote % status is "%" (must be "approved")',
      p_quote_id, v_quote.status;
  END IF;

  IF v_quote.expires_at <= now() THEN
    RAISE EXCEPTION 'Payment reservation failed: Quote % has expired at %',
      p_quote_id, v_quote.expires_at;
  END IF;

  IF v_quote.total_cents != p_amount_cents THEN
    RAISE EXCEPTION 'Payment reservation failed: Quote total (% cents) does not match requested amount (% cents)',
      v_quote.total_cents, p_amount_cents;
  END IF;

  IF UPPER(v_quote.currency) != UPPER(p_currency) THEN
    RAISE EXCEPTION 'Payment reservation failed: Quote currency "%" does not match requested currency "%"',
      v_quote.currency, p_currency;
  END IF;

  -- 3. Lock & Inspect Existing Active Payment Attempts
  SELECT * INTO v_existing
  FROM payment_attempts
  WHERE quote_id = p_quote_id
    AND status IN ('created', 'approved', 'reconciling', 'captured')
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    -- Case A: Quote has already been captured
    IF v_existing.status = 'captured' THEN
      RETURN jsonb_build_object(
        'status', 'ALREADY_CAPTURED',
        'payment_attempt_id', v_existing.id,
        'provider_order_id', v_existing.provider_order_id,
        'provider_capture_id', v_existing.provider_capture_id,
        'amount_cents', v_existing.amount_cents,
        'currency', v_existing.currency
      );
    END IF;

    -- Case B: Active provider order already exists -> Return idempotent replay
    IF v_existing.provider_order_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'status', 'REPLAY',
        'payment_attempt_id', v_existing.id,
        'provider_order_id', v_existing.provider_order_id,
        'payment_status', v_existing.status,
        'provider_response', v_existing.provider_response,
        'idempotency_key', v_existing.idempotency_key,
        'amount_cents', v_existing.amount_cents,
        'currency', v_existing.currency
      );
    END IF;

    -- Case C: Reservation exists without provider_order_id (Order creation in progress)
    IF v_existing.order_reservation_expires_at > now() THEN
      RETURN jsonb_build_object(
        'status', 'IN_FLIGHT',
        'payment_attempt_id', v_existing.id,
        'expires_at', v_existing.order_reservation_expires_at
      );
    ELSE
      -- Expired reservation: renew it for this caller
      UPDATE payment_attempts
      SET order_reservation_expires_at = now() + (p_reservation_seconds || ' seconds')::interval,
          idempotency_key = p_idempotency_key,
          amount_cents = p_amount_cents,
          currency = p_currency,
          updated_at = now()
      WHERE id = v_existing.id
      RETURNING * INTO v_existing;

      RETURN jsonb_build_object(
        'status', 'RESERVED',
        'payment_attempt_id', v_existing.id,
        'expires_at', v_existing.order_reservation_expires_at
      );
    END IF;
  END IF;

  -- 4. No active attempt exists: Insert new reservation atomically
  INSERT INTO payment_attempts (
    id,
    quote_id,
    business_id,
    provider,
    provider_order_id,
    amount_cents,
    currency,
    status,
    idempotency_key,
    provider_response,
    order_reservation_expires_at,
    created_at,
    updated_at
  ) VALUES (
    gen_random_uuid(),
    p_quote_id,
    p_business_id,
    'paypal',
    NULL,
    p_amount_cents,
    p_currency,
    'created',
    p_idempotency_key,
    '{"reservation": true, "status": "PENDING_ORDER_CREATION"}'::jsonb,
    now() + (p_reservation_seconds || ' seconds')::interval,
    now(),
    now()
  )
  RETURNING * INTO v_new_attempt;

  RETURN jsonb_build_object(
    'status', 'RESERVED',
    'payment_attempt_id', v_new_attempt.id,
    'expires_at', v_new_attempt.order_reservation_expires_at
  );
END;
$$;

-- 3. Stored Procedure: confirm_payment_order_atomic
CREATE OR REPLACE FUNCTION confirm_payment_order_atomic(
  p_payment_attempt_id UUID,
  p_provider_order_id TEXT,
  p_provider_response JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_rows INT;
BEGIN
  IF current_user IN ('anon', 'authenticated')
     OR session_user IN ('anon', 'authenticated')
     OR COALESCE(current_setting('role', true), '') IN ('anon', 'authenticated')
     OR COALESCE(current_setting('request.jwt.claim.role', true), '') IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'Authorization failure: Function confirm_payment_order_atomic can only be executed by service_role';
  END IF;

  IF p_provider_order_id IS NULL OR length(trim(p_provider_order_id)) = 0 THEN
    RAISE EXCEPTION 'Provider order ID cannot be empty.';
  END IF;

  UPDATE payment_attempts
  SET provider_order_id = p_provider_order_id,
      provider_response = p_provider_response,
      order_reservation_expires_at = NULL,
      updated_at = now()
  WHERE id = p_payment_attempt_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows != 1 THEN
    RAISE EXCEPTION 'Failed to confirm payment attempt %: record not found', p_payment_attempt_id;
  END IF;

  RETURN TRUE;
END;
$$;

-- 4. Stored Procedure: fail_payment_attempt_atomic
CREATE OR REPLACE FUNCTION fail_payment_attempt_atomic(
  p_payment_attempt_id UUID,
  p_error_message TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     OR session_user IN ('anon', 'authenticated')
     OR COALESCE(current_setting('role', true), '') IN ('anon', 'authenticated')
     OR COALESCE(current_setting('request.jwt.claim.role', true), '') IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'Authorization failure: Function fail_payment_attempt_atomic can only be executed by service_role';
  END IF;

  UPDATE payment_attempts
  SET status = 'failed',
      error_message = p_error_message,
      order_reservation_expires_at = NULL,
      capture_lease_expires_at = NULL,
      updated_at = now()
  WHERE id = p_payment_attempt_id;

  RETURN TRUE;
END;
$$;

-- 5. Stored Procedure: claim_payment_capture_atomic
CREATE OR REPLACE FUNCTION claim_payment_capture_atomic(
  p_order_id TEXT,
  p_lease_duration_seconds INT DEFAULT 60
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_payment payment_attempts%ROWTYPE;
BEGIN
  IF current_user IN ('anon', 'authenticated')
     OR session_user IN ('anon', 'authenticated')
     OR COALESCE(current_setting('role', true), '') IN ('anon', 'authenticated')
     OR COALESCE(current_setting('request.jwt.claim.role', true), '') IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'Authorization failure: Function claim_payment_capture_atomic can only be executed by service_role';
  END IF;

  IF p_order_id IS NULL OR length(trim(p_order_id)) = 0 THEN
    RAISE EXCEPTION 'Order ID cannot be empty.';
  END IF;

  SELECT * INTO v_payment
  FROM payment_attempts
  WHERE provider_order_id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment attempt not found for orderId "%"', p_order_id;
  END IF;

  -- Case A: Already captured
  IF v_payment.status = 'captured' THEN
    RETURN jsonb_build_object(
      'status', 'ALREADY_CAPTURED',
      'payment_attempt_id', v_payment.id,
      'provider_capture_id', v_payment.provider_capture_id,
      'payment_status', 'captured',
      'business_id', v_payment.business_id,
      'quote_id', v_payment.quote_id,
      'amount_cents', v_payment.amount_cents,
      'currency', v_payment.currency
    );
  END IF;

  -- Case B: Already reconciling with active lease (in-flight capture)
  IF v_payment.status = 'reconciling' AND v_payment.capture_lease_expires_at > now() THEN
    RETURN jsonb_build_object(
      'status', 'IN_FLIGHT',
      'payment_attempt_id', v_payment.id,
      'lease_expires_at', v_payment.capture_lease_expires_at
    );
  END IF;

  -- Case C: Status is created, approved, or reconciling with expired lease -> Claim lease
  UPDATE payment_attempts
  SET status = 'reconciling',
      capture_lease_expires_at = now() + (p_lease_duration_seconds || ' seconds')::interval,
      updated_at = now()
  WHERE id = v_payment.id
  RETURNING * INTO v_payment;

  RETURN jsonb_build_object(
    'status', 'CLAIMED',
    'payment_attempt_id', v_payment.id,
    'lease_expires_at', v_payment.capture_lease_expires_at,
    'business_id', v_payment.business_id,
    'quote_id', v_payment.quote_id,
    'amount_cents', v_payment.amount_cents,
    'currency', v_payment.currency
  );
END;
$$;

-- 6. Stored Procedure: release_payment_capture_claim_atomic
CREATE OR REPLACE FUNCTION release_payment_capture_claim_atomic(
  p_payment_attempt_id UUID,
  p_status TEXT,
  p_error_message TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     OR session_user IN ('anon', 'authenticated')
     OR COALESCE(current_setting('role', true), '') IN ('anon', 'authenticated')
     OR COALESCE(current_setting('request.jwt.claim.role', true), '') IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'Authorization failure: Function release_payment_capture_claim_atomic can only be executed by service_role';
  END IF;

  UPDATE payment_attempts
  SET status = p_status,
      capture_lease_expires_at = NULL,
      error_message = COALESCE(p_error_message, error_message),
      updated_at = now()
  WHERE id = p_payment_attempt_id;

  RETURN TRUE;
END;
$$;

-- 7. Permissions & Security Lockdown
REVOKE ALL ON FUNCTION reserve_payment_attempt_atomic(UUID, UUID, BIGINT, TEXT, TEXT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reserve_payment_attempt_atomic(UUID, UUID, BIGINT, TEXT, TEXT, INT) TO service_role;

REVOKE ALL ON FUNCTION confirm_payment_order_atomic(UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION confirm_payment_order_atomic(UUID, TEXT, JSONB) TO service_role;

REVOKE ALL ON FUNCTION fail_payment_attempt_atomic(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fail_payment_attempt_atomic(UUID, TEXT) TO service_role;

REVOKE ALL ON FUNCTION claim_payment_capture_atomic(TEXT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_payment_capture_atomic(TEXT, INT) TO service_role;

REVOKE ALL ON FUNCTION release_payment_capture_claim_atomic(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION release_payment_capture_claim_atomic(UUID, TEXT, TEXT) TO service_role;
