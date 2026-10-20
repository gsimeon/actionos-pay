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

# 2. Run automated test suites (41/41 passing)
npm test

# 3. Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to access the interactive Procurement Studio, Authoritative Ledger, Catalogue Directory, and Security Simulator.

## CI & Automated Quality Gates

Every pull request and push to `main` executes a GitHub Actions pipeline (`.github/workflows/ci.yml`) validating:
```bash
npm run typecheck && npm run lint && npm test && npm run build
```

## Environment Variables

Copy `.env.example` to `.env.local` to configure live external credentials:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

PAYPAL_ENV=sandbox
PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
PAYPAL_WEBHOOK_ID=
PAYPAL_ALLOW_SIMULATION=true

AI_PROVIDER=gemini
AI_API_KEY=
AI_MODEL=gemini-1.5-flash
```

> **Security Invariant**: When `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` are configured, all PayPal API failures (authentication errors, rate limits, instrument declines) fail loudly with explicit failure states. They **never** fall back to simulated success. Simulation is strictly quarantined for credential-free demos with explicit indicators (`SIM-DEMO-ORD-`, `isSimulated: true`).

## Test Suites (41 Tests Passing)

The test suite covers arithmetic precision, policy guardrails, approval binding, adversarial attacks, PayPal anti-false-positive safety, Supabase persistence durability, and end-to-end flows:

```bash
npm test
```

- `tests/unit/currency-and-quote.test.ts` (8 tests): Minor-unit arithmetic, float safety, tax math, quote calculation, SHA-256 seal.
- `tests/unit/policy-and-approval.test.ts` (6 tests): Approved vendor verification, budget limits, role authority, SoD self-approval ban.
- `tests/unit/paypal-safety.test.ts` (5 tests): Anti-false-positive guarantees, capture error propagation, explicit simulated status indicators (`SIM-DEMO-`), capture idempotency, and strict webhook header validation.
- `tests/unit/supabase.test.ts` (4 tests): Supabase client initialization, configuration checks, and error throwing on database write failures.
- `tests/adversarial/security-guardrails.test.ts` (7 tests): Client price tampering, in-flight term alteration, unapproved vendor attempts, missing approval rejection, double-capture prevention, duplicate webhook deduplication.
- `tests/adversarial/authorization-and-persistence.test.ts` (10 tests): Server-side approver identity gate, role authorization, SoD enforcement, quote checksum tampering rejection, webhook underpayment rejection (`WEBHOOK_AMOUNT_MISMATCH`), event deduplication idempotency, and Supabase error surfacing.
- `tests/integration/procurement-flow.test.ts` (1 test): Full lifecycle from natural-language intent to verified payment capture and ledger audit.

## Database Migrations

- `supabase/migrations/00001_initial_schema.sql`: 11 tables with RLS policies, foreign keys, and indexes.
- `supabase/seed.sql`: Deterministic tenant, team members, approved/unapproved suppliers, and catalogue products in minor units.

## License

MIT. See `LICENSE`.
