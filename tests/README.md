# ActionOS Pay Test Suites & Verification Matrix

All test suites are automated and executed locally and in CI using Vitest.

## Executable Test Status (41/41 Passing)

| Category | Suite File | Tests | Status | Invariants Verified |
| :--- | :--- | :---: | :---: | :--- |
| **Unit: Currency & Quotes** | `tests/unit/currency-and-quote.test.ts` | 8 | PASSED | Minor unit (cents) arithmetic, PayPal decimal string formatting without float drift, quote checksum generation, deterministic quote calculation, and multi-item tax/shipping integrity. |
| **Unit: Policy & Approval** | `tests/unit/policy-and-approval.test.ts` | 6 | PASSED | Approved vendor verification, budget threshold compliance, Segregation of Duties (SoD), role-based approval authority, and cryptographic quote binding. |
| **Unit: PayPal Safety** | `tests/unit/paypal-safety.test.ts` | 5 | PASSED | Never simulating success on real API failures, capture error propagation, explicit simulated status indicators (`SIM-DEMO-`), capture idempotency, and strict webhook header validation. |
| **Unit: Supabase Persistence** | `tests/unit/supabase.test.ts` | 4 | PASSED | Supabase client configuration, table schema naming, error throwing on database failures, and audit logging. |
| **Adversarial: Guardrails** | `tests/adversarial/security-guardrails.test.ts` | 7 | PASSED | Quote tampering detection, unapproved supplier rejection, budget overage blocking, and quote expiry enforcement. |
| **Adversarial: Auth & Webhook** | `tests/adversarial/authorization-and-persistence.test.ts` | 10 | PASSED | Anonymous/forged approver rejection (HTTP 401/403), requester self-approval blocking over $500, approver delegated threshold checks, quote checksum tampering rejection, webhook underpayment rejection (`WEBHOOK_AMOUNT_MISMATCH`), webhook event deduplication idempotency, and database persistence error surfacing. |
| **Integration: Procurement Flow**| `tests/integration/procurement-flow.test.ts` | 1 | PASSED | End-to-end deterministic lifecycle: Request creation → Server-side Quote calculation → Cryptographic Approval binding → PayPal order creation → Capture outcome → Ledger audit trail. |

**Total: 41 passing tests across 7 test suites.**

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
