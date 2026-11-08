-- =========================================================================================
-- ActionOS Pay: Live PostgreSQL Role Simulation & Permission Boundary Test Suite
-- =========================================================================================
-- Verifies least privilege and privilege boundaries by dynamically switching roles:
-- 1. SET ROLE anon:
--    - Zero execute permissions on financial RPCs (42501 permission denied)
--    - Zero schema creation permissions on public schema (42501 permission denied)
-- 2. SET ROLE authenticated:
--    - Blocked from engine-only procedures (reconcile_payment_capture_atomic, claim_webhook_event)
--    - Blocked from schema creation on public schema
--    - Enforces mandatory auth.uid() matching approver_id
--    - Tenant boundary isolation enforced
-- 3. SET ROLE service_role:
--    - Allowed execution of backend reconciliation and webhook claiming
--    - Allowed execution of valid quote approvals
-- =========================================================================================

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  v_biz_id UUID := '00000000-0000-4000-8000-000000000001'::UUID;
  v_other_biz_id UUID := '00000000-0000-4000-8000-000000000099'::UUID;

  v_requester_id UUID := '11111111-1111-4000-8000-000000000001'::UUID;
  v_approver_id UUID := '88888888-8888-4000-8000-000000000001'::UUID;
  v_other_approver_id UUID := '88888888-8888-4000-8000-000000000002'::UUID;

  v_supplier_id UUID := '22222222-2222-4000-8000-000000000001'::UUID;
  v_other_supplier_id UUID := '22222222-2222-4000-8000-000000000099'::UUID;
  v_request_id UUID := '33333333-3333-4000-8000-000000000001'::UUID;
  v_other_request_id UUID := '33333333-3333-4000-8000-000000000099'::UUID;
  v_quote_id UUID := '44444444-4444-4000-8000-000000000001'::UUID;
  v_other_quote_id UUID := '44444444-4444-4000-8000-000000000099'::UUID;
  v_auth_req_id UUID := '33333333-3333-4000-8000-000000000002'::UUID;
  v_auth_quote_id UUID := '44444444-4444-4000-8000-000000000002'::UUID;
  v_sr_req_id UUID := '33333333-3333-4000-8000-000000000003'::UUID;
  v_sr_quote_id UUID := '44444444-4444-4000-8000-000000000003'::UUID;
  v_payment_id UUID := '66666666-6666-4000-8000-000000000001'::UUID;
  v_webhook_id UUID := '77777777-7777-4000-8000-000000000001'::UUID;

  v_caught_exception BOOLEAN;
  v_error_code TEXT;
  v_error_msg TEXT;
