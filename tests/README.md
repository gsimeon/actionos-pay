# ActionOS Pay Test Suites & Verification Matrix

All test suites are automated and executed locally and in CI using Vitest.

## Executable Test Status (71/71 Passing)

| Category | Suite File | Tests | Status | Invariants Verified |
| :--- | :--- | :---: | :---: | :--- |
| **Unit: Currency & Quotes** | `tests/unit/currency-and-quote.test.ts` | 11 | PASSED | Minor unit (cents) arithmetic, PayPal decimal string formatting without float drift, ISO currency decimal mapping, multi-currency decimal string parsing and formatting without precision loss, quote checksum generation, deterministic quote calculation, and multi-item tax/shipping integrity. |
| **Unit: Policy & Approval** | `tests/unit/policy-and-approval.test.ts` | 6 | PASSED | Approved vendor verification, budget threshold compliance, Segregation of Duties (SoD), role-based approval authority, and cryptographic quote binding. |
| **Unit: PayPal Safety** | `tests/unit/paypal-safety.test.ts` | 6 | PASSED | Never simulating success on real API failures, placeholder credentials safety, capture error propagation, explicit simulated status indicators (`SIM-DEMO-`), capture idempotency, and strict webhook header validation. |
| **Unit: Supabase Persistence** | `tests/unit/supabase.test.ts` | 4 | PASSED | Supabase client configuration, template placeholder safety, error throwing on database failures, and audit logging. |
| **Adversarial: Guardrails** | `tests/adversarial/security-guardrails.test.ts` | 7 | PASSED | Quote tampering detection, unapproved supplier rejection, budget overage blocking, and quote expiry enforcement. |
| **Adversarial: Auth & Webhook** | `tests/adversarial/authorization-and-persistence.test.ts` | 35 | PASSED | Anonymous/forged approver rejection (HTTP 401/403), Supabase Auth Bearer session token verification across endpoints, database-backed membership/role lookup, requester self-approval blocking over $500, approver delegated threshold checks, mandatory HMAC secret-backed signature verification with constant-time comparison, legacy unkeyed SHA-256 rejection, exclusive dedicated `APPROVAL_SIGNING_SECRET` requirement (disallowing `SUPABASE_SERVICE_ROLE_KEY` fallback), quote checksum tampering rejection, webhook underpayment rejection (`WEBHOOK_AMOUNT_MISMATCH`), conflict-safe atomic webhook event claiming with 60s lease TTL & abandoned worker recovery, HTTP 429 (`Retry-After: 10`) retry preservation for active webhook claims (preventing premature 200 false acknowledgments), mandatory provider capture ID validation (rejecting missing `resource.id` and prohibiting `'CAP-UNKNOWN'`), background claim recovery (`recoverExpiredWebhookClaimsAsync`), strict fail-closed database RPC operations without silent sequential fallback, production demo mode isolation guard, dynamic multi-tenant plan route organization resolution, production mock signature rejection, webhook approval cryptographic binding verification, atomic payment reconciliation, missing/non-positive capture amount rejection, failed webhook retryability, database persistence error surfacing, and prohibition of synchronous persistence when Supabase is configured. |
| **Integration: Procurement Flow**| `tests/integration/procurement-flow.test.ts` | 2 | PASSED | End-to-end deterministic lifecycle (service level) AND full end-to-end execution through actual Next.js App Router HTTP handlers (`plan` -> `quote` -> `approve` -> `create-order` -> `capture-order` -> `webhook`). |

**Total: 71 passing tests across 7 test suites.**

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
