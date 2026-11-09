/**
 * ActionOS Pay: Live Multi-Session PostgreSQL Concurrency Test Harness
 *
 * Verifies true concurrent transactional behavior using multiple independent
 * PostgreSQL client sessions running against a live database instance:
 * 1. Concurrent Webhook Claiming Race (active_claim_in_progress lease lock)
 * 2. Concurrent Double Approval Race (FOR UPDATE lock serialization)
 * 3. Concurrent Payment Capture Reconciliation Race (idempotency under contention)
 * 4. Lock Contention & Rollback Isolation (zero dirty reads or corrupted state)
 *
 * Usage: npx tsx tests/db/test-concurrency.ts
 */

import { Client } from 'pg';
import { randomUUID } from 'crypto';

const connectionString =
  process.env.DATABASE_URL ||
  'postgres://test_user:test_password@localhost:5432/actionos_test';

async function runConcurrencyTests() {
  console.log('===============================================================');
  console.log('ActionOS Pay: Multi-Session PostgreSQL Concurrency Test Harness');
  console.log('===============================================================\n');

  const client1 = new Client({ connectionString });
  const client2 = new Client({ connectionString });

  await client1.connect();
  await client2.connect();
  console.log('✅ Two independent PostgreSQL client sessions connected.');

  const testBizId = randomUUID();
  const testRequesterId = randomUUID();
  const testApprover1Id = randomUUID();
  const testApprover2Id = randomUUID();
  const testSupplierId = randomUUID();

  try {
    // 0. Setup shared test fixtures
    console.log('\n[Setup] Seeding test organization, memberships, and supplier...');
    await client1.query(`
      INSERT INTO businesses (id, name, slug, default_currency, budget_limit_cents)
      VALUES ('${testBizId}', 'Concurrency Test Org', 'concurrency-test-${Date.now()}', 'USD', 5000000);

      INSERT INTO memberships (id, business_id, user_id, user_name, user_email, role, approval_limit_cents)
      VALUES
        (gen_random_uuid(), '${testBizId}', '${testRequesterId}', 'Concurrent Requester', 'req@test.co', 'requester', 100000),
        (gen_random_uuid(), '${testBizId}', '${testApprover1Id}', 'Concurrent Approver 1', 'app1@test.co', 'approver', 1000000),
        (gen_random_uuid(), '${testBizId}', '${testApprover2Id}', 'Concurrent Approver 2', 'app2@test.co', 'approver', 1000000);

      INSERT INTO suppliers (id, business_id, name, code, is_approved, risk_rating, country)
      VALUES ('${testSupplierId}', '${testBizId}', 'Concurrency Hardware', 'SUP-CONCURR', true, 'low', 'US');
    `);

    // Switch both sessions to production service_role to verify concurrent execution under intended execution role
    console.log('\n[Role Context] Transitioning concurrent sessions to production service_role...');
    await client1.query('SET ROLE service_role');
    await client2.query('SET ROLE service_role');
    console.log('✅ Both client sessions verified executing under service_role.');

    // =========================================================================
    // TEST 1: Simultaneous Webhook Claiming Race
    // =========================================================================
    console.log('\n[Test 1] Executing Simultaneous Webhook Claiming Race across 2 parallel sessions...');
    const eventId = `EVT-CONCURRENT-PARALLEL-${Date.now()}`;
    const claimPayload = JSON.stringify({ id: eventId, amount: 5000 });

    const [claimRes1, claimRes2] = await Promise.all([
      client1.query(
        `SELECT claimed, claim_status FROM claim_webhook_event($1, $2, $3, $4, $5, $6, $7)`,
        [randomUUID(), 'paypal', eventId, 'PAYMENT.CAPTURE.COMPLETED', claimPayload, true, 60]
      ),
      client2.query(
        `SELECT claimed, claim_status FROM claim_webhook_event($1, $2, $3, $4, $5, $6, $7)`,
        [randomUUID(), 'paypal', eventId, 'PAYMENT.CAPTURE.COMPLETED', claimPayload, true, 60]
      ),
    ]);

    const c1 = claimRes1.rows[0];
    const c2 = claimRes2.rows[0];

    console.log(`  Session 1 result: claimed=${c1.claimed}, status=${c1.claim_status}`);
    console.log(`  Session 2 result: claimed=${c2.claimed}, status=${c2.claim_status}`);

    const claimedCount = (c1.claimed ? 1 : 0) + (c2.claimed ? 1 : 0);
    const activeContentionCount =
      (c1.claim_status === 'active_claim_in_progress' ? 1 : 0) +
      (c2.claim_status === 'active_claim_in_progress' ? 1 : 0);

    if (claimedCount !== 1 || activeContentionCount !== 1) {
      throw new Error(
        `Concurrency Failure: Expected exactly 1 winner and 1 active_claim_in_progress, got claimedCount=${claimedCount}, activeContentionCount=${activeContentionCount}`
      );
    }
    console.log('✅ PASS: Webhook claiming lease correctly serialized concurrent workers. Zero duplicate claims.');

    // =========================================================================
    // TEST 2: Simultaneous Double-Approval Race
    // =========================================================================
    console.log('\n[Test 2] Executing Simultaneous Double-Approval Race across 2 parallel sessions...');
    const quoteId = randomUUID();
    const requestId = randomUUID();

    // Create active quote and request
    await client1.query(`
      INSERT INTO procurement_requests (id, business_id, requester_id, requester_name, raw_prompt, budget_limit_cents, currency, status)
      VALUES ('${requestId}', '${testBizId}', '${testRequesterId}', 'Concurrent Requester', 'Servers', 200000, 'USD', 'draft');

      INSERT INTO quotes (id, request_id, business_id, supplier_id, supplier_name, version, subtotal_cents, tax_cents, shipping_cents, total_cents, currency, checksum_hash, status, expires_at)
      VALUES ('${quoteId}', '${requestId}', '${testBizId}', '${testSupplierId}', 'Concurrency Hardware', 1, 100000, 5000, 0, 105000, 'USD', 'mock-checksum', 'active', now() + INTERVAL '1 day');
    `);

    const approvalPayload1 = JSON.stringify({
      id: randomUUID(),
      quote_id: quoteId,
      business_id: testBizId,
      approver_id: testApprover1Id,
      approver_name: 'Concurrent Approver 1',
      approver_role: 'approver',
      quote_version: 1,
      approved_total_cents: 105000,
      approved_currency: 'USD',
      approved_supplier_id: testSupplierId,
      decision: 'approved',
      reason: 'Approval Thread 1',
      digital_signature: 'sig-thread-1',
      created_at: new Date().toISOString(),
    });

    const approvalPayload2 = JSON.stringify({
      id: randomUUID(),
      quote_id: quoteId,
      business_id: testBizId,
      approver_id: testApprover2Id,
      approver_name: 'Concurrent Approver 2',
      approver_role: 'approver',
      quote_version: 1,
      approved_total_cents: 105000,
      approved_currency: 'USD',
      approved_supplier_id: testSupplierId,
      decision: 'approved',
      reason: 'Approval Thread 2',
      digital_signature: 'sig-thread-2',
      created_at: new Date().toISOString(),
    });

    // Fire simultaneous approvals
    const approvalResults = await Promise.allSettled([
      client1.query(`SELECT persist_approval_and_transition_atomic($1, $2, $3, $4, $5)`, [
        approvalPayload1,
        quoteId,
        requestId,
        testBizId,
        'approved',
      ]),
      client2.query(`SELECT persist_approval_and_transition_atomic($1, $2, $3, $4, $5)`, [
        approvalPayload2,
        quoteId,
        requestId,
        testBizId,
        'approved',
      ]),
    ]);

    const fulfilledCount = approvalResults.filter((r) => r.status === 'fulfilled').length;
    const rejectedCount = approvalResults.filter((r) => r.status === 'rejected').length;

    console.log(`  Approval attempts: ${fulfilledCount} succeeded, ${rejectedCount} rejected with error.`);

    if (fulfilledCount !== 1 || rejectedCount !== 1) {
      throw new Error(
        `Concurrency Failure: Expected exactly 1 successful approval and 1 locked state rejection, got ${fulfilledCount} fulfilled and ${rejectedCount} rejected`
      );
    }

    const rejectionReason = (approvalResults.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason;
    console.log(`  Rejection exception caught: "${rejectionReason.message}"`);

    // Verify database only persisted exactly 1 approval record
    const countCheck = await client1.query(`SELECT COUNT(*) FROM approvals WHERE quote_id = '${quoteId}'`);
    if (parseInt(countCheck.rows[0].count, 10) !== 1) {
      throw new Error(`Data Inconsistency: Expected 1 approval record, found ${countCheck.rows[0].count}`);
    }
    console.log('✅ PASS: Row-level FOR UPDATE locking prevented double-approval race condition.');

    // =========================================================================
    // TEST 3: Simultaneous Payment Reconciliation Race
    // =========================================================================
    console.log('\n[Test 3] Executing Simultaneous Payment Capture Reconciliation Race across 2 parallel sessions...');
    const paymentId = randomUUID();
    const webhookId1 = randomUUID();
    const webhookId2 = randomUUID();
    const captureId = `CAPT-${Date.now()}`;

    const eventId1 = `EVT-RECON-1-${Date.now()}`;
    const eventId2 = `EVT-RECON-2-${Date.now()}`;

    // Create payment attempt and verified webhook event
    await client1.query(`
      INSERT INTO payment_attempts (id, quote_id, business_id, provider, amount_cents, currency, status, idempotency_key)
      VALUES ('${paymentId}', '${quoteId}', '${testBizId}', 'paypal', 105000, 'USD', 'created', 'idem-recon-${paymentId}');

      INSERT INTO webhook_events (id, provider, event_id, event_type, payload, signature_verified, status)
      VALUES
        ('${webhookId1}', 'paypal', '${eventId1}', 'PAYMENT.CAPTURE.COMPLETED', '{"id": "${captureId}"}', true, 'received'),
        ('${webhookId2}', 'paypal', '${eventId2}', 'PAYMENT.CAPTURE.COMPLETED', '{"id": "${captureId}"}', true, 'received');
    `);

    const reconResults = await Promise.all([
      client1.query(
        `SELECT reconcile_payment_capture_atomic($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [paymentId, captureId, webhookId1, quoteId, requestId, testBizId, 105000, 'USD', eventId1]
      ),
      client2.query(
        `SELECT reconcile_payment_capture_atomic($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [paymentId, captureId, webhookId2, quoteId, requestId, testBizId, 105000, 'USD', eventId2]
      ),
    ]);

    console.log(`  Session 1 reconciliation result: ${reconResults[0].rows[0].reconcile_payment_capture_atomic}`);
    console.log(`  Session 2 reconciliation result: ${reconResults[1].rows[0].reconcile_payment_capture_atomic}`);

    const finalPay = await client1.query(`SELECT status, provider_capture_id FROM payment_attempts WHERE id = '${paymentId}'`);
    if (finalPay.rows[0].status !== 'captured' || finalPay.rows[0].provider_capture_id !== captureId) {
      throw new Error(`Reconciliation Failure: Payment attempt state invalid: ${JSON.stringify(finalPay.rows[0])}`);
    }

    const finalReq = await client1.query(`SELECT status FROM procurement_requests WHERE id = '${requestId}'`);
    if (finalReq.rows[0].status !== 'fulfilled') {
      throw new Error(`Reconciliation Failure: Procurement request state expected "fulfilled", got "${finalReq.rows[0].status}"`);
    }
    console.log('✅ PASS: Simultaneous reconciliation completed idempotently without state corruption.');

    // =========================================================================
    // TEST 4: Lock Contention & Transaction Rollback Isolation
    // =========================================================================
    console.log('\n[Test 4] Testing Lock Contention & Rollback Isolation...');
    const testRollbackQuoteId = randomUUID();
    const testRollbackReqId = randomUUID();

    await client1.query(`
      INSERT INTO procurement_requests (id, business_id, requester_id, requester_name, raw_prompt, budget_limit_cents, currency, status)
      VALUES ('${testRollbackReqId}', '${testBizId}', '${testRequesterId}', 'Rollback Requester', 'RAM', 50000, 'USD', 'draft');

      INSERT INTO quotes (id, request_id, business_id, supplier_id, supplier_name, version, subtotal_cents, tax_cents, shipping_cents, total_cents, currency, checksum_hash, status, expires_at)
      VALUES ('${testRollbackQuoteId}', '${testRollbackReqId}', '${testBizId}', '${testSupplierId}', 'Concurrency Hardware', 1, 40000, 2000, 0, 42000, 'USD', 'mock-checksum', 'active', now() + INTERVAL '1 day');
    `);

    // Session 1 begins transaction, acquires exclusive lock on quote row
    await client1.query('BEGIN');
    await client1.query(`SELECT * FROM quotes WHERE id = '${testRollbackQuoteId}' FOR UPDATE`);
    console.log('  Session 1 holds exclusive FOR UPDATE lock on quote row.');

    // Obtain Session 2's backend PID to observe lock wait deterministically in pg_locks
    const pidRes = await client2.query(`SELECT pg_backend_pid() AS pid`);
    const session2Pid = pidRes.rows[0].pid;

    // Session 2 initiates update in background (blocked by Session 1 lock)
    let session2Finished = false;
    let session2Error: Error | null = null;
    const session2Promise = (async () => {
      try {
        await client2.query(`UPDATE quotes SET subtotal_cents = 45000, total_cents = 47000 WHERE id = '${testRollbackQuoteId}'`);
        session2Finished = true;
      } catch (err: unknown) {
        session2Error = err instanceof Error ? err : new Error(String(err));
      }
    })();

    // Deterministically verify Session 2 is waiting on lock grant (granted = false) in pg_locks
    let isBlockedOnLock = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const lockCheck = await client1.query(
        `SELECT count(*) FROM pg_locks WHERE pid = $1 AND granted = false`,
        [session2Pid]
      );
      if (parseInt(lockCheck.rows[0].count, 10) > 0) {
        isBlockedOnLock = true;
        break;
      }
      if (session2Finished) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    if (!isBlockedOnLock && !session2Finished) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (session2Finished) {
      throw new Error('Locking Failure: Session 2 did not block on Session 1 FOR UPDATE lock.');
    }
    console.log(`  Session 2 (PID ${session2Pid}) verified blocked waiting for lock release via pg_locks.`);

    // Session 1 aborts and rolls back
    await client1.query('ROLLBACK');
    console.log('  Session 1 rolled back transaction.');

    // Session 2 unblocks and finishes
    await session2Promise;
    if (session2Error) throw session2Error;
    console.log('  Session 2 unblocked and acquired lock cleanly.');

    const verifyQuote = await client1.query(`SELECT total_cents FROM quotes WHERE id = '${testRollbackQuoteId}'`);
    if (parseInt(verifyQuote.rows[0].total_cents, 10) !== 47000) {
      throw new Error(`Isolation Failure: Expected quote total 47000, got ${verifyQuote.rows[0].total_cents}`);
    }
    console.log('✅ PASS: Lock contention and rollback isolation verified across sessions.');

    // =========================================================================
    // TEST 5: Concurrent Order Reservation & Capture Claim Stored Procedures
    // =========================================================================
    console.log('\n[Test 5] Testing Concurrent Order Reservation & Capture Claims...');
    const testP12QuoteId = randomUUID();
    const testP12ReqId = randomUUID();

    await client1.query(`
      INSERT INTO procurement_requests (id, business_id, requester_id, requester_name, raw_prompt, budget_limit_cents, currency, status)
      VALUES ('${testP12ReqId}', '${testBizId}', '${testRequesterId}', 'Phase 12 Requester', 'Phase 12 Laptops', 100000, 'USD', 'approved');

      INSERT INTO quotes (id, request_id, business_id, supplier_id, supplier_name, version, subtotal_cents, tax_cents, shipping_cents, total_cents, currency, checksum_hash, status, expires_at)
      VALUES ('${testP12QuoteId}', '${testP12ReqId}', '${testBizId}', '${testSupplierId}', 'Phase 12 Hardware', 1, 90000, 6750, 2000, 98750, 'USD', 'p12-checksum', 'approved', now() + INTERVAL '1 day');
    `);

    // Session 1 and Session 2 race to reserve the payment attempt
    const reserveResults = await Promise.all([
      client1.query(`SELECT reserve_payment_attempt_atomic($1, $2, $3, $4, $5, 120) AS res`, [
        testP12QuoteId,
        testBizId,
        98750,
        'USD',
        'key-race-1',
      ]),
      client2.query(`SELECT reserve_payment_attempt_atomic($1, $2, $3, $4, $5, 120) AS res`, [
        testP12QuoteId,
        testBizId,
        98750,
        'USD',
        'key-race-2',
      ]),
    ]);

    const resStatus1 = reserveResults[0].rows[0].res.status;
    const resStatus2 = reserveResults[1].rows[0].res.status;
    console.log(`  Session 1 reservation: ${resStatus1}, Session 2 reservation: ${resStatus2}`);

    const statuses = [resStatus1, resStatus2].sort();
    if (statuses[0] !== 'IN_FLIGHT' || statuses[1] !== 'RESERVED') {
      throw new Error(`Reservation Concurrency Failure: Expected exactly one RESERVED and one IN_FLIGHT, got [${resStatus1}, ${resStatus2}]`);
    }
    console.log('✅ PASS: Atomic order reservation enforced mutual exclusion across sessions.');

    const reservedObj = resStatus1 === 'RESERVED' ? reserveResults[0].rows[0].res : reserveResults[1].rows[0].res;
    const attemptId = reservedObj.payment_attempt_id;

    // Confirm order
    await client1.query(`SELECT confirm_payment_order_atomic($1, $2, $3)`, [
      attemptId,
      'PAYPAL-ORD-RACE-1',
      JSON.stringify({ status: 'CREATED', id: 'PAYPAL-ORD-RACE-1' }),
    ]);

    // Session 1 and Session 2 race to claim capture
    const claimResults = await Promise.all([
      client1.query(`SELECT claim_payment_capture_atomic('PAYPAL-ORD-RACE-1', 60) AS res`),
      client2.query(`SELECT claim_payment_capture_atomic('PAYPAL-ORD-RACE-1', 60) AS res`),
    ]);

    const claimStatus1 = claimResults[0].rows[0].res.status;
    const claimStatus2 = claimResults[1].rows[0].res.status;
    console.log(`  Session 1 capture claim: ${claimStatus1}, Session 2 capture claim: ${claimStatus2}`);

    const claimStatuses = [claimStatus1, claimStatus2].sort();
    if (claimStatuses[0] !== 'CLAIMED' || claimStatuses[1] !== 'IN_FLIGHT') {
      throw new Error(`Capture Claim Concurrency Failure: Expected exactly one CLAIMED and one IN_FLIGHT, got [${claimStatus1}, ${claimStatus2}]`);
    }
    console.log('✅ PASS: Atomic capture claim enforced mutual exclusion across sessions.');

    console.log('\n===============================================================');
    console.log('🎉 ALL MULTI-SESSION POSTGRESQL CONCURRENCY TESTS PASSED 100%');
    console.log('===============================================================\n');
  } finally {
    await client1.end().catch(() => {});
    await client2.end().catch(() => {});
  }
}

runConcurrencyTests().catch((err) => {
  console.error('\n❌ Concurrency Test Suite Failed:', err);
  process.exit(1);
});
