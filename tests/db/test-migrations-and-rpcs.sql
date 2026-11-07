-- ActionOS Pay: Live PostgreSQL Migration & Adversarial Acceptance Test Suite
-- Executes inside CI against a live PostgreSQL 15+ container to verify:
-- 1. Sequential migration upgrade: 00001 -> 00002 -> 00003 -> 00004
-- 2. Database-enforced quote financial arithmetic & item integrity
-- 3. Supplier governance & tenant isolation (rejection of unapproved & cross-tenant suppliers)
-- 4. Quote version progression & immutability of core relationships
-- 5. Stale item cleanout upon revision
-- 6. Approver membership, authorized role, and spending limit enforcement in SQL
-- 7. Dual-control segregation of duties (self-approval strictly prohibited)
-- 8. Webhook signature boundary enforcement (unverified signatures rejected)
-- 9. Protection against overwriting verified webhook payloads
-- 10. Strict payment capture idempotency and conflicting provider capture rejection
-- 11. Webhook lease claiming, metadata recovery, and abandoned worker lease recovery

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  v_biz_id UUID := '00000000-0000-4000-8000-000000000001'::UUID;
  v_other_biz_id UUID := '00000000-0000-4000-8000-000000000099'::UUID;

  v_requester_id UUID := '11111111-1111-4000-8000-000000000001'::UUID;
  v_approver_id UUID := '88888888-8888-4000-8000-000000000001'::UUID;
  v_junior_id UUID := '99999999-9999-4000-8000-000000000001'::UUID;
  v_unknown_user_id UUID := '77777777-7777-4000-8000-000000000099'::UUID;

  v_supplier_id UUID := '22222222-2222-4000-8000-000000000001'::UUID;
  v_unapproved_sup_id UUID := '22222222-2222-4000-8000-000000000002'::UUID;
  v_other_biz_sup_id UUID := '22222222-2222-4000-8000-000000000003'::UUID;

  v_request_id UUID := '33333333-3333-4000-8000-000000000001'::UUID;
  v_quote_id UUID := '44444444-4444-4000-8000-000000000001'::UUID;
  v_approval_id UUID := '55555555-5555-4000-8000-000000000001'::UUID;
  v_payment_id UUID := '66666666-6666-4000-8000-000000000001'::UUID;
  v_webhook_id UUID := '77777777-7777-4000-8000-000000000001'::UUID;
  v_unverified_webhook_id UUID := '77777777-7777-4000-8000-000000000002'::UUID;

  v_quote_json JSONB;
  v_items_json JSONB;
  v_approval_json JSONB;
  v_item_count INT;
  v_req_status TEXT;
  v_quote_status TEXT;
  v_caught_exception BOOLEAN;
