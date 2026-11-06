// Ask-batch terminal coverage — real PostgreSQL lifecycle proof.
//
// The production incident this pins had two gathered Honeybee rows survive a
// sent batch because the drafting model labelled one `skip` and one `notify`.
// The send writer correctly minted requests only for `ask`, so both rows stayed
// needs_review with no owner ask: the forbidden third state. Mocks can pin the
// assertion, but only the live schema + real evidence-request writer prove the
// end state: every gathered unresolved row becomes one open owner ask and its
// transaction moves to needs_client in the same send transaction.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import {
  __draftClientAskBatchWithClient,
  __sendClientAskBatchWithClient,
  __endFirmDbPoolForTests
} from './firmDb.js';
import { draftClientAskMessage } from './askPipeline.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const FIRM = 'firm-terminal-asks';
const CLIENT = 'client-terminal-asks';
const CACTUS_CLIENT = 'client-terminal-asks-cactus';
const LOCAL_EVIDENCE_CLIENT = 'client-terminal-asks-local-evidence';
const ACTOR = 'kari@books.example';

const askItem = (transactionId, question) => ({
  transaction_id: transactionId,
  disposition: 'ask',
  question,
  evidence_type: 'business_purpose',
  fyi_note: '',
  skip_reason: ''
});

test(
  'real PG: notify/skip drafts are refused; a complete re-draft sends one owner ask per unresolved row',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — real-PG ask terminal coverage not exercised in this run' },
  async () => {
    const dbName = `donna_ask_terminal_${Date.now().toString(36)}_${process.pid}`;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    const scratchUrl = new URL(PG_URL);
    scratchUrl.pathname = `/${dbName}`;
    const db = new pg.Client({ connectionString: scratchUrl.toString() });
    await db.connect();

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

      await db.query(
        `insert into firms (id, name, slug) values ($1, 'Terminal Ask Firm', 'terminal-ask-firm')`,
        [FIRM]
      );
      await db.query(
        `insert into firm_members (id, firm_id, email, name, role)
         values ('member-kari', $1, $2, 'Kari', 'founder')`,
        [FIRM, ACTOR]
      );
      await db.query(
        `insert into clients (id, firm_id, company_name)
         values ($1, $2, 'Honeybee Terminal Fixture')`,
        [CLIENT, FIRM]
      );
      const suggestion = ({ proposedAccount, reasoning, evidenceRequired = false }) => ({
        ai_suggestion: {
          proposed_account: proposedAccount,
          confidence: 'high',
          evidence_required: evidenceRequired,
          ask_client_question: '',
          reasoning,
          warnings: [],
          alternatives: [],
          suggested_at: Date.parse('2026-08-28T12:00:00Z')
        }
      });
      await db.query(
        `insert into transactions
           (id, firm_id, client_id, transaction_date, description, money_out, currency, status, coding_state, payload)
         values
           ('tx-dadant', $1, $2, '2026-06-22', 'DADANT.COM · GDXK', 120.77, 'USD', 'needs_review', 'proposed', $3::jsonb),
           ('tx-owner-distribution', $1, $2, '2026-06-18', 'OWNER DISTRIBUTION · 905026', 3339.14, 'USD', 'needs_review', 'proposed', $4::jsonb)`,
        [
          FIRM,
          CLIENT,
          JSON.stringify(suggestion({
            proposedAccount: 'Beekeeping supplies',
            reasoning: 'The merchant is known, but the business purpose still needs owner confirmation.',
            evidenceRequired: true
          })),
          JSON.stringify(suggestion({
            proposedAccount: 'Owner drawings',
            reasoning: 'Likely an owner distribution, but it has not been posted under delegated authority.'
          }))
        ]
      );

      const invalidDraft = {
        subject: 'June bookkeeping update',
        message_markdown: 'One line was skipped and one was presented as an FYI.',
        summary: 'Invalid non-terminal dispositions.',
        items: [
          {
            transaction_id: 'tx-dadant', disposition: 'skip', question: '',
            evidence_type: 'business_purpose', fyi_note: '', skip_reason: 'Immaterial.'
          },
          {
            transaction_id: 'tx-owner-distribution', disposition: 'notify', question: '',
            evidence_type: 'business_purpose', fyi_note: 'Treated as an owner draw.', skip_reason: ''
          }
        ],
        statement_requests: [],
        document_asks: []
      };
      await assert.rejects(
        __draftClientAskBatchWithClient({
          client: db,
          firmId: FIRM,
          clientId: CLIENT,
          actorId: ACTOR,
          draftFn: async () => ({ draft: invalidDraft, model: 'test-model', response_id: 'invalid-response' })
        }),
        (error) => error.code === 'ASK_PIPELINE_BAD_DRAFT'
          && error.details.failures.includes('transaction:tx-dadant:nonterminal_skip')
          && error.details.failures.includes('transaction:tx-owner-distribution:nonterminal_notify')
      );
      assert.equal(
        Number((await db.query(`select count(*) from client_ask_batches`)).rows[0].count),
        0,
        'the malformed model result never becomes a persisted draft'
      );

      const validDraft = {
        subject: 'Two quick June questions',
        message_markdown: [
          '## Questions we need answered',
          '1. DADANT.COM · GDXK — what was this purchase for?',
          '2. OWNER DISTRIBUTION · 905026 — please confirm this was an owner distribution.'
        ].join('\n'),
        summary: 'Two unresolved transactions, two owner questions.',
        items: [
          askItem('tx-dadant', 'What was the DADANT.COM purchase for, and was it a business expense?'),
          askItem('tx-owner-distribution', 'Please confirm the June 18 payment was an owner distribution.')
        ],
        // This request deliberately overlaps the second transaction ask. The
        // writer reuses that active ask; the sent receipt must name it once.
        statement_requests: [{
          account_reference: 'SECOND BUSINESS ACCOUNT',
          request_text: 'Please send the statement for the second business account.',
          anchor_transaction_ids: ['tx-owner-distribution']
        }],
        document_asks: [],
        counts: { ask: 2, notify: 0, skip: 0, statement_requests: 1, document_asks: 0 }
      };
      const drafted = await __draftClientAskBatchWithClient({
        client: db,
        firmId: FIRM,
        clientId: CLIENT,
        actorId: ACTOR,
        draftFn: async () => ({ draft: validDraft, model: 'test-model', response_id: 'valid-response' })
      });
      assert.ok(drafted.batch?.id);

      const persistedDraft = (await db.query(
        `select payload from client_ask_batches where id = $1`,
        [drafted.batch.id]
      )).rows[0].payload;
      assert.deepEqual(
        persistedDraft.terminal_ask_anchor_ids.transaction_ids,
        ['tx-owner-distribution', 'tx-dadant'],
        'the generation receipt names the complete model-visible unresolved set in gather order'
      );

      const sent = await __sendClientAskBatchWithClient({
        client: db,
        firmId: FIRM,
        clientId: CLIENT,
        batchId: drafted.batch.id,
        actorId: ACTOR
      });
      assert.equal(sent.status, 'sent');
      assert.deepEqual(
        sent.sent.evidence_request_ids,
        [...new Set(sent.sent.evidence_request_ids)],
        'an overlapping statement/item anchor appears once in the sent receipt'
      );
      assert.equal(sent.sent.evidence_request_ids.length, 2);

      const asks = await db.query(
        `select transaction_id, status, question
           from client_evidence_requests
          where firm_id = $1 and client_id = $2
          order by transaction_id`,
        [FIRM, CLIENT]
      );
      assert.deepEqual(
        asks.rows.map((row) => ({ transaction_id: row.transaction_id, status: row.status })),
        [
          { transaction_id: 'tx-dadant', status: 'draft' },
          { transaction_id: 'tx-owner-distribution', status: 'draft' }
        ],
        'both gathered rows now rest on the owner'
      );
      assert.ok(asks.rows.every((row) => row.question), 'every open request carries the model-authored question');

      const transactions = await db.query(
        `select id, status, coding_state
           from transactions
          where firm_id = $1 and client_id = $2
          order by id`,
        [FIRM, CLIENT]
      );
      assert.deepEqual(
        transactions.rows.map((row) => ({ id: row.id, status: row.status, coding_state: row.coding_state })),
        [
          { id: 'tx-dadant', status: 'needs_client', coding_state: 'asked' },
          { id: 'tx-owner-distribution', status: 'needs_client', coding_state: 'asked' }
        ],
        'neither transaction remains in the Open/firm-side lane after send'
      );

      // Production-wiring regression for the Cactus rollout: one completed
      // local file needs only a confirmation, while a different bare line may
      // legitimately ask for an upload in the SAME batch. The validator must
      // associate message prose with the exact filename instead of treating
      // the entire batch as if every sentence described every transaction.
      await db.query(
        `insert into clients (id, firm_id, company_name)
         values ($1, $2, 'Mixed Local Evidence Fixture')`,
        [LOCAL_EVIDENCE_CLIENT, FIRM]
      );
      await db.query(
        `insert into transactions
           (id, firm_id, client_id, transaction_date, description, money_out, currency,
            status, structured_reference, coding_state, payload)
         values
           ('tx-local-square', $1, $2, '2026-06-07', 'ACH PAYOUT', 2935.04, 'USD',
            'needs_review', 'SQUARE', 'proposed', $3::jsonb),
           ('tx-bare-payout', $1, $2, '2026-06-08', 'UNEXPLAINED PAYOUT', 401.22, 'USD',
            'needs_review', null, 'proposed', $4::jsonb)`,
        [
          FIRM,
          LOCAL_EVIDENCE_CLIENT,
          JSON.stringify(suggestion({
            proposedAccount: 'Sales',
            reasoning: 'Confirm whether the existing Square report supports this payout.',
            evidenceRequired: true
          })),
          JSON.stringify(suggestion({
            proposedAccount: 'Sales',
            reasoning: 'The payout report is missing.',
            evidenceRequired: true
          }))
        ]
      );
      await db.query(
        `insert into documents
           (id, firm_id, client_id, filename, document_type, parse_status,
            vendor_name, document_date, total_amount, currency)
         values
           ('doc-local-square', $1, $2, 'deposit_square_jun7_2026.pdf',
            'receipt', 'completed', 'Square', '2026-06-07', 2936.04, 'USD')`,
        [FIRM, LOCAL_EVIDENCE_CLIENT]
      );

      let mixedDraftInput = null;
      const mixedDrafted = await __draftClientAskBatchWithClient({
        client: db,
        firmId: FIRM,
        clientId: LOCAL_EVIDENCE_CLIENT,
        actorId: ACTOR,
        draftFn: async (input) => {
          mixedDraftInput = input;
          return {
            model: 'test-model',
            response_id: 'mixed-local-evidence-response',
            draft: {
              subject: 'Two evidence questions',
              message_markdown: [
                '## Questions we need answered',
                '1. Please confirm whether deposit_square_jun7_2026.pdf supports the Square payout.',
                '2. Please upload the settlement report for the unexplained payout.'
              ].join('\n'),
              summary: 'One local-file confirmation and one missing-file request.',
              items: [
                {
                  transaction_id: 'tx-local-square',
                  disposition: 'ask',
                  question: 'Does deposit_square_jun7_2026.pdf support the Square payout?',
                  evidence_type: 'business_purpose',
                  fyi_note: '',
                  skip_reason: '',
                  local_document_ids: ['doc-local-square']
                },
                {
                  transaction_id: 'tx-bare-payout',
                  disposition: 'ask',
                  question: 'Please upload the settlement report for the unexplained payout.',
                  evidence_type: 'supporting_document',
                  fyi_note: '',
                  skip_reason: '',
                  local_document_ids: []
                }
              ],
              statement_requests: [],
              document_asks: [],
              counts: { ask: 2, notify: 0, skip: 0, statement_requests: 0, document_asks: 0 }
            }
          };
        }
      });
      assert.deepEqual(
        mixedDraftInput.codingItems.find((item) => item.id === 'tx-local-square')
          ?.local_evidence_candidates.map((candidate) => candidate.id),
        ['doc-local-square'],
        'draft and freshness load the same persisted structured-reference evidence universe'
      );
      assert.deepEqual(
        mixedDraftInput.codingItems.find((item) => item.id === 'tx-bare-payout')
          ?.local_evidence_candidates,
        [],
        'the genuinely bare transaction stays eligible for a missing-evidence request'
      );
      const mixedSent = await __sendClientAskBatchWithClient({
        client: db,
        firmId: FIRM,
        clientId: LOCAL_EVIDENCE_CLIENT,
        batchId: mixedDrafted.batch.id,
        actorId: ACTOR
      });
      assert.equal(mixedSent.status, 'sent');
      const mixedAsks = await db.query(
        `select transaction_id, evidence_type, status
           from client_evidence_requests
          where firm_id = $1 and client_id = $2
          order by transaction_id`,
        [FIRM, LOCAL_EVIDENCE_CLIENT]
      );
      assert.deepEqual(mixedAsks.rows, [
        { transaction_id: 'tx-bare-payout', evidence_type: 'supporting_document', status: 'draft' },
        { transaction_id: 'tx-local-square', evidence_type: 'business_purpose', status: 'draft' }
      ]);

      // Cactus-shaped integration: many persisted ids share a long prefix.
      // Exercise the REAL provider boundary (fake transport only), then the
      // real batch persistence + send writer. Correct model output order is
      // deliberately reversed to prove selection is by call-local handle.
      await db.query(
        `insert into clients (id, firm_id, company_name)
         values ($1, $2, 'Cactus Blossom Terminal Fixture')`,
        [CACTUS_CLIENT, FIRM]
      );
      const cactusIds = Array.from(
        { length: 33 },
        (_, index) => `cactus-blossom-june-2025-statement-transaction-${String(index + 1).padStart(2, '0')}`
      );
      await db.query(
        `insert into transactions
           (id, firm_id, client_id, transaction_date, description, money_out, currency, status, coding_state, payload)
         select line.id, $1, $2, '2026-06-15', 'CACTUS LINE ' || line.ordinality,
                line.ordinality::numeric, 'USD', 'needs_review', 'proposed', $4::jsonb
           from unnest($3::text[]) with ordinality as line(id, ordinality)`,
        [
          FIRM,
          CACTUS_CLIENT,
          cactusIds,
          JSON.stringify(suggestion({
            proposedAccount: 'Suspense',
            reasoning: 'The bank description does not establish the business purpose.',
            evidenceRequired: true
          }))
        ]
      );

      let providerInput = null;
      const cactusDrafted = await __draftClientAskBatchWithClient({
        client: db,
        firmId: FIRM,
        clientId: CACTUS_CLIENT,
        actorId: ACTOR,
        draftFn: (args) => draftClientAskMessage({
          ...args,
          openAiConfig: { apiKey: 'test-key', model: 'test-strong-model' },
          fetchImpl: async (url, options) => {
            const request = JSON.parse(options.body);
            providerInput = JSON.parse(request.input);
            return {
              ok: true,
              status: 200,
              json: async () => ({
                id: 'cactus-provider-response',
                model: 'test-strong-model-resolved',
                output_text: JSON.stringify({
                  subject: 'June bookkeeping questions',
                  message_markdown: '## Questions we need answered\nPlease clarify the listed June transactions.',
                  summary: 'Thirty-three owner questions.',
                  items: [...providerInput.coding_items].reverse().map((item) => ({
                    transaction_ref: item.transaction_ref,
                    disposition: 'ask',
                    question: `What was ${item.description} for?`,
                    evidence_type: 'business_purpose',
                    fyi_note: '',
                    skip_reason: ''
                  })),
                  statement_requests: [],
                  document_asks: []
                })
              })
            };
          }
        })
      });
      assert.ok(cactusDrafted.batch?.id);
      assert.deepEqual(
        providerInput.coding_items.map((item) => item.transaction_ref),
        Array.from({ length: 33 }, (_, index) => `transaction_${index + 1}`)
      );
      const serializedProviderInput = JSON.stringify(providerInput);
      assert.ok(cactusIds.every((id) => !serializedProviderInput.includes(id)), 'no persisted Cactus id crossed the model boundary');

      const cactusSent = await __sendClientAskBatchWithClient({
        client: db,
        firmId: FIRM,
        clientId: CACTUS_CLIENT,
        batchId: cactusDrafted.batch.id,
        actorId: ACTOR
      });
      assert.equal(cactusSent.status, 'sent');
      const cactusAsks = await db.query(
        `select transaction_id, status
           from client_evidence_requests
          where firm_id = $1 and client_id = $2
          order by transaction_id`,
        [FIRM, CACTUS_CLIENT]
      );
      assert.equal(cactusAsks.rows.length, 33);
      assert.deepEqual(cactusAsks.rows.map((row) => row.transaction_id), [...cactusIds].sort());
      assert.ok(cactusAsks.rows.every((row) => row.status === 'draft'));
      const cactusTransactions = await db.query(
        `select count(*) filter (where status = 'needs_client')::int as needs_client,
                count(*) filter (where coding_state = 'asked')::int as waiting
           from transactions
          where firm_id = $1 and client_id = $2`,
        [FIRM, CACTUS_CLIENT]
      );
      assert.deepEqual(cactusTransactions.rows[0], { needs_client: 33, waiting: 33 });
    } finally {
      await __endFirmDbPoolForTests().catch(() => null);
      await db.end().catch(() => null);
      await admin.query(
        `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
        [dbName]
      ).catch(() => null);
      await admin.query(`drop database if exists "${dbName}"`).catch(() => null);
      await admin.end().catch(() => null);
    }
  }
);
