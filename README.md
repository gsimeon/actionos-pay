# ActionOS Pay

**Governed AI procurement, cryptographic dual-control approval, and verified PayPal Sandbox checkout.**

ActionOS Pay is a hardened AI procurement and payment authorization prototype built for the **PayPal AI Hackathon 2026**. It turns natural-language purchase instructions into validated supplier quotes, enforces corporate governance policies and cryptographic human approvals, executes verified PayPal Orders v2 sandbox checkout, and maintains an authoritative append-only PostgreSQL ledger.

---

## The Problem & Proposition

Small and medium-sized businesses (SMEs) face an operational dilemma: AI agents can dramatically accelerate purchasing and supplier discovery, but autonomous agents must never be granted unconstrained spending authority or direct access to payment credentials.

ActionOS Pay solves this by decoupling **AI intent extraction** from **financial execution** through a cryptographically-enforced governance boundary:
1. **AI Procurement Agent**: Interprets natural language requests, handles ambiguity, and extracts line items against pre-approved catalogues.
2. **Deterministic Server Calculation**: Integer minor-unit arithmetic calculates prices, Nigerian VAT (7.5%), and insured delivery with an immutable SHA-256 seal.
3. **Dual-Control Human Governance**: Requesters cannot approve their own purchases (Segregation of Duties). Authorized finance approvers must issue an HMAC-SHA256 digital signature to unlock payment.
4. **Governed PayPal Checkout**: Orders v2 API creates PayPal checkout sessions strictly from the sealed quote. Clients have zero authority over payment amounts.
5. **Authoritative Financial Ledger**: PostgreSQL row-level locks (`FOR UPDATE`), atomic reservation, and mutual-exclusion capture leases guarantee exactly-one payment outcome.

---

## Featured Scenario: Lagos SME IT Procurement

- **Organization**: **Apex Innovations Africa Ltd** (Victoria Island Tech Hub, Lagos, Nigeria)
- **Requester**: **Sarah Chen** (Head of Engineering)
- **Approver**: **Marcus Vance** (VP of Finance, Delegated Authority: \$15,000)
- **Supplier**: **AfriTech Solutions Hub** (Approved Tier-1 Hardware Vendor)
- **Purchase Intent**: *"Order 2 Dell XPS 15 laptops from AfriTech for our engineering team. Budget under \$5,000."*
- **Terms**: Subtotal \$3,598.00 + 7.5% Nigerian VAT (\$269.85) + Insured Local Logistics (\$45.00) = **\$3,912.85 USD**.
- **Payment Outcome**: Live PayPal Orders v2 Sandbox order creation, buyer approval URL generation, and server-side capture reconciliation.

---

## Three-Tier Acceptance Test Architecture

To maintain rigorous engineering honesty, ActionOS Pay organizes its testing into three distinct tiers:

| Tier | Suite | Scope & Verification |
| :--- | :--- | :--- |
| **Tier 1: Automated Simulation** | Unit, Security & Adversarial Suites (`npm test`) | 129 automated tests verifying state machines, quote seals, SoD rules, tenant isolation, and fail-closed security invariants. |
| **Tier 2: Live PayPal Sandbox API** | Live Sandbox Contract Suite (`npm run test:sandbox`) | Real PayPal Sandbox OAuth2 token acquisition, live Orders v2 API order creation, HATEOAS approval link extraction, and unapproved capture rejection (`ORDER_NOT_APPROVED`). |
| **Tier 3: Interactive Sandbox Acceptance** | CLI Verification Runner (`npm run verify:sandbox`) | End-to-end interactive buyer lifecycle: creates order, prints Sandbox buyer approval URL, and executes `--capture <orderId>` post-approval to record authoritative ledger state. |

---

## Architecture & Financial Invariants

- **Minor-Unit Integer Precision**: All pricing and calculations use integer cents (`179900` = \$1,799.00) to eliminate floating-point drift.
- **Client Amounts Untrusted**: Browsers never supply payment amounts. Prices are loaded authoritatively from the catalogue on the server.
- **Atomic Order Reservation**: Stored procedure `reserve_payment_attempt_atomic` (Migration `00008`) reserves quotes before contacting PayPal, enforcing mutual exclusion against concurrent requests.
- **Atomic Capture Claims**: Stored procedure `claim_payment_capture_atomic` acquires a time-bounded capture lease, preventing simultaneous duplicate capture requests.
- **Fail-Closed Webhook Verification**: Webhook mock signatures are strictly restricted to `APP_MODE=demo` in non-production, non-live environments without PayPal credentials. Any deployment with PayPal credentials requires a valid `PAYPAL_WEBHOOK_ID` and verifies cryptographically via PayPal's API.
- **Production Demo Lockdown**: In production (`NODE_ENV=production`), demo identity headers (`x-demo-user-id`) are strictly prohibited (returning 403), state reset is unconditionally disabled (returning 403), and simulation is disabled. Real Supabase Bearer JWT authentication is mandatory.
- **Runtime Environment Validation**: Runtime validation strictly verifies `PAYPAL_ENV` (`'sandbox'` or `'live'`), rejecting typos or unsupported configurations.
- **Tenant Isolation**: Multi-tenant database schema with Row Level Security (RLS) on every table scoped to `business_id`.
- **Append-Only Ledger**: All events (`REQUEST_CREATED`, `QUOTE_CALCULATED`, `QUOTE_APPROVED`, `PAYMENT_ATTEMPT_CREATED`, `PAYMENT_CAPTURED`, etc.) are immutably logged with actor, role, and payload diffs.