BEGIN
  RAISE NOTICE '===============================================================';
  RAISE NOTICE 'Starting ActionOS Pay PostgreSQL Role Simulation Test Suite...';
  RAISE NOTICE '===============================================================';

  -- Seed fixtures for role tests
  INSERT INTO businesses (id, name, slug, default_currency, budget_limit_cents)
  VALUES
    (v_biz_id, 'Apex Primary', 'apex-primary-roles', 'USD', 2000000),
    (v_other_biz_id, 'Rogue Tenant Corp', 'rogue-roles', 'USD', 2000000)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO memberships (id, business_id, user_id, user_name, user_email, role, approval_limit_cents)
  VALUES
    (gen_random_uuid(), v_biz_id, v_requester_id, 'Amina Requester', 'amina@roles.co', 'requester', 50000),
    (gen_random_uuid(), v_biz_id, v_approver_id, 'Chidi Approver', 'chidi@roles.co', 'approver', 500000),
    (gen_random_uuid(), v_other_biz_id, v_other_approver_id, 'Rogue Approver', 'rogue@other.co', 'approver', 500000);

  INSERT INTO suppliers (id, business_id, name, code, is_approved, risk_rating, country)
  VALUES
    (v_supplier_id, v_biz_id, 'Verified Supplier', 'SUP-VERIFIED', true, 'low', 'US'),
    (v_other_supplier_id, v_other_biz_id, 'Other Supplier', 'SUP-OTHER', true, 'low', 'US');

  INSERT INTO procurement_requests (id, business_id, requester_id, requester_name, raw_prompt, budget_limit_cents, currency, status)
  VALUES
    (v_request_id, v_biz_id, v_requester_id, 'Amina Requester', 'Laptops', 200000, 'USD', 'draft'),
    (v_other_request_id, v_other_biz_id, v_other_approver_id, 'Rogue Approver', 'Rogue Request', 200000, 'USD', 'draft'),
    (v_auth_req_id, v_biz_id, v_requester_id, 'Amina Requester', 'Auth Laptops', 200000, 'USD', 'draft'),
    (v_sr_req_id, v_biz_id, v_requester_id, 'Amina Requester', 'SR Laptops', 200000, 'USD', 'draft');

  INSERT INTO quotes (id, request_id, business_id, supplier_id, supplier_name, version, subtotal_cents, tax_cents, shipping_cents, total_cents, currency, checksum_hash, status, expires_at)
  VALUES
    (v_quote_id, v_request_id, v_biz_id, v_supplier_id, 'Verified Supplier', 1, 100000, 5000, 0, 105000, 'USD', 'hash-1', 'approved', now() + INTERVAL '1 day'),
    (v_other_quote_id, v_other_request_id, v_other_biz_id, v_other_supplier_id, 'Other Supplier', 1, 50000, 2000, 0, 52000, 'USD', 'hash-other', 'active', now() + INTERVAL '1 day'),
    (v_auth_quote_id, v_auth_req_id, v_biz_id, v_supplier_id, 'Verified Supplier', 1, 80000, 4000, 0, 84000, 'USD', 'hash-auth', 'active', now() + INTERVAL '1 day'),
    (v_sr_quote_id, v_sr_req_id, v_biz_id, v_supplier_id, 'Verified Supplier', 1, 70000, 3500, 0, 73500, 'USD', 'hash-sr', 'active', now() + INTERVAL '1 day');

  INSERT INTO payment_attempts (id, quote_id, business_id, provider, amount_cents, currency, status, idempotency_key)
  VALUES (v_payment_id, v_quote_id, v_biz_id, 'paypal', 105000, 'USD', 'created', 'idem-role-test-001');

  INSERT INTO webhook_events (id, provider, event_id, event_type, payload, signature_verified, status)
  VALUES (v_webhook_id, 'paypal', 'EVT-ROLE-TEST-001', 'PAYMENT.CAPTURE.COMPLETED', '{"id": "CAPT-ROLE-001"}'::jsonb, true, 'received');

  RAISE NOTICE 'Fixtures seeded successfully.';
END;
$$;

-- Grant minimal table usage so role permissions test stored procedures cleanly
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
ALTER ROLE service_role BYPASSRLS;

-- =============================================================================
-- 1. ROLE TEST: anon (Untrusted anonymous caller)
-- =============================================================================
SET ROLE anon;

-- Test 1A: anon blocked from reconcile_payment_capture_atomic
DO $$
DECLARE
  v_caught BOOLEAN := false;
BEGIN
  BEGIN
    PERFORM reconcile_payment_capture_atomic(
      '66666666-6666-4000-8000-000000000001'::UUID,
      'CAPT-ANON',
      '77777777-7777-4000-8000-000000000001'::UUID,
      '44444444-4444-4000-8000-000000000001'::UUID,
      '33333333-3333-4000-8000-000000000001'::UUID,
      '00000000-0000-4000-8000-000000000001'::UUID,
      105000,
      'USD',
      'EVT-ROLE-TEST-001'
    );
  EXCEPTION WHEN insufficient_privilege THEN
    v_caught := true;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'Privilege Violation: anon role was allowed to execute reconcile_payment_capture_atomic';
  END IF;
  RAISE NOTICE '✅ PASS: anon cannot execute reconcile_payment_capture_atomic (insufficient_privilege 42501).';
END;
$$;

-- Test 1B: anon blocked from claim_webhook_event
DO $$
DECLARE
  v_caught BOOLEAN := false;
BEGIN
  BEGIN
    PERFORM claim_webhook_event(
      gen_random_uuid(),
      'paypal',
      'EVT-ANON-CLAIM',
      'PAYMENT.CAPTURE.COMPLETED',
      '{}'::jsonb,
      false,
      60
    );
  EXCEPTION WHEN insufficient_privilege THEN
    v_caught := true;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'Privilege Violation: anon role was allowed to execute claim_webhook_event';
  END IF;
  RAISE NOTICE '✅ PASS: anon cannot execute claim_webhook_event (insufficient_privilege 42501).';
END;
$$;

-- Test 1C: anon blocked from persist_approval_and_transition_atomic
DO $$
DECLARE
  v_caught BOOLEAN := false;
