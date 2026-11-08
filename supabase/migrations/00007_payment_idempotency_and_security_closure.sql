-- =========================================================================================
-- ActionOS Pay: Migration 00007 - Payment Idempotency & Database Security Closure
-- =========================================================================================
-- Phase 11 Hardened Guarantees:
-- 1. Database-level partial unique index preventing duplicate active/in-flight payment attempts for the same quote
-- 2. Fast composite lookup index on quote_id and status
-- 3. Strict schema modification lockdown preventing untrusted roles from mutating public schema
-- =========================================================================================

-- 1. Schema Lockdown Reaffirmation
REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- 2. Payment Attempt Active Uniqueness Constraint
-- Guarantees that at the database engine level, only ONE payment attempt can be in an active
-- non-terminal status ('created', 'approved', 'reconciling') for any quote.
-- Concurrent order creation attempts for the same quote fail closed with a unique constraint violation.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_attempts_active_quote
  ON payment_attempts(quote_id)
  WHERE status IN ('created', 'approved', 'reconciling');

-- 3. Composite Quote and Status Index for Idempotent Queries
CREATE INDEX IF NOT EXISTS idx_payment_attempts_quote_status
  ON payment_attempts(quote_id, status);

-- 4. Table Permission Grants & Service Role Engine Parity
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO service_role;
ALTER ROLE service_role BYPASSRLS;

GRANT SELECT, INSERT, UPDATE ON payment_attempts TO service_role;
GRANT SELECT ON payment_attempts TO authenticated;