---

## Tech Stack

- **Framework**: Next.js 15 (App Router) + React 19 + TypeScript
- **Styling**: Tailwind CSS + Enterprise Structured Theme (Light default, Dark optional)
- **Validation**: Zod
- **Database**: Supabase PostgreSQL with RLS migrations (`00001` -> `00008`) & seed data
- **Payments**: PayPal Orders API v2 (Sandbox + Emulated Fallback)
- **AI**: Gemini API (`gemini-1.5-flash`) + Offline Deterministic Planner
- **Testing**: Vitest (Unit, Integration, Adversarial, and PayPal Sandbox Live Suites)

---

## Quick Start (Run Locally in Under 3 Minutes)

Requirements: Node.js 20.9+ and npm.

```bash
# 1. Install dependencies
npm install

# 2. Run automated test suites (129/129 passing)
npm test

# 3. Run live multi-session PostgreSQL concurrency test suite
npm run test:db:concurrency

# 4. Run live PayPal Sandbox API acceptance tests
npm run test:sandbox

# 5. Run PayPal Sandbox CLI order verification runner
npm run verify:sandbox

# 6. Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to access the interactive Procurement Studio, Authoritative Ledger, Catalogue Directory, and Security Simulator.

---

## CI & Automated Quality Gates

Every pull request and push to `main` executes a GitHub Actions pipeline (`.github/workflows/ci.yml`) enforcing 4 discrete acceptance gates:
1. **Static Analysis & Lint Gate**: ESLint and TypeScript strict type checking (`npm run lint`, `npm run typecheck`).
2. **Financial Integrity & Adversarial Tests**: Vitest test execution across all 129 tests.
3. **Database Migration & PostgreSQL Acceptance Gate**: Boots a live `postgres:15-alpine` container, sequentially applies migrations `00001` through `00008`, and executes:
   - `tests/db/test-migrations-and-rpcs.sql`: 27 live stored procedures, transactional constraints, session identity binding (`auth.uid()`), atomic reservation, lease contention, and rollback behaviors.
   - `tests/db/test-role-permissions.sql`: Dynamic PostgreSQL role switching (`SET ROLE`) verifying privilege boundaries across `anon`, `authenticated` (matching/mismatched `auth.uid()`), and `service_role`.
   - `tests/db/test-concurrency.ts`: True multi-session concurrent PostgreSQL tests running under `service_role` and verifying simultaneous webhook claiming races, double-approval lock serialization (`FOR UPDATE`), payment reconciliation idempotency, and atomic order reservation mutual exclusion across separate database connections.
4. **Next.js Production Build Gate**: Clean production compilation with standalone bundle validation (`next build`).

---

## Scheduled Webhook Recovery Automation

Abandoned worker claims (>60s) and retryable failed webhook events are processed automatically via `.github/workflows/scheduled-recovery.yml` every 15 minutes.
When `WEBHOOK_RECOVERY_URL` and `CRON_SECRET` are configured:
- Workflow executes a preflight configuration verification, failing if secrets are missing.
- Dispatches `POST /api/paypal/webhook/recover` with `{"strict": true}`.
- Parses JSON metrics: fails the job if `failedCount > 0`, and alerts if `deadLetteredCount > 0`.

---

## Environment Variables

Copy `.env.example` to `.env.local` to configure live external credentials:

```env
# Supabase Configuration
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
APPROVAL_SIGNING_SECRET=
CRON_SECRET=
MONITORING_SECRET=

# PayPal Orders v2 Sandbox Configuration
PAYPAL_ENV=sandbox
PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
PAYPAL_WEBHOOK_ID=
PAYPAL_ALLOW_SIMULATION=true

# AI Intent Engine Configuration
AI_PROVIDER=gemini
AI_API_KEY=
AI_MODEL=gemini-1.5-flash
```

---

## Hackathon Submission Details

- **Hackathon**: PayPal AI Hackathon 2026 (Devpost)
- **Submission Deadline**: November 12, 2026 at 12:00 PM PT (9:00 PM WAT)
- **Demo Video**: [3-Minute YouTube Walkthrough](#) *(Lagos SME B2B procurement, dual-control approval, and PayPal Sandbox checkout)*
- **License**: MIT
