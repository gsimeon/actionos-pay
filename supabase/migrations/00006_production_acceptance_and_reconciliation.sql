-- =========================================================================================
-- ActionOS Pay: Phase 10 Production Acceptance, Payment Reconciliation & Operational Readiness
-- Migration: 00006_production_acceptance_and_reconciliation.sql
-- =========================================================================================
-- Hardened Guarantees:
-- 1. Schema Security: REVOKE CREATE ON SCHEMA public to prevent search-path injection.
-- 2. Strict Privilege Lockdown: Untrusted roles (PUBLIC, anon) have zero RPC execution privileges.
-- 3. Authenticated Role Hardening: Direct execution of approval requires non-null auth.uid() matching approver_id.
-- 4. Engine-Only Restrictions: reconcile_payment_capture_atomic and claim_webhook_event strictly restricted to service_role.
-- 5. Complete Search-Path Hardening: SET search_path = public, auth, pg_temp on all financial procedures.
-- =========================================================================================

-- 1. Hardening Schema Permissions Against Search-Path Poisoning
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE CREATE ON SCHEMA public FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE CREATE ON SCHEMA public FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT USAGE ON SCHEMA public TO service_role;
  END IF;
END $$;


-- 2. Hardened Atomic Quote Approval Stored Procedure
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
  -- 0. Identity Binding & Service-Role Boundary:
  -- If invoked directly under 'authenticated' role, auth.uid() is mandatory and must match submitted approver_id
  IF current_user = 'authenticated' OR COALESCE(current_setting('request.jwt.claim.role', true), '') = 'authenticated' THEN
    IF v_session_user_id IS NULL THEN
      RAISE EXCEPTION 'Authorization failure: Direct execution under "authenticated" role requires an active auth.uid() session';
    END IF;
    IF v_session_user_id IS DISTINCT FROM v_approver_id THEN
      RAISE EXCEPTION 'Authorization failure: Authenticated session actor % cannot approve quote on behalf of approver %',
        v_session_user_id, v_approver_id;
    END IF;
  END IF;

  -- Under any execution context (including service_role or test harnesses), if auth.uid() is set, it must never contradict v_approver_id
  IF v_session_user_id IS NOT NULL AND v_session_user_id IS DISTINCT FROM v_approver_id THEN
    RAISE EXCEPTION 'Authorization failure: Authenticated session actor % cannot approve quote on behalf of approver %',
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