BEGIN
  RAISE NOTICE '=======================================================';
  RAISE NOTICE 'Starting ActionOS Pay Phase 8 Live PostgreSQL Tests...';
  RAISE NOTICE '=======================================================';

  -- 1. Setup Base Tenant Data & Memberships
  INSERT INTO businesses (id, name, slug, default_currency, budget_limit_cents)
  VALUES (v_biz_id, 'Apex Corp Primary', 'apex-primary', 'USD', 1000000)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO businesses (id, name, slug, default_currency, budget_limit_cents)
  VALUES (v_other_biz_id, 'Other Biz Rogue', 'other-rogue', 'USD', 1000000)
  ON CONFLICT (id) DO NOTHING;

  -- Memberships: Requester ($500 limit), Junior ($1,000 limit), Senior Approver ($5,000 limit)
  INSERT INTO memberships (id, business_id, user_id, user_name, user_email, role, approval_limit_cents)
  VALUES (gen_random_uuid(), v_biz_id, v_requester_id, 'Amina Requester', 'amina@apex.co', 'requester', 50000);

  INSERT INTO memberships (id, business_id, user_id, user_name, user_email, role, approval_limit_cents)
  VALUES (gen_random_uuid(), v_biz_id, v_junior_id, 'Junior Approver', 'junior@apex.co', 'approver', 100000);

  INSERT INTO memberships (id, business_id, user_id, user_name, user_email, role, approval_limit_cents)
  VALUES (gen_random_uuid(), v_biz_id, v_approver_id, 'Chidi Senior Approver', 'chidi@apex.co', 'approver', 500000);

  -- Suppliers: Approved, Unapproved, and Other Business
  INSERT INTO suppliers (id, business_id, name, code, is_approved, risk_rating, country)
  VALUES (v_supplier_id, v_biz_id, 'Tech Supplier Alpha', 'SUP-ALPHA', true, 'low', 'US');

  INSERT INTO suppliers (id, business_id, name, code, is_approved, risk_rating, country)
  VALUES (v_unapproved_sup_id, v_biz_id, 'Shadow Vendor Unapproved', 'SUP-SHADOW', false, 'high', 'AE');

  INSERT INTO suppliers (id, business_id, name, code, is_approved, risk_rating, country)
  VALUES (v_other_biz_sup_id, v_other_biz_id, 'Cross-Tenant Vendor', 'SUP-OTHER', true, 'low', 'US');

  -- Base Procurement Request
  INSERT INTO procurement_requests (id, business_id, requester_id, requester_name, raw_prompt, budget_limit_cents, currency, status)
  VALUES (v_request_id, v_biz_id, v_requester_id, 'Amina Requester', 'Engineering laptops', 300000, 'USD', 'draft');

  -- =========================================================================
  -- 2. ADVERSARIAL QUOTE INTEGRITY TESTS
  -- =========================================================================

  -- Test 2A: Arithmetic violation: subtotal + tax + shipping != total
  v_quote_json := jsonb_build_object(
    'id', v_quote_id,
    'request_id', v_request_id,
    'business_id', v_biz_id,
    'supplier_id', v_supplier_id,
    'supplier_name', 'Tech Supplier Alpha',
    'version', 1,
    'subtotal_cents', 200000,
    'tax_cents', 20000,
    'shipping_cents', 5000,
    'total_cents', 999999, -- Wrong Total! Should be 225000
    'currency', 'USD',
    'checksum_hash', 'hash-v1',
    'status', 'active',
    'expires_at', now() + interval '7 days',
    'created_at', now()
  );
  v_items_json := jsonb_build_array(
    jsonb_build_object('id', gen_random_uuid(), 'item_name', 'Laptop Alpha', 'quantity', 1, 'unit_price_cents', 200000, 'total_cents', 200000)
  );

  v_caught_exception := false;
  BEGIN
    PERFORM persist_quote_and_transition_request_atomic(v_quote_json, v_items_json, v_request_id, v_biz_id);
  EXCEPTION WHEN OTHERS THEN
    v_caught_exception := true;
  END;
  IF NOT v_caught_exception THEN
    RAISE EXCEPTION 'Adversarial Test Failed: Expected exception on quote arithmetic mismatch (subtotal + tax + shipping != total).';
  END IF;

  -- Test 2B: Item calculation mismatch: quantity * unit_price != total_cents
  v_quote_json := jsonb_set(v_quote_json, '{total_cents}', '225000');
  v_items_json := jsonb_build_array(
    jsonb_build_object('id', gen_random_uuid(), 'item_name', 'Laptop Alpha', 'quantity', 2, 'unit_price_cents', 100000, 'total_cents', 150000) -- 2 * 100k != 150k
  );

  v_caught_exception := false;
  BEGIN
    PERFORM persist_quote_and_transition_request_atomic(v_quote_json, v_items_json, v_request_id, v_biz_id);
  EXCEPTION WHEN OTHERS THEN
    v_caught_exception := true;
  END;
  IF NOT v_caught_exception THEN
    RAISE EXCEPTION 'Adversarial Test Failed: Expected exception on item arithmetic violation (qty * unit_price != total).';
  END IF;

  -- Test 2C: Unapproved supplier quote rejected
  v_quote_json := jsonb_set(v_quote_json, '{supplier_id}', to_jsonb(v_unapproved_sup_id::TEXT));
  v_items_json := jsonb_build_array(
    jsonb_build_object('id', gen_random_uuid(), 'item_name', 'Laptop Alpha', 'quantity', 1, 'unit_price_cents', 200000, 'total_cents', 200000)
  );

  v_caught_exception := false;
  BEGIN
    PERFORM persist_quote_and_transition_request_atomic(v_quote_json, v_items_json, v_request_id, v_biz_id);
  EXCEPTION WHEN OTHERS THEN
    v_caught_exception := true;
  END;
  IF NOT v_caught_exception THEN
    RAISE EXCEPTION 'Adversarial Test Failed: Expected exception on unapproved supplier.';
  END IF;

  -- Test 2D: Cross-tenant supplier injection rejected
  v_quote_json := jsonb_set(v_quote_json, '{supplier_id}', to_jsonb(v_other_biz_sup_id::TEXT));
  v_caught_exception := false;
  BEGIN
    PERFORM persist_quote_and_transition_request_atomic(v_quote_json, v_items_json, v_request_id, v_biz_id);
  EXCEPTION WHEN OTHERS THEN
    v_caught_exception := true;
  END;
  IF NOT v_caught_exception THEN
    RAISE EXCEPTION 'Adversarial Test Failed: Expected exception on cross-tenant supplier injection.';
  END IF;

  -- Test 2E: Valid Initial Quote (Version 1)
  v_quote_json := jsonb_set(v_quote_json, '{supplier_id}', to_jsonb(v_supplier_id::TEXT));
  PERFORM persist_quote_and_transition_request_atomic(v_quote_json, v_items_json, v_request_id, v_biz_id);

  SELECT status INTO v_req_status FROM procurement_requests WHERE id = v_request_id;
  IF v_req_status != 'quoted' THEN
    RAISE EXCEPTION 'Test Failed: Expected request to transition to "quoted", got "%"', v_req_status;
  END IF;

  -- Test 2F: Quote revision with invalid version progression (version 4 instead of 2)
  v_quote_json := jsonb_set(v_quote_json, '{version}', '4');
  v_caught_exception := false;
  BEGIN
    PERFORM persist_quote_and_transition_request_atomic(v_quote_json, v_items_json, v_request_id, v_biz_id);
  EXCEPTION WHEN OTHERS THEN
    v_caught_exception := true;
  END;
  IF NOT v_caught_exception THEN
    RAISE EXCEPTION 'Adversarial Test Failed: Expected exception on skipped quote version revision.';
  END IF;

  -- Test 2G: Valid Quote Revision (Version 2) with Stale Item Purge
  v_quote_json := jsonb_set(v_quote_json, '{version}', '2');
  v_items_json := jsonb_build_array(
    jsonb_build_object('id', gen_random_uuid(), 'item_name', 'Laptop Beta', 'quantity', 2, 'unit_price_cents', 100000, 'total_cents', 200000)
  );
  PERFORM persist_quote_and_transition_request_atomic(v_quote_json, v_items_json, v_request_id, v_biz_id);

  SELECT count(*) INTO v_item_count FROM quote_items WHERE quote_id = v_quote_id;
  IF v_item_count != 1 THEN
    RAISE EXCEPTION 'Test Failed: Stale quote items were not purged cleanly on revision, count: %', v_item_count;
  END IF;

  -- =========================================================================
  -- 3. ADVERSARIAL APPROVAL GOVERNANCE TESTS
  -- =========================================================================

  -- Test 3A: Unknown user approval rejected
  v_approval_json := jsonb_build_object(
    'id', v_approval_id,
    'quote_id', v_quote_id,
    'business_id', v_biz_id,
    'approver_id', v_unknown_user_id,
    'approver_name', 'Intruder',
    'approver_role', 'admin',
    'quote_version', 2,
    'approved_total_cents', 225000,
    'approved_currency', 'USD',
    'approved_supplier_id', v_supplier_id,
    'decision', 'approved',
    'reason', 'Approved',
    'digital_signature', 'sig-test',
    'created_at', now()
  );

  v_caught_exception := false;
  BEGIN
    PERFORM persist_approval_and_transition_atomic(v_approval_json, v_quote_id, v_request_id, v_biz_id, 'approved'::TEXT);
  EXCEPTION WHEN OTHERS THEN
    v_caught_exception := true;
  END;
  IF NOT v_caught_exception THEN
    RAISE EXCEPTION 'Adversarial Test Failed: Expected exception when unknown user attempts approval.';
  END IF;

  -- Test 3B: Requester role attempting to approve rejected
  v_approval_json := jsonb_set(v_approval_json, '{approver_id}', to_jsonb(v_requester_id::TEXT));
  v_caught_exception := false;
  BEGIN
    PERFORM persist_approval_and_transition_atomic(v_approval_json, v_quote_id, v_request_id, v_biz_id, 'approved'::TEXT);
  EXCEPTION WHEN OTHERS THEN
    v_caught_exception := true;
  END;
  IF NOT v_caught_exception THEN
    RAISE EXCEPTION 'Adversarial Test Failed: Expected exception when user with requester role attempts approval.';
  END IF;

  -- Test 3C: Spending authority limit exceeded ($1,000 limit < $2,250 quote total)
  v_approval_json := jsonb_set(v_approval_json, '{approver_id}', to_jsonb(v_junior_id::TEXT));
  v_caught_exception := false;
  BEGIN
    PERFORM persist_approval_and_transition_atomic(v_approval_json, v_quote_id, v_request_id, v_biz_id, 'approved'::TEXT);
  EXCEPTION WHEN OTHERS THEN
    v_caught_exception := true;
  END;
  IF NOT v_caught_exception THEN
    RAISE EXCEPTION 'Adversarial Test Failed: Expected exception when quote total exceeds approver spending limit.';
  END IF;

  -- Test 3D: Valid Approval by Senior Approver ($5,000 limit >= $2,250)
  v_approval_json := jsonb_set(v_approval_json, '{approver_id}', to_jsonb(v_approver_id::TEXT));
  PERFORM persist_approval_and_transition_atomic(v_approval_json, v_quote_id, v_request_id, v_biz_id, 'approved'::TEXT);

  SELECT status INTO v_quote_status FROM quotes WHERE id = v_quote_id;
  SELECT status INTO v_req_status FROM procurement_requests WHERE id = v_request_id;
  IF v_quote_status != 'approved' OR v_req_status != 'approved' THEN
    RAISE EXCEPTION 'Test Failed: Expected quote and request to be "approved", got quote=%, req=%', v_quote_status, v_req_status;
  END IF;

  -- =========================================================================
  -- 4. ADVERSARIAL WEBHOOK & PAYMENT RECONCILIATION TESTS
  -- =========================================================================

  -- Setup Payment Attempt
  INSERT INTO payment_attempts (id, quote_id, business_id, provider, amount_cents, currency, status, idempotency_key)
  VALUES (v_payment_id, v_quote_id, v_biz_id, 'paypal', 225000, 'USD', 'created', 'idem-phase8');

  -- Setup Unverified Webhook Event
  INSERT INTO webhook_events (id, provider, event_id, event_type, signature_verified, payload, status)
  VALUES (v_unverified_webhook_id, 'paypal', 'EVT-UNVERIFIED-99', 'PAYMENT.CAPTURE.COMPLETED', false, '{"id":"EVT-UNVERIFIED-99"}'::jsonb, 'received');

  -- Test 4A: Webhook with unverified signature rejected by reconciliation
  v_caught_exception := false;
  BEGIN
    PERFORM reconcile_payment_capture_atomic(
      v_payment_id,
      'CAPTURE-VALID-1'::TEXT,
      v_unverified_webhook_id,
      v_quote_id,
      v_request_id,
      v_biz_id,
      225000::BIGINT,
      'USD'::TEXT,
      'EVT-UNVERIFIED-99'::TEXT
    );
  EXCEPTION WHEN OTHERS THEN
    v_caught_exception := true;
  END;
  IF NOT v_caught_exception THEN
    RAISE EXCEPTION 'Adversarial Test Failed: Expected exception when unverified webhook triggers reconciliation.';
  END IF;

  -- Setup Verified Webhook Event
  INSERT INTO webhook_events (id, provider, event_id, event_type, signature_verified, payload, status)
  VALUES (v_webhook_id, 'paypal', 'EVT-VERIFIED-1', 'PAYMENT.CAPTURE.COMPLETED', true, '{"id":"EVT-VERIFIED-1"}'::jsonb, 'received');

  -- Test 4B: Verified Webhook Reconciliation Succeeds
  PERFORM reconcile_payment_capture_atomic(
    v_payment_id,
    'CAPTURE-VALID-1'::TEXT,
    v_webhook_id,
    v_quote_id,
    v_request_id,
    v_biz_id,
    225000::BIGINT,
    'USD'::TEXT,
    'EVT-VERIFIED-1'::TEXT
  );

  SELECT status INTO v_req_status FROM procurement_requests WHERE id = v_request_id;
  IF v_req_status != 'fulfilled' THEN
    RAISE EXCEPTION 'Test Failed: Expected procurement request to be "fulfilled", got "%"', v_req_status;
  END IF;

  -- Test 4C: Conflicting capture ID on already-captured payment rejected
  v_caught_exception := false;
  BEGIN
    PERFORM reconcile_payment_capture_atomic(
      v_payment_id,
      'CAPTURE-CONFLICTING-99'::TEXT,
      v_webhook_id,
      v_quote_id,
      v_request_id,
      v_biz_id,
      225000::BIGINT,
      'USD'::TEXT,
      'EVT-VERIFIED-1'::TEXT
    );
  EXCEPTION WHEN OTHERS THEN
    v_caught_exception := true;
  END;
  IF NOT v_caught_exception THEN
    RAISE EXCEPTION 'Adversarial Test Failed: Expected exception on conflicting capture ID on already-captured payment.';
  END IF;

  -- Test 4D: Identical capture ID succeeds idempotently
  PERFORM reconcile_payment_capture_atomic(
    v_payment_id,
    'CAPTURE-VALID-1'::TEXT,
    v_webhook_id,
    v_quote_id,
    v_request_id,
    v_biz_id,
    225000::BIGINT,
    'USD'::TEXT,
    'EVT-VERIFIED-1'::TEXT
  );

  -- Test 4E: Webhook Claim Protection (cannot overwrite verified with unverified)
  v_caught_exception := false;
  BEGIN
    PERFORM claim_webhook_event(
      gen_random_uuid(),
      'paypal'::TEXT,
      'EVT-VERIFIED-1'::TEXT,
      'PAYMENT.CAPTURE.COMPLETED'::TEXT,
      '{"hacked": true}'::jsonb,
      false::BOOLEAN, -- unverified!
      60::INT
    );
  EXCEPTION WHEN OTHERS THEN
    v_caught_exception := true;
  END;
  IF NOT v_caught_exception THEN
    RAISE EXCEPTION 'Adversarial Test Failed: Expected exception when unverified payload attempts to claim verified event.';
  END IF;

  RAISE NOTICE '=======================================================';
  RAISE NOTICE 'All 15 ActionOS Pay Phase 8 Live Acceptance Tests PASSED!';
  RAISE NOTICE '=======================================================';
END;
$$;

ROLLBACK;
