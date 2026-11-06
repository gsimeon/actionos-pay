-- ActionOS Pay: Atomic Webhook Event Claim & Payment Reconciliation Migration
-- Guarantees:
-- 1. Atomic claim of webhook events to prevent concurrent processing races
-- 2. Transactional payment reconciliation, request fulfillment, and audit logging

-- Function: claim_webhook_event
-- Atomically claims a webhook event: returns 'claimed', 'duplicate', or 'in_progress'
CREATE OR REPLACE FUNCTION claim_webhook_event(
  p_id UUID,
  p_provider TEXT,
  p_event_id TEXT,
  p_event_type TEXT,
  p_payload JSONB,
  p_signature_verified BOOLEAN DEFAULT true
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
  -- Check for existing event
  SELECT * INTO v_existing FROM webhook_events WHERE event_id = p_event_id;

  IF FOUND THEN
    IF v_existing.status IN ('processed', 'duplicate') THEN
      RETURN QUERY SELECT false, 'duplicate'::TEXT, v_existing;
      RETURN;
    ELSIF v_existing.status = 'received' THEN
      RETURN QUERY SELECT false, 'in_progress'::TEXT, v_existing;
      RETURN;
    ELSIF v_existing.status = 'failed' THEN
      -- Re-activate failed webhook event for retry
      UPDATE webhook_events
      SET status = 'received',
          processed_at = NULL,
          payload = p_payload
      WHERE id = v_existing.id AND status = 'failed'
      RETURNING * INTO v_existing;

      IF FOUND THEN
        RETURN QUERY SELECT true, 'retryable'::TEXT, v_existing;
        RETURN;
      ELSE
        RETURN QUERY SELECT false, 'duplicate'::TEXT, v_existing;
        RETURN;
      END IF;
    END IF;
  END IF;

  -- Insert new webhook event
  BEGIN
    INSERT INTO webhook_events (id, provider, event_id, event_type, signature_verified, payload, status)
    VALUES (p_id, p_provider, p_event_id, p_event_type, p_signature_verified, p_payload, 'received')
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
-- Atomically marks payment captured, request fulfilled, webhook processed, and logs audit
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
BEGIN
  -- 1. Update Payment Attempt
  UPDATE payment_attempts
  SET status = 'captured',
      provider_capture_id = p_provider_capture_id,
      updated_at = now()
  WHERE id = p_payment_id;

  -- 2. Update Webhook Event
  UPDATE webhook_events
  SET status = 'processed',
      processed_at = now()
  WHERE id = p_webhook_id;

  -- 3. Transition Procurement Request
  IF p_request_id IS NOT NULL THEN
    UPDATE procurement_requests
    SET status = 'fulfilled',
        updated_at = now()
    WHERE id = p_request_id;
  END IF;

  -- 4. Record Audit Event
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