-- 3. Hardened Payment Capture Reconciliation Stored Procedure (Engine Only)
CREATE OR REPLACE FUNCTION reconcile_payment_capture_atomic(
  p_payment_id UUID,
  p_provider_capture_id TEXT,
  p_quote_id UUID,
  p_request_id UUID,
  p_business_id UUID,
  p_webhook_id UUID,
  p_amount_cents BIGINT,
  p_currency TEXT,
  p_provider TEXT DEFAULT 'paypal'
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
  -- Strict Engine Privilege Lockdown
  IF current_user IN ('anon', 'authenticated') OR COALESCE(current_setting('request.jwt.claim.role', true), '') IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'Authorization failure: Function reconcile_payment_capture_atomic can only be executed by service_role';
  END IF;

  -- 1. Input parameter integrity guards
  IF p_provider_capture_id IS NULL OR length(trim(p_provider_capture_id)) = 0 THEN
    RAISE EXCEPTION 'Financial reconciliation failed: Provider capture ID is mandatory and cannot be empty.';
  END IF;

  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'Financial reconciliation failed: Capture amount must be positive, got %', p_amount_cents;
  END IF;

  IF p_currency IS NULL OR length(trim(p_currency)) != 3 THEN
    RAISE EXCEPTION 'Financial reconciliation failed: Capture currency must be a valid 3-letter ISO code, got "%"', p_currency;
  END IF;

  -- 2. Lock and validate Payment Attempt
  SELECT * INTO v_payment FROM payment_attempts WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial reconciliation failed: Payment attempt % does not exist', p_payment_id;
  END IF;

  IF v_payment.business_id IS DISTINCT FROM p_business_id THEN
    RAISE EXCEPTION 'Tenant boundary violation: Payment attempt business % does not match expected %',
      v_payment.business_id, p_business_id;
  END IF;

  IF v_payment.quote_id IS DISTINCT FROM p_quote_id THEN
    RAISE EXCEPTION 'Relational integrity violation: Payment attempt quote % does not match expected %',
      v_payment.quote_id, p_quote_id;
  END IF;

  -- 3. Lock and validate Quote
  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial reconciliation failed: Referenced quote % does not exist', p_quote_id;
  END IF;

  IF v_quote.business_id IS DISTINCT FROM p_business_id THEN
    RAISE EXCEPTION 'Tenant boundary violation: Quote business % does not match expected %',
      v_quote.business_id, p_business_id;
  END IF;

  IF v_quote.status != 'approved' THEN
    RAISE EXCEPTION 'Financial reconciliation failed: Quote % is in status "%" (must be "approved" to reconcile capture)',
      p_quote_id, v_quote.status;
  END IF;

  -- 4. Reconcile Amount & Currency against Quote and Payment Attempt
  IF v_quote.total_cents != p_amount_cents THEN
    RAISE EXCEPTION 'Financial reconciliation mismatch: Captured amount (% cents) does not match quote total (% cents)',
      p_amount_cents, v_quote.total_cents;
  END IF;

  IF UPPER(v_quote.currency) != UPPER(p_currency) THEN
    RAISE EXCEPTION 'Financial reconciliation mismatch: Captured currency "%" does not match quote currency "%"',
      p_currency, v_quote.currency;
  END IF;

  IF v_payment.amount_cents != p_amount_cents THEN
    RAISE EXCEPTION 'Financial reconciliation mismatch: Captured amount (% cents) does not match payment attempt amount (% cents)',
      p_amount_cents, v_payment.amount_cents;
  END IF;

  IF UPPER(v_payment.currency) != UPPER(p_currency) THEN
    RAISE EXCEPTION 'Financial reconciliation mismatch: Captured currency "%" does not match payment attempt currency "%"',
      p_currency, v_payment.currency;
  END IF;

  -- 5. Lock and validate Procurement Request if present
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
      RAISE EXCEPTION 'Tenant boundary violation: Procurement request business % does not match expected %',
        v_request.business_id, p_business_id;
    END IF;
  END IF;

  -- 6. Lock and validate Webhook Event
  SELECT * INTO v_webhook FROM webhook_events WHERE id = p_webhook_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial reconciliation failed: Webhook event % does not exist', p_webhook_id;
  END IF;

  IF v_webhook.signature_verified IS NOT TRUE THEN
    RAISE EXCEPTION 'Security violation: Cannot reconcile payment % from unverified webhook event %',
      p_payment_id, p_webhook_id;
  END IF;

  -- 7. Idempotency Check & Conflicting Capture Guard
  IF v_payment.status = 'captured' THEN
    IF v_payment.provider_capture_id IS DISTINCT FROM p_provider_capture_id THEN
      RAISE EXCEPTION 'Financial reconciliation conflict: Payment % is already captured with different provider capture ID "%" (attempted: "%")',
        p_payment_id, v_payment.provider_capture_id, p_provider_capture_id;
    END IF;

    -- Valid duplicate capture: ensure webhook is marked processed and request is fulfilled
    UPDATE webhook_events
    SET status = 'processed',
        processed_at = COALESCE(processed_at, now()),
        claim_lease_expires_at = NULL,
        last_error = NULL
    WHERE id = p_webhook_id;

    GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
    IF v_rows_affected != 1 THEN
      RAISE EXCEPTION 'Failed to update webhook event % on idempotent replay: expected 1 row, got %', p_webhook_id, v_rows_affected;
    END IF;

    IF p_request_id IS NOT NULL THEN
      UPDATE procurement_requests
      SET status = 'fulfilled',
          updated_at = now()
      WHERE id = p_request_id;

      GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
      IF v_rows_affected != 1 THEN
        RAISE EXCEPTION 'Failed to update procurement request % on idempotent replay: expected 1 row, got %', p_request_id, v_rows_affected;
      END IF;
    END IF;

    RETURN true;
  END IF;

  -- Verify payment status is in a valid state for capture
  IF v_payment.status NOT IN ('created', 'pending') THEN
    RAISE EXCEPTION 'Financial reconciliation failed: Payment % cannot be captured because status is "%"',
      p_payment_id, v_payment.status;
  END IF;

  -- 8. Apply Transactional Updates & Validate Affected Rows
  -- Update Payment Attempt
  UPDATE payment_attempts
  SET status = 'captured',
      provider_capture_id = p_provider_capture_id,
      updated_at = now()
  WHERE id = p_payment_id;

  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  IF v_rows_affected != 1 THEN
    RAISE EXCEPTION 'Failed to update payment attempt %: expected 1 row, got %', p_payment_id, v_rows_affected;
  END IF;

  -- 9. Reconcile Webhook Event
  UPDATE webhook_events
  SET status = 'processed',
      processed_at = now(),
      claim_lease_expires_at = NULL,
      last_error = NULL
  WHERE id = p_webhook_id;

  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  IF v_rows_affected != 1 THEN
    RAISE EXCEPTION 'Failed to update webhook event %: expected 1 row, got %', p_webhook_id, v_rows_affected;
  END IF;

  -- 10. Update Procurement Request to 'fulfilled'
  IF p_request_id IS NOT NULL THEN
    UPDATE procurement_requests
    SET status = 'fulfilled',
        updated_at = now()
    WHERE id = p_request_id;

    GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
    IF v_rows_affected != 1 THEN
      RAISE EXCEPTION 'Failed to update procurement request % to fulfilled: expected 1 row, got %', p_request_id, v_rows_affected;
    END IF;
  END IF;

  -- 11. Record authoritative audit event
  INSERT INTO audit_events (
    id, business_id, entity_type, entity_id, actor_id, actor_role, action, payload, created_at
  ) VALUES (
    gen_random_uuid(),
    p_business_id,
    'payment',
    p_payment_id::TEXT,
    'webhook_processor',
    'system',
    'PAYMENT_CAPTURED',
    jsonb_build_object(
      'paymentId', p_payment_id,
      'providerCaptureId', p_provider_capture_id,
      'quoteId', p_quote_id,
      'requestId', p_request_id,
      'amountCents', p_amount_cents,
      'currency', p_currency,
      'webhookId', p_webhook_id,
      'provider', p_provider
    ),
    now()
  );

  RETURN true;
END;
$$;


-- 4. Hardened Webhook Claiming Stored Procedure (Engine Only)
CREATE OR REPLACE FUNCTION claim_webhook_event(
  p_id UUID,
  p_provider TEXT,
  p_event_id TEXT,
  p_event_type TEXT,
  p_payload JSONB,
  p_signature_verified BOOLEAN,
  p_lease_seconds INT DEFAULT 60
)
RETURNS TABLE (
  claimed BOOLEAN,
  claim_status TEXT,
  event_record webhook_events
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_existing webhook_events%ROWTYPE;
BEGIN
  -- Strict Engine Privilege Lockdown
  IF current_user IN ('anon', 'authenticated') OR COALESCE(current_setting('request.jwt.claim.role', true), '') IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'Authorization failure: Function claim_webhook_event can only be executed by service_role';
  END IF;

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
-- SQL FUNCTION SECURITY & ROLE PRIVILEGE LOCKDOWN
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
REVOKE ALL ON FUNCTION reconcile_payment_capture_atomic(UUID, TEXT, UUID, UUID, UUID, UUID, BIGINT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION claim_webhook_event(UUID, TEXT, TEXT, TEXT, JSONB, BOOLEAN, INT) FROM PUBLIC, anon, authenticated;

-- 2. Grant execution for user-facing workflows to authenticated members and backend service_role
GRANT EXECUTE ON FUNCTION auth_user_business_ids() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION persist_quote_and_transition_request_atomic(JSONB, JSONB, UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION persist_approval_and_transition_atomic(JSONB, UUID, UUID, UUID, TEXT) TO authenticated, service_role;

-- 3. Restrict critical financial reconciliation and webhook claiming strictly to service_role (engine only)
GRANT EXECUTE ON FUNCTION reconcile_payment_capture_atomic(UUID, TEXT, UUID, UUID, UUID, UUID, BIGINT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION claim_webhook_event(UUID, TEXT, TEXT, TEXT, JSONB, BOOLEAN, INT) TO service_role;
