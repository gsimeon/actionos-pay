# Threat Model (initial)

## Assets
Business records, supplier catalogue, purchase quotes, approval records, PayPal order/capture identifiers, secrets and audit history.

## Threats and controls
- Prompt injection or malicious request: treat user/supplier content as untrusted; tool allowlist; strict schemas; no direct model-to-payment execution.
- Amount tampering: server loads quote and computes amount; never trust browser amount.
- Quote mutation after approval: immutable version/snapshot and approval binding.
- Unauthorized approval: authenticated membership/role checks and server-side authorization.
- Cross-tenant access: business_id scoping, RLS and tests.
- Duplicate capture or webhook: idempotency, unique provider IDs and guarded transitions.
- Forged webhook: verify signature using PayPal's supported verification process.
- Secret exposure: server-only env vars, .gitignore, no secrets in logs.
- Ambiguous network result: reconciliation state; no blind retry.
- Audit tampering: append-only application interface and restrictive database permissions.

This is an initial planning document, not a completed security review. Revisit it as integrations are implemented.
