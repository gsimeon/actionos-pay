# Product Brief

## Summary
ActionOS Pay is an AI procurement agent for global small businesses, designed with a Nigeria-aware user experience. It turns natural-language purchase instructions into validated quotes, explicit human approvals, PayPal sandbox checkout and a traceable action ledger.

## Problem
Purchasing workflows often span chat, spreadsheets, supplier quotes and payment tools. This creates manual effort, weak auditability and the risk of acting on changed terms.

## Primary user
Small-business owner or operations manager who needs to purchase equipment from approved suppliers under a spending limit.

## MVP journey
1. Submit a purchase request in natural language.
2. Parse into a structured plan and clarify missing details.
3. Select from a seeded supplier/product catalogue.
4. Calculate an itemized quote server-side.
5. Approve or reject a specific immutable quote version.
6. Create PayPal sandbox order from the stored approved quote.
7. Complete checkout and capture server-side.
8. Verify webhook and record authoritative outcome in the ledger.

## MVP requirements
- Authentication and tenant isolation.
- Seeded suppliers/products.
- Structured AI plan, schema validated.
- Quote calculation using integer minor units.
- Budget and approved supplier policy checks.
- Approval bound to quote ID/version/amount/currency.
- PayPal sandbox Orders API integration.
- Verified webhook handling and idempotency.
- Audit ledger and transparent statuses.
- Automated tests for authorization and payment failure cases.

## Out of scope
Live money, unattended autonomous spending, real supplier fulfilment, real escrow, multi-agent orchestration, ERP integrations, invoice OCR, production international compliance.

## Success criteria
A judge can run the documented app, create a quote, observe a policy guardrail, approve the exact quote, complete a PayPal sandbox payment and see a server-verified outcome in the ledger. Any not-yet-implemented behavior must be clearly labelled.
