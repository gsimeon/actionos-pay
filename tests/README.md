# ActionOS Pay Test Suites & Verification Matrix

All test suites are automated and executed locally and in CI using Vitest.

## Executable Test Status (95/95 Passing)

| Category | Suite File | Tests | Status | Invariants Verified |
| :--- | :--- | :---: | :---: | :--- |
| **Unit: Currency & Quotes** | `tests/unit/currency-and-quote.test.ts` | 11 | PASSED | Minor unit (cents) arithmetic, PayPal decimal string formatting without float drift, ISO currency decimal mapping, multi-currency decimal string parsing and formatting without precision loss, quote checksum generation, deterministic quote calculation, and multi-item tax/shipping integrity. |
| **Unit: Policy & Approval** | `tests/unit/policy-and-approval.test.ts` | 6 | PASSED | Approved vendor verification, budget threshold compliance, Segregation of Duties (SoD), role-based approval authority, and cryptographic quote binding. |
| **Unit: PayPal Safety** | `tests/unit/paypal-safety.test.ts` | 6 | PASSED | Never simulating success on real API failures, placeholder credentials safety, capture error propagation, explicit simulated status indicators (`SIM-DEMO-`), capture idempotency, and strict webhook header validation. |
| **Unit: Supabase Persistence** | `tests/unit/supabase.test.ts` | 4 | PASSED | Supabase client configuration, template placeholder safety, error throwing on database failures, and audit logging. |
| **Adversarial: Guardrails** | `tests/adversarial/security-guardrails.test.ts` | 7 | PASSED | Quote tampering detection, unapproved supplier rejection, budget overage blocking, and quote expiry enforcement. |
| **Adversarial: Auth & Webhook** | `tests/adversarial/authorization-and-persistence.test.ts` | 59 | PASSED | Anonymous/forged approver rejection (HTTP 401/403), Supabase Auth Bearer session token verification across endpoints, database-backed membership/role lookup, requester self-approval blocking over $500, approver delegated threshold checks, mandatory HMAC secret-backed signature verification with constant-time comparison, legacy unkeyed SHA-256 rejection, exclusive dedicated `APPROVAL_SIGNING_SECRET` requirement, quote checksum tampering rejection, webhook underpayment rejection (`WEBHOOK_AMOUNT_MISMATCH`), conflict-safe atomic webhook event claiming with 60s lease TTL & abandoned worker recovery, HTTP 429 (`Retry-After: 10`) retry preservation for active claims, mandatory provider capture ID validation, strict reconciliation idempotency (rejecting mismatched `provider_capture_id` with conflict exceptions while accepting matching duplicate captures after full relational validation), cross-entity relational integrity verification across payment, quote, request, and webhook rows, operational durable webhook recovery worker (`runWebhookRecoveryWorkerAsync`) with retry backoff and dead-lettering (`exhausted` status on >= 5 retries), lease expiry metadata preservation in `recoverExpiredWebhookClaimsWithMetadataAsync` (CTE ensures `previous_lease_expiry` is never NULL), atomic quote creation and request status transition (`persist_quote_and_transition_request_atomic`), atomic approval persistence, quote/request status transition, and audit trail (`persist_approval_and_transition_atomic`), database-level approval constraints (quote version, total cents, currency, supplier, business tenant, and decision restriction), removal of legacy non-atomic fallbacks (fail-closed with `DatabaseCompatibilityError`), secured operational metrics endpoint (`/api/paypal/webhook/recover` GET protected with `CRON_SECRET`, `MONITORING_SECRET`, or admin session), dedicated recovery trigger (`POST /api/paypal/webhook/recover`), dynamic multi-tenant state isolation across organizations, strict fail-closed database RPC operations, and prohibition of synchronous persistence when Supabase is configured. |
| **Integration: Procurement Flow**| `tests/integration/procurement-flow.test.ts` | 2 | PASSED | End-to-end deterministic lifecycle (service level) AND full end-to-end execution through actual Next.js App Router HTTP handlers (`plan` -> `quote` -> `approve` -> `create-order` -> `capture-order` -> `webhook`). |
| **Live Database Acceptance** | `tests/db/test-migrations-and-rpcs.sql` | SQL Suite | PASSED in CI | Executes against live `postgres:15-alpine` container in CI Gate 3 to verify sequential migration upgrades (`00001` -> `00002` -> `00003`), stored procedure existence, atomic quote persistence and stale item cleanup, database-enforced approval constraints, payment reconciliation, strict capture idempotency conflict handling, and webhook lease recovery. |

**Total: 95 passing TypeScript tests across 7 test suites, plus live PostgreSQL 15 integration suite.**

---

## Running the Tests Locally

Execute Vitest test runner:
```bash
npm test
```

Execute typecheck:
```bash
npm run typecheck
```

Execute lint:
```bash
npm run lint
```

Execute production build:
```bash
npm run build
```

Full CI pipeline command:
```bash
npm run typecheck && npm run lint && npm test && npm run build
```
