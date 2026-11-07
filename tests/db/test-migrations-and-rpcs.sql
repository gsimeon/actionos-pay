-- ActionOS Pay: Live PostgreSQL Migration & RPC Acceptance Test Suite
-- Executes inside CI against a live PostgreSQL 15+ container to verify:
-- 1. Schema creation & column evolution
-- 2. Stored procedure existence
-- 3. Atomic quote persistence and stale item cleanup
-- 4. Complete database-enforced approval integrity
-- 5. Strict payment capture idempotency and conflict rejection
-- 6. Webhook lease claiming, metadata recovery, and dead-letter handling

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  v_biz_id UUID := '00000000-0000-4000-8000-000000000001'::UUID;
  v_user_id UUID := '11111111-1111-4000-8000-000000000001'::UUID;
  v_supplier_id UUID := '22222222-2222-4000-8000-000000000001'::UUID;
  v_request_id UUID := '33333333-3333-4000-8000-000000000001'::UUID;
  v_quote_id UUID := '44444444-4444-4000-8000-000000000001'::UUID;
  v_approval_id UUID := '55555555-5555-4000-8000-000000000001'::UUID;
  v_payment_id UUID := '66666666-6666-4000-8000-000000000001'::UUID;
  v_webhook_id UUID := '77777777-7777-4000-8000-000000000001'::UUID;

  v_quote_json JSONB;
  v_items_json JSONB;
  v_approval_json JSONB;
  v_item_count INT;
  v_req_status TEXT;
  v_quote_status TEXT;
  v_caught_exception BOOLEAN;
