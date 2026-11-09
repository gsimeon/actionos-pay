-- ==============================================================================
-- ActionOS Pay: Migration 00009
-- Capture State Alignment and Security Hardening (Phase 13)
--
-- Aligns PostgreSQL claim_payment_capture_atomic with LedgerEngine in-memory
-- state machine and closes the failed-state capture loophole:
-- 1. Failed payment attempts (status = 'failed') return status = 'FAILED' with
--    error_message, preventing illicit transitions back to 'reconciling'.
-- 2. Permitted capture claim states are restricted to 'created', 'approved',
--    or 'reconciling' with an expired lease.
-- 3. Terminal or unexpected states fail closed immediately.
-- ==============================================================================

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

  -- Case A: Already captured -> Idempotent Replay
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

  -- Case B: Reconciling with active unexpired lease -> In-Flight Capture (HTTP 429)
  IF v_payment.status = 'reconciling' AND v_payment.capture_lease_expires_at > now() THEN
    RETURN jsonb_build_object(
      'status', 'IN_FLIGHT',
      'payment_attempt_id', v_payment.id,
      'lease_expires_at', v_payment.capture_lease_expires_at
    );
  END IF;

  -- Case C: Failed payment attempt -> Return FAILED (Prevents illegal state transition back to reconciling)
  IF v_payment.status = 'failed' THEN
    RETURN jsonb_build_object(
      'status', 'FAILED',
      'payment_attempt_id', v_payment.id,
      'error_message', v_payment.error_message,
      'payment_status', 'failed',
      'business_id', v_payment.business_id,
      'quote_id', v_payment.quote_id,
      'amount_cents', v_payment.amount_cents,
      'currency', v_payment.currency
    );
  END IF;

  -- Case D: Permitted capture states: 'created', 'approved', or 'reconciling' with expired lease
  IF v_payment.status IN ('created', 'approved')
     OR (v_payment.status = 'reconciling' AND (v_payment.capture_lease_expires_at IS NULL OR v_payment.capture_lease_expires_at <= now())) THEN
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
  END IF;

  -- Fail closed for any terminal or unpermitted state
  RAISE EXCEPTION 'Cannot claim capture lease for payment attempt in state "%"', v_payment.status;
END;
$$;

REVOKE ALL ON FUNCTION claim_payment_capture_atomic(TEXT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_payment_capture_atomic(TEXT, INT) TO service_role;

