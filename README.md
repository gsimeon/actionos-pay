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
5. **Authoritative Financial Ledger**: PostgreSQL row-level locks (`FOR UPDATE`), atomic reservation, and mutual-exclusion capture leases prevent duplicate processing and support reliable payment reconciliation across distributed boundaries.

---

## Featured Scenario: Lagos SME IT Procurement

- **Organization**: **Apex Innovations Africa Ltd** (Victoria Island Tech Hub, Lagos, Nigeria)
- **Requester**: **Amina Bello** (Head of Procurement)
- **Approver**: **Chidi Okonkwo** (VP of Finance, Delegated Authority: \$15,000)
- **Administrator**: **Tunde Davies** (Managing Director)
- **Supplier**: **AfriTech Solutions Hub** (Approved Tier-1 Hardware Vendor)
- **Purchase Intent**: *"Order 2 Dell XPS 15 laptops from AfriTech for our engineering team. Budget under \$5,000."*
- **Terms**: Subtotal \$3,598.00 + 7.5% Nigerian VAT (\$269.85) + Insured Local Logistics (\$45.00) = **\$3,912.85 USD**.
- **Payment Outcome**: Live PayPal Orders v2 Sandbox order creation, buyer approval URL generation, and server-side capture reconciliation.

*(Note: The Lagos SME scenario incorporates illustrative 7.5% Nigerian VAT and local logistics calculations for demonstration; it represents a governed corporate procurement workflow rather than an exhaustive international tax-compliance engine.)*

---

## Three-Tier Acceptance Test Architecture

To maintain rigorous engineering honesty, ActionOS Pay organizes its testing into three distinct tiers:

| Tier | Suite | Scope & Verification |
| :--- | :--- | :--- |
| **Tier 1: Automated Simulation** | Unit, Security & Adversarial Suites (`npm test`) | 137 automated tests across 10 test files verifying state machines, quote seals, SoD rules, tenant isolation, production capture lockdown, and fail-closed security invariants. |
| **Tier 2: Live PayPal Sandbox API** | Live Sandbox Contract Suite (`npm run test:sandbox`) | Real PayPal Sandbox OAuth2 token acquisition, live Orders v2 API order creation, HATEOAS approval link extraction, and unapproved capture rejection (`ORDER_NOT_APPROVED`). |
| **Tier 3: Interactive Sandbox Acceptance** | CLI Verification Runner (`npm run verify:sandbox`) | End-to-end interactive buyer lifecycle: creates order, prints Sandbox buyer approval URL, verifies pre-capture order status (`APPROVED`), and executes server-side capture via `--capture <orderId>` to record authoritative ledger state. |

---

## Architecture & Financial Invariants

- **Minor-Unit Integer Precision**: All pricing and calculations use integer cents (`179900` = \$1,799.00) to eliminate floating-point drift.
- **Client Amounts Untrusted**: Browsers never supply payment amounts. Prices are loaded authoritatively from the catalogue on the server.
- **Atomic Order Reservation**: Stored procedure `reserve_payment_attempt_atomic` (Migration `00008`) reserves quotes before contacting PayPal, enforcing mutual exclusion against concurrent requests.
- **Atomic Capture Claims**: Stored procedure `claim_payment_capture_atomic` (Migration `00008` & `00009`) acquires a time-bounded capture lease, preventing simultaneous duplicate capture requests.
- **Capture State Alignment**: Migration `00009` ensures that failed payment attempts return `status = 'FAILED'`, preventing failed records from illicitly transitioning back to `reconciling`.
- **Production Simulation Lockdown**: In production (`NODE_ENV=production`) or whenever real PayPal credentials are configured, simulated order captures are strictly prohibited with HTTP 403 / error exceptions.
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
- **Database**: Supabase PostgreSQL with RLS migrations (`00001` -> `00009`) & seed data
- **Payments**: PayPal Orders API v2 (Sandbox + Emulated Fallback)
- **AI**: Gemini API (`gemini-1.5-flash`) + Offline Deterministic Planner
- **Testing**: Vitest (Unit, Integration, Adversarial, and PayPal Sandbox Live Suites)

