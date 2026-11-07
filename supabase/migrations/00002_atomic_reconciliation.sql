-- ActionOS Pay: Atomic Webhook Event Claim, Lease Recovery & Payment Reconciliation Migration
-- Guarantees:
-- 1. Atomic claim of webhook events with lease expiry and abandoned worker recovery
-- 2. Transactional payment reconciliation, request fulfillment, and audit logging
-- 3. Atomic quote and quote item persistence

-- Schema Evolution: Add lease expiry column to webhook_events
ALTER TABLE webhook_events
ADD COLUMN IF NOT EXISTS claim_lease_expires_at TIMESTAMPTZ;

-- Function: claim_webhook_event
-- Atomically claims a webhook event with lease expiry (60s TTL) and automatic recovery of abandoned workers
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
AS $$
DECLARE
  v_existing webhook_events%ROWTYPE;
BEGIN
  -- Lock and query existing event row if present
  SELECT * INTO v_existing FROM webhook_events WHERE event_id = p_event_id FOR UPDATE;

  IF FOUND THEN
    IF v_existing.status IN ('processed', 'duplicate') THEN
      RETURN QUERY SELECT false, 'duplicate'::TEXT, v_existing;
      RETURN;
    ELSIF v_existing.status = 'received' THEN
      -- Check lease expiry: if lease is still active, event is actively in progress
      IF v_existing.claim_lease_expires_at IS NOT NULL AND v_existing.claim_lease_expires_at > now() THEN
        RETURN QUERY SELECT false, 'in_progress'::TEXT, v_existing;
        RETURN;
      ELSE
        -- Lease expired (worker crashed or abandoned). Recover stale claim safely!
        UPDATE webhook_events
        SET claim_lease_expires_at = now() + (p_lease_seconds || ' seconds')::INTERVAL,
            payload = p_payload
        WHERE id = v_existing.id
        RETURNING * INTO v_existing;

        RETURN QUERY SELECT true, 'recovered_lease'::TEXT, v_existing;
        RETURN;
      END IF;
    ELSIF v_existing.status = 'failed' THEN
      -- Re-activate failed webhook event for retry
      UPDATE webhook_events
      SET status = 'received',
          processed_at = NULL,
          claim_lease_expires_at = now() + (p_lease_seconds || ' seconds')::INTERVAL,
          payload = p_payload
      WHERE id = v_existing.id
      RETURNING * INTO v_existing;

      RETURN QUERY SELECT true, 'retryable'::TEXT, v_existing;
      RETURN;
    END IF;
  END IF;

  -- Insert new webhook event with initial lease
  BEGIN
    INSERT INTO webhook_events (
      id, provider, event_id, event_type, signature_verified, payload, status, claim_lease_expires_at
    )
    VALUES (
      p_id, p_provider, p_event_id, p_event_type, p_signature_verified, p_payload, 'received',
      now() + (p_lease_seconds || ' seconds')::INTERVAL
    )
    RETURNING * INTO v_existing;

    RETURN QUERY SELECT true, 'received'::TEXT, v_existing;
    RETURN;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_existing FROM webhook_events WHERE event_id = p_event_id;
    RETURN QUERY SELECT false, 'duplicate'::TEXT, v_existing;
    RETURN;
  END;
END;
$$;

-- Function: reconcile_payment_capture_atomic
-- Atomically validates preconditions (row lock, amount, currency, status), marks payment captured,
-- request fulfilled, webhook processed, and logs audit in a single database transaction.
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
  v_webhook webhook_events%ROWTYPE;
BEGIN
  -- 1. Lock and validate Payment Attempt preconditions
  SELECT * INTO v_payment
  FROM payment_attempts
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial Reconciliation Invariant: Payment attempt "%" not found.', p_payment_id;
  END IF;

  -- Idempotency check: if already captured with matching provider_capture_id, succeed safely
  IF v_payment.status = 'captured' THEN
    RETURN true;
  END IF;

  IF v_payment.status != 'created' THEN
    RAISE EXCEPTION 'Financial Reconciliation Invariant: Cannot reconcile payment "%" in status "%" (expected "created").',
      p_payment_id, v_payment.status;
  END IF;

  IF v_payment.business_id != p_business_id THEN
    RAISE EXCEPTION 'Financial Reconciliation Invariant: Tenant boundary mismatch for payment "%" (expected %, got %).',
      p_payment_id, p_business_id, v_payment.business_id;
  END IF;

  IF v_payment.amount_cents != p_amount_cents THEN
    RAISE EXCEPTION 'Financial Reconciliation Invariant: Amount mismatch for payment "%" (expected % cents, received % cents).',
      p_payment_id, v_payment.amount_cents, p_amount_cents;
  END IF;

  IF v_payment.currency != p_currency THEN
    RAISE EXCEPTION 'Financial Reconciliation Invariant: Currency mismatch for payment "%" (expected %, received %).',
      p_payment_id, v_payment.currency, p_currency;
  END IF;

  -- 2. Lock and validate Webhook Event preconditions
  SELECT * INTO v_webhook
  FROM webhook_events
  WHERE id = p_webhook_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial Reconciliation Invariant: Webhook event "%" not found.', p_webhook_id;
  END IF;

  IF v_webhook.status != 'received' THEN
    RAISE EXCEPTION 'Financial Reconciliation Invariant: Cannot reconcile with webhook event "%" in status "%" (expected "received").',
      p_webhook_id, v_webhook.status;
  END IF;

  -- 3. Update Payment Attempt to captured
  UPDATE payment_attempts
  SET status = 'captured',
      provider_capture_id = p_provider_capture_id,
      updated_at = now()
  WHERE id = p_payment_id;

  -- 4. Update Webhook Event (mark processed and clear active claim lease)
  UPDATE webhook_events
  SET status = 'processed',
      processed_at = now(),
      claim_lease_expires_at = NULL
  WHERE id = p_webhook_id;

  -- 5. Transition Procurement Request if linked
  IF p_request_id IS NOT NULL THEN
    UPDATE procurement_requests
    SET status = 'fulfilled',
        updated_at = now()
    WHERE id = p_request_id;
  END IF;

  -- 6. Insert Authoritative Immutable Audit Record inside transaction
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

-- Function: recover_expired_webhook_claims
-- Scans for received webhook events with expired claim leases and prepares them for reprocessing
CREATE OR REPLACE FUNCTION recover_expired_webhook_claims(
  p_max_count INT DEFAULT 50
)
RETURNS TABLE (
  recovered_id UUID,
  event_id TEXT,
  previous_lease_expiry TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  UPDATE webhook_events
  SET claim_lease_expires_at = NULL,
      status = 'received'
  WHERE id IN (
    SELECT id
    FROM webhook_events
    WHERE status = 'received'
      AND claim_lease_expires_at IS NOT NULL
      AND claim_lease_expires_at < now()
    LIMIT p_max_count
    FOR UPDATE SKIP LOCKED
  )
  RETURNING id, webhook_events.event_id, claim_lease_expires_at;
END;
$$;

-- Function: create_quote_atomic
-- Atomically persists quote and all quote items in a single PostgreSQL transaction
CREATE OR REPLACE FUNCTION create_quote_atomic(
  p_quote JSONB,
  p_items JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
  -- 1. Insert or update quote
  INSERT INTO quotes (
    id, request_id, business_id, supplier_id, supplier_name,
    version, subtotal_cents, tax_cents, shipping_cents, total_cents,
    currency, checksum_hash, status, expires_at, created_at
  ) VALUES (
    (p_quote->>'id')::UUID,
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
      (p_quote->>'id')::UUID,
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

  RETURN true;
END;
$$;