BEGIN
  BEGIN
    PERFORM persist_approval_and_transition_atomic(
      '{}'::jsonb,
      '44444444-4444-4000-8000-000000000001'::UUID,
      '33333333-3333-4000-8000-000000000001'::UUID,
      '00000000-0000-4000-8000-000000000001'::UUID,
      'approved'
    );
  EXCEPTION WHEN insufficient_privilege THEN
    v_caught := true;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'Privilege Violation: anon role was allowed to execute persist_approval_and_transition_atomic';
  END IF;
  RAISE NOTICE '✅ PASS: anon cannot execute persist_approval_and_transition_atomic (insufficient_privilege 42501).';
END;
$$;

-- Test 1D: anon blocked from creating tables in public schema
DO $$
DECLARE
  v_caught BOOLEAN := false;
BEGIN
  BEGIN
    EXECUTE 'CREATE TABLE public.anon_trojan_test (id int)';
  EXCEPTION WHEN insufficient_privilege THEN
    v_caught := true;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'Schema Violation: anon role was allowed to create table in schema public';
  END IF;
  RAISE NOTICE '✅ PASS: anon cannot create objects in schema public.';
END;
$$;


-- =============================================================================
-- 2. ROLE TEST: authenticated (Logged-in user role)
-- =============================================================================
SET ROLE authenticated;

-- Test 2A: authenticated blocked from reconcile_payment_capture_atomic
DO $$
DECLARE
  v_caught BOOLEAN := false;
BEGIN
  BEGIN
    PERFORM reconcile_payment_capture_atomic(
      '66666666-6666-4000-8000-000000000001'::UUID,
      'CAPT-AUTH',
      '77777777-7777-4000-8000-000000000001'::UUID,
      '44444444-4444-4000-8000-000000000001'::UUID,
      '33333333-3333-4000-8000-000000000001'::UUID,
      '00000000-0000-4000-8000-000000000001'::UUID,
      105000,
      'USD',
      'EVT-ROLE-TEST-001'
    );
  EXCEPTION WHEN insufficient_privilege THEN
    v_caught := true;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'Privilege Violation: authenticated role was allowed to execute reconcile_payment_capture_atomic';
  END IF;
  RAISE NOTICE '✅ PASS: authenticated cannot execute reconcile_payment_capture_atomic (restricted to service_role).';
END;
$$;

-- Test 2B: authenticated blocked from claim_webhook_event
DO $$
DECLARE
  v_caught BOOLEAN := false;
BEGIN
  BEGIN
    PERFORM claim_webhook_event(
      gen_random_uuid(),
      'paypal',
      'EVT-AUTH-CLAIM',
      'PAYMENT.CAPTURE.COMPLETED',
      '{}'::jsonb,
      false,
      60
    );
  EXCEPTION WHEN insufficient_privilege THEN
    v_caught := true;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'Privilege Violation: authenticated role was allowed to execute claim_webhook_event';
  END IF;
  RAISE NOTICE '✅ PASS: authenticated cannot execute claim_webhook_event (restricted to service_role).';
END;
$$;

-- Test 2C: authenticated without auth.uid() session cannot execute approval
DO $$
DECLARE
  v_caught BOOLEAN := false;
  v_app_json JSONB;
BEGIN
  v_app_json := jsonb_build_object(
    'id', gen_random_uuid(),
    'quote_id', '44444444-4444-4000-8000-000000000001'::UUID,
    'business_id', '00000000-0000-4000-8000-000000000001'::UUID,
    'approver_id', '88888888-8888-4000-8000-000000000001'::UUID,
    'approver_name', 'Chidi Approver',
    'approver_role', 'approver',
    'quote_version', 1,
    'approved_total_cents', 105000,
    'approved_currency', 'USD',
    'approved_supplier_id', '22222222-2222-4000-8000-000000000001'::UUID,
    'decision', 'approved',
    'digital_signature', 'sig-test',
    'created_at', now()
  );

  BEGIN
    -- No auth.uid() configured in this session
    PERFORM persist_approval_and_transition_atomic(
      v_app_json,
      '44444444-4444-4000-8000-000000000001'::UUID,
      '33333333-3333-4000-8000-000000000001'::UUID,
      '00000000-0000-4000-8000-000000000001'::UUID,
      'approved'
    );
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM ILIKE '%requires an active auth.uid() session%' THEN
      v_caught := true;
    END IF;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'Security Violation: authenticated caller without auth.uid() was allowed to execute approval';
  END IF;
  RAISE NOTICE '✅ PASS: authenticated role requires active auth.uid() session.';
END;
$$;

-- Test 2C-1: authenticated caller with mismatched auth.uid() is rejected
DO $$
DECLARE
  v_caught BOOLEAN := false;
  v_app_json JSONB;
