# ActionOS Pay

**AI procurement, human approval, and verified PayPal sandbox payments.**

ActionOS Pay is a production-grade hackathon MVP for governed AI procurement workflows. It turns natural-language purchase instructions into validated quotes, explicit human approvals, PayPal sandbox checkout, and an authoritative append-only ledger.

## Implemented Flow

1. **Natural-Language Purchase Intent**: Users describe purchase requests in natural language with optional budget limits (e.g., *"Order 2 Dell XPS 15 laptops from AfriTech for our engineering team. Budget under $5,000."*).
2. **AI Structured Planning**: Schema-validated intent extraction with Gemini 1.5 Flash / offline deterministic fallback. Identifies target suppliers, catalogue SKUs, quantities, and flags structured clarification questions when input is ambiguous.
3. **Deterministic Server Quote Engine**: Calculates itemized pricing strictly from trusted database records in integer minor units (cents). Computes subtotal, VAT/tax (7.5%), insured freight ($45.00), and a cryptographic **SHA-256 seal** over the exact quote terms.
4. **Corporate Governance & Policy Engine**: Enforces company guardrails:
   - Approved vendor verification (blocks unapproved suppliers like ShadowTech).
   - Budget threshold compliance (flags overages).
   - Segregation of Duties (SoD) & Self-Approval Ban (requesters cannot self-approve purchases > $500).
   - Role-based authority limits.
5. **Human Approval Gate**: Authorized approvers (e.g., VP of Finance) review the quote and generate an immutable digital signature sealing Quote ID, Version, Total, Currency, and Supplier.
6. **PayPal Sandbox Integration**: Server creates orders via PayPal Orders v2 API strictly from the approved quote record (client has zero authority over amount). Captures payments server-side with idempotency keys.
7. **Webhook Verification & Authoritative Ledger**: Reconciles payment events with signature verification and event deduplication, recording all actions in an append-only audit trail.
8. **Interactive Security Playground**: 1-click test bench in the UI to demonstrate defense against price tampering, unapproved vendor orders, SoD bypass, and replay attacks.

## Architecture & Security Invariants

- **Minor-Unit Integer Precision**: All pricing and calculations use integer cents (`179900` = `$1,799.00`) to prevent floating-point drift.
- **Client Amounts Untrusted**: Browsers never supply payment amounts. Prices are loaded authoritatively from the catalogue on the server.
- **Immutable Approval Binding**: Approvals cryptographically bind to `{ quoteId, version, totalCents, currency, supplierId }`. Any quote change invalidates previous approval.
- **Append-Only Ledger**: All events (`REQUEST_CREATED`, `QUOTE_CALCULATED`, `POLICY_EVALUATED`, `QUOTE_APPROVED`, `PAYMENT_CAPTURED`, etc.) are immutably logged with actor, role, and payload diffs.
- **Tenant Isolation**: Multi-tenant database schema with Row Level Security (RLS) on every table scoped to `business_id`.

## Tech Stack

- **Framework**: Next.js 15 (App Router) + React 19 + TypeScript
- **Styling**: Tailwind CSS + Custom Dark Theme Glassmorphism
- **Validation**: Zod
- **Database**: Supabase PostgreSQL with RLS migrations & seed data
- **Payments**: PayPal Orders API v2 (Sandbox + Emulated Fallback)
- **AI**: Gemini API (`gemini-1.5-flash`) + Offline Deterministic Planner
- **Testing**: Vitest (Unit, Integration, and Adversarial Suites)

## Quick Start

Requirements: Node.js 20.9+ and npm.

```bash
# 1. Install dependencies
npm install

# 2. Run automated test suites (95/95 passing)
npm test

# 3. Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to access the interactive Procurement Studio, Authoritative Ledger, Catalogue Directory, and Security Simulator.

## CI & Automated Quality Gates

Every pull request and push to `main` executes a GitHub Actions pipeline (`.github/workflows/ci.yml`) enforcing 4 discrete acceptance gates:
1. **Static Analysis & Lint Gate**: ESLint and TypeScript strict type checking (`npm run lint`, `npm run typecheck`).
2. **Financial Integrity & Adversarial Tests**: Vitest test execution across all 95 tests.
3. **Database Migration & PostgreSQL Acceptance Gate**: Boots a live `postgres:15-alpine` container, applies `00001` -> `00002` -> `00003` migrations, and executes `tests/db/test-migrations-and-rpcs.sql` to verify live stored procedures, transactional constraints, and rollback behaviors.
4. **Next.js Production Build Gate**: Clean production compilation with standalone bundle validation (`next build`).

## Scheduled Webhook Recovery Automation

Abandoned worker claims (>60s) and retryable failed webhook events are processed automatically via `.github/workflows/scheduled-recovery.yml` every 15 minutes.
When `WEBHOOK_RECOVERY_URL` and `CRON_SECRET` are configured in GitHub Actions secrets, it triggers `POST /api/paypal/webhook/recover` via `curl`, validates HTTP 200, checks dead-letter counts, and alerts if events are exhausted.

For Supabase / self-hosted PostgreSQL deployments with `pg_cron` enabled, the worker can also be scheduled directly in the database:
```sql
-- Schedule recovery worker every 5 minutes in PostgreSQL
SELECT cron.schedule(
  'recover-abandoned-webhooks',
  '*/5 * * * *',
  $$ SELECT recover_expired_webhook_claims(60); $$
);
```

## Environment Variables

Copy `.env.example` to `.env.local` to configure live external credentials:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
APPROVAL_SIGNING_SECRET=
CRON_SECRET=
MONITORING_SECRET=

PAYPAL_ENV=sandbox
PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
PAYPAL_WEBHOOK_ID=
PAYPAL_ALLOW_SIMULATION=true

AI_PROVIDER=gemini
AI_API_KEY=
AI_MODEL=gemini-1.5-flash
```