---

## Quick Start & Setup Paths for Judges

Requirements: Node.js 20.9+ and npm.

### Path A: Zero-Config Local Demo Mode (Quick Evaluation)
No database credentials or PayPal credentials needed. Runs with an in-memory ledger and local simulation.

```bash
# 1. Install dependencies
npm install

# 2. Run automated test suites (137 tests passing)
npm test

# 3. Start local development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to access:
- **Procurement Studio**: Natural language procurement with AI intent planner.
- **Authoritative Ledger**: Visual audit trail with immutable event history.
- **Catalogue Directory**: Verified pre-approved suppliers and equipment.
- **Security Simulator**: Adversarial testing for Segregation of Duties, price tampering, and expired quotes.

> [!NOTE]
> Demo identities:
> - **Amina Bello** (`requester`): Submits requests.
> - **Chidi Okonkwo** (`approver`): Issues cryptographic approvals up to \$15,000.
> - **Tunde Davies** (`admin`): Full executive governance and configuration.
> 
> *Simulated payments in demo mode are for local functional walkthroughs and policy testing only; they are strictly segregated from real PayPal transactions.*

---

### Path B: Real PayPal Sandbox Mode (Live API & Verification)
Requires PayPal Sandbox Developer Credentials:
1. Copy `.env.example` to `.env.local` and add:
   ```env
   PAYPAL_ENV=sandbox
   PAYPAL_CLIENT_ID=your-sandbox-client-id
   PAYPAL_CLIENT_SECRET=your-sandbox-client-secret
   PAYPAL_WEBHOOK_ID=your-sandbox-webhook-id
   ```
2. Run Tier 2 Live PayPal Sandbox Contract Suite:
   ```bash
   npm run test:sandbox
   ```
3. Run Tier 3 Interactive Buyer-to-Ledger Acceptance Runner:
   ```bash
   # Generates quote, signed approval, reserves attempt in ledger, and creates live PayPal order
   npm run verify:sandbox

   # Follow the printed instructions: approve in sandbox browser, then capture:
   npm run verify:sandbox -- --capture <ORDER_ID>
   ```

---

### Path C: Multi-Session PostgreSQL Concurrency & Migration Testing
Requires a live PostgreSQL database (e.g., local Docker container or Supabase):
```bash
# Set DATABASE_URL to your test PostgreSQL instance
export DATABASE_URL=postgres://test_user:test_password@localhost:5432/actionos_test

# Run the live multi-session concurrency suite (testing row-locks and RPCs)
npm run test:db:concurrency
```

---

## CI & Automated Quality Gates

Every pull request and push to `main` executes a GitHub Actions pipeline (`.github/workflows/ci.yml`) enforcing 4 discrete acceptance gates:
1. **Static Analysis & Lint Gate**: ESLint and TypeScript strict type checking (`npm run lint`, `npm run typecheck`).
2. **Financial Integrity & Adversarial Tests**: Vitest test execution across all 137 tests.
3. **Database Migration & PostgreSQL Acceptance Gate**: Boots a live `postgres:15-alpine` container, sequentially applies migrations `00001` through `00009`, and executes:
   - `tests/db/test-migrations-and-rpcs.sql`: 29 live stored procedures, transactional constraints, session identity binding (`auth.uid()`), atomic reservation, lease contention, failed capture state handling, and rollback behaviors.
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

## Hackathon Submission Details

- **Hackathon**: PayPal AI Hackathon 2026 (Devpost)
- **Submission Deadline**: November 12, 2026 at 12:00 PM PT (9:00 PM WAT)
- **Demo Video**: [3-Minute YouTube Walkthrough](#) *(Lagos SME B2B procurement, Gemini AI intent planning, dual-control approval, and PayPal Sandbox checkout — video link will be populated upon final Devpost submission)*
- **License**: MIT