BEGIN
  -- Set auth.uid() to Rogue Approver (v_other_approver_id)
  PERFORM set_config('request.jwt.claim.sub', '88888888-8888-4000-8000-000000000002', true);

  v_app_json := jsonb_build_object(
    'id', gen_random_uuid(),
    'quote_id', '44444444-4444-4000-8000-000000000002'::UUID,
    'business_id', '00000000-0000-4000-8000-000000000001'::UUID,
    'approver_id', '88888888-8888-4000-8000-000000000001'::UUID,
    'approver_name', 'Chidi Approver',
    'approver_role', 'approver',
    'quote_version', 1,
    'approved_total_cents', 84000,
    'approved_currency', 'USD',
    'approved_supplier_id', '22222222-2222-4000-8000-000000000001'::UUID,
    'decision', 'approved',
    'digital_signature', 'sig-test-mismatch',
    'created_at', now()
  );

  BEGIN
    PERFORM persist_approval_and_transition_atomic(
      v_app_json,
      '44444444-4444-4000-8000-000000000002'::UUID,
      '33333333-3333-4000-8000-000000000002'::UUID,
      '00000000-0000-4000-8000-000000000001'::UUID,
      'approved'
    );
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM ILIKE '%cannot approve quote on behalf of approver%' THEN
      v_caught := true;
    END IF;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'Security Violation: authenticated caller with mismatched auth.uid() was allowed to approve quote';
  END IF;
  RAISE NOTICE '✅ PASS: authenticated caller with mismatched auth.uid() is rejected.';
END;
$$;

-- Test 2C-2: authenticated caller with matching auth.uid() successfully approves quote
DO $$
DECLARE
  v_app_json JSONB;
  v_res UUID;
BEGIN
  -- Set auth.uid() matching approver (Chidi: v_approver_id)
  PERFORM set_config('request.jwt.claim.sub', '88888888-8888-4000-8000-000000000001', true);

  v_app_json := jsonb_build_object(
    'id', gen_random_uuid(),
    'quote_id', '44444444-4444-4000-8000-000000000002'::UUID,
    'business_id', '00000000-0000-4000-8000-000000000001'::UUID,
    'approver_id', '88888888-8888-4000-8000-000000000001'::UUID,
    'approver_name', 'Chidi Approver',
    'approver_role', 'approver',
    'quote_version', 1,
    'approved_total_cents', 84000,
    'approved_currency', 'USD',
    'approved_supplier_id', '22222222-2222-4000-8000-000000000001'::UUID,
    'decision', 'approved',
    'digital_signature', 'sig-test-valid-auth',
    'created_at', now()
  );

  v_res := persist_approval_and_transition_atomic(
    v_app_json,
    '44444444-4444-4000-8000-000000000002'::UUID,
    '33333333-3333-4000-8000-000000000002'::UUID,
    '00000000-0000-4000-8000-000000000001'::UUID,
    'approved'
  );

  IF v_res IS NULL THEN
    RAISE EXCEPTION 'Execution Failure: authenticated caller with matching auth.uid() failed to approve quote';
  END IF;
  RAISE NOTICE '✅ PASS: authenticated caller with matching auth.uid() successfully approves quote.';
END;
$$;

-- Test 2D: authenticated role cannot create tables in schema public
DO $$
DECLARE
  v_caught BOOLEAN := false;
BEGIN
  BEGIN
    EXECUTE 'CREATE TABLE public.auth_trojan_test (id int)';
  EXCEPTION WHEN insufficient_privilege THEN
    v_caught := true;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'Schema Violation: authenticated role was allowed to create table in schema public';
  END IF;
  RAISE NOTICE '✅ PASS: authenticated cannot create objects in schema public.';
END;
$$;


-- =============================================================================
-- 3. ROLE TEST: service_role (Trusted Backend Engine)
-- =============================================================================
SET ROLE service_role;

-- Test 3A: service_role can claim webhooks
DO $$
DECLARE
  v_claimed BOOLEAN;
  v_status TEXT;
BEGIN
  SELECT claimed, claim_status INTO v_claimed, v_status
  FROM claim_webhook_event(
    gen_random_uuid(),
    'paypal',
    'EVT-SERVICE-ROLE-CLAIM',
    'PAYMENT.CAPTURE.COMPLETED',
    '{"id": "EVT-SERVICE-ROLE-CLAIM"}'::jsonb,
    true,
    60
  );

  IF NOT v_claimed OR v_status != 'claimed' THEN
    RAISE EXCEPTION 'Execution Failure: service_role failed to claim webhook: claimed=%, status=%', v_claimed, v_status;
  END IF;
  RAISE NOTICE '✅ PASS: service_role can execute claim_webhook_event.';