> **Security Invariant**: When `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` are configured with valid credentials, all PayPal API failures (authentication errors, rate limits, instrument declines) fail loudly with explicit failure states. They **never** fall back to simulated success. Simulation is strictly quarantined for credential-free demos with explicit indicators (`SIM-DEMO-ORD-`, `isSimulated: true`), and template placeholders (`your-*`) are automatically ignored.

## Test Suites (95 Tests Passing)

The test suite covers arithmetic precision, multi-currency decimal accuracy, policy guardrails, approval binding, adversarial attacks, PayPal anti-false-positive safety, Supabase persistence durability, and end-to-end flows:

```bash
npm test
```

- `tests/unit/currency-and-quote.test.ts` (11 tests): Minor-unit arithmetic, float safety, ISO currency decimal mapping, multi-currency decimal string parsing and formatting without precision loss, tax math, quote calculation, and SHA-256 seal.
- `tests/unit/policy-and-approval.test.ts` (6 tests): Approved vendor verification, budget limits, role authority, SoD self-approval ban.
- `tests/unit/paypal-safety.test.ts` (6 tests): Anti-false-positive guarantees, placeholder credentials safety, capture error propagation, explicit simulated status indicators (`SIM-DEMO-`), capture idempotency, and strict webhook header validation.
- `tests/unit/supabase.test.ts` (4 tests): Supabase client initialization, configuration checks, placeholder safety, and error throwing on database write failures.
- `tests/adversarial/security-guardrails.test.ts` (7 tests): Client price tampering, in-flight term alteration, unapproved vendor attempts, missing approval rejection, double-capture prevention, duplicate webhook deduplication.
- `tests/adversarial/authorization-and-persistence.test.ts` (59 tests): Server-side approver identity gate, Supabase Auth Bearer session token verification across routes, database-backed membership/role lookup, SoD enforcement, mandatory HMAC secret-backed signature verification with constant-time comparison, legacy SHA-256 rejection, exclusive dedicated `APPROVAL_SIGNING_SECRET` requirement, quote checksum tampering rejection, webhook underpayment rejection (`WEBHOOK_AMOUNT_MISMATCH`), conflict-safe atomic webhook event claiming with 60s lease TTL, HTTP 429 (`Retry-After: 10`) retry preservation for active claims, mandatory provider capture ID validation (rejecting missing `resource.id` and prohibiting `'CAP-UNKNOWN'`), strict reconciliation idempotency (rejecting mismatched `provider_capture_id` with conflict exceptions while accepting matching duplicate captures after full relational validation), cross-entity relational integrity verification across payment, quote, request, and webhook rows, operational durable webhook recovery worker (`runWebhookRecoveryWorkerAsync`) with retry backoff and dead-lettering (`exhausted` status on >= 5 retries), lease expiry metadata preservation in `recoverExpiredWebhookClaimsWithMetadataAsync` (CTE ensures `previous_lease_expiry` is never NULL), atomic quote creation and request status transition (`persist_quote_and_transition_request_atomic`), atomic approval persistence, quote/request status transition, and audit trail (`persist_approval_and_transition_atomic`), database-level approval constraints (quote version, total cents, currency, supplier, business tenant, and decision restriction), removal of legacy non-atomic fallbacks (fail-closed with `DatabaseCompatibilityError`), secured operational metrics endpoint (`/api/paypal/webhook/recover` GET protected with `CRON_SECRET`, `MONITORING_SECRET`, or admin session), dedicated recovery trigger (`POST /api/paypal/webhook/recover`), dynamic multi-tenant state isolation across organizations, strict fail-closed database RPC operations, and prohibition of synchronous persistence when Supabase is configured.
- `tests/integration/procurement-flow.test.ts` (2 tests): End-to-end deterministic lifecycle via service layer and full lifecycle execution through actual Next.js App Router HTTP handlers (`plan` -> `quote` -> `approve` -> `create-order` -> `capture-order` -> `webhook`).

## Database Migrations

- `supabase/migrations/00001_initial_schema.sql`: 11 tables with RLS policies, foreign keys, and indexes.
- `supabase/migrations/00002_atomic_reconciliation.sql`: Schema evolution adding `claim_lease_expires_at` column, `claim_webhook_event`, `create_quote_atomic`, and initial atomic reconciliation.
- `supabase/migrations/00003_financial_integrity_hardening.sql`: Forward migration adding `retry_count`, `last_error`, `next_retry_at` columns, hardened `reconcile_payment_capture_atomic` with strict capture ID matching idempotency and full relational integrity cross-checks, `claim_expired_webhook_events_for_worker`, `dead_letter_exhausted_webhook_events`, `recover_expired_webhook_claims` with preserved metadata, `persist_quote_and_transition_request_atomic`, and `persist_approval_and_transition_atomic`.
- `supabase/seed.sql`: Deterministic tenant, team members, approved/unapproved suppliers, and catalogue products in minor units.

## License

MIT. See `LICENSE`.
