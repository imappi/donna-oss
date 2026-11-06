// Universal coding-convergence lifecycle — real PostgreSQL proof.
//
// Cactus Blossom exposed two stateful gaps that injected seams cannot prove:
// ordinary uncoded needs-review bank lines were absent from both the scheduler
// discovery and the batch coder's real pool, while a final skipped/failed
// document did not wake an ask draft previously deferred for parse quiescence.
// This test runs the production SQL and terminal writers against the current
// schema. No model or transport is called.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test(
  'real PG: convergence admission, exclusive parse ownership, and terminal ask wakes hold together',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — universal convergence lifecycle not exercised in this run' },
  async () => {
    const dbName = `donna_universal_convergence_${Date.now().toString(36)}_${process.pid}`;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    const scratchUrl = new URL(PG_URL);
    scratchUrl.pathname = `/${dbName}`;
    const db = new pg.Client({ connectionString: scratchUrl.toString() });
    await db.connect();

    const priorEnv = {
      DATABASE_URL: process.env.DATABASE_URL,
      LOOPS_TIER: process.env.LOOPS_TIER,
      LOOPS_SHADOW: process.env.LOOPS_SHADOW,
      RECONCILIATION_ASK_QUIESCENCE_GATE: process.env.RECONCILIATION_ASK_QUIESCENCE_GATE,
      RECEIPT_MATCHER_ENABLED: process.env.RECEIPT_MATCHER_ENABLED,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY
    };
    let endPool = async () => {};
    try {
      const supabaseOnly = new Set([
        '010_evidence_object_storage.sql',
        '032_lock_down_public_rls.sql',
        '060_procountor_api_key.sql'
      ]);
      const files = (await readdir(path.join(ROOT, 'db', 'migrations')))
        .filter((file) => file.endsWith('.sql') && !supabaseOnly.has(file))
        .sort();
      for (const file of files) {
        await db.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
      }

      process.env.DATABASE_URL = scratchUrl.toString();
      process.env.LOOPS_TIER = 'canary';
      process.env.LOOPS_SHADOW = 'true';
      process.env.RECONCILIATION_ASK_QUIESCENCE_GATE = 'true';

      const firmDb = await import('./firmDb.js');
      const convergence = await import('./codingConvergence.js');
      const codingAutoPost = await import('./codingAutoPost.js');
      const parsing = await import('./parseDocumentsDb.js');
      const receiptReconciliation = await import('./receiptReconciliation.js');
      const loops = await import('./loopsShadowProducers.js');
      endPool = firmDb.__endFirmDbPoolForTests;

      const firmId = 'firm-universal-convergence';
      const clientId = 'client-cactus-shaped';
      await db.query(
        `insert into firms (id, name, slug, metadata)
         values ($1, 'Universal Convergence Firm', 'universal-convergence-firm', $2::jsonb)`,
        [firmId, JSON.stringify({ loops: { tier: 'canary' } })]
      );
      await db.query(
        `insert into clients (id, firm_id, company_name, jurisdiction, profile)
         values ($1, $2, 'Cactus-shaped Entity', 'US', $3::jsonb)`,
        [clientId, firmId, JSON.stringify({ accounting_system: 'xero' })]
      );
      await db.query(
        `insert into transactions
           (id, firm_id, client_id, transaction_date, description, money_out, currency, status, coding_state, payload)
         values
           ('tx-bare', $1, $2, '2026-06-01', 'BARE IMPORT', 11, 'USD', 'needs_review', null, '{}'::jsonb),
           ('tx-excluded-by-round', $1, $2, '2026-06-02', 'ALREADY IN RICHER POOL', 12, 'USD', 'needs_review', null, '{}'::jsonb),
           ('tx-already-coded', $1, $2, '2026-06-03', 'ALREADY CODED', 13, 'USD', 'needs_review', 'proposed', $3::jsonb),
           ('tx-auto-source', $1, $2, '2026-06-04', 'RULE HANDLED', 14, 'USD', 'needs_review', null, $4::jsonb),
           ('tx-owner-waiting', $1, $2, '2026-06-05', 'OWNER WAITING', 15, 'USD', 'needs_review', null, '{}'::jsonb),
           ('tx-ready', $1, $2, '2026-06-06', 'ALREADY READY', 16, 'USD', 'ready', null, '{}'::jsonb)`,
        [
          firmId,
          clientId,
          JSON.stringify({
            ai_suggestion: {
              proposed_account: 'Utilities',
              confidence: 'high',
              evidence_required: false,
              reasoning: 'A strong coding verdict landed before its document match.'
            }
          }),
          JSON.stringify({ auto_categorize_source: 'client_rule' })
        ]
      );
      await db.query(
        `insert into client_evidence_requests
           (id, firm_id, client_id, transaction_id, status, question)
         values ('ask-owner-waiting', $1, $2, 'tx-owner-waiting', 'open', 'What was this for?')`,
        [firmId, clientId]
      );

      const discovered = await db.query(convergence.DISCOVER_CODER_CLIENTS_SQL, [firmId, 3]);
      assert.deepEqual(
        discovered.rows.map((row) => ({ client_id: row.client_id, unseen_lines: Number(row.unseen_lines) })),
        [{ client_id: clientId, unseen_lines: 2 }],
        'only the two bare eligible rows are visible to the scheduler'
      );

      const directPool = await firmDb.__loadDirectUncodedNeedsReviewPool({
        client: db,
        firmId,
        clientId,
        limit: 80,
        excludedTransactionIds: ['tx-excluded-by-round']
      });
      assert.deepEqual(
        directPool.map((row) => row.id),
        ['tx-bare'],
        'the real coder pool admits a plain needs-review row without a match or review queue sidecar'
      );

      // Coding-before-match order: the strong verdict is already persisted on
      // tx-already-coded, then a document settles later. There is deliberately
      // NO transaction_review_queue row. The real scheduler discovery, source-
      // owned candidate SQL, case-file mint, and named review writer must still
      // take it terminal without another upload or model call.
      await db.query(
        `insert into documents
           (id, firm_id, client_id, filename, document_type, parse_status, total_amount, currency)
         values ('doc-late-match', $1, $2, 'late-utility-bill.pdf', 'supplier_bill', 'completed', 13, 'USD')`,
        [firmId, clientId]
      );
      await db.query(
        `insert into reconciliation_matches
           (id, firm_id, client_id, bank_transaction_id, matched_object_type,
            matched_object_id, match_amount, match_confidence, match_reason, status, created_by)
         values
           ('match-late-after-coding', $1, $2, 'tx-already-coded', 'supplier_bill',
            'doc-late-match', 13, 0.97, 'Late document settled the prior coding.', 'auto_matched', 'system')`,
        [firmId, clientId]
      );
      const sweepDiscovered = await db.query(convergence.DISCOVER_SWEEP_CLIENTS_SQL, [firmId, 10]);
      assert.deepEqual(sweepDiscovered.rows.map((row) => row.client_id), [clientId]);
      const settled = await codingAutoPost.runCodingAutoPostForTransaction({
        firmId,
        clientId,
        transactionId: 'tx-already-coded',
        env: {},
        configSnapshot: { CODING_AUTO_POST: { stage: 'auto' } }
      });
      assert.equal(settled.evaluated, 1);
      assert.equal(settled.auto_posted, 1);
      assert.equal(settled.case_files_minted, 1);
      const settledReceipt = await db.query(
        `select t.account_code, t.coding_state,
                q.reason
           from transactions t
           join transaction_review_queue q
             on q.firm_id = t.firm_id and q.client_id = t.client_id and q.item_id = t.id
          where t.firm_id = $1 and t.id = 'tx-already-coded'`,
        [firmId]
      );
      // RT-16: the ONE coding state lives on the transaction; the case file
      // carries none.
      assert.deepEqual(settledReceipt.rows, [{
        account_code: 'Utilities',
        coding_state: 'applied',
        reason: 'coding_convergence_bare_line'
      }]);
      const replay = await codingAutoPost.runCodingAutoPostForTransaction({
        firmId,
        clientId,
        transactionId: 'tx-already-coded',
        env: {},
        configSnapshot: { CODING_AUTO_POST: { stage: 'auto' } }
      });
      assert.equal(replay.evaluated, 0, 'the accepted transaction leaves the source-of-truth pool');

      // Ask-before-match order: the coder persisted a strong suggestion, the
      // owner ask parked BOTH the transaction and its optional review case at
      // `waiting`, then a late document auto-resolved the ask and restored only
      // the case sidecar to `suggested`. Cactus reproduced this exact split:
      // the transaction-owned sweep could not see twenty-one valid matches.
      // One real convergence tick must heal the transaction receipt, keep the
      // optional case in lockstep, discover the client, and use the normal
      // review writer in the same tick.
      await db.query(
        `insert into transactions
           (id, firm_id, client_id, transaction_date, description, money_out,
            currency, status, reconciliation_status, coding_state, payload)
         values
           ('tx-waiting-late-match', $1, $2, '2026-06-06',
            'WAITING THEN MATCHED', 17, 'USD', 'needs_client', 'needs_review', 'asked', $3::jsonb)`,
        [
          firmId,
          clientId,
          JSON.stringify({
            ai_suggestion: {
              proposed_account: 'Utilities',
              confidence: 'high',
              evidence_required: false,
              reasoning: 'The document now settles the previously waiting coding.'
            }
          })
        ]
      );
      await db.query(
        `insert into documents
           (id, firm_id, client_id, filename, document_type, parse_status, total_amount, currency)
         values ('doc-waiting-late-match', $1, $2, 'waiting-late-match.pdf', 'supplier_bill', 'completed', 17, 'USD')`,
        [firmId, clientId]
      );
      await db.query(
        `insert into reconciliation_matches
           (id, firm_id, client_id, bank_transaction_id, matched_object_type,
            matched_object_id, match_amount, match_confidence, match_reason, status, created_by)
         values
           ('match-waiting-late', $1, $2, 'tx-waiting-late-match', 'supplier_bill',
            'doc-waiting-late-match', 17, 0.98, 'Late evidence settled a waiting line.', 'auto_matched', 'system')`,
        [firmId, clientId]
      );
      await db.query(
        `insert into transaction_review_queue
           (id, firm_id, client_id, item_type, item_id, reason, status, payload)
         values
           ('review-waiting-late', $1, $2, 'transaction', 'tx-waiting-late-match',
            'coding_convergence_bare_line', 'open', $3::jsonb)`,
        [firmId, clientId, JSON.stringify({ transaction_id: 'tx-waiting-late-match' })]
      );
      await db.query(
        `insert into client_evidence_requests
           (id, firm_id, client_id, transaction_id, review_item_id, status, question, resolved_at)
         values
           ('ask-waiting-late', $1, $2, 'tx-waiting-late-match', 'review-waiting-late',
            'resolved', 'Please provide the document.', now())`,
        [firmId, clientId]
      );

      const waitingConvergence = await convergence.runCodingConvergence({
        firmId,
        env: {},
        discoverCoderClientsFn: async () => [],
        recoverAskDraftFn: async () => [],
        requestAskDraftFn: async () => ({ enqueued: 0, reason: 'fixture_inert' }),
        discoverLedgerPostClientsFn: async () => [],
        readConfigSnapshotFn: async () => ({ CODING_AUTO_POST: { stage: 'auto' } })
      });
      assert.deepEqual(waitingConvergence.released, [{
        client_id: clientId,
        // RT-16: the release moves the TRANSACTION's coding_state (asked →
        // proposed); the open case file for the line is touched as context
        // and named in the receipt, whatever label it used to carry.
        review_item_id: 'review-waiting-late',
        transaction_id: 'tx-waiting-late-match'
      }]);
      assert.equal(waitingConvergence.swept.length, 1);
      assert.equal(waitingConvergence.swept[0].auto_posted, 1);
      const waitingReceipt = await db.query(
        `select t.coding_state,
                t.account_code,
                q.status as case_status
           from transactions t
           join transaction_review_queue q on q.id = 'review-waiting-late'
          where t.firm_id = $1 and t.id = 'tx-waiting-late-match'`,
        [firmId]
      );
      assert.deepEqual(waitingReceipt.rows, [{
        coding_state: 'applied',
        account_code: 'Utilities',
        case_status: 'open'
      }]);

      // RT-26 (2) (Kari's word, 2026-09-09): a matched balance-sheet payable is
      // EVIDENCED by its notice — which liability the payroll-tax payment
      // settles is the coder's decision, a knowledge question never sent to the
      // owner. The red gate yields: the line auto-posts (applied, auto_applied)
      // and NO treatment ask is minted. (Before RT-26 this exact line minted an
      // account_treatment ask — the second run's two payroll asks.)
      await db.query(
        `insert into transactions
           (id, firm_id, client_id, transaction_date, description, money_out,
            currency, status, reconciliation_status, coding_state, payload)
         values
           ('tx-matched-red', $1, $2, '2026-06-06', 'GUSTO TAX', 1564.25,
            'USD', 'needs_review', 'reconciled', 'proposed', $3::jsonb)`,
        [firmId, clientId, JSON.stringify({
          ai_suggestion: {
            proposed_account: 'Payroll taxes payable',
            confidence: 'high',
            evidence_required: false,
            reasoning: 'The payroll tax payment is matched but needs liability treatment authority.'
          }
        })]
      );
      await db.query(
        `insert into documents
           (id, firm_id, client_id, filename, document_type, parse_status, total_amount, currency)
         values ('doc-matched-red', $1, $2, 'gusto-tax.pdf', 'payment_confirmation', 'completed', 1564.25, 'USD')`,
        [firmId, clientId]
      );
      await db.query(
        `insert into reconciliation_matches
           (id, firm_id, client_id, bank_transaction_id, matched_object_type,
            matched_object_id, match_amount, match_confidence, match_reason, status, created_by)
         values ('match-red', $1, $2, 'tx-matched-red', 'payment_confirmation',
                 'doc-matched-red', 1564.25, 0.99, 'Exact payroll settlement.', 'auto_matched', 'system')`,
        [firmId, clientId]
      );
      const redTerminal = await codingAutoPost.runCodingAutoPostForTransaction({
        firmId,
        clientId,
        transactionId: 'tx-matched-red',
        env: {},
        configSnapshot: { CODING_AUTO_POST: { stage: 'auto' } }
      });
      assert.equal(redTerminal.owner_asked, 0, 'RT-26: no treatment question to the owner');
      assert.equal(redTerminal.auto_posted, 1, 'the evidenced liability posts');
      assert.equal(redTerminal.skipped, 0);
      const redReceipt = await db.query(
        `select t.coding_state, t.payload->>'ai_suggestion_status' as suggestion_status,
                t.payload->>'support_note' as support_note,
                (select count(*)::int from client_evidence_requests r
                  where r.firm_id = t.firm_id and r.transaction_id = t.id) as asks
           from transactions t
          where t.firm_id = $1 and t.id = 'tx-matched-red'`,
        [firmId]
      );
      assert.equal(redReceipt.rows[0]?.coding_state, 'applied', 'RT-16: the auto-post applies the coding');
      assert.equal(redReceipt.rows[0]?.suggestion_status, 'auto_applied');
      assert.equal(redReceipt.rows[0]?.asks, 0, 'no ask of any kind on the line');
      assert.match(redReceipt.rows[0]?.support_note || '', /evidenced by the matched document/);

      // Workflow identity bridge: reconciliation cases/evaluations use the
      // canonical target type `document`, while a real match row keeps the
      // concrete subtype. The second production close pass must see that
      // supplier_bill match by document id, close the canonical gap, and append
      // a MET GoalReport; otherwise the stale UNMET report outranks the posted
      // transaction forever on Material.
      await db.query(
        `insert into transactions
           (id, firm_id, client_id, transaction_date, description, money_out, currency, status)
         values ('tx-goal-subtype', $1, $2, '2026-06-06', 'GOAL SUBTYPE BRIDGE', 18, 'USD', 'needs_review')`,
        [firmId, clientId]
      );
      await db.query(
        `insert into documents
           (id, firm_id, client_id, filename, document_type, parse_status, total_amount, currency)
         values ('doc-goal-subtype', $1, $2, 'goal-subtype.pdf', 'supplier_bill', 'completed', 18, 'USD')`,
        [firmId, clientId]
      );
      await db.query(
        `insert into reconciliation_evaluations
           (id, firm_id, client_id, target_type, target_id, matcher_family,
            verdict, unmatchable_reason, candidate_count, eligible_count)
         values
           ('eval-goal-subtype', $1, $2, 'document', 'doc-goal-subtype',
            'supplier_bill', 'no_match', 'receipt_needed', 1, 1)`,
        [firmId, clientId]
      );
      const openedGap = await loops.onReconciliationRunCompleted({
        client: db,
        firmId,
        clientId,
        targets: [{ targetType: 'document', targetId: 'doc-goal-subtype' }]
      });
      assert.equal(openedGap.opened, 1);
      const unmetGap = await db.query(
        `select c.id, c.status, r.status as report_status
           from bookkeeping_cases c
           join lateral (
             select status from loop_goal_reports r
              where r.case_id = c.id order by r.created_at desc limit 1
           ) r on true
          where c.firm_id = $1 and c.client_id = $2
            and c.case_type = 'reconciliation'
            and c.primary_object_type = 'document'
            and c.primary_object_id = 'doc-goal-subtype'`,
        [firmId, clientId]
      );
      assert.equal(unmetGap.rows[0]?.report_status, 'unmet');

      await db.query(
        `insert into reconciliation_matches
           (id, firm_id, client_id, bank_transaction_id, matched_object_type,
            matched_object_id, match_amount, match_confidence, match_reason, status, created_by)
         values
           ('match-goal-subtype', $1, $2, 'tx-goal-subtype', 'supplier_bill',
            'doc-goal-subtype', 18, 0.99, 'Concrete subtype settled canonical document case.',
            'auto_matched', 'system')`,
        [firmId, clientId]
      );
      const closedGap = await loops.onReconciliationRunCompleted({
        client: db,
        firmId,
        clientId,
        targets: [{ targetType: 'document', targetId: 'doc-goal-subtype' }]
      });
      assert.equal(closedGap.resolved, 1);
      const metGap = await db.query(
        `select c.status, r.status as report_status
           from bookkeeping_cases c
           join lateral (
             select status from loop_goal_reports r
              where r.case_id = c.id order by r.created_at desc limit 1
           ) r on true
          where c.id = $1`,
        [unmetGap.rows[0].id]
      );
      assert.deepEqual(metGap.rows, [{ status: 'resolved', report_status: 'met' }]);

      // Posting-before-document order: drive the real coding-auto-post writer
      // first, then let the ledger-shaped fixture move the accepted line to
      // `posted`, and only then finish the receipt. This pins the lifecycle
      // marker at the production choke point: if auto-post leaves the coding
      // as `suggested`, the owner-ask gather can re-ask settled work and the
      // posted-line matcher cannot attach the later evidence.
      await db.query(
        `insert into transactions
           (id, firm_id, client_id, transaction_date, description, money_out,
            currency, status, reconciliation_status, coding_state, payload)
         values
           ('tx-posted-before-document', $1, $2, '2026-06-07',
            'LATE EVIDENCE COFFEE', 19.99, 'USD', 'needs_review', 'needs_review',
            'proposed', $3::jsonb)`,
        [
          firmId,
          clientId,
          JSON.stringify({
            ai_suggestion: {
              proposed_account: 'Office expenses',
              confidence: 'high',
              evidence_required: false,
              reasoning: 'A routine coffee purchase can post from the bank line.'
            },
            reconciliation_match_type: 'bank_line'
          })
        ]
      );
      const postedBeforeDocument = await codingAutoPost.runCodingAutoPostForTransaction({
        firmId,
        clientId,
        transactionId: 'tx-posted-before-document',
        env: {},
        configSnapshot: { CODING_AUTO_POST: { stage: 'auto' } }
      });
      assert.equal(postedBeforeDocument.auto_posted, 1);
      await db.query(
        `update transactions
            set status = 'posted', reconciliation_status = 'posted', updated_at = now()
          where firm_id = $1 and id = 'tx-posted-before-document'`,
        [firmId]
      );
      const autoPostMarker = await db.query(
        `select account_code,
                payload->>'ai_suggestion_status' as ai_suggestion_status,
                payload->>'ai_suggestion_applied_via' as ai_suggestion_applied_via
           from transactions
          where firm_id = $1 and id = 'tx-posted-before-document'`,
        [firmId]
      );
      assert.deepEqual(autoPostMarker.rows, [{
        account_code: 'Office expenses',
        ai_suggestion_status: 'auto_applied',
        ai_suggestion_applied_via: 'coding_auto_post'
      }]);
      await db.query(
        `insert into documents
           (id, firm_id, client_id, filename, document_type, parse_status,
            vendor_name, customer_name, document_date, total_amount, currency,
            extraction_confidence, parse_summary)
         values
           ('doc-after-posting', $1, $2, 'late-evidence-coffee.pdf', 'receipt',
            'completed', 'Late Evidence Coffee', 'Cactus-shaped Entity',
            '2026-06-07', 19.99, 'USD', 0.99, $3::jsonb)`,
        [firmId, clientId, JSON.stringify({ warnings: [] })]
      );
      const realMatcher = receiptReconciliation.__llmMatcher.run;
      let lateEvidenceStats;
      try {
        // Force the production deterministic fallback without a network call;
        // all database selection, scoring, persistence and audit wiring remain real.
        receiptReconciliation.__llmMatcher.run = async () => ({ disabled: true, disabled_reason: 'pg_fixture' });
        lateEvidenceStats = await receiptReconciliation.runReceiptReconciliationForDocument({
          client: db,
          firmId,
          clientId,
          documentId: 'doc-after-posting'
        });
      } finally {
        receiptReconciliation.__llmMatcher.run = realMatcher;
      }
      assert.equal(lateEvidenceStats.suggested_inserted, 1);
      const lateEvidenceReceipt = await db.query(
        `select rm.status as match_status,
                t.status as transaction_status,
                t.reconciliation_status,
                t.account_code,
                t.payload->>'ai_suggestion_status' as ai_suggestion_status
           from reconciliation_matches rm
           join transactions t on t.id = rm.bank_transaction_id
          where rm.firm_id = $1
            and rm.bank_transaction_id = 'tx-posted-before-document'
            and rm.matched_object_id = 'doc-after-posting'`,
        [firmId]
      );
      assert.deepEqual(lateEvidenceReceipt.rows, [{
        match_status: 'suggested',
        transaction_status: 'posted',
        reconciliation_status: 'posted',
        account_code: 'Office expenses',
        ai_suggestion_status: 'auto_applied'
      }]);

      // One run has one owner. This uses the production DB wrappers (not the
      // injected SQL seam): a duplicate delivery cannot re-claim processing,
      // while an explicit retry release makes the same run claimable again.
      const exclusiveRunId = '00000000-0000-0000-0000-000000000099';
      await db.query(
        `insert into documents
           (id, firm_id, client_id, filename, document_type, parse_status, parse_run_id)
         values ('doc-exclusive-claim', $1, $2, 'exclusive.pdf', 'unknown', 'pending', $3::uuid)`,
        [firmId, clientId, exclusiveRunId]
      );
      const firstClaim = await parsing.claimParseRunInDb({
        firmId,
        documentId: 'doc-exclusive-claim',
        parseRunId: exclusiveRunId
      });
      const duplicateClaim = await parsing.claimParseRunInDb({
        firmId,
        documentId: 'doc-exclusive-claim',
        parseRunId: exclusiveRunId
      });
      assert.equal(firstClaim.outcome, 'claimed');
      assert.equal(firstClaim.claimed?.parse_status, 'processing');
      assert.equal(duplicateClaim.claimed, null, 'active processing ownership is exclusive');
      assert.equal(duplicateClaim.outcome, 'not_pending', 'RT-02: the duplicate reads a typed outcome');
      const releasedClaim = await parsing.releaseParseRunForRetryInDb({
        firmId,
        documentId: 'doc-exclusive-claim',
        parseRunId: exclusiveRunId
      });
      assert.equal(releasedClaim?.parse_status, 'pending');
      const retryClaim = await parsing.claimParseRunInDb({
        firmId,
        documentId: 'doc-exclusive-claim',
        parseRunId: exclusiveRunId
      });
      assert.equal(retryClaim.claimed?.parse_status, 'processing');
      const claimReceipt = await db.query(
        `select parse_attempts from documents where firm_id=$1 and id='doc-exclusive-claim'`,
        [firmId]
      );
      assert.equal(claimReceipt.rows[0]?.parse_attempts, 2, 'only successful claims increment attempts');
      await parsing.markParseCompletedInDb({
        firmId,
        documentId: 'doc-exclusive-claim',
        parseRunId: exclusiveRunId,
        summary: { source: 'exclusive_claim_lifecycle', transaction_count: 0 }
      });

      const insertProcessingDocument = async ({ id, runId, heartbeat = 'now()' }) => {
        await db.query(
          `insert into documents
             (id, firm_id, client_id, filename, document_type, parse_status, parse_run_id, parse_heartbeat_at)
           values ($1, $2, $3, $4, 'unknown', 'processing', $5::uuid, ${heartbeat})`,
          [id, firmId, clientId, `${id}.pdf`, runId]
        );
      };
      const assertWakeSource = async (source) => {
        const rows = await db.query(
          `select payload->>'source' as source, status
             from loop_event_outbox
            where firm_id = $1 and client_id = $2 and event_type = 'ask_draft.requested'`,
          [firmId, clientId]
        );
        assert.deepEqual(rows.rows, [{ source, status: 'pending' }]);
        await db.query(
          `delete from loop_event_outbox
            where firm_id = $1 and client_id = $2 and event_type = 'ask_draft.requested'`,
          [firmId, clientId]
        );
      };

      await insertProcessingDocument({ id: 'doc-skipped', runId: '00000000-0000-0000-0000-000000000101' });
      await parsing.markParseSkippedInDb({
        firmId,
        documentId: 'doc-skipped',
        parseRunId: '00000000-0000-0000-0000-000000000101',
        reason: 'unsupported_document_type'
      });
      await assertWakeSource('document_parse_skipped');

      await insertProcessingDocument({ id: 'doc-failed', runId: '00000000-0000-0000-0000-000000000102' });
      await parsing.markParseFailedInDb({
        firmId,
        documentId: 'doc-failed',
        parseRunId: '00000000-0000-0000-0000-000000000102',
        parseError: { code: 'TERMINAL_FIXTURE', retryable: false }
      });
      await assertWakeSource('document_parse_failed');

      await insertProcessingDocument({
        id: 'doc-stale',
        runId: '00000000-0000-0000-0000-000000000103',
        heartbeat: `now() - interval '10 minutes'`
      });
      const stale = await parsing.failStuckProcessingRowsInDb({ thresholdSeconds: 300 });
      assert.deepEqual(stale, { stuck_count: 1, failed_count: 1 });
      await assertWakeSource('document_parse_stale');
    } finally {
      await endPool().catch(() => {});
      await db.end().catch(() => {});
      for (const [key, value] of Object.entries(priorEnv)) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
      await admin.query(
        `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
        [dbName]
      ).catch(() => {});
      await admin.query(`drop database if exists "${dbName}"`).catch(() => {});
      await admin.end().catch(() => {});
    }
  }
);