END;
$$;

-- Test 3B: service_role can reconcile payment captures
DO $$
DECLARE
  v_success BOOLEAN;
BEGIN
  -- Mark quote as approved first
  UPDATE quotes SET status = 'approved' WHERE id = '44444444-4444-4000-8000-000000000001'::UUID;

  v_success := reconcile_payment_capture_atomic(
    '66666666-6666-4000-8000-000000000001'::UUID,
    'CAPT-SERVICE-ROLE-001',
    '77777777-7777-4000-8000-000000000001'::UUID,
    '44444444-4444-4000-8000-000000000001'::UUID,
    '33333333-3333-4000-8000-000000000001'::UUID,
    '00000000-0000-4000-8000-000000000001'::UUID,
    105000,
    'USD',
    'EVT-ROLE-TEST-001'
  );

  IF NOT v_success THEN
    RAISE EXCEPTION 'Execution Failure: service_role failed to reconcile payment capture';
  END IF;
  RAISE NOTICE '✅ PASS: service_role can execute reconcile_payment_capture_atomic.';
END;
$$;

-- Test 3C: Tenant isolation enforced under service_role
DO $$
DECLARE
  v_caught BOOLEAN := false;
  v_app_json JSONB;
BEGIN
  -- Attempt to approve quote of Other Biz using membership of Primary Biz
  v_app_json := jsonb_build_object(
    'id', gen_random_uuid(),
    'quote_id', '44444444-4444-4000-8000-000000000099'::UUID,
    'business_id', '00000000-0000-4000-8000-000000000001'::UUID, -- Mismatch with quote's business!
    'approver_id', '88888888-8888-4000-8000-000000000001'::UUID,
    'approver_name', 'Chidi Approver',
    'approver_role', 'approver',
    'quote_version', 1,
    'approved_total_cents', 52000,
    'approved_currency', 'USD',
    'approved_supplier_id', '22222222-2222-4000-8000-000000000001'::UUID,
    'decision', 'approved',
    'digital_signature', 'sig-test',
    'created_at', now()
  );

  BEGIN
    PERFORM persist_approval_and_transition_atomic(
      v_app_json,
      '44444444-4444-4000-8000-000000000099'::UUID,
      NULL,
      '00000000-0000-4000-8000-000000000001'::UUID,
      'approved'
    );
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM ILIKE '%Tenant boundary violation%' THEN
      v_caught := true;
    END IF;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'Tenant Isolation Violation: Cross-tenant approval was not rejected';
  END IF;
  RAISE NOTICE '✅ PASS: Tenant boundary violation correctly enforced under service_role.';
END;
$$;

-- Test 3D: service_role can approve quotes through trusted backend boundary without auth.uid()
DO $$
DECLARE
  v_app_json JSONB;
  v_res UUID;
BEGIN
  -- Clear auth.uid() session to prove service_role does not require auth.uid()
  PERFORM set_config('request.jwt.claim.sub', '', true);

  v_app_json := jsonb_build_object(
    'id', gen_random_uuid(),
    'quote_id', '44444444-4444-4000-8000-000000000003'::UUID,
    'business_id', '00000000-0000-4000-8000-000000000001'::UUID,
    'approver_id', '88888888-8888-4000-8000-000000000001'::UUID,
    'approver_name', 'Chidi Approver',
    'approver_role', 'approver',
    'quote_version', 1,
    'approved_total_cents', 73500,
    'approved_currency', 'USD',
    'approved_supplier_id', '22222222-2222-4000-8000-000000000001'::UUID,
    'decision', 'approved',
    'digital_signature', 'sig-test-valid-sr',
    'created_at', now()
  );

  v_res := persist_approval_and_transition_atomic(
    v_app_json,
    '44444444-4444-4000-8000-000000000003'::UUID,
    '33333333-3333-4000-8000-000000000003'::UUID,
    '00000000-0000-4000-8000-000000000001'::UUID,
    'approved'
  );

  IF v_res IS NULL THEN
    RAISE EXCEPTION 'Execution Failure: service_role failed to approve quote through trusted boundary';
  END IF;
  RAISE NOTICE '✅ PASS: service_role can execute quote approvals through trusted backend boundary.';
END;
$$;

RESET ROLE;

\echo '==============================================================='
\echo '🎉 ALL POSTGRESQL ROLE SIMULATION TESTS PASSED 100%'
\echo '==============================================================='

ROLLBACK;
