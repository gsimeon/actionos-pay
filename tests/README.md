# Test plan

Planned suites:
- Unit: quote arithmetic, budget policy, quote expiry and state transitions.
- Integration: auth/tenant access, approval binding, PayPal order/capture service, webhook verification and deduplication.
- E2E: request -> quote -> approval -> sandbox checkout -> verified ledger outcome.
- Adversarial: changed quote, over-budget quote, unapproved supplier, duplicate requests, forged webhook and timeout reconciliation.

Do not mark a scenario as passing until an executable test exists and has been run.
