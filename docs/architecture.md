# Architecture

## Trust boundaries
- Browser: renders UI and initiates user-approved actions; never authoritative for prices or payment status.
- Next.js server routes: authenticate, authorize, validate and orchestrate.
- AI provider: proposes structured plans; cannot directly execute payment or write privileged state.
- Supabase Postgres: stores tenant-scoped business state, quotes, approvals, payment attempts and audit events.
- PayPal: external payment provider; checkout approval and capture status must be reconciled.

## Planned request path
Natural-language request -> validated AI plan -> deterministic catalogue lookup and quote calculation -> policy engine -> immutable quote -> explicit approval -> server-side PayPal order -> buyer checkout -> server-side capture -> verified webhook/reconciliation -> ledger.

## Key invariants
1. Amounts come from trusted database records and server-side calculations.
2. Approval binds to the exact quote version, total, currency and supplier.
3. A quote change invalidates previous approval.
4. Payment execution uses atomic state transitions and idempotency keys.
5. Webhook signature is verified and event IDs are deduplicated.
6. A timeout is not treated as a failure or success without reconciliation.
7. Tenant ownership is checked server-side and enforced with RLS.
8. Privileged keys are server-only.
