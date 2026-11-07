# ActionOS Pay Test Suites & Verification Matrix

All test suites are automated and executed locally and in CI using Vitest.

## Executable Test Status (103/103 Passing)

| Category | Suite File | Tests | Status | Invariants Verified |
| :--- | :--- | :---: | :---: | :--- |
| **Unit: Currency & Quotes** | `tests/unit/currency-and-quote.test.ts` | 11 | PASSED | Minor unit (cents) arithmetic, PayPal decimal string formatting without float drift, ISO currency decimal mapping, multi-currency decimal string parsing and formatting without precision loss, quote checksum generation, deterministic quote calculation, and multi-item tax/shipping integrity. |
| **Unit: Policy & Approval** | `tests/unit/policy-and-approval.test.ts` | 6 | PASSED | Approved vendor verification, budget threshold compliance, Segregation of Duties (SoD), role-based approval authority, and cryptographic quote binding. |
| **Unit: PayPal Safety** | `tests/unit/paypal-safety.test.ts` | 6 | PASSED | Never simulating success on real API failures, placeholder credentials safety, capture error propagation, explicit simulated status indicators (`SIM-DEMO-`), capture idempotency, and strict webhook header validation. |
| **Unit: Supabase Persistence** | `tests/unit/supabase.test.ts` | 4 | PASSED | Supabase client configuration, template placeholder safety, error throwing on database failures, and audit logging. |
| **Adversarial: Guardrails** | `tests/adversarial/security-guardrails.test.ts` | 7 | PASSED | Quote tampering detection, unapproved supplier rejection, budget overage blocking, and quote expiry enforcement. |
| **Adversarial: Auth & Webhook** | `tests/adversarial/authorization-and-persistence.test.ts` | 60 | PASSED | Anonymous/forged approver rejection (HTTP 401/403), client-supplied approverUserId spoofing rejection when authenticated, Supabase Auth Bearer session token verification across endpoints, database-backed membership/role lookup, requester self-approval blocking over $500, approver delegated threshold checks, mandatory HMAC secret-backed signature verification with constant-time comparison, legacy unkeyed SHA-256 rejection, exclusive dedicated `APPROVAL_SIGNING_SECRET` requirement, quote checksum tampering rejection, webhook underpayment rejection (`WEBHOOK_AMOUNT_MISMATCH`), conflict-safe atomic webhook event claiming with 60s lease TTL & abandoned worker recovery, HTTP 429 (`Retry-After: 10`) retry preservation for active claims, mandatory provider capture ID validation, strict reconciliation idempotency (rejecting mismatched `provider_capture_id` with conflict exceptions while accepting matching duplicate captures after full relational validation), cross-entity relational integrity verification across payment, quote, request, and webhook rows, operational durable webhook recovery worker (`runWebhookRecoveryWorkerAsync`) with retry backoff and dead-lettering (`exhausted` status on >= 5 retries), lease expiry metadata preservation in `recoverExpiredWebhookClaimsWithMetadataAsync` (CTE ensures `previous_lease_expiry` is never NULL), atomic quote creation and request status transition (`persist_quote_and_transition_request_atomic`), atomic approval persistence, quote/request status transition, and audit trail (`persist_approval_and_transition_atomic`), database-level approval constraints (quote version, total cents, currency, supplier, business tenant, and decision restriction), removal of legacy non-atomic fallbacks (fail-closed with `DatabaseCompatibilityError`), secured operational metrics endpoint (`/api/paypal/webhook/recover` GET protected with `CRON_SECRET`, `MONITORING_SECRET`, or admin session), dedicated recovery trigger (`POST /api/paypal/webhook/recover`), dynamic multi-tenant state isolation across organizations, strict fail-closed database RPC operations, and prohibition of synchronous persistence when Supabase is configured. |
| **Integration: Procurement Flow**| `tests/integration/procurement-flow.test.ts` | 2 | PASSED | End-to-end deterministic lifecycle (service level) AND full end-to-end execution through actual Next.js App Router HTTP handlers (`plan` -> `quote` -> `approve` -> `create-order` -> `capture-order` -> `webhook`). |
| **Integration: PayPal Sandbox E2E** | `tests/integration/paypal-sandbox-e2e.test.ts` | 7 | PASSED | Live PayPal OAuth2 authentication, Orders v2 creation (`POST /v2/checkout/orders`), HATEOAS approve URL verification, request idempotency with `PayPal-Request-Id`, pre-execution approval cryptographic binding verification, live buyer approval prerequisite failure handling (`ORDER_NOT_APPROVED`), live webhook signature header validation, and completed 7-stage buyer-to-ledger transaction with atomic webhook claiming, duplicate event delivery replay, and authoritative reconciliation. |
| **Live Database Acceptance** | `tests/db/test-migrations-and-rpcs.sql` | 20 SQL Invariants | PASSED in CI | Executes against live `postgres:15-alpine` container in CI Gate 3 to verify sequential migration upgrades (`00001` -> `00002` -> `00003` -> `00004` -> `00005` -> `00006`), quote arithmetic, line item math, supplier ownership/approval, version progression immutability, stale item purge, membership and role authority checks, dual-control self-approval prohibition, authenticated session identity binding (`auth.uid()`), double approval race-condition guard, webhook signature boundary enforcement, payload overwrite protection, payment idempotency, webhook lease claiming, worker contention (`active_claim_in_progress`), stale lease recovery, rollback atomicity, and function privilege lockdown. |
| **Live Role Permission Boundaries** | `tests/db/test-role-permissions.sql` | Role Simulation Suite | PASSED in CI | Dynamic role switching (`SET ROLE`) verifying: `anon` blocked from all financial RPCs and schema creation (42501); `authenticated` blocked from engine reconciliation and webhook claiming; `authenticated` requires valid `auth.uid()`; `service_role` permitted backend operations and tenant isolation enforced. |
| **Live Multi-Session Concurrency Harness** | `tests/db/test-concurrency.ts` | 4 Parallel Scenarios | PASSED in CI | Multi-session PostgreSQL concurrency testing across independent database clients: simultaneous webhook claim race (serialized worker leases), simultaneous double-approval race (row-level `FOR UPDATE` lock), simultaneous payment capture reconciliation (idempotent replay), and lock contention rollback isolation. |

**Total: 103 passing TypeScript tests across 8 test suites, 20 live PostgreSQL 15 integration assertions, comprehensive role simulation tests, and multi-session concurrency verification.**

---

## Running the Tests Locally

Execute Vitest test runner (all 103 tests):
```bash
npm test
```

Execute Live Multi-Session PostgreSQL Concurrency tests (requires running database):
```bash
npm run test:db:concurrency
```

Execute Live PayPal Sandbox E2E tests:
```bash
npm run test:sandbox
```

Execute PayPal Sandbox CLI verification script:
```bash
npm run verify:sandbox
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