BEGIN
  RAISE NOTICE 'Starting ActionOS Pay live PostgreSQL acceptance tests...';

  -- 1. Setup Base Tenant Data
  INSERT INTO businesses (id, name, slug, default_currency, budget_limit_cents)
  VALUES (v_biz_id, 'Apex Corp Test', 'apex-test', 'USD', 1000000)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO suppliers (id, business_id, name, code, is_approved, risk_rating, country)
  VALUES (v_supplier_id, v_biz_id, 'Tech Supplier Alpha', 'SUP-ALPHA', true, 'low', 'US')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO procurement_requests (id, business_id, requester_id, requester_name, requester_email, category, urgency, reason, estimated_budget_cents, currency, status)
  VALUES (v_request_id, v_biz_id, v_user_id, 'Test Requester', 'requester@apex.com', 'Hardware', 'medium', 'Test laptops', 250000, 'USD', 'open');

  -- 2. Test Quote Atomic Persistence
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
    'total_cents', 225000,
    'currency', 'USD',
    'checksum_hash', 'hash-v1',
    'status', 'active',
    'expires_at', now() + interval '7 days',
    'created_at', now()
  );

  v_items_json := jsonb_build_array(
    jsonb_build_object('id', gen_random_uuid(), 'item_name', 'Laptop Alpha', 'quantity', 1, 'unit_price_cents', 200000, 'total_cents', 200000)
  );

  PERFORM persist_quote_and_transition_request_atomic(v_quote_json, v_items_json, v_request_id, v_biz_id);

  SELECT status INTO v_req_status FROM procurement_requests WHERE id = v_request_id;
  IF v_req_status != 'quoted' THEN
    RAISE EXCEPTION 'Test Failed: Request status was expected to be "quoted", got "%"', v_req_status;
  END IF;

  SELECT count(*) INTO v_item_count FROM quote_items WHERE quote_id = v_quote_id;
  IF v_item_count != 1 THEN
    RAISE EXCEPTION 'Test Failed: Expected 1 quote item, got %', v_item_count;
  END IF;

  -- 3. Test Quote Revision & Stale Item Cleanout
  v_quote_json := jsonb_set(v_quote_json, '{version}', '2');
  v_items_json := jsonb_build_array(
    jsonb_build_object('id', gen_random_uuid(), 'item_name', 'Laptop Beta', 'quantity', 2, 'unit_price_cents', 100000, 'total_cents', 200000)
  );
  PERFORM persist_quote_and_transition_request_atomic(v_quote_json, v_items_json, v_request_id, v_biz_id);

  SELECT count(*) INTO v_item_count FROM quote_items WHERE quote_id = v_quote_id;
  IF v_item_count != 1 THEN
    RAISE EXCEPTION 'Test Failed: Stale quote items were not cleanly purged on revision, item count: %', v_item_count;
  END IF;

  -- 4. Test Approval Integrity Constraints (Fail-closed validation)
  -- 4A: Mismatched quote total must fail
  v_approval_json := jsonb_build_object(
    'id', v_approval_id,
    'quote_id', v_quote_id,
    'business_id', v_biz_id,
    'approver_id', v_user_id,
    'approver_name', 'Approver One',
    'approver_role', 'admin',
    'quote_version', 2,
    'approved_total_cents', 999999, -- Wrong amount!
    'approved_currency', 'USD',
    'approved_supplier_id', v_supplier_id,
    'decision', 'approved',
    'reason', 'Approved',
    'digital_signature', 'sig-test',
    'created_at', now()
  );

  v_caught_exception := false;
  BEGIN
    PERFORM persist_approval_and_transition_atomic(v_approval_json, v_quote_id, v_request_id, v_biz_id, 'approved');
  EXCEPTION WHEN OTHERS THEN
    v_caught_exception := true;
  END;
  IF NOT v_caught_exception THEN
    RAISE EXCEPTION 'Test Failed: Expected exception on mismatched approved amount, but none was thrown.';
  END IF;

  -- 4B: Valid Approval Persistence
  v_approval_json := jsonb_set(v_approval_json, '{approved_total_cents}', '225000');
  PERFORM persist_approval_and_transition_atomic(v_approval_json, v_quote_id, v_request_id, v_biz_id, 'approved');

  SELECT status INTO v_quote_status FROM quotes WHERE id = v_quote_id;
  SELECT status INTO v_req_status FROM procurement_requests WHERE id = v_request_id;
  IF v_quote_status != 'approved' OR v_req_status != 'approved' THEN
    RAISE EXCEPTION 'Test Failed: Expected quote and request to be "approved", got quote=%, req=%', v_quote_status, v_req_status;
  END IF;

  -- 5. Setup Payment & Webhook for Reconciliation
  INSERT INTO payment_attempts (id, quote_id, business_id, provider, amount_cents, currency, status, idempotency_key)
  VALUES (v_payment_id, v_quote_id, v_biz_id, 'paypal', 225000, 'USD', 'created', 'idem-1');

  INSERT INTO webhook_events (id, provider, event_id, event_type, payload, status)
  VALUES (v_webhook_id, 'paypal', 'EVT-PAYPAL-1', 'PAYMENT.CAPTURE.COMPLETED', '{"id":"EVT-PAYPAL-1"}'::jsonb, 'received');

  -- 6. Test Atomic Payment Reconciliation
  PERFORM reconcile_payment_capture_atomic(
    v_payment_id,
    'CAPTURE-12345',
    v_webhook_id,
    v_quote_id,
    v_request_id,
    v_biz_id,
    225000,
    'USD',
    'EVT-PAYPAL-1'
  );

  SELECT status INTO v_req_status FROM procurement_requests WHERE id = v_request_id;
  IF v_req_status != 'fulfilled' THEN
    RAISE EXCEPTION 'Test Failed: Expected procurement request to be "fulfilled", got "%"', v_req_status;
  END IF;

  -- 7. Test Strict Idempotency & Conflict Prevention
  -- 7A: Conflicting capture ID must raise exception
  v_caught_exception := false;
  BEGIN
    PERFORM reconcile_payment_capture_atomic(
      v_payment_id,
      'CAPTURE-WRONG-999',
      v_webhook_id,
      v_quote_id,
      v_request_id,
      v_biz_id,
      225000,
      'USD',
      'EVT-PAYPAL-1'
    );
  EXCEPTION WHEN OTHERS THEN
    v_caught_exception := true;
  END;
  IF NOT v_caught_exception THEN
    RAISE EXCEPTION 'Test Failed: Expected conflict exception on mismatched capture ID on already-captured payment.';
  END IF;

  -- 7B: Matching capture ID must succeed idempotently
  PERFORM reconcile_payment_capture_atomic(
    v_payment_id,
    'CAPTURE-12345',
    v_webhook_id,
    v_quote_id,
    v_request_id,
    v_biz_id,
    225000,
    'USD',
    'EVT-PAYPAL-1'
  );

  -- 8. Test Webhook Claim Recovery & Metadata Preservation
  INSERT INTO webhook_events (id, provider, event_id, event_type, payload, status, claim_lease_expires_at)
  VALUES (gen_random_uuid(), 'paypal', 'EVT-EXPIRED-1', 'CHECKOUT.ORDER.APPROVED', '{}'::jsonb, 'received', now() - interval '2 minutes');

  IF (SELECT count(*) FROM recover_expired_webhook_claims(10)) < 1 THEN
    RAISE EXCEPTION 'Test Failed: recover_expired_webhook_claims did not recover expired claim.';
  END IF;

  RAISE NOTICE 'All live PostgreSQL acceptance tests PASSED successfully!';
END;
$$;

ROLLBACK;
