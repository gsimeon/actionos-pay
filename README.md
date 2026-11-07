# ActionOS Pay

**Governed AI procurement, cryptographic human approval, and verified PayPal sandbox checkout.**

ActionOS Pay is a production-grade enterprise procurement and payment authorization platform. It turns natural-language purchase instructions into validated supplier quotes, explicit cryptographic human approvals, verified PayPal Orders v2 sandbox checkout, and an authoritative append-only PostgreSQL ledger.

## Implemented Flow

1. **Natural-Language Purchase Intent**: Requesters describe procurement requirements in natural language with budget constraints (e.g., *"Order 2 Dell XPS 15 laptops from AfriTech for our engineering team. Budget under \$5,000."*).
2. **AI Structured Planning**: Schema-validated intent extraction with Gemini 1.5 Flash / offline deterministic fallback. Identifies target suppliers, catalogue SKUs, quantities, and flags structured clarification questions when specifications are incomplete.
3. **Deterministic Server Quote Engine**: Calculates itemized pricing strictly from trusted database records in integer minor units (cents). Computes subtotal, VAT/tax (7.5%), insured freight (\$45.00), and a cryptographic **SHA-256 seal** over the exact quote terms.
4. **Corporate Governance & Policy Engine**: Enforces corporate policies:
   - Approved vendor verification (blocks unapproved suppliers like ShadowTech).
   - Budget threshold compliance (flags overages).
   - Segregation of Duties (SoD) & Dual Control (requesters cannot approve their own purchases over \$500).
   - Database-enforced role and spending authority limits.
5. **Human Approval Gate**: Authorized approvers (e.g., VP of Finance) review the quote and generate an immutable HMAC-SHA256 digital signature sealing Quote ID, Version, Total, Currency, and Supplier.
6. **PayPal Sandbox Checkout**: Server creates orders via PayPal Orders v2 API strictly from the approved quote record (client has zero authority over amount). Captures payments server-side with idempotency keys.
7. **Webhook Verification & Authoritative Ledger**: Reconciles payment events with signature verification and event deduplication, recording all actions in an append-only audit trail.
8. **Interactive Security Playground**: 1-click test bench in the UI to demonstrate defense against price tampering, unapproved vendor orders, SoD bypass, and replay attacks.

## Architecture & Financial Invariants

- **Minor-Unit Integer Precision**: All pricing and calculations use integer cents (`179900` = \$1,799.00) to eliminate floating-point drift.
- **Client Amounts Untrusted**: Browsers never supply payment amounts. Prices are loaded authoritatively from the catalogue on the server.
- **Database-Enforced Quote Integrity**: Migration `00004` verifies supplier approval, `subtotal + tax + shipping = total`, line item math (`qty * unit_price = total`), sum of items = subtotal, and monotonic version progression (`v2 = v1 + 1`).
- **Database-Enforced Approval Authority**: Database stored procedures assert that the approver is an active member of the business, holds an authorized role (`approver` or `admin`), has sufficient delegated spending limit, and is not the requester (prohibiting self-approval).
- **Database Webhook Signature Boundary**: Reconciliation requires `signature_verified = true` at the database boundary, and existing verified webhooks cannot be overwritten by unverified payloads.
- **Strict Idempotency**: Repeated captures for the same order verify that `provider_capture_id` matches the existing record, raising conflict exceptions if mismatched.
- **Append-Only Ledger**: All events (`REQUEST_CREATED`, `QUOTE_CALCULATED`, `POLICY_EVALUATED`, `QUOTE_APPROVED`, `PAYMENT_CAPTURED`, etc.) are immutably logged with actor, role, and payload diffs.
- **Tenant Isolation**: Multi-tenant database schema with Row Level Security (RLS) on every table scoped to `business_id`.

## Tech Stack

- **Framework**: Next.js 15 (App Router) + React 19 + TypeScript
- **Styling**: Tailwind CSS + Enterprise Structured Theme
- **Validation**: Zod
- **Database**: Supabase PostgreSQL with RLS migrations (`00001` -> `00004`) & seed data
- **Payments**: PayPal Orders API v2 (Sandbox + Emulated Fallback)
- **AI**: Gemini API (`gemini-1.5-flash`) + Offline Deterministic Planner
- **Testing**: Vitest (Unit, Integration, Adversarial, and PayPal Sandbox Live Suites)

## Quick Start

Requirements: Node.js 20.9+ and npm.

```bash
# 1. Install dependencies
npm install

# 2. Run automated test suites (99/99 passing)
npm test

# 3. Run live PayPal Sandbox E2E tests
npm run test:sandbox

# 4. Run PayPal Sandbox CLI verification script
npm run verify:sandbox

# 5. Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to access the interactive Procurement Studio, Authoritative Ledger, Catalogue Directory, and Security Simulator.

## CI & Automated Quality Gates

Every pull request and push to `main` executes a GitHub Actions pipeline (`.github/workflows/ci.yml`) enforcing 4 discrete acceptance gates:
1. **Static Analysis & Lint Gate**: ESLint and TypeScript strict type checking (`npm run lint`, `npm run typecheck`).
2. **Financial Integrity & Adversarial Tests**: Vitest test execution across all 99 tests.
3. **Database Migration & PostgreSQL Acceptance Gate**: Boots a live `postgres:15-alpine` container, sequentially applies migrations `00001` -> `00002` -> `00003` -> `00004`, and executes `tests/db/test-migrations-and-rpcs.sql` to verify live stored procedures, transactional constraints, and rollback behaviors.
4. **Next.js Production Build Gate**: Clean production compilation with standalone bundle validation (`next build`).

## Scheduled Webhook Recovery Automation

Abandoned worker claims (>60s) and retryable failed webhook events are processed automatically via `.github/workflows/scheduled-recovery.yml` every 15 minutes.
When `WEBHOOK_RECOVERY_URL` and `CRON_SECRET` are configured:
- Workflow executes a preflight configuration verification, failing if secrets are missing.
- Dispatches `POST /api/paypal/webhook/recover` with `{"strict": true}`.
- Parses JSON metrics: fails the job if `failedCount > 0`, and alerts if `deadLetteredCount > 0`.

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
