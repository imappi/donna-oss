// Pinned-SQL smoke for migration files. We don't have a live test DB
// in unit-land, so this asserts the migration source carries the
// columns + indexes the PR contract promises. If someone renames a
// column or drops an index, the diff bubbles up here before it lands
// in prod.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

// Pin the 037 goal-layer CHECK vocabularies to the runtime's exported constants
// so the schema and server/donna/loopGoal.js can never drift apart (a stop_reason
// the runtime emits but the column rejects would be a silent write failure).
import { GOAL_STATUSES, EVALUATOR_TYPES, STOP_REASONS } from './loopGoal.js';
// Pin the 038 case-suspension CHECK vocabularies the same way: the action verbs to
// the caseSuspension runtime, the authority actor types to the pure gate's set.
import { CASE_SUSPENSION_ACTIONS } from './caseSuspension.js';
import { AUTHORITY_ACTOR_TYPES } from './loopExecutionPolicy.js';
// Pin the 042 config-stage CHECK to clientConfig's CONFIG_STAGES so the column and the
// runtime can never drift (a stage the runtime writes but the column rejects = silent fail).
import { CONFIG_STAGES } from './clientConfig.js';
// Pin the 117 specialist-assignment CHECK vocabularies to the roles runtime the same way:
// the status vocabulary to roleRegistry's RoleAssignment shape law, the extended 042 source
// CHECK to the hire flow's provenance value (a source the hire writes but the column rejects
// would fail every hire at the first staged flag).
import { ASSIGNMENT_STATUSES } from './roles/roleRegistry.js';
import { ROLE_HIRE_CONFIG_SOURCE } from './roles/roleEmployment.js';
// Pin the 050 marketing-outbound CHECK vocabularies to the marketing runtime the
// same way (draft statuses; send-authority stages REUSE 042's CONFIG_STAGES — no
// third staging vocabulary).
import { DRAFT_STATUSES } from './marketing/marketingOutbound.js';
// Pin the 051 prospecting-lab CHECK vocabularies (prospect lifecycle incl.
// research_only; acceptance tiers) to the lab runtime.
import { PROSPECT_STATUSES, PROSPECT_TIERS } from './marketing/prospectLab.js';
import { HANDLED_INBOUND_EVENTS, INBOUND_CLASSIFICATIONS } from './marketing/marketingInbound.js';
// Pin the 165 site-chat CHECK vocabularies (Donna on books.example) to the runtime.
import { SITE_CHAT_LANGS, SITE_CHAT_ROLES } from './marketing/siteChatVocabulary.js';
// Pin the 097 reply-triage CHECK vocabularies (M4) to the triage runtime: a
// semantic class the sweep writes but the column rejects = silent write failure.
import { RECOMMENDED_TRIAGE_ACTIONS, SEMANTIC_CLASSES, TRIAGE_CONFIDENCES } from './marketing/replyTriage.js';
// Pin the 099 social-post CHECK vocabularies (buzz B1) to the social runtime.
import { SOCIAL_POST_KINDS, SOCIAL_POST_STATUSES } from './marketing/socialPost.js';
// Pin the 104 owner-command CHECK vocabularies (kernel-audit G13) to the
// adapter runtime: a status or channel the adapter writes but the column
// rejects would be a silent write failure on the first-loop's entry point.
import {
  OWNER_COMMAND_STATUSES, OWNER_COMMAND_CHANNELS
} from './ownerInvoiceCommand.js';
// Pin the 053 case-type CHECK to the caseManager runtime (the 'sync' amendment —
// INT-4): a case type the runtime mints but the column rejects = silent fail.
import { LOOP_CASE_TYPES } from './caseManager.js';
// Pin the 054 ledger-sync grant CHECK vocabularies to the store runtime (INT-6):
// a status/system/source the store writes but the column rejects = silent fail.
import {
  LEDGER_SYNC_GRANT_SYSTEMS,
  LEDGER_SYNC_GRANT_STATUSES,
  LEDGER_SYNC_GRANT_SOURCES
} from './ledgerSyncAuthorityGrants.js';
// Pin the 063 fiscal-year (tilikausi) status CHECK to the FI-4 runtime so a
// status the runtime writes but the column rejects = silent fail.
import { FISCAL_YEAR_STATUSES } from './finland/tilikausi.js';
// Pin the 076 StatutoryBlocker (FI-13 13.0b) CHECK vocabularies to the store
// runtime so a severity / assignee / status / event_type the store writes but the
// column rejects = silent fail. reason_code is deliberately NOT a CHECK (the C7
// default-blocker doctrine) and so is not pinned.
import {
  BLOCKER_SEVERITIES,
  BLOCKER_ASSIGNEES,
  BLOCKER_STATUSES,
  BLOCKER_EVENT_TYPES
} from './statutoryBlocker.js';
// Pin the 078 ownership-model (FI-13 13.0A-2) CHECK vocabularies to the store
// runtime so a party_type / event_type the store writes but the column rejects =
// silent fail.
import { OWNERSHIP_PARTY_TYPES, OWNERSHIP_EVENT_TYPES } from './finland/ownership.js';
// Pin the 079 authority-role (FI-13 13.0A-2b) CHECK vocabularies the same way —
// the role and basis enums must never drift between the SQL and the store.
import { FINLAND_AUTHORITY_ROLES, FINLAND_AUTHORITY_BASES } from './finland/authority.js';
// Pin the 080 inventory-posting (I4·posting P3) CHECK vocabularies to the taxonomy
// runtime so a posting_kind / outcome / waiter_type / relationship / allowance status the
// writer emits but the column rejects = silent fail. reason_code is deliberately NOT a
// CHECK (default-blocker doctrine).
import {
  INVENTORY_POSTING_KINDS,
  INVENTORY_POSTING_OUTCOMES,
  SUCCESSFUL_POSTING_OUTCOMES,
  INVENTORY_POSTING_WAITER_TYPES,
  INVENTORY_JOURNAL_RELATIONSHIPS,
  INVENTORY_ALLOWANCE_STATUSES
} from './inventory/postingLog.js';
// Pin the 084 incident-record (I4·posting P7 §12) CHECK vocabularies to the runtime so an
// incident_kind / status the writer emits but the column rejects = silent fail. reason_code /
// target_queue / posting_kind / waiter_type are deliberately NOT CHECKed there (default-blocker
// doctrine + provenance already enforced at the attempts log).
import {
  INVENTORY_INCIDENT_KINDS,
  INVENTORY_INCIDENT_STATUSES
} from './inventory/postingIncidents.js';
// Pin the 090 outbound-party (outbound-actions M0.2, G1) CHECK vocabularies to
// the party store runtime so a status / channel_kind / suggestion status the
// writers emit but the column rejects = silent fail. source is deliberately NOT
// a CHECK (a new backfill source must never reject an identity write).
import {
  PARTY_STATUSES,
  PARTY_CHANNEL_KINDS,
  PARTY_MERGE_SUGGESTION_STATUSES
} from './outbound/partyStore.js';
// Pin the 091 outbound-action (M0.3/M0.4, G2/G3/G10) CHECK vocabularies to the
// gate runtime so an action_type / verdict / status / receipt outcome the
// pipeline writes but the column rejects = silent fail. gate_verdict includes
// the RESERVED-UNUSED hold_for_internal_review (D1 open) — pinned so choosing
// the lane later is a data change, not a migration.
import {
  OUTBOUND_ACTION_TYPES,
  OUTBOUND_GATE_VERDICTS,
  OUTBOUND_ACTION_STATUSES,
  OUTBOUND_RECEIPT_OUTCOMES
} from './outbound/actionGate.js';
// Pin the 092 receivable-case (M1, G5) CHECK vocabularies to the case runtime
// so a status / anchor_type the writers emit but the column rejects = silent
// fail. Collection state lives ALONGSIDE computed settlement, never replaces
// it — the paid-truth guard (G4) stays the settlement authority.
import {
  RECEIVABLE_CASE_STATUSES,
  RECEIVABLE_CASE_ANCHOR_TYPES
} from './outbound/receivableCases.js';
// Pin the 095 M2 vocabularies (D6 grants + D4 pay-links) to their runtimes so
// a domain / status / source the writers emit but the column rejects = silent
// fail. The grant engine is ONE table with a domain scope — the anti-fourth-
// copy check is that the legacy domains are already representable.
import {
  ACTION_GRANT_DOMAINS,
  ACTION_GRANT_SCOPE_KINDS,
  ACTION_GRANT_SOURCES,
  ACTION_GRANT_STATUSES
} from './actionAuthorityGrants.js';
import {
  PAY_LINK_STATUSES,
  PAY_LINK_ANCHOR_TYPES,
  PAY_LINK_PROVIDERS
} from './outbound/payLinks.js';
// Pin the 100 earned-auto ladder (D1) CHECK vocabularies to the ladder
// runtime so a state / action_type the recorders write but the column rejects
// = silent fail. 100 also widens the 042 source CHECK with 'earned_auto' —
// the graduation write's honest provenance.
import { EARNED_AUTO_STATES } from './outbound/earnedAutoLadder.js';
// Pin the 102 owner-reply CHECK vocabularies to the reply-ingestion runtime
// (reply_if_wrong v2) — a status the sweep writes but the CHECK refuses is a
// silent fail.
import { REPLY_STATUSES } from './outbound/replyIngestionCore.js';
// Pin the 085 memories-store (BizOS Slice 2b, memory-v2 addendum §3-§6) CHECK
// vocabularies to the memory.v1 contract runtime so a scope / lifecycle / kind /
// state / origin / class / relation the writers emit but the column rejects =
// silent fail. predicate_class is pinned NARROWER than the contract enum on
// purpose — the refused classes must not be representable as rows.
import {
  MEMORY_KINDS as MEMORY_V1_KINDS,
  MEMORY_SCOPE_TYPES,
  LIFECYCLE_OWNER_TYPES,
  RECORD_STATES as MEMORY_RECORD_STATES,
  EPISTEMIC_STATES as MEMORY_EPISTEMIC_STATES,
  MEMORY_RELATION_TYPES,
  ASSERTION_ORIGINS as MEMORY_ASSERTION_ORIGINS,
  CONFIDENTIALITY_CLASSES,
  PERSONAL_DATA_CLASSES
} from './memoryModel.js';
import { MEMORY_CANDIDATE_TARGET_CONTRACTS } from './memoryCandidates.js';
// Pin the 086 memory-history-epoch (2c-iii §F/§N-D) fence modes to the runtime so a
// mode_entered the writer emits but the column rejects = silent fail.
import { MEMORY_HISTORY_EPOCH_MODES } from './memoryHistoryEpoch.js';
// Pin the 089 Singapore-core CHECK vocabularies to the SG runtime the same way:
// the gst_returns lifecycle to gstReturn.js, the corppass_mandates status enum +
// default scope to corpPassMandate.js — a status/scope the store writes but the
// column rejects = silent fail.
import { GST_RETURN_STATUSES } from './singapore/gstReturn.js';
// Pin the 109 K1 knowledge-base CHECK vocabularies to the contract runtime
// (knowledgeBase.js) — a jurisdiction / authority class / topic / answer shape
// / status the writer emits but the column rejects = silent fail. The topic
// list is the design's §5 closed vocabulary; widening it is a decision, and
// this pin is what makes the two halves move together.
import {
  KNOWLEDGE_JURISDICTIONS,
  KNOWLEDGE_AUTHORITY_CLASSES,
  KNOWLEDGE_TOPICS,
  KNOWLEDGE_ANSWER_SHAPES,
  KNOWLEDGE_STATUSES,
  KNOWLEDGE_TRANSLATION_STATUSES
} from './knowledgeBase.js';
import { CORPPASS_MANDATE_STATUSES, CORPPASS_SCOPE_GST } from './singapore/corpPassMandate.js';
// Pin the 111 MTD-2 obligation-state CHECK to the GB VAT read runtime — a status
// the persistence writes but the column rejects = silent fail.
import { VAT_PERIOD_STATUSES } from './taxAuthorities/hmrcVatObligations.js';
// Pin the 115 feedback-kind CHECK to the userFeedback runtime.
import { FEEDBACK_KINDS } from './userFeedback.js';
// Pin the 116 challenger-outcome CHECK to the modelChallenger runtime.
import { CHALLENGER_OUTCOMES } from './modelChallenger.js';

const __dirname = resolvePath(fileURLToPath(import.meta.url), '..');
const repoRoot = resolvePath(__dirname, '..', '..');

let passed = 0;
let failed = 0;

const test = (name, fn) =>
  Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed += 1;
      console.log(`  ok  ${name}`);
    })
    .catch((err) => {
      failed += 1;
      console.error(`  fail ${name}`);
      console.error(`       ${err?.stack || err?.message || err}`);
    });

const readMigration = (name) =>
  readFileSync(resolvePath(repoRoot, 'db', 'migrations', name), 'utf8');

const runTests = async () => {
  console.log('migrations:');

  await test('013 alters document_lines with the five PR 2 columns', () => {
    const sql = readMigration('013_document_lines_review_fields.sql');
    assert.match(sql, /alter\s+table\s+document_lines/i, 'alters document_lines');
    for (const col of [
      'line_no',
      'fingerprint',
      'coding_confidence',
      'coding_source',
      'review_status'
    ]) {
      assert.ok(
        new RegExp(`add column if not exists\\s+${col}\\b`, 'i').test(sql),
        `adds ${col} (if not exists)`
      );
    }
  });

  await test('013 review_status defaults to needs_review and is not null', () => {
    const sql = readMigration('013_document_lines_review_fields.sql');
    assert.match(
      sql,
      /review_status\s+text\s+not\s+null\s+default\s+'needs_review'/i,
      "review_status NOT NULL DEFAULT 'needs_review'"
    );
  });

  await test('013 creates the two PR 2 indexes', () => {
    const sql = readMigration('013_document_lines_review_fields.sql');
    assert.match(
      sql,
      /create\s+index\s+if\s+not\s+exists\s+document_lines_firm_client_review_idx\s+on\s+document_lines\s*\(\s*firm_id\s*,\s*client_id\s*,\s*review_status\s*\)/i,
      'firm/client/review index'
    );
    assert.match(
      sql,
      /create\s+index\s+if\s+not\s+exists\s+document_lines_document_fingerprint_idx\s+on\s+document_lines\s*\(\s*document_id\s*,\s*fingerprint\s*\)/i,
      'document/fingerprint index'
    );
  });

  await test('014 flips review-queue status vocabulary closed→resolved, dismissed→cancelled', () => {
    const sql = readMigration('014_review_queue_status_vocabulary.sql');
    assert.match(
      sql,
      /update\s+transaction_review_queue\s+set\s+status\s*=\s*'resolved'[\s\S]*where\s+status\s*=\s*'closed'/i,
      "closed → resolved"
    );
    assert.match(
      sql,
      /update\s+transaction_review_queue\s+set\s+status\s*=\s*'cancelled'[\s\S]*where\s+status\s*=\s*'dismissed'/i,
      "dismissed → cancelled"
    );
  });

  await test('020 adds clients.legal_names text[] not null default {}', () => {
    const sql = readMigration('020_document_classification_schema.sql');
    assert.match(
      sql,
      /alter\s+table\s+clients\s+add\s+column\s+if\s+not\s+exists\s+legal_names\s+text\[\]\s+not\s+null\s+default\s+'\{\}'::text\[\]/i,
      'legal_names column added'
    );
    assert.match(
      sql,
      /update\s+clients\s+set\s+legal_names\s*=\s*array\[company_name\]/i,
      'seed canonical from company_name'
    );
  });

  await test('020 adds documents.direction with CHECK in (incoming,outgoing,internal,unknown)', () => {
    const sql = readMigration('020_document_classification_schema.sql');
    assert.match(
      sql,
      /alter\s+table\s+documents\s+add\s+column\s+if\s+not\s+exists\s+direction\s+text\s+not\s+null\s+default\s+'unknown'/i,
      'direction column added'
    );
    assert.match(
      sql,
      /check\s*\(\s*direction\s+in\s*\(\s*'incoming'\s*,\s*'outgoing'\s*,\s*'internal'\s*,\s*'unknown'\s*\)\s*\)/i,
      'CHECK constraint on direction'
    );
    assert.match(
      sql,
      /update\s+documents\s+set\s+direction\s*=\s*case[\s\S]*receipt[\s\S]*outgoing[\s\S]*sales_invoice[\s\S]*incoming/i,
      'direction backfill case-statement covers AP / AR sides'
    );
  });

  await test('020 introduces issued_receipt into the document_type CHECK list', () => {
    const sql = readMigration('020_document_classification_schema.sql');
    assert.match(sql, /issued_receipt/, 'issued_receipt referenced');
    assert.match(
      sql,
      /array\['issued_receipt',\s*'unknown'\]::text\[\]/i,
      'allowed-list union seeds with issued_receipt + unknown'
    );
    assert.match(
      sql,
      /documents_document_type_valid/i,
      'CHECK constraint named documents_document_type_valid'
    );
    assert.match(
      sql,
      /validate\s+constraint\s+documents_document_type_valid/i,
      'CHECK is validated, not left NOT VALID'
    );
  });

  await test('020 creates the firm/client/direction partial index', () => {
    const sql = readMigration('020_document_classification_schema.sql');
    assert.match(
      sql,
      /create\s+index\s+if\s+not\s+exists\s+documents_firm_client_direction_idx\s+on\s+documents\s*\(\s*firm_id\s*,\s*client_id\s*,\s*direction\s*\)/i,
      'direction index on (firm_id, client_id, direction)'
    );
    assert.match(
      sql,
      /where\s+direction\s+in\s*\(\s*'incoming'\s*,\s*'outgoing'\s*\)/i,
      'index is partial — only AP/AR rows'
    );
  });

  await test('022 adds clients.jurisdiction text (nullable, no default)', () => {
    const sql = readMigration('022_client_jurisdiction.sql');
    assert.match(
      sql,
      /alter\s+table\s+clients\s+add\s+column\s+if\s+not\s+exists\s+jurisdiction\s+text\s*;/i,
      'jurisdiction column added (nullable, no default — null means inherit from firm)'
    );
    // Defensive: must not introduce a NOT NULL constraint or a default
    // value. Existing rows must remain in their pre-migration state
    // (null jurisdiction = use firm's jurisdiction).
    assert.doesNotMatch(
      sql,
      /jurisdiction\s+text\s+not\s+null/i,
      'must not be NOT NULL — that would break existing rows'
    );
    assert.doesNotMatch(
      sql,
      /default\s+'[A-Z]{2}'/i,
      'must not set a default jurisdiction — would mask the "inherit from firm" semantics'
    );
  });

  await test('021 widens documents_document_type_valid to the full code vocabulary', () => {
    const sql = readMigration('021_document_type_full_vocabulary.sql');
    // Every legitimate code-emitted document_type must appear literally
    // in the hardcoded vocabulary array. Anything missing here is a
    // ticking 500 on the next upload of that type.
    for (const value of [
      'bank_statement',
      'chart_of_accounts',
      'contract',
      'financing',
      'issued_receipt',
      'payment_confirmation',
      'payroll_cpf',
      'receipt',
      'sales_invoice',
      'statutory_record',
      'supplier_bill',
      'unknown',
      'xero_setup'
    ]) {
      assert.match(
        sql,
        new RegExp(`'${value}'`),
        `code_vocabulary includes ${value}`
      );
    }
    assert.match(
      sql,
      /existing_types\s*\|\|\s*code_vocabulary/i,
      'unions existing-distinct with hardcoded vocabulary'
    );
    assert.match(
      sql,
      /drop\s+constraint\s+if\s+exists\s+documents_document_type_valid/i,
      'drops the prior CHECK before recreating'
    );
    assert.match(
      sql,
      /validate\s+constraint\s+documents_document_type_valid/i,
      'validates the new CHECK rather than leaving it NOT VALID'
    );
  });

  await test('023 adds payment_account_statement to the CHECK vocabulary', () => {
    const sql = readMigration('023_payment_account_statement_doc_type.sql');
    assert.match(
      sql,
      /'payment_account_statement'/,
      "code_vocabulary includes 'payment_account_statement'"
    );
    // Mirror 021's full vocabulary so the rebuild doesn't silently drop
    // a type 021 added (every prior allowed value must still appear).
    for (const value of [
      'bank_statement',
      'chart_of_accounts',
      'contract',
      'financing',
      'issued_receipt',
      'payment_confirmation',
      'payroll_cpf',
      'receipt',
      'sales_invoice',
      'statutory_record',
      'supplier_bill',
      'unknown',
      'xero_setup'
    ]) {
      assert.match(
        sql,
        new RegExp(`'${value}'`),
        `code_vocabulary still includes ${value}`
      );
    }
    assert.match(
      sql,
      /existing_types\s*\|\|\s*code_vocabulary/i,
      'unions existing-distinct with hardcoded vocabulary'
    );
    assert.match(
      sql,
      /drop\s+constraint\s+if\s+exists\s+documents_document_type_valid/i,
      'drops the prior CHECK before recreating'
    );
    assert.match(
      sql,
      /validate\s+constraint\s+documents_document_type_valid/i,
      'validates the new CHECK rather than leaving it NOT VALID'
    );
  });

  await test('137 persists the convergence verdict and records input marks — the law stays in JS (RT-13)', () => {
    const sql = readMigration('137_convergence_state.sql');
    for (const table of ['transactions', 'documents']) {
      for (const column of ['convergence_state', 'convergence_reason', 'convergence_as_of']) {
        assert.match(sql, new RegExp(`alter table ${table}[\\s\\S]*?add column if not exists ${column}`), `${table}.${column}`);
      }
      assert.match(sql, new RegExp(`${table}_convergence_state_valid[\\s\\S]*?in \\('auto_reconciled', 'on_owner', 'hanging'\\)`), `${table} CHECK vocabulary`);
    }
    assert.match(sql, /create table if not exists convergence_marks/);
    assert.match(sql, /marked_xid xid8 not null default pg_current_xact_id\(\)/, 'marks carry the writing xid');
    for (const table of [
      'transactions', 'documents', 'reconciliation_matches', 'reconciliation_evaluations',
      'client_evidence_requests', 'transaction_review_queue', 'loop_goal_reports'
    ]) {
      assert.match(sql, new RegExp(`create trigger ${table}_convergence_mark`), `${table} input trigger`);
    }
    // The settle writes only the convergence_* columns; the transactions
    // trigger's column list must not include them, or every settle re-marks.
    const txTrigger = /create trigger transactions_convergence_mark\s+after insert or update of ([^\n]+)/.exec(sql);
    assert.ok(txTrigger, 'transactions trigger has a column list');
    assert.doesNotMatch(txTrigger[1], /convergence_/);
    // No derivation in SQL: the migration never assigns a convergence verdict.
    assert.doesNotMatch(sql, /convergence_state\s*=\s*'(auto_reconciled|on_owner|hanging)'/, 'the migration derives nothing');
    assert.match(sql, /select firm_id, client_id, 'transaction', id, 'migration_137'/, 'existing rows are marked for their first derivation');
  });

  await test('138 collapses the coding vocabularies into transactions.coding_state (RT-16)', () => {
    const sql = readMigration('138_coding_state.sql');
    assert.match(sql, /alter table transactions[\s\S]*?add column if not exists coding_state text/, 'the one column');
    assert.match(sql, /add column if not exists coding_state_as_of timestamptz/);
    assert.match(sql, /transactions_coding_state_valid[\s\S]*?in \('proposed', 'applied', 'asked', 'held', 'posted', 'synced', 'closed'\)/, 'the machine vocabulary');
    assert.match(sql, /create index if not exists idx_transactions_coding_state/);
    // The backfill mapping (every row of the header table has its SQL arm).
    for (const label of ['closed', 'synced', 'posted', 'held']) {
      assert.match(sql, new RegExp(`when '${label}' in \\(q\\.q_state, q\\.q_payload_state, t\\.payload->>'review_state'\\)`), `${label} label arm`);
    }
    assert.match(sql, /in \('asked_client', 'waiting'\)/, 'the ask labels');
    assert.match(sql, /in \('accepted', 'resolved'\)/, 'the decided labels');
    assert.match(sql, /'applied', 'alternative_applied', 'reviewer_applied', 'auto_applied'/, 'the applied receipts');
    assert.match(sql, /t\.payload \? 'ai_suggestion'/, 'a proposal must exist for a bare suggested label');
    assert.match(sql, /when m\.needs_client then 'asked'/, 'the needs_client fallback');
    assert.match(sql, /when m\.q_status in \('resolved', 'cancelled', 'closed', 'dismissed'\) then 'applied'/, 'the closed-case fallback');
    assert.match(sql, /else null/, 'no label, no proposal ⇒ NULL — a case file is not a coding state');
    assert.match(sql, /where t\.coding_state_as_of is null/, 'idempotent: only never-stamped rows');
    // The legacy labels are stripped from both tables; applied receipts survive.
    assert.match(sql, /update transactions\s+set payload = \(payload - 'review_state' - 'reviewState'\)/);
    assert.match(sql, /update transaction_review_queue\s+set payload = \(payload - 'review_state' - 'reviewState'\)/);
    assert.match(sql, /set payload = payload - 'ai_suggestion_status'\s+where payload->>'ai_suggestion_status' = 'suggested'/);
    assert.doesNotMatch(sql, /payload - 'ai_suggestion_status'\s+where payload->>'ai_suggestion_status' (in|=) '(applied|auto_applied)/, 'the applied receipts stay');
    // The queue's coding column goes, with its index and CHECK.
    assert.match(sql, /drop index if exists transaction_review_queue_firm_client_review_state_idx/);
    assert.match(sql, /drop constraint if exists transaction_review_queue_review_state_check/);
    assert.match(sql, /alter table transaction_review_queue drop column if exists review_state/);
    // A coding transition marks the row for the convergence settle; the
    // settle's own columns stay out of the list (137's rule holds).
    const txTrigger = /create trigger transactions_convergence_mark\s+after insert or update of ([^\n]+)/.exec(sql);
    assert.ok(txTrigger, 'the transactions trigger is recreated');
    assert.match(txTrigger[1], /\bcoding_state\b/);
    assert.doesNotMatch(txTrigger[1], /convergence_/);
    assert.match(sql, /execute function convergence_mark_from_transaction\(\)/, 'same function, wider column list');
    // No convergence derivation in SQL (137's law).
    assert.doesNotMatch(sql, /convergence_state\s*=\s*'(auto_reconciled|on_owner|hanging)'/);
  });

  await test('136 adds payout_statement + deposit_slip to the CHECK vocabulary (RT-18)', () => {
    const sql = readMigration('136_payout_deposit_slip_doc_types.sql');
    for (const value of ['payout_statement', 'deposit_slip']) {
      assert.match(sql, new RegExp(`'${value}'`), `code_vocabulary includes '${value}'`);
    }
    // Mirror 023's full vocabulary so the rebuild doesn't silently drop a
    // type an earlier migration added (every prior allowed value must still
    // appear).
    for (const value of [
      'bank_statement',
      'chart_of_accounts',
      'contract',
      'financing',
      'issued_receipt',
      'payment_account_statement',
      'payment_confirmation',
      'payroll_cpf',
      'receipt',
      'sales_invoice',
      'statutory_record',
      'supplier_bill',
      'unknown',
      'xero_setup'
    ]) {
      assert.match(sql, new RegExp(`'${value}'`), `code_vocabulary still includes ${value}`);
    }
    assert.match(sql, /existing_types\s*\|\|\s*code_vocabulary/i, 'unions existing-distinct with hardcoded vocabulary');
    assert.match(sql, /drop\s+constraint\s+if\s+exists\s+documents_document_type_valid/i, 'drops the prior CHECK before recreating');
    assert.match(sql, /validate\s+constraint\s+documents_document_type_valid/i, 'validates the new CHECK rather than leaving it NOT VALID');
  });

  await test('024 creates qbo_connections mirroring xero_connections with the OAuth token columns', () => {
    const sql = readMigration('024_qbo_integration.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+qbo_connections/i, 'creates qbo_connections');
    for (const col of [
      'realm_id',
      'company_name',
      'status',
      'scopes',
      'access_token',
      'refresh_token',
      'id_token',
      'token_type',
      'expires_at',
      'refresh_token_expires_at'
    ]) {
      assert.ok(
        new RegExp(`\\b${col}\\b`, 'i').test(sql),
        `qbo_connections defines ${col}`
      );
    }
    assert.match(
      sql,
      /unique\s*\(\s*firm_id\s*,\s*client_id\s*,\s*realm_id\s*\)/i,
      'unique (firm_id, client_id, realm_id) — realm_id plays tenant_id\'s role'
    );
    assert.match(
      sql,
      /create\s+index\s+if\s+not\s+exists\s+qbo_connections_firm_client_idx\s+on\s+qbo_connections\s*\(\s*firm_id\s*,\s*client_id\s*,\s*status\s*\)/i,
      'firm/client/status index'
    );
  });

  await test('024 realm_id is NOT NULL — the realm IS the connection', () => {
    const sql = readMigration('024_qbo_integration.sql');
    assert.match(sql, /realm_id\s+text\s+not\s+null/i, 'realm_id NOT NULL');
  });


  await test('060 creates client-owned hmrc_connections with encrypted tokens and RLS', () => {
    const sql = readMigration('060_hmrc_integration.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+hmrc_connections/i, 'creates hmrc_connections');
    for (const col of [
      'firm_id',
      'client_id',
      'hmrc_user_type',
      'grant_created_at',
      'access_token_encrypted',
      'refresh_token_encrypted',
      'expires_at',
      'last_error'
    ]) {
      assert.ok(new RegExp(`\\b${col}\\b`, 'i').test(sql), `hmrc_connections defines ${col}`);
    }
    assert.match(sql, /hmrc_user_type\s+text\s+not\s+null\s+check\s*\([^)]*individual[^)]*organisation/i, 'only individual/organisation HMRC user types');
    assert.doesNotMatch(sql, /hmrc_user_type[^;]*agent/i, 'no agent enum value in HMRC connection storage');
    assert.match(sql, /status\s+text\s+not\s+null\s+default\s+'active'\s+check\s*\([^)]*active[^)]*expired[^)]*revoked[^)]*error/i, 'active/expired/revoked/error status enum');
    assert.match(sql, /unique\s*\(\s*firm_id\s*,\s*client_id\s*\)/i, 'one HMRC grant per client');
    assert.match(sql, /alter\s+table\s+hmrc_connections\s+enable\s+row\s+level\s+security/i, 'RLS enabled');
    assert.match(sql, /revoke\s+all\s+on\s+hmrc_connections\s+from\s+authenticated/i, 'browser role revoked');
  });


  await test('062 creates HMRC request audit spine with only fraud header hash/version and RLS', () => {
    const sql = readMigration('062_hmrc_request_audit.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+hmrc_request_audit/i, 'creates hmrc_request_audit');
    for (const col of [
      'id',
      'firm_id',
      'client_id',
      'hmrc_connection_id',
      'hmrc_endpoint',
      'http_method',
      'request_purpose',
      'fraud_header_set_version',
      'fraud_header_hash',
      'hmrc_correlation_id',
      'response_status',
      'response_error_code',
      'created_at'
    ]) {
      assert.ok(new RegExp(String.raw`\b${col}\b`, 'i').test(sql), `hmrc_request_audit defines ${col}`);
    }
    assert.doesNotMatch(sql, /fraud_headers|raw_header|header_payload/i, 'does not store raw fraud headers');
    assert.match(sql, /alter\s+table\s+hmrc_request_audit\s+enable\s+row\s+level\s+security/i, 'RLS enabled');
    assert.doesNotMatch(sql, /force\s+row\s+level\s+security/i, 'RLS is not forced so owner stays exempt');
    assert.match(sql, /revoke\s+all\s+on\s+hmrc_request_audit\s+from\s+authenticated/i, 'browser role revoked');
  });

  await test('025 creates the four qbo reference tables + qbo_sync_runs', () => {
    const sql = readMigration('025_qbo_reference_data.sql');
    for (const table of ['qbo_accounts', 'qbo_classes', 'qbo_vendors', 'qbo_customers', 'qbo_sync_runs']) {
      assert.match(
        sql,
        new RegExp(String.raw`create\s+table\s+if\s+not\s+exists\s+${table}\b`, 'i'),
        `creates ${table}`
      );
    }
  });

  await test('025 reference tables FK qbo_connections and upsert on (connection_id, <entity>_id)', () => {
    const sql = readMigration('025_qbo_reference_data.sql');
    // Every reference table cascades from the connection so a disconnect /
    // delete can't orphan synced rows, and each carries the unique key the
    // syncQboReferenceDataInDb upsert targets.
    for (const [table, idCol] of [
      ['qbo_accounts', 'qbo_account_id'],
      ['qbo_classes', 'qbo_class_id'],
      ['qbo_vendors', 'qbo_vendor_id'],
      ['qbo_customers', 'qbo_customer_id']
    ]) {
      assert.ok(
        new RegExp(`${idCol}\\b`, 'i').test(sql),
        `${table} defines ${idCol}`
      );
      assert.match(
        sql,
        new RegExp(`unique\\s*\\(\\s*connection_id\\s*,\\s*${idCol}\\s*\\)`, 'i'),
        `${table} unique (connection_id, ${idCol})`
      );
    }
    assert.match(
      sql,
      /references\s+qbo_connections\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i,
      'reference rows cascade from qbo_connections'
    );
  });

  await test('025 qbo_accounts carries the QBO CoA vocabulary columns', () => {
    const sql = readMigration('025_qbo_reference_data.sql');
    for (const col of [
      'account_number',
      'account_type',
      'account_sub_type',
      'classification',
      'current_balance'
    ]) {
      assert.ok(new RegExp(`\\b${col}\\b`, 'i').test(sql), `qbo_accounts defines ${col}`);
    }
  });

  await test('026 creates qbo_journal_mirrors keyed on (connection_id, journal_id)', () => {
    const sql = readMigration('026_qbo_journal_mirrors.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+qbo_journal_mirrors\b/i, 'creates qbo_journal_mirrors');
    // The idempotency guard: one mirror row per (connection, journal); stores the
    // QBO id + sync token so a re-sync UPDATEs instead of duplicating.
    for (const col of ['journal_id', 'qbo_journal_entry_id', 'sync_token', 'doc_number', 'source_type', 'source_id']) {
      assert.ok(new RegExp(`\\b${col}\\b`, 'i').test(sql), `qbo_journal_mirrors defines ${col}`);
    }
    assert.match(
      sql,
      /unique\s*\(\s*connection_id\s*,\s*journal_id\s*\)/i,
      'unique (connection_id, journal_id) — the dedup guard'
    );
    assert.match(
      sql,
      /journal_id\s+text\s+not\s+null\s+references\s+ledger_journals\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i,
      'journal_id FK ledger_journals on delete cascade'
    );
  });

  await test('026 status CHECK covers running/synced/error/stale', () => {
    const sql = readMigration('026_qbo_journal_mirrors.sql');
    assert.match(
      sql,
      /status\s+text\s+not\s+null\s+default\s+'running'\s+check\s*\(\s*status\s+in\s*\(\s*'running'\s*,\s*'synced'\s*,\s*'error'\s*,\s*'stale'\s*\)\s*\)/i,
      'status vocabulary pinned'
    );
  });

  await test('055 creates Procountor connection/reference/mirror tables for the capability trial', () => {
    const sql = readMigration('055_procountor_integration.sql');
    for (const table of [
      'procountor_connections',
      'procountor_accounts',
      'procountor_dimensions',
      'procountor_vendors',
      'procountor_customers',
      'procountor_sync_runs',
      'procountor_journal_mirrors'
    ]) {
      assert.match(sql, new RegExp('create\\s+table\\s+if\\s+not\\s+exists\\s+' + table + '\\b', 'i'), `creates ${table}`);
    }
    assert.match(sql, /status\s+text\s+not\s+null\s+default\s+'connected'\s+check\s*\(\s*status\s+in\s*\(\s*'connected'\s*,\s*'disconnected'\s*,\s*'expired'\s*,\s*'error'\s*\)\s*\)/i, 'connection status honesty vocabulary');
    assert.match(sql, /unique\s*\(\s*firm_id\s*,\s*client_id\s*,\s*company_id\s*\)/i, 'one Procountor company connection per client');
    assert.match(sql, /unique\s*\(\s*connection_id\s*,\s*journal_id\s*\)/i, 'journal mirror idempotency key');
    assert.match(sql, /references\s+procountor_connections\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i, 'reference rows cascade from Procountor connections');
  });

  await test('060 adds the api_key column for the Procountor M2M (client_credentials) connect', () => {
    const sql = readMigration('060_procountor_api_key.sql');
    assert.match(sql, /alter\s+table\s+procountor_connections\s+add\s+column\s+if\s+not\s+exists\s+api_key\s+text/i, 'adds nullable api_key column');
  });

  await test('061 reshapes the Procountor reference tables to the live API field shapes', () => {
    const sql = readMigration('061_procountor_reference_schema.sql');
    // The QBO-placeholder split vendor/customer tables collapse into the single
    // business-partners table (one /businesspartners endpoint, type enum).
    assert.match(sql, /drop\s+table\s+if\s+exists\s+procountor_vendors\b/i, 'drops the placeholder vendors table');
    assert.match(sql, /drop\s+table\s+if\s+exists\s+procountor_customers\b/i, 'drops the placeholder customers table');
    assert.match(sql, /create\s+table\s+procountor_business_partners\b/i, 'creates procountor_business_partners');
    assert.match(sql, /partner_type\s+text/i, 'business partners carry the type enum column');
    // coa: ledger_account_code is the identifier; en/sv name columns.
    assert.match(sql, /create\s+table\s+procountor_accounts\b/i, 'recreates procountor_accounts');
    assert.match(sql, /ledger_account_code\s+text\s+not\s+null/i, 'accounts key on ledger_account_code');
    assert.match(sql, /unique\s*\(\s*connection_id\s*,\s*ledger_account_code\s*\)/i, 'accounts unique on connection + code');
    // bank accounts: a new table absent from 055.
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+procountor_bank_accounts\b/i, 'creates procountor_bank_accounts');
    assert.match(sql, /iban\s+text/i, 'bank accounts store the iban');
    assert.match(sql, /references\s+procountor_connections\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i, 'reference rows cascade from Procountor connections');
  });

  await test('056 creates client_chat_messages — owner thread with client actor attribution', () => {
    const sql = readMigration('056_client_chat_messages.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+client_chat_messages\b/i, 'creates client_chat_messages');
    // The owner speaks as actor_type 'client' — the value the firm chat
    // tables (015/016) deliberately do not admit. This is the day-one
    // actor-attribution requirement for the portal chat.
    assert.match(
      sql,
      /actor_type\s+text\s+not\s+null\s+default\s+'client'\s+check\s*\(\s*actor_type\s+in\s*\(\s*'client'\s*,\s*'firm'\s*,\s*'system'\s*,\s*'llm'\s*\)\s*\)/i,
      'actor vocabulary includes client and defaults to it'
    );
    assert.match(sql, /role\s+text\s+not\s+null\s+check\s*\(\s*role\s+in\s*\(\s*'user'\s*,\s*'assistant'\s*,\s*'system'\s*\)\s*\)/i, 'role vocabulary matches the firm chat tables');
    // Tenancy: both FKs cascade so a deleted client/firm takes its owner
    // thread with it.
    assert.match(sql, /firm_id\s+text\s+not\s+null\s+references\s+firms\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i, 'firm_id FK cascades');
    assert.match(sql, /client_id\s+text\s+not\s+null\s+references\s+clients\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i, 'client_id FK cascades');
    assert.match(sql, /create\s+index\s+if\s+not\s+exists\s+client_chat_messages_thread_idx/i, 'thread index exists');
  });

  await test('027 creates document_corrections with the right FK + writeback indexes', () => {
    const sql = readMigration('027_document_corrections.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+document_corrections\b/i, 'creates document_corrections');
    // jsonb columns round-trip strings + numbers + null without coercion.
    for (const col of ['prior_value', 'corrected_value']) {
      assert.ok(new RegExp(`${col}\\s+jsonb`, 'i').test(sql), `${col} is jsonb`);
    }
    // FKs cascade so a deleted document cleans up its history.
    assert.match(
      sql,
      /document_id\s+text\s+not\s+null\s+references\s+documents\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i,
      'document_id FK cascades'
    );
    assert.match(
      sql,
      /firm_id\s+text\s+not\s+null\s+references\s+firms\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i,
      'firm_id FK cascades'
    );
    // source enum pinned so non-manual sources (auto-corrections from
    // a future ML pass) round-trip cleanly.
    assert.match(
      sql,
      /source\s+text\s+not\s+null\s+default\s+'manual'\s+check\s*\(\s*source\s+in\s*\(\s*'manual'\s*,\s*'auto'\s*\)\s*\)/i,
      'source vocabulary pinned'
    );
    // Two indexes: per-document history + recent-firm scan.
    assert.match(
      sql,
      /create\s+index\s+if\s+not\s+exists\s+document_corrections_doc_idx\s+on\s+document_corrections\s*\(\s*firm_id\s*,\s*document_id\s*,\s*field_path\s*,\s*corrected_at\s+desc\s*\)/i,
      'per-document history index'
    );
    assert.match(
      sql,
      /create\s+index\s+if\s+not\s+exists\s+document_corrections_firm_recent_idx\s+on\s+document_corrections\s*\(\s*firm_id\s*,\s*corrected_at\s+desc\s*\)/i,
      'recent-firm scan index'
    );
  });

  await test('027 carries the orphaned-type defensive prelude', () => {
    // Why this test exists: production deploy of #275 failed with
    // `duplicate key value violates unique constraint
    // "pg_type_typname_nsp_index"`. Root cause was an orphan row
    // type in pg_type left from an interrupted earlier attempt.
    // The DO block below drops only the orphan; removing it would
    // re-introduce the prod failure.
    const sql = readMigration('027_document_corrections.sql');
    assert.match(sql, /do \$\$[\s\S]*pg_type[\s\S]*pg_class[\s\S]*drop type document_corrections[\s\S]*end \$\$/i,
      'orphan pg_type cleanup DO block present');
    // Order: cleanup before CREATE TABLE.
    const cleanupIdx = sql.search(/drop type document_corrections/i);
    const createIdx = sql.search(/create\s+table\s+if\s+not\s+exists\s+document_corrections/i);
    assert.ok(cleanupIdx > -1 && createIdx > -1 && cleanupIdx < createIdx,
      'cleanup precedes CREATE TABLE');
  });

  await test('028 creates reconciliation_evaluations with the verdict columns + last-evaluation upsert key', () => {
    const sql = readMigration('028_reconciliation_evaluations.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+reconciliation_evaluations/i, 'creates the table');
    for (const col of [
      'target_type',
      'target_id',
      'matcher_family',
      'matcher_mode',
      'verdict',
      'unmatchable_reason',
      'proposal_count',
      'candidate_count',
      'eligible_count',
      'evaluated_at'
    ]) {
      assert.match(sql, new RegExp(`\\b${col}\\b`, 'i'), `carries ${col}`);
    }
    // The upsert key recordReconciliationEvaluation's ON CONFLICT
    // targets — renaming or reordering these columns breaks the stamp.
    assert.match(
      sql,
      /create\s+unique\s+index\s+if\s+not\s+exists\s+uq_reconciliation_evaluations_target\s+on\s+reconciliation_evaluations\s*\(\s*firm_id\s*,\s*client_id\s*,\s*target_type\s*,\s*target_id\s*,\s*matcher_family\s*\)/i,
      'last-evaluation upsert key'
    );
  });

  await test('029 creates client_ask_batches with the status vocabulary + staleness anchor', () => {
    const sql = readMigration('029_client_ask_batches.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+client_ask_batches/i, 'creates the table');
    for (const col of [
      'period_start',
      'period_end',
      'subject',
      'message_markdown',
      'payload',
      'verdicts_as_of',
      'model',
      'sent_at',
      'sent_by'
    ]) {
      assert.match(sql, new RegExp(`\\b${col}\\b`, 'i'), `carries ${col}`);
    }
    // The send path's draft-only guard keys off this vocabulary.
    assert.match(
      sql,
      /check\s*\(\s*status\s+in\s*\(\s*'draft'\s*,\s*'sent'\s*,\s*'superseded'\s*,\s*'cancelled'\s*\)\s*\)/i,
      'status vocabulary pinned'
    );
    assert.match(
      sql,
      /create\s+index\s+if\s+not\s+exists\s+client_ask_batches_firm_client_idx\s+on\s+client_ask_batches\s*\(\s*firm_id\s*,\s*client_id\s*,\s*status\s*,\s*created_at\s+desc\s*\)/i,
      'firm/client/status index'
    );
  });

  await test('030 creates firm_facts — identity-keyed Layer-2 memory, no client FK', () => {
    const sql = readMigration('030_firm_facts.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+firm_facts/i, 'creates the table');
    for (const col of ['scope', 'subject', 'fact', 'provenance', 'confidence', 'model', 'status']) {
      assert.match(sql, new RegExp(`\\b${col}\\b`, 'i'), `carries ${col}`);
    }
    assert.match(
      sql,
      /check\s*\(\s*scope\s+in\s*\(\s*'merchant'\s*,\s*'client'\s*,\s*'jurisdiction'\s*,\s*'firm'\s*\)\s*\)/i,
      'scope vocabulary pinned'
    );
    assert.match(
      sql,
      /check\s*\(\s*status\s+in\s*\(\s*'active'\s*,\s*'dismissed'\s*\)\s*\)/i,
      'status vocabulary pinned (readers honour active only)'
    );
    // THE design invariant: facts survive client deletion/recreation.
    // A references-clauses scan must show firms only — no clients FK.
    assert.ok(!/references\s+clients/i.test(sql),
      'firm_facts must NOT reference clients(id) — identity keys, not row ids');
    assert.match(
      sql,
      /create\s+index\s+if\s+not\s+exists\s+firm_facts_lookup_idx\s+on\s+firm_facts\s*\(\s*firm_id\s*,\s*scope\s*,\s*subject\s*,\s*status\s*\)/i,
      'lookup index'
    );
  });

  await test('031 idempotently drops the transaction_chat_messages → transactions FK (feed sentinel thread)', () => {
    const sql = readMigration('031_drop_transaction_chat_messages_fk.sql');
    assert.match(
      sql,
      /alter\s+table\s+transaction_chat_messages\s+drop\s+constraint\s+if\s+exists\s+transaction_chat_messages_transaction_id_fkey/i,
      'drops the stray FK with IF EXISTS (no-op on schemas built from current files)'
    );
    // The feed thread sentinel ('__feed__') has no backing transactions
    // row by design (016) — 031 must not re-introduce a transactions FK.
    assert.ok(!/add\s+constraint[\s\S]*references\s+transactions/i.test(sql),
      '031 must not re-add a transactions FK');
  });

  await test('032 locks RLS via a DYNAMIC pg_class/pg_namespace scan, not a frozen list', () => {
    const sql = readMigration('032_lock_down_public_rls.sql');
    // The whole point of the second pass: scan the catalog at apply time so the
    // lockdown covers whatever public tables exist (robust to 033/034 churn),
    // never a hardcoded table list that goes stale on the next merge.
    assert.match(sql, /from\s+pg_class\b/i, 'scans pg_class');
    assert.match(sql, /join\s+pg_namespace\b/i, 'joins pg_namespace');
    assert.match(sql, /nspname\s*=\s*'public'/i, 'scoped to the public schema');
    assert.match(sql, /relkind\s+in\s*\(\s*'r'\s*,\s*'p'\s*\)/i, 'ordinary + partitioned tables only');
    assert.match(sql, /enable\s+row\s+level\s+security/i, 'ENABLEs RLS in the loop');
    // ENABLE, never FORCE — the owner (server) connection must stay exempt.
    assert.doesNotMatch(sql, /force\s+row\s+level\s+security/i, 'must not FORCE (would lock out the owner server role)');
    // Must not pin a literal table-name list (the stale-list failure mode).
    assert.doesNotMatch(
      sql,
      /enable\s+row\s+level\s+security\s+on\b/i,
      'no per-table ENABLE list — coverage comes from the catalog scan'
    );
  });

  await test('032 revokes the browser roles, role-guarded, with no browser data policy', () => {
    const sql = readMigration('032_lock_down_public_rls.sql');
    assert.match(sql, /rolname\s*=\s*'anon'/i, 'guards on the anon role existing');
    assert.match(sql, /rolname\s*=\s*'authenticated'/i, 'guards on the authenticated role existing');
    assert.match(sql, /revoke\s+all\s+on[\s\S]*from\s+anon/i, 'revokes table privileges from anon');
    assert.match(sql, /revoke\s+all\s+on[\s\S]*from\s+authenticated/i, 'revokes table privileges from authenticated');
    assert.match(
      sql,
      /revoke\s+all\s+on\s+all\s+sequences\s+in\s+schema\s+public\s+from\s+anon/i,
      'revokes sequences too (the generated API reaches them as well)'
    );
    // THE invariant: a blanket lockdown must add NO browser-facing policy — one
    // permissive policy for anon/authenticated would re-open the API path. Strip
    // line comments first so the explanatory "NO create policy" prose in the
    // migration header isn't mistaken for an actual CREATE POLICY statement.
    const sqlNoComments = sql.replace(/--.*$/gm, '');
    assert.doesNotMatch(sqlNoComments, /create\s+policy/i, 'must not create any browser data policy');
  });

  await test('032 ships the future-guard event trigger as a non-invokable SECURITY DEFINER fn', () => {
    const sql = readMigration('032_lock_down_public_rls.sql');
    assert.match(
      sql,
      /create\s+or\s+replace\s+function\s+donna_lock_down_new_public_table\(\)\s+returns\s+event_trigger/i,
      'declares the event_trigger function'
    );
    assert.match(sql, /security\s+definer/i, 'runs with definer rights');
    assert.match(sql, /set\s+search_path\s*=\s*pg_catalog/i, 'pins search_path (SECURITY DEFINER hardening)');
    assert.match(sql, /pg_event_trigger_ddl_commands\(\)/i, 'reads the DDL command set');
    assert.match(
      sql,
      /create\s+event\s+trigger\s+donna_lock_down_new_public_table_trg\s+on\s+ddl_command_end/i,
      'attaches on ddl_command_end'
    );
    // The function itself must not be callable by the browser/API roles.
    assert.match(
      sql,
      /revoke\s+all\s+on\s+function\s+donna_lock_down_new_public_table\(\)\s+from\s+public/i,
      'EXECUTE revoked from public'
    );
  });

  await test('032 degrades gracefully when the role cannot CREATE EVENT TRIGGER', () => {
    // CREATE EVENT TRIGGER needs superuser; Supabase's migration role is not
    // one. The trigger creation MUST be guarded so the §1 static lockdown (the
    // actual fix for the advisor warning) always applies — the backstop is a
    // best-effort extra, never a gate on the migration succeeding.
    const sql = readMigration('032_lock_down_public_rls.sql');
    assert.match(sql, /insufficient_privilege/i, 'catches the privilege error on trigger creation');
    const triggerIdx = sql.search(/create\s+event\s+trigger/i);
    const handlerIdx = sql.search(/insufficient_privilege/i);
    assert.ok(
      triggerIdx > -1 && handlerIdx > -1,
      'both the trigger creation and its exception handler are present'
    );
  });

  await test('035 adds ledger_accounts.canonical_role — additive, nullable, no default, no CHECK', () => {
    const sql = readMigration('035_ledger_account_canonical_role.sql');
    assert.match(
      sql,
      /alter\s+table\s+ledger_accounts\s+add\s+column\s+if\s+not\s+exists\s+canonical_role\s+text\s*;/i,
      'canonical_role column added (nullable text)'
    );
    // Strip line comments first so the explanatory header (which discusses why we
    // do NOT add NOT NULL / a default / a CHECK) can't trip the negative asserts.
    const sqlNoComments = sql.replace(/--.*$/gm, '');
    // NULL means "model resolves later" — NOT NULL would force a guess at write time.
    assert.doesNotMatch(sqlNoComments, /canonical_role\s+text\s+not\s+null/i, 'must not be NOT NULL');
    // No default — an unresolved role is null, not a wrong-but-present guess.
    assert.doesNotMatch(sqlNoComments, /canonical_role\s+text[^;]*default/i, 'must not set a default role');
    // No CHECK enumerating the role set — the vocabulary lives in accountRoles.js;
    // a DB CHECK would be a second source of truth that drifts on the next role add.
    assert.doesNotMatch(sqlNoComments, /check\s*\(\s*canonical_role/i, 'must not pin a CHECK on canonical_role');
  });

  await test('035 creates the partial (firm, client, role) lookup index', () => {
    const sql = readMigration('035_ledger_account_canonical_role.sql');
    assert.match(
      sql,
      /create\s+index\s+if\s+not\s+exists\s+ledger_accounts_firm_client_role_idx\s+on\s+ledger_accounts\s*\(\s*firm_id\s*,\s*client_id\s*,\s*canonical_role\s*\)/i,
      'role lookup index on (firm_id, client_id, canonical_role)'
    );
    assert.match(
      sql,
      /where\s+canonical_role\s+is\s+not\s+null/i,
      'index is partial — only rows with a resolved role'
    );
  });

  await test('037 creates the four goal-layer tables (specs/runs/reports/dependencies)', () => {
    const sql = readMigration('037_loop_goal_layer.sql');
    for (const table of ['loop_goal_specs', 'loop_runs', 'loop_goal_reports', 'bookkeeping_case_dependencies']) {
      assert.match(
        sql,
        new RegExp(String.raw`create\s+table\s+if\s+not\s+exists\s+${table}\b`, 'i'),
        `creates ${table}`
      );
    }
  });

  await test('037 loop_goal_specs is content-addressed on goal_spec_hash (the hash IS the key)', () => {
    const sql = readMigration('037_loop_goal_layer.sql');
    assert.match(
      sql,
      /goal_spec_hash\s+text\s+primary\s+key/i,
      'goal_spec_hash is the primary key — same spec content de-dupes to one row'
    );
  });

  await test('037 loop_runs.stop_reason CHECK matches loopGoal STOP_REASONS exactly', () => {
    const sql = readMigration('037_loop_goal_layer.sql');
    // Every runtime stop reason must be an accepted column value, and the column
    // must accept nothing extra — the in-lockstep guard.
    const match = sql.match(/stop_reason\s+text\s+not\s+null\s*\n?\s*check\s*\(\s*stop_reason\s+in\s*\(([^)]*)\)/i);
    assert.ok(match, 'stop_reason CHECK present');
    const listed = (match[1].match(/'([^']+)'/g) || []).map((s) => s.replace(/'/g, '')).sort();
    assert.deepEqual(listed, [...STOP_REASONS].sort(), 'stop_reason vocabulary == STOP_REASONS');
  });

  await test('037 loop_goal_reports.status CHECK matches loopGoal GOAL_STATUSES exactly', () => {
    const sql = readMigration('037_loop_goal_layer.sql');
    const match = sql.match(/status\s+text\s+not\s+null\s*\n?\s*check\s*\(\s*status\s+in\s*\(([^)]*)\)/i);
    assert.ok(match, 'status CHECK present');
    const listed = (match[1].match(/'([^']+)'/g) || []).map((s) => s.replace(/'/g, '')).sort();
    assert.deepEqual(listed, [...GOAL_STATUSES].sort(), 'goal status vocabulary == GOAL_STATUSES');
  });

  await test('037 evaluator_type CHECK matches loopGoal EVALUATOR_TYPES (specs + reports)', () => {
    const sql = readMigration('037_loop_goal_layer.sql');
    const checks = sql.match(/check\s*\(\s*evaluator_type\s+in\s*\(([^)]*)\)/gi) || [];
    assert.ok(checks.length >= 2, 'evaluator_type CHECK on both loop_goal_specs and loop_goal_reports');
    for (const clause of checks) {
      const listed = (clause.match(/'([^']+)'/g) || []).map((s) => s.replace(/'/g, '')).sort();
      assert.deepEqual(listed, [...EVALUATOR_TYPES].sort(), 'evaluator_type vocabulary == EVALUATOR_TYPES');
    }
  });

  await test('037 loop_goal_reports carries the MANDATORY event pointer (§13.2)', () => {
    const sql = readMigration('037_loop_goal_layer.sql');
    // event_id NOT NULL + FK bookkeeping_case_events — every report is reachable
    // from the single append-only audit stream.
    assert.match(
      sql,
      /event_id\s+text\s+not\s+null\s+references\s+bookkeeping_case_events\s*\(\s*id\s*\)/i,
      'event_id NOT NULL references bookkeeping_case_events'
    );
  });

  await test('037 idempotency keys: run per (case, trigger event); report per run (§13.4)', () => {
    const sql = readMigration('037_loop_goal_layer.sql');
    assert.match(
      sql,
      /create\s+unique\s+index\s+if\s+not\s+exists\s+loop_runs_case_trigger_uidx\s+on\s+loop_runs\s*\(\s*case_id\s*,\s*trigger_event_id\s*\)\s*where\s+trigger_event_id\s+is\s+not\s+null/i,
      'loop_runs partial-unique (case_id, trigger_event_id)'
    );
    assert.match(
      sql,
      /create\s+unique\s+index\s+if\s+not\s+exists\s+loop_goal_reports_run_uidx\s+on\s+loop_goal_reports\s*\(\s*loop_run_id\s*\)\s*where\s+loop_run_id\s+is\s+not\s+null/i,
      'loop_goal_reports partial-unique (loop_run_id) — one report per run'
    );
  });

  await test('037 enforces APPEND-ONLY on runs + reports, with a purge-only DELETE hatch (INV-17)', () => {
    const sql = readMigration('037_loop_goal_layer.sql');
    assert.match(
      sql,
      /create\s+or\s+replace\s+function\s+loop_goal_append_only_guard\(\)\s+returns\s+trigger/i,
      'append-only guard function declared'
    );
    assert.match(sql, /raise\s+exception\s*\n?\s*'append-only/i, 'forbidden ops raise');
    // UPDATE or DELETE on both tables fires the guard.
    for (const table of ['loop_runs', 'loop_goal_reports']) {
      assert.match(
        sql,
        new RegExp(`before\\s+update\\s+or\\s+delete\\s+on\\s+${table}\\b`, 'i'),
        `${table} guarded on update + delete`
      );
      assert.match(
        sql,
        new RegExp(`drop\\s+trigger\\s+if\\s+exists\\s+\\w+\\s+on\\s+${table}`, 'i'),
        `${table} trigger drop-if-exists (idempotent re-run)`
      );
    }
    // The ONLY sanctioned removal: the client-delete purge opens a session-local
    // flag (firm memory dies with its client) — otherwise DELETE is forbidden.
    assert.match(
      sql,
      /current_setting\(\s*'donna\.allow_append_only_purge'\s*,\s*true\s*\)[\s\S]{0,20}=\s*'on'/i,
      'DELETE allowed only under the client-delete purge flag'
    );
  });

  await test('037 adds bookkeeping_cases.case_version (single-flight INV-16) — additive, defaulted', () => {
    const sql = readMigration('037_loop_goal_layer.sql');
    assert.match(
      sql,
      /alter\s+table\s+bookkeeping_cases\s*\n?\s*add\s+column\s+if\s+not\s+exists\s+case_version\s+integer\s+not\s+null\s+default\s+1/i,
      'case_version integer NOT NULL DEFAULT 1 (if not exists)'
    );
  });

  await test('037 adds bookkeeping_cases.latest_goal_report_id as a POINTER ONLY — no FK (§13.3)', () => {
    const sql = readMigration('037_loop_goal_layer.sql');
    assert.match(
      sql,
      /add\s+column\s+if\s+not\s+exists\s+latest_goal_report_id\s+text\s*;/i,
      'latest_goal_report_id plain text column (mirrors latest_snapshot_id)'
    );
    // Strip line comments so the header prose ("pointer/cache only", "never read
    // as truth") can't trip the negative assert.
    const sqlNoComments = sql.replace(/--.*$/gm, '');
    // It must NOT be a foreign key — the terminal-state read derives from the
    // append-only table, so the pointer stays an un-enforced cache.
    assert.doesNotMatch(
      sqlNoComments,
      /latest_goal_report_id\s+text\s+references/i,
      'latest_goal_report_id must not be a FK — it is a cache, never a source of truth'
    );
  });

  await test('037 bookkeeping_case_dependencies: typed verbs, one canonical direction, no self-edge', () => {
    const sql = readMigration('037_loop_goal_layer.sql');
    const match = sql.match(/check\s*\(\s*relationship_type\s+in\s*\(([^)]*)\)/i);
    assert.ok(match, 'relationship_type CHECK present');
    const listed = (match[1].match(/'([^']+)'/g) || []).map((s) => s.replace(/'/g, '')).sort();
    assert.deepEqual(
      listed,
      ['aggregates', 'blocks', 'child_of', 'satisfies', 'spawned_from', 'supersedes'],
      'canonical relationship verbs only (no inverse rows)'
    );
    assert.match(sql, /check\s*\(\s*parent_case_id\s*<>\s*child_case_id\s*\)/i, 'forbids self-dependency');
    assert.match(
      sql,
      /unique\s*\(\s*parent_case_id\s*,\s*child_case_id\s*,\s*relationship_type\s*\)/i,
      'one canonical (parent → child) edge per type'
    );
  });

  await test('037 goal-layer tables follow the firm_facts pattern (plain client_id, no clients FK)', () => {
    const sql = readMigration('037_loop_goal_layer.sql');
    // Like 033: the delete cascade from clients must NOT reach these rows (an
    // explicit client-delete purge is load-bearing instead).
    const sqlNoComments = sql.replace(/--.*$/gm, '');
    assert.ok(!/references\s+clients\b/i.test(sqlNoComments),
      'no table may reference clients(id) — client_id is a plain column');
    assert.match(sql, /client_id\s+text\s+not\s+null/i, 'client_id is a plain not-null column');
  });

  await test('037 is RLS-native (mirror 033): ENABLE + guarded revoke, never FORCE', () => {
    const sql = readMigration('037_loop_goal_layer.sql');
    for (const table of ['loop_goal_specs', 'loop_runs', 'loop_goal_reports', 'bookkeeping_case_dependencies']) {
      assert.match(
        sql,
        new RegExp(String.raw`alter\s+table\s+${table}\s+enable\s+row\s+level\s+security`, 'i'),
        `${table} ENABLEs RLS`
      );
    }
    assert.match(sql, /rolname\s*=\s*'anon'/i, 'guards on the anon role existing');
    assert.match(sql, /rolname\s*=\s*'authenticated'/i, 'guards on the authenticated role existing');
    assert.doesNotMatch(sql, /force\s+row\s+level\s+security/i, 'must not FORCE (owner server role stays exempt)');
  });

  await test('038 bookkeeping_case_suspensions.action CHECK matches CASE_SUSPENSION_ACTIONS exactly', () => {
    const sql = readMigration('038_loop_case_suspensions.sql');
    // The schema must accept every action the runtime writes and nothing extra —
    // the in-lockstep guard (pause/resume/cancel).
    const match = sql.match(/action\s+text\s+not\s+null\s*\n?\s*check\s*\(\s*action\s+in\s*\(([^)]*)\)/i);
    assert.ok(match, 'action CHECK present');
    const listed = (match[1].match(/'([^']+)'/g) || []).map((s) => s.replace(/'/g, '')).sort();
    assert.deepEqual(listed, [...CASE_SUSPENSION_ACTIONS].sort(), 'action vocabulary == CASE_SUSPENSION_ACTIONS');
  });

  await test('038 authorized_by_actor_type CHECK matches AUTHORITY_ACTOR_TYPES (only an authority may govern)', () => {
    const sql = readMigration('038_loop_case_suspensions.sql');
    const match = sql.match(/authorized_by_actor_type\s+text\s+not\s+null\s*\n?\s*check\s*\(\s*authorized_by_actor_type\s+in\s*\(([^)]*)\)/i);
    assert.ok(match, 'authorized_by_actor_type CHECK present');
    const listed = (match[1].match(/'([^']+)'/g) || []).map((s) => s.replace(/'/g, '')).sort();
    assert.deepEqual(listed, [...AUTHORITY_ACTOR_TYPES].sort(), 'authority vocabulary == AUTHORITY_ACTOR_TYPES');
  });

  await test('038 follows the firm_facts pattern (plain client_id, no clients FK)', () => {
    const sql = readMigration('038_loop_case_suspensions.sql');
    const sqlNoComments = sql.replace(/--.*$/gm, '');
    assert.ok(!/references\s+clients\b/i.test(sqlNoComments),
      'must not reference clients(id) — client_id is a plain column (the clients cascade misses these rows)');
    assert.match(sql, /client_id\s+text\s+not\s+null/i, 'client_id is a plain not-null column');
  });

  await test('038 case_id FKs bookkeeping_cases ON DELETE CASCADE (the spine anchor)', () => {
    const sql = readMigration('038_loop_case_suspensions.sql');
    assert.match(
      sql,
      /case_id\s+text\s+not\s+null\s+references\s+bookkeeping_cases\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i,
      'case_id NOT NULL references bookkeeping_cases(id) ON DELETE CASCADE'
    );
  });

  await test('038 enforces APPEND-ONLY (reuses 037 guard), purge-only DELETE hatch (INV-17)', () => {
    const sql = readMigration('038_loop_case_suspensions.sql');
    // UPDATE or DELETE fires 037's generic guard function.
    assert.match(
      sql,
      /before\s+update\s+or\s+delete\s+on\s+bookkeeping_case_suspensions\b/i,
      'guarded on update + delete'
    );
    assert.match(
      sql,
      /execute\s+function\s+loop_goal_append_only_guard\(\)/i,
      'reuses 037 loop_goal_append_only_guard (table-agnostic)'
    );
    assert.match(
      sql,
      /drop\s+trigger\s+if\s+exists\s+\w+\s+on\s+bookkeeping_case_suspensions/i,
      'trigger drop-if-exists (idempotent re-run)'
    );
  });

  await test('038 is RLS-native (mirror 033/037): ENABLE + guarded revoke, never FORCE', () => {
    const sql = readMigration('038_loop_case_suspensions.sql');
    assert.match(
      sql,
      /alter\s+table\s+bookkeeping_case_suspensions\s+enable\s+row\s+level\s+security/i,
      'ENABLEs RLS'
    );
    assert.match(sql, /rolname\s*=\s*'anon'/i, 'guards on the anon role existing');
    assert.match(sql, /rolname\s*=\s*'authenticated'/i, 'guards on the authenticated role existing');
    assert.doesNotMatch(sql, /force\s+row\s+level\s+security/i, 'must not FORCE (owner server role stays exempt)');
  });

  await test('039 cascades reconciliation_evaluations with the client (purge orphans + on-delete-cascade FK)', () => {
    const sql = readMigration('039_reconciliation_evaluations_client_cascade.sql');
    assert.match(
      sql,
      /delete\s+from\s+reconciliation_evaluations[\s\S]*not\s+exists\s*\(\s*select\s+1\s+from\s+clients/i,
      'purges orphan evaluations whose client no longer exists (FK precondition + Honeybee repair)'
    );
    assert.match(
      sql,
      /drop\s+constraint\s+if\s+exists\s+reconciliation_evaluations_client_id_fkey/i,
      'drops-if-exists first (idempotent re-run)'
    );
    assert.match(
      sql,
      /add\s+constraint\s+reconciliation_evaluations_client_id_fkey[\s\S]*references\s+clients\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i,
      'adds the on-delete-cascade FK so a client delete removes its evaluations'
    );
  });

  await test('041 reconciliation_authorization_requests: status vocabulary + required positive amount', () => {
    const sql = readMigration('041_reconciliation_authorization_requests.sql');
    assert.match(
      sql,
      /status\s+text\s+not\s+null\s+default\s+'open'\s*\n?\s*check\s*\(\s*status\s+in\s*\(\s*'open',\s*'confirmed',\s*'granted',\s*'declined',\s*'superseded'\s*\)\s*\)/i,
      'the five-state lifecycle is a CHECK constraint, default open'
    );
    assert.match(sql, /match_amount\s+numeric\s+not\s+null\s+check\s*\(\s*match_amount\s*>\s*0\s*\)/i, 'required positive match amount');
    assert.match(sql, /requirement_key\s+text\s+not\s+null\s+default\s+'material_match_authority'/i, 'requirement_key discriminator defaulted');
  });

  await test('041 dies with its client AND its match (FK cascades)', () => {
    const sql = readMigration('041_reconciliation_authorization_requests.sql');
    assert.match(sql, /client_id\s+text\s+not\s+null\s+references\s+clients\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i, 'client_id FK cascade');
    assert.match(sql, /match_id\s+text\s+not\s+null\s+references\s+reconciliation_matches\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i, 'match_id FK cascade');
  });

  await test('041 is RLS-native (mirror 037/038/040): ENABLE + guarded revoke, never FORCE', () => {
    const sql = readMigration('041_reconciliation_authorization_requests.sql');
    assert.match(sql, /alter\s+table\s+reconciliation_authorization_requests\s+enable\s+row\s+level\s+security/i, 'enables RLS');
    assert.match(sql, /rolname\s*=\s*'anon'/i, 'guards on the anon role existing');
    assert.match(sql, /rolname\s*=\s*'authenticated'/i, 'guards on the authenticated role existing');
    assert.doesNotMatch(sql, /force\s+row\s+level\s+security/i, 'must not FORCE (owner server role stays exempt)');
  });

  await test('042 creates client_capability_config — client-scoped, FK-cascades to firms + clients', () => {
    const sql = readMigration('042_client_capability_config.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+client_capability_config\b/i, 'creates the table');
    for (const col of ['flag_key', 'stage', 'source', 'reason', 'set_by_actor_type', 'valid_from', 'valid_to']) {
      assert.match(sql, new RegExp(`\\b${col}\\b`, 'i'), `carries ${col}`);
    }
    assert.match(
      sql,
      /firm_id\s+text\s+not\s+null\s+references\s+firms\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i,
      'firm_id FK cascade'
    );
    // client_id is nullable (firm-wide default rows) but still cascades when set — a config
    // row dies with its client (the 040/041 convention), unlike firm_facts.
    assert.match(
      sql,
      /client_id\s+text\s+references\s+clients\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i,
      'client_id FK cascade (nullable)'
    );
  });

  await test('042 stage CHECK matches clientConfig CONFIG_STAGES exactly; default off', () => {
    const sql = readMigration('042_client_capability_config.sql');
    const match = sql.match(/stage\s+text\s+not\s+null\s+default\s+'off'\s*\n?\s*check\s*\(\s*stage\s+in\s*\(([^)]*)\)/i);
    assert.ok(match, "stage CHECK present with default 'off'");
    const listed = (match[1].match(/'([^']+)'/g) || []).map((s) => s.replace(/'/g, '')).sort();
    assert.deepEqual(listed, [...CONFIG_STAGES].sort(), 'stage vocabulary == CONFIG_STAGES');
  });

  await test('042 source CHECK pins the provenance vocabulary (incl. emergency_override)', () => {
    const sql = readMigration('042_client_capability_config.sql');
    assert.match(
      sql,
      /source\s+text\s+not\s+null\s+default\s+'manual'\s*\n?\s*check\s*\(\s*source\s+in\s*\(\s*'default'\s*,\s*'cohort'\s*,\s*'manual'\s*,\s*'emergency_override'\s*\)\s*\)/i,
      'source vocabulary pinned'
    );
  });

  await test('042 partial-unique on the active (firm, client, flag) row + firm-wide default', () => {
    const sql = readMigration('042_client_capability_config.sql');
    assert.match(
      sql,
      /create\s+unique\s+index\s+if\s+not\s+exists\s+client_capability_config_client_flag_uniq\s+on\s+client_capability_config\s*\(\s*firm_id\s*,\s*client_id\s*,\s*flag_key\s*\)\s*where\s+valid_to\s+is\s+null\s+and\s+client_id\s+is\s+not\s+null/i,
      'one active row per (firm, client, flag)'
    );
    assert.match(
      sql,
      /create\s+unique\s+index\s+if\s+not\s+exists\s+client_capability_config_firm_flag_uniq\s+on\s+client_capability_config\s*\(\s*firm_id\s*,\s*flag_key\s*\)\s*where\s+valid_to\s+is\s+null\s+and\s+client_id\s+is\s+null/i,
      'one active firm-wide default per flag'
    );
  });

  await test('042 is RLS-native (mirror 040/041): ENABLE + guarded revoke, never FORCE', () => {
    const sql = readMigration('042_client_capability_config.sql');
    assert.match(sql, /alter\s+table\s+client_capability_config\s+enable\s+row\s+level\s+security/i, 'enables RLS');
    assert.match(sql, /rolname\s*=\s*'anon'/i, 'guards on the anon role existing');
    assert.match(sql, /rolname\s*=\s*'authenticated'/i, 'guards on the authenticated role existing');
    assert.doesNotMatch(sql, /force\s+row\s+level\s+security/i, 'must not FORCE (owner server role stays exempt)');
  });

  await test('043 creates cohort_capability_config + client_cohort_members, FK-cascading to firms/clients', () => {
    const sql = readMigration('043_client_cohorts.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+cohort_capability_config\b/i, 'creates the cohort config table');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+client_cohort_members\b/i, 'creates the membership table');
    // cohort config is keyed by cohort_key (not client_id) and carries the same stage shape as 042
    for (const col of ['cohort_key', 'flag_key', 'stage', 'source', 'valid_from', 'valid_to']) {
      assert.match(sql, new RegExp(`\\b${col}\\b`, 'i'), `carries ${col}`);
    }
    // both tables cascade with their firm; membership cascades with its client (NOT NULL)
    assert.match(
      sql,
      /firm_id\s+text\s+not\s+null\s+references\s+firms\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i,
      'firm_id FK cascade'
    );
    assert.match(
      sql,
      /client_id\s+text\s+not\s+null\s+references\s+clients\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i,
      'membership client_id is NOT NULL + FK cascade'
    );
  });

  await test('043 cohort stage CHECK matches clientConfig CONFIG_STAGES exactly; default off', () => {
    const sql = readMigration('043_client_cohorts.sql');
    const match = sql.match(/stage\s+text\s+not\s+null\s+default\s+'off'\s*\n?\s*check\s*\(\s*stage\s+in\s*\(([^)]*)\)/i);
    assert.ok(match, "cohort stage CHECK present with default 'off'");
    const listed = (match[1].match(/'([^']+)'/g) || []).map((s) => s.replace(/'/g, '')).sort();
    assert.deepEqual(listed, [...CONFIG_STAGES].sort(), 'cohort stage vocabulary == CONFIG_STAGES');
  });

  await test("043 cohort source CHECK pins the provenance vocabulary; defaults to 'cohort'", () => {
    const sql = readMigration('043_client_cohorts.sql');
    assert.match(
      sql,
      /source\s+text\s+not\s+null\s+default\s+'cohort'\s*\n?\s*check\s*\(\s*source\s+in\s*\(\s*'default'\s*,\s*'cohort'\s*,\s*'manual'\s*,\s*'emergency_override'\s*\)\s*\)/i,
      "cohort source vocabulary pinned, default 'cohort'"
    );
  });

  await test('043 partial-uniques: one active (firm, cohort, flag) row + one active (firm, cohort, client) membership', () => {
    const sql = readMigration('043_client_cohorts.sql');
    assert.match(
      sql,
      /create\s+unique\s+index\s+if\s+not\s+exists\s+cohort_capability_config_cohort_flag_uniq\s+on\s+cohort_capability_config\s*\(\s*firm_id\s*,\s*cohort_key\s*,\s*flag_key\s*\)\s*where\s+valid_to\s+is\s+null/i,
      'one active row per (firm, cohort, flag)'
    );
    assert.match(
      sql,
      /create\s+unique\s+index\s+if\s+not\s+exists\s+client_cohort_members_active_uniq\s+on\s+client_cohort_members\s*\(\s*firm_id\s*,\s*cohort_key\s*,\s*client_id\s*\)\s*where\s+valid_to\s+is\s+null/i,
      'one active membership per (firm, cohort, client)'
    );
  });

  await test('043 is RLS-native (mirror 040/041/042): ENABLE + guarded revoke on both tables, never FORCE', () => {
    const sql = readMigration('043_client_cohorts.sql');
    assert.match(sql, /alter\s+table\s+cohort_capability_config\s+enable\s+row\s+level\s+security/i, 'enables RLS on cohort config');
    assert.match(sql, /alter\s+table\s+client_cohort_members\s+enable\s+row\s+level\s+security/i, 'enables RLS on membership');
    assert.match(sql, /rolname\s*=\s*'anon'/i, 'guards on the anon role existing');
    assert.match(sql, /rolname\s*=\s*'authenticated'/i, 'guards on the authenticated role existing');
    assert.doesNotMatch(sql, /force\s+row\s+level\s+security/i, 'must not FORCE (owner server role stays exempt)');
  });

  await test('044 creates config_snapshots (content-addressed, FK-cascading) + adds llm_decisions.config_snapshot_id', () => {
    const sql = readMigration('044_config_snapshots.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+config_snapshots\b/i, 'creates config_snapshots');
    assert.match(sql, /id\s+text\s+primary\s+key/i, 'content-addressed text PK');
    assert.match(sql, /snapshot\s+jsonb\s+not\s+null/i, 'stores the resolved stage map');
    assert.match(sql, /firm_id\s+text\s+references\s+firms\(id\)\s+on\s+delete\s+cascade/i, 'firm FK cascade');
    assert.match(sql, /client_id\s+text\s+references\s+clients\(id\)\s+on\s+delete\s+cascade/i, 'client FK cascade');
    assert.match(sql, /alter\s+table\s+llm_decisions\s+add\s+column\s+if\s+not\s+exists\s+config_snapshot_id\s+text/i, 'adds the receipt link, nullable');
  });

  await test('044 is RLS-native (mirror 042/043): ENABLE + guarded revoke, never FORCE', () => {
    const sql = readMigration('044_config_snapshots.sql');
    assert.match(sql, /alter\s+table\s+config_snapshots\s+enable\s+row\s+level\s+security/i, 'enables RLS');
    assert.match(sql, /rolname\s*=\s*'anon'/i, 'guards on the anon role existing');
    assert.match(sql, /rolname\s*=\s*'authenticated'/i, 'guards on the authenticated role existing');
    assert.doesNotMatch(sql, /force\s+row\s+level\s+security/i, 'must not FORCE (owner server role stays exempt)');
  });

  await test('045 adds the correction-chain columns to llm_decisions (nullable, indexed)', () => {
    const sql = readMigration('045_decision_receipt_immutability.sql');
    assert.match(sql, /alter\s+table\s+llm_decisions\s+add\s+column\s+if\s+not\s+exists\s+previous_decision_id\s+text/i, 'adds previous_decision_id, nullable text');
    assert.match(sql, /alter\s+table\s+llm_decisions\s+add\s+column\s+if\s+not\s+exists\s+correction_reason\s+text/i, 'adds correction_reason, nullable text');
    assert.match(sql, /create\s+index\s+if\s+not\s+exists\s+idx_llm_decisions_previous/i, 'indexes the chain link');
    // Fork A guard: NO corrected_by column (deferred to the actor-attribution slice).
    assert.doesNotMatch(sql, /add\s+column\s+if\s+not\s+exists\s+corrected_by/i, 'corrected_by is deferred, not added here');
  });

  await test('045 freezes prediction columns with a fail-closed allow-list trigger', () => {
    const sql = readMigration('045_decision_receipt_immutability.sql');
    assert.match(sql, /create\s+or\s+replace\s+function\s+llm_decisions_freeze_prediction/i, 'defines the freeze function');
    assert.match(sql, /before\s+update\s+on\s+llm_decisions/i, 'fires BEFORE UPDATE on the table');
    assert.match(sql, /to_jsonb\(old\)\s*-\s*allowed\)?\s*is\s+distinct\s+from\s*\(?\s*to_jsonb\(new\)\s*-\s*allowed/i, 'compares rows minus the allow-list (fail-closed)');
    // The allow-list must be EXACTLY the six annotation columns the two post-insert
    // writers (recordHumanOutcome / recordLouisVerdict) touch — nothing else.
    for (const col of ['human_outcome', 'human_outcome_at', 'reversal_metadata', 'louis_verdict', 'louis_evaluated_at', 'resolved_at']) {
      assert.match(sql, new RegExp(`'${col}'`, 'i'), `allow-list includes ${col}`);
    }
    // Prediction columns must NOT be in the allow-list array.
    assert.doesNotMatch(sql, /'(decision_type|final_state|config_snapshot_id|model_name|previous_decision_id)'/i, 'no prediction column is allow-listed');
  });

  await test('049 creates convergence_metric_snapshots (daily series, firm FK cascade, plain client_id)', () => {
    const sql = readMigration('049_convergence_metric_snapshots.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+convergence_metric_snapshots\b/i, 'creates the table');
    assert.match(sql, /id\s+text\s+primary\s+key/i, 'deterministic daily-key text PK');
    assert.match(sql, /firm_id\s+text\s+not\s+null\s+references\s+firms\(id\)\s+on\s+delete\s+cascade/i, 'firm FK cascade');
    // client_id is a PLAIN column (not a clients FK) — the 033/037/firm_facts
    // pattern, so the explicit client-delete purge is load-bearing.
    assert.match(sql, /client_id\s+text\s+not\s+null,/i, 'client_id is a plain non-FK column');
    assert.doesNotMatch(sql, /client_id\s+text[^\n]*references\s+clients/i, 'client_id must NOT FK clients (purge is load-bearing)');
    assert.match(sql, /captured_date\s+date\s+not\s+null/i, 'has the daily bucket');
    assert.match(sql, /metric\s+jsonb\s+not\s+null/i, 'stores the convergenceMetrics blob');
  });

  await test('049 is RLS-native (mirror 037/044): ENABLE + guarded revoke, never FORCE', () => {
    const sql = readMigration('049_convergence_metric_snapshots.sql');
    assert.match(sql, /alter\s+table\s+convergence_metric_snapshots\s+enable\s+row\s+level\s+security/i, 'enables RLS');
    assert.match(sql, /rolname\s*=\s*'anon'/i, 'guards on the anon role existing');
    assert.match(sql, /rolname\s*=\s*'authenticated'/i, 'guards on the authenticated role existing');
    assert.doesNotMatch(sql, /force\s+row\s+level\s+security/i, 'must not FORCE (owner server role stays exempt)');
  });

  await test('050 creates the marketing outbound spine (firm-agnostic — 047 line)', () => {
    const sql = readMigration('050_marketing_outbound.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+marketing_suppression\b/i, 'suppression table');
    assert.match(sql, /marketing_suppression_email_uniq\s+on\s+marketing_suppression\(lower\(email\)\)/i, 'suppression dedup on lower(email)');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+marketing_draft\b/i, 'draft table');
    assert.match(sql, /model\s+text\s+not\s+null/i, 'model id is NOT NULL (the receipt)');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+marketing_send_receipt\b/i, 'receipt table');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+marketing_send_authority\b/i, 'authority table');
    // Firm-agnostic: lead/outbound tables must never FK into firm/client data.
    assert.doesNotMatch(sql, /references\s+(firms|clients)\b/i, 'no FK into firms/clients (047 line)');
  });

  await test('050 draft-status CHECK matches the marketing runtime vocabulary', () => {
    const sql = readMigration('050_marketing_outbound.sql');
    const match = sql.match(/status\s+text\s+not\s+null\s+default\s+'proposed'\s*\n?\s*check\s*\(status\s+in\s*\(([^)]+)\)\)/i);
    assert.ok(match, 'marketing_draft.status carries a CHECK');
    const dbStatuses = match[1].split(',').map((s) => s.trim().replace(/'/g, ''));
    assert.deepEqual(dbStatuses, [...DRAFT_STATUSES], 'CHECK vocabulary === DRAFT_STATUSES');
  });

  await test('050 send-authority stage CHECK reuses 042\'s CONFIG_STAGES (no third vocabulary)', () => {
    const sql = readMigration('050_marketing_outbound.sql');
    const match = sql.match(/stage\s+text\s+not\s+null\s*\n?\s*check\s*\(stage\s+in\s*\(([^)]+)\)\)/i);
    assert.ok(match, 'marketing_send_authority.stage carries a CHECK');
    const dbStages = match[1].split(',').map((s) => s.trim().replace(/'/g, ''));
    assert.deepEqual(dbStages, [...CONFIG_STAGES], 'CHECK vocabulary === CONFIG_STAGES');
  });

  await test('050 is RLS-native (mirror 047): ENABLE + guarded revoke, never FORCE', () => {
    const sql = readMigration('050_marketing_outbound.sql');
    for (const table of ['marketing_suppression', 'marketing_draft', 'marketing_send_receipt', 'marketing_send_authority']) {
      assert.match(sql, new RegExp(String.raw`alter\s+table\s+${table}\s+enable\s+row\s+level\s+security`, 'i'), `enables RLS on ${table}`);
      assert.match(sql, new RegExp(String.raw`revoke\s+all\s+on\s+${table}\s+from\s+anon`, 'i'), `revokes anon on ${table}`);
    }
    assert.doesNotMatch(sql, /force\s+row\s+level\s+security/i, 'must not FORCE (owner server role stays exempt)');
  });

  await test('051 creates the prospecting lab spine (firm-agnostic; campaign ≠ source)', () => {
    const sql = readMigration('051_marketing_prospect_lab.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+marketing_source_run\b/i, 'source-run receipts table');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+marketing_prospect\b/i, 'prospect table');
    assert.match(sql, /campaigns\s+jsonb/i, 'campaign tags separate from source');
    assert.match(sql, /source\s+text\s+not\s+null/i, 'source provenance column');
    assert.match(sql, /dossier_model\s+text/i, 'dossier model id column (the receipt)');
    assert.match(sql, /reject_reasons\s+jsonb/i, 'reject-taxonomy column');
    assert.doesNotMatch(sql, /references\s+(firms|clients)\b/i, 'no FK into firms/clients (047 line)');
  });

  await test('051 prospect status/tier CHECKs match the lab runtime vocabularies', () => {
    const sql = readMigration('051_marketing_prospect_lab.sql');
    const statusMatch = sql.match(/status\s+text\s+not\s+null\s+default\s+'candidate'\s*\n?\s*check\s*\(status\s+in\s*\(([^)]+)\)\)/i);
    assert.ok(statusMatch, 'marketing_prospect.status carries a CHECK');
    const dbStatuses = statusMatch[1].split(',').map((s) => s.trim().replace(/'/g, ''));
    assert.deepEqual(dbStatuses, [...PROSPECT_STATUSES], 'status CHECK === PROSPECT_STATUSES (incl. research_only)');
    const tierMatch = sql.match(/tier\s+text\s+not\s+null\s+default\s+'green'\s*\n?\s*check\s*\(tier\s+in\s*\(([^)]+)\)\)/i);
    assert.ok(tierMatch, 'marketing_prospect.tier carries a CHECK');
    const dbTiers = tierMatch[1].split(',').map((s) => s.trim().replace(/'/g, ''));
    assert.deepEqual(dbTiers, [...PROSPECT_TIERS], 'tier CHECK === PROSPECT_TIERS');
  });

  await test('051 is RLS-native (mirror 047/050): ENABLE + guarded revoke, never FORCE', () => {
    const sql = readMigration('051_marketing_prospect_lab.sql');
    for (const table of ['marketing_source_run', 'marketing_prospect']) {
      assert.match(sql, new RegExp(String.raw`alter\s+table\s+${table}\s+enable\s+row\s+level\s+security`, 'i'), `enables RLS on ${table}`);
      assert.match(sql, new RegExp(String.raw`revoke\s+all\s+on\s+${table}\s+from\s+anon`, 'i'), `revokes anon on ${table}`);
    }
    assert.doesNotMatch(sql, /force\s+row\s+level\s+security/i, 'must not FORCE');
  });

  await test('052 adds the manual-upload signal-hypothesis column, idempotently', () => {
    const sql = readMigration('052_marketing_prospect_source_note.sql');
    assert.match(sql, /alter\s+table\s+marketing_prospect\s*\n?\s*add\s+column\s+if\s+not\s+exists\s+source_note\s+text/i, 'source_note column, add-if-not-exists');
  });

  await test('096 creates marketing_inbound_message (M3) — CHECKs match the runtime vocabularies', () => {
    const sql = readMigration('096_marketing_inbound.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+marketing_inbound_message\b/i, 'inbound message table');
    const eventMatch = sql.match(/check\s*\(event_type\s+in\s*\(([^)]+)\)\)/i);
    assert.ok(eventMatch, 'event_type carries a CHECK');
    const dbEvents = eventMatch[1].split(',').map((s) => s.trim().replace(/'/g, ''));
    assert.deepEqual(dbEvents, [...HANDLED_INBOUND_EVENTS], 'event_type CHECK === HANDLED_INBOUND_EVENTS');
    const classMatch = sql.match(/check\s*\(classification\s+in\s*\(([\s\S]+?)\)\)/i);
    assert.ok(classMatch, 'classification carries a CHECK');
    const dbClasses = classMatch[1].split(',').map((s) => s.trim().replace(/'/g, ''));
    assert.deepEqual(dbClasses, [...INBOUND_CLASSIFICATIONS], 'classification CHECK === INBOUND_CLASSIFICATIONS');
    assert.match(sql, /handled_actions\s+jsonb\s+not\s+null\s+default/i, 'handled-actions receipt column');
    assert.match(
      sql,
      /create\s+unique\s+index\s+if\s+not\s+exists\s+marketing_inbound_dedupe_uniq[\s\S]+?where\s+provider_email_id\s+is\s+not\s+null/i,
      'partial unique dedupe index (Svix redelivery absorber)'
    );
    assert.doesNotMatch(sql, /references\s+(firms|clients)\b/i, 'no FK into firms/clients (047 line)');
  });

  await test('096 is RLS-native (mirror 050/051): ENABLE + guarded revoke, never FORCE', () => {
    const sql = readMigration('096_marketing_inbound.sql');
    assert.match(sql, /alter\s+table\s+marketing_inbound_message\s+enable\s+row\s+level\s+security/i, 'enables RLS');
    assert.match(sql, /revoke\s+all\s+on\s+marketing_inbound_message\s+from\s+anon/i, 'revokes anon');
    assert.doesNotMatch(sql, /force\s+row\s+level\s+security/i, 'must not FORCE');
  });

  await test('165 creates the site-chat tables (Donna on books.example) — CHECKs match the runtime, firm-agnostic, RLS-native', () => {
    const sql = readMigration('165_marketing_site_chat.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+marketing_site_chat_conversation\b/i, 'conversation table');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+marketing_site_chat_message\b/i, 'message table');
    const langMatch = sql.match(/check\s*\(lang\s+in\s*\(([^)]+)\)\)/i);
    assert.ok(langMatch, 'lang carries a CHECK');
    assert.deepEqual(langMatch[1].split(',').map((s) => s.trim().replace(/'/g, '')), [...SITE_CHAT_LANGS], 'lang CHECK === SITE_CHAT_LANGS');
    const roleMatch = sql.match(/check\s*\(role\s+in\s*\(([^)]+)\)\)/i);
    assert.ok(roleMatch, 'role carries a CHECK');
    assert.deepEqual(roleMatch[1].split(',').map((s) => s.trim().replace(/'/g, '')), [...SITE_CHAT_ROLES], 'role CHECK === SITE_CHAT_ROLES');
    assert.match(sql, /\bmodel\s+text\b/i, 'the model id is part of the receipt');
    assert.doesNotMatch(sql, /references\s+(firms|clients)\b/i, 'no FK into firms/clients (047 line)');
    for (const table of ['marketing_site_chat_conversation', 'marketing_site_chat_message']) {
      assert.match(sql, new RegExp(`alter\\s+table\\s+${table}\\s+enable\\s+row\\s+level\\s+security`, 'i'), `${table} enables RLS`);
      assert.match(sql, new RegExp(`revoke\\s+all\\s+on\\s+${table}\\s+from\\s+anon`, 'i'), `${table} revokes anon`);
    }
    assert.doesNotMatch(sql, /force\s+row\s+level\s+security/i, 'must not FORCE');
  });

  await test('097 creates marketing_reply_triage (M4) — CHECKs match the runtime vocabularies', () => {
    const sql = readMigration('097_marketing_reply_triage.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+marketing_reply_triage\b/i, 'triage verdict table');
    const classMatch = sql.match(/check\s*\(semantic_class\s+in\s*\(([\s\S]+?)\)\)/i);
    assert.ok(classMatch, 'semantic_class carries a CHECK');
    const dbClasses = classMatch[1].split(',').map((s) => s.trim().replace(/'/g, ''));
    assert.deepEqual(dbClasses, [...SEMANTIC_CLASSES], 'semantic_class CHECK === SEMANTIC_CLASSES');
    const actionMatch = sql.match(/check\s*\(recommended_action\s+in\s*\(([\s\S]+?)\)\)/i);
    assert.ok(actionMatch, 'recommended_action carries a CHECK');
    const dbActions = actionMatch[1].split(',').map((s) => s.trim().replace(/'/g, ''));
    assert.deepEqual(dbActions, [...RECOMMENDED_TRIAGE_ACTIONS], 'recommended_action CHECK === RECOMMENDED_TRIAGE_ACTIONS');
    const confidenceMatch = sql.match(/check\s*\(confidence\s+in\s*\(([^)]+)\)\)/i);
    assert.ok(confidenceMatch, 'confidence carries a CHECK');
    const dbConfidences = confidenceMatch[1].split(',').map((s) => s.trim().replace(/'/g, ''));
    assert.deepEqual(dbConfidences, [...TRIAGE_CONFIDENCES], 'confidence CHECK === TRIAGE_CONFIDENCES');
    assert.match(sql, /model\s+text\s+not\s+null/i, 'the model id is part of the receipt — NOT NULL');
    assert.match(sql, /applied_actions\s+jsonb\s+not\s+null\s+default/i, 'applied-actions receipt column');
    assert.match(sql, /inbound_message_id\s+text\s+not\s+null\s+references\s+marketing_inbound_message\s*\(\s*id\s*\)/i, 'verdict FKs its message');
    assert.match(
      sql,
      /alter\s+table\s+marketing_draft\s*\n?\s*add\s+column\s+if\s+not\s+exists\s+inbound_message_id\s+text\s+references\s+marketing_inbound_message\s*\(\s*id\s*\)/i,
      'reply drafts link their inbound message, add-if-not-exists'
    );
    assert.match(
      sql,
      /alter\s+table\s+marketing_draft\s*\n?\s*add\s+column\s+if\s+not\s+exists\s+prospect_id\s+text\s+references\s+marketing_prospect\s*\(\s*id\s*\)/i,
      'reply drafts link their prospect, add-if-not-exists'
    );
    assert.doesNotMatch(sql, /references\s+(firms|clients)\b/i, 'no FK into firms/clients (047 line)');
  });

  await test('097 is RLS-native (mirror 050/051/096): ENABLE + guarded revoke, never FORCE', () => {
    const sql = readMigration('097_marketing_reply_triage.sql');
    assert.match(sql, /alter\s+table\s+marketing_reply_triage\s+enable\s+row\s+level\s+security/i, 'enables RLS');
    assert.match(sql, /revoke\s+all\s+on\s+marketing_reply_triage\s+from\s+anon/i, 'revokes anon');
    assert.doesNotMatch(sql, /force\s+row\s+level\s+security/i, 'must not FORCE');
  });

  await test('099 creates marketing_social_post (buzz B1) — CHECKs match the runtime vocabularies', () => {
    const sql = readMigration('099_marketing_social_post.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+marketing_social_post\b/i, 'social post table');
    const kindMatch = sql.match(/check\s*\(kind\s+in\s*\(([\s\S]+?)\)\)/i);
    assert.ok(kindMatch, 'kind carries a CHECK');
    const dbKinds = kindMatch[1].split(',').map((s) => s.trim().replace(/'/g, ''));
    assert.deepEqual(dbKinds, [...SOCIAL_POST_KINDS], 'kind CHECK === SOCIAL_POST_KINDS');
    const statusMatch = sql.match(/check\s*\(status\s+in\s*\(([\s\S]+?)\)\)/i);
    assert.ok(statusMatch, 'status carries a CHECK');
    const dbStatuses = statusMatch[1].split(',').map((s) => s.trim().replace(/'/g, ''));
    assert.deepEqual(dbStatuses, [...SOCIAL_POST_STATUSES], 'status CHECK === SOCIAL_POST_STATUSES');
    assert.match(sql, /model\s+text\s+not\s+null/i, 'the model id is part of the receipt — NOT NULL');
    for (const col of ['published_url', 'published_at', 'published_by', 'source_context', 'target_handle']) {
      assert.match(sql, new RegExp(`\\b${col}\\b`, 'i'), `carries ${col}`);
    }
    assert.doesNotMatch(sql, /references\s+(firms|clients)\b/i, 'no FK into firms/clients (047 line)');
  });

  await test('099 is RLS-native (mirror 050/051/096/097): ENABLE + guarded revoke, never FORCE', () => {
    const sql = readMigration('099_marketing_social_post.sql');
    assert.match(sql, /alter\s+table\s+marketing_social_post\s+enable\s+row\s+level\s+security/i, 'enables RLS');
    assert.match(sql, /revoke\s+all\s+on\s+marketing_social_post\s+from\s+anon/i, 'revokes anon');
    assert.doesNotMatch(sql, /force\s+row\s+level\s+security/i, 'must not FORCE');
  });

  await test('098 adds the structured bank-line reference columns (G12), additively and idempotently', () => {
    const sql = readMigration('098_transaction_structured_reference.sql');
    assert.match(sql, /alter\s+table\s+transactions\s+add\s+column\s+if\s+not\s+exists\s+structured_reference\s+text/i, 'structured_reference column, add-if-not-exists');
    assert.match(sql, /alter\s+table\s+transactions\s+add\s+column\s+if\s+not\s+exists\s+structured_reference_checked_at\s+timestamptz/i, 'checked_at idempotence marker, add-if-not-exists');
    assert.match(sql, /create\s+index\s+if\s+not\s+exists\s+idx_transactions_reference_capture/i, 'sweep work-queue index');
    assert.match(sql, /where\s+structured_reference_checked_at\s+is\s+null\s+and\s+money_in\s+>\s+0/i, 'work-queue index is partial: unexamined money-in lines');
    assert.match(sql, /create\s+index\s+if\s+not\s+exists\s+idx_transactions_structured_reference/i, 'reference lookup index');
    // Additive only — the migration must not drop, rewrite, or update anything.
    assert.doesNotMatch(sql, /\b(drop|update|delete)\b/i, 'strictly additive');
  });

  await test('101 adds the structured parsed-invoice reference columns (G12 invoice-side), additively and idempotently', () => {
    const sql = readMigration('101_document_structured_reference.sql');
    assert.match(sql, /alter\s+table\s+documents\s+add\s+column\s+if\s+not\s+exists\s+structured_reference\s+text/i, 'structured_reference column, add-if-not-exists');
    assert.match(sql, /alter\s+table\s+documents\s+add\s+column\s+if\s+not\s+exists\s+structured_reference_checked_at\s+timestamptz/i, 'checked_at idempotence marker, add-if-not-exists');
    assert.match(sql, /create\s+index\s+if\s+not\s+exists\s+idx_documents_reference_capture/i, 'sweep work-queue index');
    assert.match(sql, /where\s+structured_reference_checked_at\s+is\s+null\s+and\s+document_type\s+=\s+'sales_invoice'/i, 'work-queue index is partial: unexamined sales invoices');
    assert.match(sql, /create\s+index\s+if\s+not\s+exists\s+idx_documents_structured_reference/i, 'reference lookup index');
    // Additive only — the migration must not drop, rewrite, or update anything.
    assert.doesNotMatch(sql, /\b(drop|update|delete)\b/i, 'strictly additive');
  });

  await test('102 creates the owner-reply store (reply_if_wrong v2), vocabularies pinned to the runtime', () => {
    const sql = readMigration('102_outbound_owner_replies.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+outbound_owner_replies\b/i, 'creates outbound_owner_replies');
    const statusMatch = sql.match(/status\s+text\s+not\s+null\s+default\s+'stored'\s*\n?\s*check\s*\(status\s+in\s*\(([^)]+)\)\)/i);
    assert.ok(statusMatch, 'carries the status CHECK, default stored');
    assert.deepEqual(
      statusMatch[1].split(',').map((s) => s.trim().replace(/'/g, '')),
      [...REPLY_STATUSES],
      'status CHECK === REPLY_STATUSES'
    );
    const viaMatch = sql.match(/matched_via\s+text\s+not\s+null\s+check\s*\(matched_via\s+in\s*\(([^)]+)\)\)/i);
    assert.ok(viaMatch, 'carries the matched_via CHECK');
    assert.deepEqual(
      viaMatch[1].split(',').map((s) => s.trim().replace(/'/g, '')),
      ['digest_thread', 'owner_email'],
      'matched_via CHECK === the attribution provenance enum'
    );
    assert.match(sql, /references\s+clients\(id\)\s+on\s+delete\s+cascade/i, 'reply rows die with their client');
    assert.match(sql, /create\s+unique\s+index\s+if\s+not\s+exists\s+outbound_owner_replies_dedupe_idx/i, 'webhook redelivery dedupe index');
    assert.match(sql, /where\s+status\s+=\s+'stored'/i, 'work-queue index is partial: stored rows');
    assert.match(sql, /where\s+status\s+=\s+'needs_owner'\s+and\s+owner_notified_at\s+is\s+null/i, 'digest gather index is partial: un-notified needs-owner rows');
    for (const field of ['classification', 'classified_at', 'marked_action_id', 'attempts',
      'owner_notified_at', 'forwarded_to', 'in_reply_to', 'matched_via']) {
      assert.match(sql, new RegExp(String.raw`\b${field}\b`, 'i'), `outbound_owner_replies carries ${field}`);
    }
    assert.match(sql, /alter\s+table\s+outbound_owner_replies\s+enable\s+row\s+level\s+security/i, 'RLS on outbound_owner_replies');
    assert.match(sql, /revoke\s+all\s+on\s+outbound_owner_replies\s+from\s+anon/i, 'revokes anon');
    assert.doesNotMatch(sql, /force\s+row\s+level\s+security/i, 'must not FORCE');
  });

  await test('100 creates the D1 earned-auto ladder, vocabularies pinned to the runtime', () => {
    const sql = readMigration('100_outbound_earned_auto.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+outbound_earned_auto\b/i, 'creates outbound_earned_auto');
    const typeMatch = sql.match(/action_type\s+text\s+not\s+null\s*\n?\s*check\s*\(action_type\s+in\s*\(([^)]+)\)\)/i);
    assert.ok(typeMatch, 'carries the action_type CHECK');
    assert.deepEqual(
      typeMatch[1].split(',').map((s) => s.trim().replace(/'/g, '')).sort(),
      [...OUTBOUND_ACTION_TYPES].sort(),
      'action_type CHECK === the closed outbound action-type enum'
    );
    const stateMatch = sql.match(/state\s+text\s+not\s+null\s+default\s+'counting'\s*\n?\s*check\s*\(state\s+in\s*\(([^)]+)\)\)/i);
    assert.ok(stateMatch, 'carries the state CHECK, default counting');
    assert.deepEqual(
      stateMatch[1].split(',').map((s) => s.trim().replace(/'/g, '')),
      [...EARNED_AUTO_STATES],
      'state CHECK === EARNED_AUTO_STATES'
    );
    assert.match(sql, /create\s+unique\s+index\s+if\s+not\s+exists\s+outbound_earned_auto_key_idx\s+on\s+outbound_earned_auto\(firm_id,\s*client_id,\s*action_type\)/i,
      'one ladder row per (firm, client, action_type)');
    for (const field of ['clean_streak', 'total_clean', 'corrections_count', 'clean_target',
      'earned_at', 'graduated_at', 'last_clean_receipt_id', 'last_correction']) {
      assert.match(sql, new RegExp(String.raw`\b${field}\b`, 'i'), `outbound_earned_auto carries ${field}`);
    }
    assert.match(sql, /references\s+clients\(id\)\s+on\s+delete\s+cascade/i, 'ladder rows die with their client');
    // The graduation write's provenance: 100 widens the 042 source CHECK with
    // 'earned_auto' (drop-if-exists + re-add — the 053 widening pattern).
    assert.match(sql, /alter\s+table\s+client_capability_config\s*\n?\s*drop\s+constraint\s+if\s+exists\s+client_capability_config_source_check/i,
      'drops the old source CHECK idempotently');
    const sourceMatch = sql.match(/add\s+constraint\s+client_capability_config_source_check\s*\n?\s*check\s*\(source\s+in\s*\(([^)]+)\)\)/i);
    assert.ok(sourceMatch, 're-adds the source CHECK');
    assert.deepEqual(
      sourceMatch[1].split(',').map((s) => s.trim().replace(/'/g, '')),
      ['default', 'cohort', 'manual', 'emergency_override', 'earned_auto'],
      'source vocabulary = the 042 set + earned_auto, nothing else'
    );
    assert.match(sql, /alter\s+table\s+outbound_earned_auto\s+enable\s+row\s+level\s+security/i, 'RLS on outbound_earned_auto');
    assert.match(sql, /revoke\s+all\s+on\s+outbound_earned_auto\s+from\s+anon/i, 'revokes anon');
    assert.doesNotMatch(sql, /force\s+row\s+level\s+security/i, 'must not FORCE');
  });

  await test('053 widens the case_type CHECK to exactly LOOP_CASE_TYPES (incl. sync), idempotently', () => {
    const sql = readMigration('053_sync_case_type.sql');
    assert.match(sql, /drop\s+constraint\s+if\s+exists\s+bookkeeping_cases_case_type_check/i, 'drop-if-exists for re-runnability');
    const checkMatch = sql.match(/check\s*\(case_type\s+in\s*\(([^)]+)\)\)/i);
    assert.ok(checkMatch, 'carries the case_type CHECK');
    const dbTypes = checkMatch[1].split(',').map((s) => s.trim().replace(/'/g, ''));
    assert.deepEqual(dbTypes, [...LOOP_CASE_TYPES], 'case_type CHECK === LOOP_CASE_TYPES — schema and runtime can never drift');
  });

  await test('054 creates ledger_sync_authority_grants — client-scoped, FK-cascades to firms + clients', () => {
    const sql = readMigration('054_ledger_sync_authority_grants.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+ledger_sync_authority_grants\b/i, 'creates the table');
    assert.match(
      sql,
      /firm_id\s+text\s+not\s+null\s+references\s+firms\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i,
      'firm_id FK cascade'
    );
    assert.match(
      sql,
      /client_id\s+text\s+not\s+null\s+references\s+clients\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i,
      'client_id FK cascade — a grant dies with its client (039/040 convention)'
    );
    for (const col of ['expires_at', 'review_after', 'use_count', 'correction_count', 'provenance', 'model']) {
      assert.match(sql, new RegExp(`\\b${col}\\b`, 'i'), `carries ${col}`);
    }
  });

  await test('054 CHECK vocabularies match the ledgerSyncAuthorityGrants runtime exactly', () => {
    const sql = readMigration('054_ledger_sync_authority_grants.sql');
    const pinned = [
      ['accounting_system', LEDGER_SYNC_GRANT_SYSTEMS],
      ['status', LEDGER_SYNC_GRANT_STATUSES],
      ['source', LEDGER_SYNC_GRANT_SOURCES]
    ];
    for (const [column, expected] of pinned) {
      const match = sql.match(new RegExp(`check\\s*\\(\\s*${column}\\s+in\\s*\\(([^)]+)\\)\\s*\\)`, 'i'));
      assert.ok(match, `carries the ${column} CHECK`);
      const listed = match[1].split(',').map((s) => s.trim().replace(/'/g, ''));
      assert.deepEqual(listed, [...expected], `${column} CHECK === runtime vocabulary`);
    }
    assert.match(
      sql,
      /check\s*\(\s*action\s+in\s*\(\s*'export_posted_journal'\s*\)\s*\)/i,
      "action CHECK is exactly 'export_posted_journal' — widening it is a doctrine change"
    );
    assert.match(
      sql,
      /check\s*\(\s*amount_ceiling\s+is\s+null\s+or\s+amount_ceiling\s*>\s*0\s*\)/i,
      'the OPTIONAL ceiling must be positive when set'
    );
  });

  await test('054 is RLS-native (mirror 040/041/042): ENABLE + guarded revoke, never FORCE', () => {
    const sql = readMigration('054_ledger_sync_authority_grants.sql');
    assert.match(sql, /alter\s+table\s+ledger_sync_authority_grants\s+enable\s+row\s+level\s+security/i, 'enables RLS');
    assert.match(sql, /rolname\s*=\s*'anon'/i, 'guards on the anon role existing');
    assert.match(sql, /rolname\s*=\s*'authenticated'/i, 'guards on the authenticated role existing');
    assert.doesNotMatch(sql, /force\s+row\s+level\s+security/i, 'must not FORCE (owner server role stays exempt)');
  });


  await test('057 creates WhatsApp binding + message delivery ledger tables', () => {
    const sql = readMigration('057_whatsapp_owner_channel.sql');
    for (const table of ['client_whatsapp_bind_tokens', 'client_whatsapp_bindings', 'message_delivery_ledger']) {
      assert.match(sql, new RegExp(String.raw`create\s+table\s+if\s+not\s+exists\s+${table}\b`, 'i'), `creates ${table}`);
    }
    for (const field of ['message_id', 'channel', 'provider', 'ask_id', 'client_id', 'recipient_phone_hash', 'template_name', 'sent_at', 'delivered_at', 'read_at', 'failed_at', 'failure_reason', 'fallback_triggered_at', 'inbound_reply_id', 'resolved_request_id']) {
      assert.match(sql, new RegExp(String.raw`\b${field}\b`, 'i'), `delivery ledger carries ${field}`);
    }
  });

  await test('057 is RLS-native for WhatsApp owner-channel tables', () => {
    const sql = readMigration('057_whatsapp_owner_channel.sql');
    for (const table of ['client_whatsapp_bind_tokens', 'client_whatsapp_bindings', 'message_delivery_ledger']) {
      assert.match(sql, new RegExp(String.raw`alter\s+table\s+${table}\s+enable\s+row\s+level\s+security`, 'i'), `enables RLS on ${table}`);
      assert.match(sql, new RegExp(String.raw`revoke\s+all\s+on\s+${table}\s+from\s+anon`, 'i'), `revokes anon on ${table}`);
      assert.match(sql, new RegExp(String.raw`revoke\s+all\s+on\s+${table}\s+from\s+authenticated`, 'i'), `revokes authenticated on ${table}`);
    }
    assert.doesNotMatch(sql, /force\s+row\s+level\s+security/i, 'must not FORCE');
  });

  await test('058 pins WhatsApp inbound idempotency on the existing delivery ledger', () => {
    const sql = readMigration('058_whatsapp_inbound_idempotency.sql');
    assert.match(sql, /create\s+unique\s+index\s+if\s+not\s+exists\s+message_delivery_ledger_inbound_reply_id_uidx/i, 'creates the inbound reply id unique index');
    assert.match(sql, /on\s+message_delivery_ledger\s*\(\s*inbound_reply_id\s*\)/i, 'indexes inbound_reply_id on the existing ledger');
    assert.match(sql, /where\s+inbound_reply_id\s+is\s+not\s+null/i, 'keeps the nullable outbound rows valid');
  });

  await test('059 adds SMS channel discriminator to owner phone bindings', () => {
    const sql = readMigration('059_sms_owner_channel.sql');
    assert.match(sql, /alter\s+table\s+client_whatsapp_bindings\s+add\s+column\s+if\s+not\s+exists\s+channel\s+text\s+not\s+null\s+default\s+'whatsapp'/i, 'adds channel discriminator with WhatsApp default');
    assert.match(sql, /check\s*\(\s*channel\s+in\s*\(\s*'whatsapp'\s*,\s*'sms'\s*\)\s*\)/i, 'pins binding channel vocabulary');
    assert.match(sql, /unique\s*\(\s*firm_id\s*,\s*client_id\s*,\s*collaborator_id\s*,\s*phone_hash\s*,\s*channel\s*\)/i, 'unique binding identity includes channel');
    assert.match(sql, /client_whatsapp_bindings_sms_client_active_idx/i, 'adds SMS active client lookup index');
    assert.match(sql, /client_whatsapp_bindings_sms_phone_active_idx/i, 'adds SMS active phone lookup index');
  });

  await test('063 creates fiscal_years (tilikausi) with the FI-4 contract columns + constraints', () => {
    const sql = readMigration('063_finland_fiscal_years.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+fiscal_years\b/i, 'creates fiscal_years');
    for (const field of ['id', 'firm_id', 'client_id', 'label', 'starts_on', 'ends_on', 'status', 'next_tosite_no', 'closed_at', 'closed_by', 'payload']) {
      assert.match(sql, new RegExp(String.raw`\b${field}\b`, 'i'), `fiscal_years carries ${field}`);
    }
    // status CHECK pinned to the runtime vocabulary — no drift.
    for (const status of FISCAL_YEAR_STATUSES) {
      assert.match(sql, new RegExp(String.raw`'${status}'`), `status CHECK includes '${status}'`);
    }
    assert.match(sql, /check\s*\(\s*status\s+in\s*\(/i, 'status has a CHECK constraint');
    assert.match(sql, /check\s*\(\s*ends_on\s*>=\s*starts_on\s*\)/i, 'bounds CHECK ends_on >= starts_on');
    assert.match(sql, /unique\s*\(\s*firm_id\s*,\s*client_id\s*,\s*starts_on\s*\)/i, 'unique (firm, client, starts_on)');
    assert.match(sql, /unique\s*\(\s*firm_id\s*,\s*client_id\s*,\s*label\s*\)/i, 'unique (firm, client, label)');
    assert.match(sql, /references\s+firms\(id\)\s+on\s+delete\s+cascade/i, 'firm FK cascades (firm-memory-dies-with-its-client)');
    assert.match(sql, /references\s+clients\(id\)\s+on\s+delete\s+cascade/i, 'client FK cascades');
    assert.match(sql, /fiscal_years_firm_client_idx/i, 'adds the firm/client lookup index');
  });

  await test('064 adds the FI-5 tositenumero columns + gap-free partial unique index', () => {
    const sql = readMigration('064_finland_tositenumero.sql');
    // Additive, null-safe: both columns are ADD COLUMN IF NOT EXISTS on ledger_journals.
    assert.match(sql, /alter\s+table\s+ledger_journals\s+add\s+column\s+if\s+not\s+exists\s+fiscal_year_id\s+text/i, 'adds fiscal_year_id text');
    assert.match(sql, /references\s+fiscal_years\(id\)\s+on\s+delete\s+restrict/i, 'fiscal_year_id FK → fiscal_years, restrict (never orphan a numbered voucher)');
    assert.match(sql, /alter\s+table\s+ledger_journals\s+add\s+column\s+if\s+not\s+exists\s+tosite_number\s+integer/i, 'adds tosite_number integer');
    // The belt-and-braces uniqueness backstop: gap-free per (client, tilikausi),
    // partial so null (unnumbered / flag-off) journals never collide.
    assert.match(sql, /create\s+unique\s+index\s+if\s+not\s+exists\s+ledger_journals_tosite_uidx/i, 'creates the tosite unique index');
    assert.match(sql, /on\s+ledger_journals\s*\(\s*firm_id\s*,\s*client_id\s*,\s*fiscal_year_id\s*,\s*tosite_number\s*\)/i, 'unique over (firm, client, fiscal_year, tosite_number)');
    assert.match(sql, /where\s+tosite_number\s+is\s+not\s+null/i, 'partial index excludes null tosite_number');
  });

  await test('065 creates the FI-10 issued-invoice lifecycle with the closed two-terminal enum + counter', () => {
    const sql = readMigration('065_finland_issued_invoices.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+issued_invoices\b/i, 'creates issued_invoices');
    // The CLOSED lifecycle: pending (on-owner), issued / cancelled (receipted terminals).
    assert.match(sql, /check\s*\(\s*status\s+in\s*\(\s*'draft_pending_confirmation'\s*,\s*'issued'\s*,\s*'cancelled'\s*\)\s*\)/i, 'status CHECK pins the three resting states');
    for (const field of ['invoice_number', 'draft', 'ar_journal_id', 'cash_basis_skip', 'transmit_receipt', 'authority_basis', 'issued_at', 'cancelled_at']) {
      assert.match(sql, new RegExp(String.raw`\b${field}\b`, 'i'), `issued_invoices carries ${field}`);
    }
    assert.match(sql, /unique\s*\(\s*firm_id\s*,\s*client_id\s*,\s*invoice_number\s*\)/i, 'invoice number unique per client');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+issued_invoice_counters\b/i, 'creates the per-client sequence counter');
    assert.match(sql, /primary\s+key\s*\(\s*firm_id\s*,\s*client_id\s*\)/i, 'counter keyed per (firm, client)');
    assert.match(sql, /references\s+clients\(id\)\s+on\s+delete\s+cascade/i, 'client FK cascades (firm-memory-dies-with-its-client)');
  });

  await test('066 creates the FI-3 ALV return lifecycle with the closed two-terminal enum + live-period uniqueness', () => {
    const sql = readMigration('066_finland_alv_returns.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+alv_returns\b/i, 'creates alv_returns');
    // The CLOSED lifecycle: pending (on-owner), filed / cancelled (receipted terminals).
    assert.match(sql, /check\s*\(\s*status\s+in\s*\(\s*'draft_pending_confirmation'\s*,\s*'filed'\s*,\s*'cancelled'\s*\)\s*\)/i, 'status CHECK pins the three resting states');
    assert.match(sql, /check\s*\(\s*period_type\s+in\s*\(\s*'month'\s*,\s*'quarter'\s*,\s*'year'\s*\)\s*\)/i, 'period_type CHECK pins the verokausi lengths');
    for (const field of ['period_key', 'starts_on', 'ends_on', 'verdict', 'model', 'filing_receipt', 'authority_basis', 'filed_at', 'filed_by', 'cancelled_at', 'cancel_reason']) {
      assert.match(sql, new RegExp(String.raw`\b${field}\b`, 'i'), `alv_returns carries ${field}`);
    }
    // ONE live return per (firm, client, period): partial unique over pending+filed,
    // so a cancel frees the period while a live row blocks duplicates.
    assert.match(sql, /create\s+unique\s+index\s+if\s+not\s+exists\s+alv_returns_live_period_idx/i, 'creates the live-period unique index');
    assert.match(sql, /on\s+alv_returns\s*\(\s*firm_id\s*,\s*client_id\s*,\s*period_key\s*\)/i, 'unique over (firm, client, period_key)');
    assert.match(sql, /where\s+status\s+in\s*\(\s*'draft_pending_confirmation'\s*,\s*'filed'\s*\)/i, 'partial index spans the live states only');
    assert.match(sql, /references\s+clients\(id\)\s+on\s+delete\s+cascade/i, 'client FK cascades (firm-memory-dies-with-its-client)');
  });

  await test('067 creates the G-3 Suomi.fi mandate store with the closed status enum + one-active-grant uniqueness', () => {
    const sql = readMigration('067_finland_suomifi_mandates.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+suomifi_mandates\b/i, 'creates suomifi_mandates');
    // CLOSED two-state enum: active | revoked; expiry evaluates at read time.
    assert.match(sql, /check\s*\(\s*status\s+in\s*\(\s*'active'\s*,\s*'revoked'\s*\)\s*\)/i, 'status CHECK pins the two resting states');
    for (const field of ['scope', 'granted_on', 'expires_on', 'revoked_on', 'revoke_reason', 'reference', 'provenance', 'recorded_by']) {
      assert.match(sql, new RegExp(String.raw`\b${field}\b`, 'i'), `suomifi_mandates carries ${field}`);
    }
    assert.match(sql, /default\s+'veroasioiden_hoito'/i, 'scope defaults to the tax-affairs mandate theme');
    // ONE active grant per (firm, client, scope): re-recording requires an
    // explicit revoke first — the trail stays honest.
    assert.match(sql, /create\s+unique\s+index\s+if\s+not\s+exists\s+suomifi_mandates_active_scope_idx/i, 'creates the active-grant unique index');
    assert.match(sql, /on\s+suomifi_mandates\s*\(\s*firm_id\s*,\s*client_id\s*,\s*scope\s*\)/i, 'unique over (firm, client, scope)');
    assert.match(sql, /where\s+status\s*=\s*'active'/i, 'partial index spans active only');
    assert.match(sql, /references\s+clients\(id\)\s+on\s+delete\s+cascade/i, 'client FK cascades (firm-memory-dies-with-its-client)');
  });

  await test('068 creates the G-6 prepayment-register check ledger with the closed enums', () => {
    const sql = readMigration('068_finland_prepayment_register.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+prepayment_register_checks\b/i, 'creates prepayment_register_checks');
    // CLOSED enums: subject (self|supplier), what the registry SAID (freshness
    // is never a stored state), and the check source (open-data reserved).
    assert.match(sql, /check\s*\(\s*subject_type\s+in\s*\(\s*'self'\s*,\s*'supplier'\s*\)\s*\)/i, 'subject_type CHECK pins the two subjects');
    assert.match(sql, /check\s*\(\s*status\s+in\s*\(\s*'registered'\s*,\s*'not_registered'\s*,\s*'unknown'\s*\)\s*\)/i, 'status CHECK pins what the registry said');
    assert.match(sql, /check\s*\(\s*source\s+in\s*\(\s*'ytj_manual'\s*,\s*'ytj_open_data'\s*\)\s*\)/i, 'source CHECK pins manual + the reserved open-data lane');
    for (const field of ['business_id', 'counterparty_name', 'counterparty_key', 'checked_on', 'reference', 'note', 'recorded_by']) {
      assert.match(sql, new RegExp(String.raw`\b${field}\b`, 'i'), `prepayment_register_checks carries ${field}`);
    }
    assert.match(sql, /references\s+clients\(id\)\s+on\s+delete\s+cascade/i, 'client FK cascades (firm-memory-dies-with-its-client)');
  });

  await test('069 teaches issued_invoices the credit-note kind + original link (G-8, additive)', () => {
    const sql = readMigration('069_finland_credit_notes.sql');
    // The kind enum is CLOSED and existing rows default to 'invoice' untouched.
    assert.match(sql, /alter\s+table\s+issued_invoices\s+add\s+column\s+if\s+not\s+exists\s+kind\s+text\s+not\s+null\s+default\s+'invoice'/i, 'kind is additive with the invoice default');
    assert.match(sql, /check\s*\(\s*kind\s+in\s*\(\s*'invoice'\s*,\s*'credit_note'\s*\)\s*\)/i, 'kind CHECK pins the two artifact kinds');
    // The original link self-references and must not cascade a delete through
    // an issued credit note (restrict, never silent).
    assert.match(sql, /credits_invoice_id\s+text\s+references\s+issued_invoices\(id\)\s+on\s+delete\s+restrict/i, 'credits_invoice_id self-FK restricts');
    assert.match(sql, /create\s+index\s+if\s+not\s+exists\s+issued_invoices_credits_idx/i, 'credit lookups indexed');
    assert.match(sql, /where\s+credits_invoice_id\s+is\s+not\s+null/i, 'partial index spans credit notes only');
    // No payment/credited state column — payment state computes at READ time (D-G8-6).
    assert.doesNotMatch(sql, /paid|payment_state|settled/i, 'no stored derived payment state, ever');
  });

  await test('070 creates issued_quotes on its OWN numbering series (C-1, additive)', () => {
    const sql = readMigration('070_finland_quotes.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+issued_quotes\b/i, 'creates issued_quotes');
    // A quote is NOT an issued_invoices row (D-C1-1): its own counter table so
    // a tarjous can never consume a laskunumero.
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+issued_quote_counters\b/i, 'creates the separate quote counter');
    assert.match(sql, /next_quote_no\s+integer\s+not\s+null\s+default\s+1/i, 'counter seeds at 1');
    // CLOSED five-state lifecycle; expiry is data (valid_until), never a state.
    assert.match(
      sql,
      /check\s*\(\s*status\s+in\s*\(\s*'draft_pending_confirmation'\s*,\s*'sent'\s*,\s*'converted'\s*,\s*\n?\s*'declined'\s*,\s*'cancelled'\s*\)\s*\)/i,
      'status CHECK pins the closed quote lifecycle'
    );
    assert.doesNotMatch(sql, /'expired'/i, 'expired is a read-time annotation, never a stored state');
    for (const field of ['quote_number', 'valid_until', 'transmit_receipt', 'authority_basis', 'converted_invoice_id', 'decline_reason', 'cancel_reason']) {
      assert.match(sql, new RegExp(String.raw`\b${field}\b`, 'i'), `issued_quotes carries ${field}`);
    }
    // The conversion link points at the issued invoice and never cascades a
    // delete through a converted quote (restrict, never silent).
    assert.match(sql, /converted_invoice_id\s+text\s+references\s+issued_invoices\(id\)\s+on\s+delete\s+restrict/i, 'conversion FK restricts');
    assert.match(sql, /unique\s*\(\s*firm_id\s*,\s*client_id\s*,\s*quote_number\s*\)/i, 'quote numbers unique per client');
    assert.match(sql, /references\s+clients\(id\)\s+on\s+delete\s+cascade/i, 'client FK cascades (firm-memory-dies-with-its-client)');
    // A tarjous books NOTHING: no ledger/AR columns exist here (D-C1-4).
    assert.doesNotMatch(sql, /journal|tosite|viitenumero/i, 'no ledger surface on a quote');
  });

  await test('076 creates the FI-13 StatutoryBlocker store + append-only event trail (D-FI13-2)', () => {
    const sql = readMigration('076_finland_statutory_blockers.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+statutory_blockers\b/i, 'creates statutory_blockers');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+statutory_blocker_events\b/i, 'creates the append-only event trail');
    for (const field of ['id', 'firm_id', 'client_id', 'period_id', 'surface', 'reason_code', 'severity', 'assigned_to', 'status', 'due_date', 'resolution_path', 'evidence_ref', 'blocked_by_blocker_id', 'close_attempt_id', 'entity_type', 'detail', 'acknowledged_at', 'resolved_at']) {
      assert.match(sql, new RegExp(String.raw`\b${field}\b`, 'i'), `statutory_blockers carries ${field}`);
    }
    // severity / assigned_to / status CHECKs pinned to the runtime vocabulary — no drift.
    for (const sev of BLOCKER_SEVERITIES) assert.match(sql, new RegExp(String.raw`'${sev}'`), `severity CHECK includes '${sev}'`);
    for (const who of BLOCKER_ASSIGNEES) assert.match(sql, new RegExp(String.raw`'${who}'`), `assigned_to CHECK includes '${who}'`);
    for (const st of BLOCKER_STATUSES) assert.match(sql, new RegExp(String.raw`'${st}'`), `status CHECK includes '${st}'`);
    for (const ev of BLOCKER_EVENT_TYPES) assert.match(sql, new RegExp(String.raw`'${ev}'`), `event_type CHECK includes '${ev}'`);
    assert.match(sql, /check\s*\(\s*severity\s+in\s*\(/i, 'severity has a CHECK');
    assert.match(sql, /check\s*\(\s*assigned_to\s+in\s*\(/i, 'assigned_to has a CHECK');
    assert.match(sql, /check\s*\(\s*status\s+in\s*\(/i, 'status has a CHECK');
    assert.match(sql, /check\s*\(\s*event_type\s+in\s*\(/i, 'event_type has a CHECK');
    // reason_code is intentionally NOT constrained (the C7 default-blocker doctrine).
    assert.doesNotMatch(sql, /check\s*\(\s*reason_code\s+in\s*\(/i, 'reason_code is free-form (no CHECK)');
    // A blocker dies with its client (firm-memory-dies-with-its-client); the trail cascades from its blocker.
    assert.match(sql, /references\s+clients\(id\)\s+on\s+delete\s+cascade/i, 'client FK cascades');
    assert.match(sql, /references\s+statutory_blockers\(id\)\s+on\s+delete\s+cascade/i, 'event trail cascades from its blocker');
    assert.match(sql, /statutory_blockers_open_idx/i, 'adds the open-work lookup index');
    assert.match(sql, /statutory_blocker_events_blocker_idx/i, 'adds the event-trail index');
    // Guards act on entity type alone — NOT behind a capability flag (D-FI13-2).
    assert.doesNotMatch(sql, /flag_key|capability_config/i, 'no capability-flag coupling — refusing wrong output is never flag-off-able');
    // RLS-native (mirror 040 / 063).
    assert.match(sql, /alter\s+table\s+statutory_blockers\s+enable\s+row\s+level\s+security/i, 'enables RLS on statutory_blockers');
    assert.match(sql, /alter\s+table\s+statutory_blocker_events\s+enable\s+row\s+level\s+security/i, 'enables RLS on the event trail');
  });

  await test('077 backfills Finnish-flagged clients to fi-toiminimi, idempotently and fail-hard (FI-13 13.0b)', () => {
    const sql = readMigration('077_finland_entity_type_backfill.sql');
    // Sets the explicit legal form.
    assert.match(sql, /set\s+entity_type\s*=\s*'fi-toiminimi'/i, "sets entity_type = 'fi-toiminimi'");
    // Idempotent: only touches rows without an explicit legal form yet.
    assert.match(sql, /where\s+c\.entity_type\s+is\s+null/i, 'only backfills entity_type IS NULL rows (idempotent)');
    // Config-join identification: a Finnish client is one with a FINLAND_* flag row.
    assert.match(sql, /client_capability_config/i, 'identifies Finnish clients via the config plane');
    assert.match(sql, /flag_key\s+like\s+'FINLAND\\_%'\s+escape\s+'\\'/i, 'matches FINLAND_* flag keys (underscore escaped)');
    // Verified row-count receipt.
    assert.match(sql, /get\s+diagnostics\s+updated_count\s*=\s*row_count/i, 'captures the updated row count');
    assert.match(sql, /raise\s+notice/i, 'emits a receipt NOTICE with the counts');
    // Fail-hard: partial backfill / inconsistency raises and rolls the migration back.
    assert.match(sql, /raise\s+exception/i, 'a partial or inconsistent backfill RAISES (rolls back)');
    assert.match(sql, /entity_type\s+is\s+null\s+or\s+c\.entity_type\s+not\s+in\s*\(\s*'fi-toiminimi'\s*,\s*'fi-oy'\s*\)/i, 'the fail-hard check catches null AND non-Finnish legal forms on flagged clients');
    // No new schema — this is a pure data migration.
    assert.doesNotMatch(sql, /create\s+table|alter\s+table/i, 'a pure data migration — no schema change');
  });

  await test('078 creates the FI-13 ownership model — effective-dated core, RLS, dies-with-client (D-FI13-14)', () => {
    const sql = readMigration('078_finland_ownership.sql');
    for (const table of ['finland_shareholders', 'finland_share_classes', 'finland_ownership_events', 'finland_shareholdings']) {
      assert.match(sql, new RegExp(String.raw`create\s+table\s+if\s+not\s+exists\s+${table}\b`, 'i'), `creates ${table}`);
    }
    // party_type / event_type CHECKs pinned to the runtime vocabulary — no drift.
    assert.match(sql, /check\s*\(\s*party_type\s+in\s*\(/i, 'party_type has a CHECK');
    for (const pt of OWNERSHIP_PARTY_TYPES) assert.match(sql, new RegExp(String.raw`'${pt}'`), `party_type CHECK includes '${pt}'`);
    assert.match(sql, /check\s*\(\s*event_type\s+in\s*\(/i, 'event_type has a CHECK');
    for (const ev of OWNERSHIP_EVENT_TYPES) assert.match(sql, new RegExp(String.raw`'${ev}'`), `event_type CHECK includes '${ev}'`);
    // Effective-dating is load-bearing: holdings carry a validity window.
    assert.match(sql, /valid_from\s+date\s+not\s+null/i, 'shareholdings carry valid_from');
    assert.match(sql, /\bvalid_until\s+date\b/i, 'shareholdings carry a nullable valid_until');
    // The append-only event log links to holdings; holdings link shareholder + class.
    assert.match(sql, /references\s+finland_shareholders\(id\)\s+on\s+delete\s+cascade/i, 'holdings cascade from their shareholder');
    assert.match(sql, /references\s+finland_share_classes\(id\)\s+on\s+delete\s+cascade/i, 'holdings cascade from their share class');
    assert.match(sql, /references\s+finland_ownership_events\(id\)/i, 'holdings link the ownership event that opened them');
    // AML/PII posture: NO raw national identifiers baked into schema (identifier_ref is a reference).
    assert.match(sql, /identifier_ref\s+text/i, 'identity is a reference column, not a raw id');
    // No raw national-id COLUMN (AML/PII posture — counsel-gated). Targets column
    // declarations, not the header prose that documents the posture.
    assert.doesNotMatch(sql, /^\s*(hetu|ssn|social_security\w*|national_id)\s+(text|varchar|char)/im, 'no raw national-id column');
    // Everything dies with its client; RLS-native (mirror 040 / 063 / 076).
    assert.match(sql, /references\s+clients\(id\)\s+on\s+delete\s+cascade/i, 'client FK cascades');
    for (const table of ['finland_shareholders', 'finland_share_classes', 'finland_ownership_events', 'finland_shareholdings']) {
      assert.match(sql, new RegExp(String.raw`alter\s+table\s+${table}\s+enable\s+row\s+level\s+security`, 'i'), `enables RLS on ${table}`);
    }
    assert.match(sql, /finland_shareholdings_asof_idx/i, 'adds the as-of lookup index');
  });

  await test('079 creates the FI-13 authority role model — grant-pattern, effective-dated, RLS, dies-with-client (D-FI13-11)', () => {
    const sql = readMigration('079_finland_authority_roles.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+finland_authority_roles\b/i, 'creates finland_authority_roles');
    // role / authority_basis CHECKs pinned to the runtime vocabulary — no drift.
    assert.match(sql, /check\s*\(\s*role\s+in\s*\(/i, 'role has a CHECK');
    for (const role of FINLAND_AUTHORITY_ROLES) assert.match(sql, new RegExp(String.raw`'${role}'`), `role CHECK includes '${role}'`);
    assert.match(sql, /check\s*\(\s*authority_basis\s+in\s*\(/i, 'authority_basis has a CHECK');
    for (const basis of FINLAND_AUTHORITY_BASES) assert.match(sql, new RegExp(String.raw`'${basis}'`), `authority_basis CHECK includes '${basis}'`);
    // The D-FI13-11 shape: {authority_basis, verified_at, verified_from, valid_from/until, scope}.
    assert.match(sql, /verified_at\s+timestamptz/i, 'carries verified_at');
    assert.match(sql, /verified_from\s+text/i, 'carries verified_from');
    assert.match(sql, /scope\s+jsonb\s+not\s+null/i, 'carries a scope');
    assert.match(sql, /valid_from\s+date\s+not\s+null/i, 'effective-dated: valid_from');
    assert.match(sql, /\bvalid_until\s+date\b/i, 'effective-dated: nullable valid_until');
    // Governance mirror of the 040 grant statuses: revoked is a recorded "no".
    assert.match(sql, /check\s*\(\s*status\s+in\s*\(\s*'active'\s*,\s*'revoked'\s*\)\s*\)/i, 'status is active|revoked');
    assert.match(sql, /revoked_reason\s+text/i, 'a revocation carries its reason');
    // The optional ownership link must NOT cascade — authority outlives a
    // shareholder-row correction.
    assert.match(sql, /references\s+finland_shareholders\(id\)\s+on\s+delete\s+set\s+null/i, 'shareholder link is SET NULL, not cascade');
    // AML/PII posture: holder identity is a reference column, no raw national id.
    assert.match(sql, /holder_ref\s+text/i, 'holder identity is a reference column');
    assert.doesNotMatch(sql, /^\s*(hetu|ssn|social_security\w*|national_id)\s+(text|varchar|char)/im, 'no raw national-id column');
    // Everything dies with its client; RLS-native (mirror 040 / 063 / 076 / 078).
    assert.match(sql, /references\s+clients\(id\)\s+on\s+delete\s+cascade/i, 'client FK cascades');
    assert.match(sql, /alter\s+table\s+finland_authority_roles\s+enable\s+row\s+level\s+security/i, 'enables RLS');
    assert.match(sql, /finland_authority_roles_asof_idx/i, 'adds the as-of lookup index');
  });

  await test('080 creates the I4·posting persistence — append-only attempts, heads view, journals, allocations, allowance register (D-POST-8/13/14)', () => {
    const sql = readMigration('080_inventory_posting.sql');
    for (const table of [
      'inventory_posting_attempts',
      'inventory_posting_journals',
      'inventory_journal_allocations',
      'inventory_valuation_allowances'
    ]) {
      assert.match(sql, new RegExp(String.raw`create\s+table\s+if\s+not\s+exists\s+${table}\b`, 'i'), `creates ${table}`);
    }
    // The heads projection is a VIEW (rebuildable, never a stored source of truth).
    assert.match(sql, /create\s+or\s+replace\s+view\s+inventory_posting_heads\b/i, 'inventory_posting_heads is a view');
    assert.match(sql, /distinct\s+on\s*\(\s*firm_id\s*,\s*client_id\s*,\s*operation_id\s*,\s*posting_kind\s*\)/i, 'head = latest per operation+kind');

    // CHECK vocabularies pinned to the runtime taxonomy — no drift. posting_kind is defined
    // across 080 (the base CHECK), 081 (recreates it with 'allowance_release'), and 082
    // (recreates it with 'grni_retranslation'), so the pin checks the UNION of all three
    // migration files against the runtime list.
    assert.match(sql, /check\s*\(\s*posting_kind\s+in\s*\(/i, 'posting_kind has a CHECK');
    const postingKindSql = sql
      + '\n' + readMigration('081_inventory_allowance_consumption.sql')
      + '\n' + readMigration('082_inventory_grni_retranslation.sql');
    for (const k of INVENTORY_POSTING_KINDS) assert.match(postingKindSql, new RegExp(String.raw`'${k}'`), `posting_kind CHECK (080∪081∪082) includes '${k}'`);
    assert.match(sql, /check\s*\(\s*outcome\s+in\s*\(/i, 'outcome has a CHECK');
    for (const o of INVENTORY_POSTING_OUTCOMES) assert.match(sql, new RegExp(String.raw`'${o}'`), `outcome CHECK includes '${o}'`);
    assert.match(sql, /check\s*\(\s*waiter_type\s+in\s*\(/i, 'waiter_type has a CHECK');
    for (const w of INVENTORY_POSTING_WAITER_TYPES) assert.match(sql, new RegExp(String.raw`'${w}'`), `waiter_type CHECK includes '${w}'`);
    assert.match(sql, /check\s*\(\s*relationship\s+in\s*\(/i, 'relationship has a CHECK');
    for (const r of INVENTORY_JOURNAL_RELATIONSHIPS) assert.match(sql, new RegExp(String.raw`'${r}'`), `relationship CHECK includes '${r}'`);
    assert.match(sql, /check\s*\(\s*status\s+in\s*\(/i, 'allowance status has a CHECK');
    for (const s of INVENTORY_ALLOWANCE_STATUSES) assert.match(sql, new RegExp(String.raw`'${s}'`), `allowance status CHECK includes '${s}'`);

    // The partial-unique guard: exactly one SUCCESSFUL application per (op, kind, basis).
    assert.match(
      sql,
      /create\s+unique\s+index\s+if\s+not\s+exists\s+inventory_posting_attempts_success_idx[\s\S]*?on\s+inventory_posting_attempts\s*\(\s*operation_id\s*,\s*posting_kind\s*,\s*posting_basis_version\s*\)\s*where\s+outcome\s+in\s*\(/i,
      'partial-unique index over the successful outcomes only'
    );
    for (const o of SUCCESSFUL_POSTING_OUTCOMES) {
      assert.match(
        sql,
        new RegExp(String.raw`where\s+outcome\s+in\s*\([^)]*'${o}'`, 'i'),
        `success index predicate includes '${o}'`
      );
    }

    // Append-only posture: attempts carry a supersede link and NO updated_at (the register
    // does carry updated_at — it is mutable current-state, not the log).
    assert.match(sql, /supersedes_attempt_id\s+bigint\s+references\s+inventory_posting_attempts\(id\)/i, 'attempts self-reference the superseded row');
    // Isolate the attempts CREATE TABLE block and assert it carries no updated_at (the
    // allowance register legitimately has one — it is mutable current-state, not the log).
    const attemptsBlock = (sql.match(/create\s+table\s+if\s+not\s+exists\s+inventory_posting_attempts\s*\(([\s\S]*?)\n\);/i) || [])[1] || '';
    assert.ok(attemptsBlock.length > 0, 'found the attempts table block');
    assert.doesNotMatch(attemptsBlock, /\bupdated_at\b/i, 'attempts log has no updated_at (append-only)');

    // Links + FK integrity: journals link ledger_journals; allocations carry amount+run.
    assert.match(sql, /ledger_journal_id\s+text\s+not\s+null\s+references\s+ledger_journals\(id\)/i, 'journal link FKs ledger_journals');
    assert.match(sql, /allocated_amount\s+numeric/i, 'allocations carry an allocated amount');
    assert.match(sql, /valuation_run_id\s+text\s+not\s+null/i, 'allocations carry the pricing valuation_run_id');

    // Allowance register invariants: consumed ≤ allowance, cap ≤ allowance, scoped not-pool.
    assert.match(sql, /check\s*\(\s*consumed_amount\s*>=\s*0\s+and\s+consumed_amount\s*<=\s*allowance_amount\s*\)/i, 'consumed within allowance');
    assert.match(sql, /check\s*\(\s*max_reversible_amount\s*>=\s*0\s+and\s+max_reversible_amount\s*<=\s*allowance_amount\s*\)/i, 'reversal cap within allowance');
    assert.match(sql, /check\s*\(\s*scope_item_id\s+is\s+not\s+null\s+or\s+scope_group\s+is\s+not\s+null\s*\)/i, 'allowance is item- or group-scoped');

    // Everything dies with its client (mirror the inventory substrate).
    assert.match(sql, /references\s+clients\(id\)\s+on\s+delete\s+cascade/i, 'client FK cascades');
  });

  await test('081 adds allowance derecognition-consumption — bound quantity + the allowance_release kind (§5-F/P6b)', () => {
    const sql = readMigration('081_inventory_allowance_consumption.sql');
    // The bound-quantity columns the proportional consumption reads.
    assert.match(sql, /add\s+column\s+if\s+not\s+exists\s+bound_quantity\s+numeric/i, 'adds bound_quantity');
    assert.match(sql, /add\s+column\s+if\s+not\s+exists\s+remaining_quantity\s+numeric/i, 'adds remaining_quantity');
    // remaining_quantity stays within [0, bound_quantity].
    assert.match(sql, /remaining_quantity\s*>=\s*0/i, 'remaining_quantity non-negative');
    assert.match(sql, /remaining_quantity\s*<=\s*bound_quantity/i, 'remaining_quantity ≤ bound_quantity');
    // The posting_kind CHECK is recreated with the release kind, and 'allowance_release' is in it.
    assert.match(sql, /drop\s+constraint\s+if\s+exists\s+inventory_posting_attempts_posting_kind_check/i, 'drops the old posting_kind CHECK');
    assert.match(sql, /add\s+constraint\s+inventory_posting_attempts_posting_kind_check[\s\S]*check\s*\(\s*posting_kind\s+in\s*\(/i, 'recreates the posting_kind CHECK');
    assert.match(sql, /'allowance_release'/i, "adds the 'allowance_release' kind");
    // It IS in the runtime taxonomy (the pin the 080 test now checks across 080∪081∪082).
    assert.ok(INVENTORY_POSTING_KINDS.includes('allowance_release'), 'runtime INVENTORY_POSTING_KINDS carries allowance_release');
  });

  await test('082 adds the grni_retranslation posting_kind (§10 FX retranslation of open GRNI/P6c)', () => {
    const sql = readMigration('082_inventory_grni_retranslation.sql');
    // The posting_kind CHECK is recreated with the retranslation kind added, and it carries the
    // full prior vocabulary (it supersedes 081's recreation, so every earlier kind must be present).
    assert.match(sql, /drop\s+constraint\s+if\s+exists\s+inventory_posting_attempts_posting_kind_check/i, 'drops the old posting_kind CHECK');
    assert.match(sql, /add\s+constraint\s+inventory_posting_attempts_posting_kind_check[\s\S]*check\s*\(\s*posting_kind\s+in\s*\(/i, 'recreates the posting_kind CHECK');
    assert.match(sql, /'grni_retranslation'/i, "adds the 'grni_retranslation' kind");
    assert.match(sql, /'allowance_release'/i, 'carries the 081 kind forward (supersedes its CHECK)');
    // It IS in the runtime taxonomy (the pin the 080 test checks across 080∪081∪082).
    assert.ok(INVENTORY_POSTING_KINDS.includes('grni_retranslation'), 'runtime INVENTORY_POSTING_KINDS carries grni_retranslation');
  });

  await test('083 adds the inventory posting-authority grants table with §13 aggregate ceilings (P7)', () => {
    const sql = readMigration('083_inventory_posting_authority_grants.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+inventory_posting_authority_grants\b/i, 'creates the grants table');
    // The §13 hardening: per-journal cap REQUIRED (> 0), daily + period aggregate ceilings present.
    assert.match(sql, /per_journal_ceiling\s+numeric[^\n]*not\s+null\s+check\s*\(\s*per_journal_ceiling\s*>\s*0\s*\)/i, 'per-journal ceiling required and positive');
    assert.match(sql, /daily_aggregate_ceiling\s+numeric/i, 'carries a daily aggregate ceiling');
    assert.match(sql, /period_aggregate_ceiling\s+numeric/i, 'carries a period aggregate ceiling');
    // Allow-lists (fail-closed) + the extra gates.
    assert.match(sql, /allowed_posting_kinds\s+text\[\]/i, 'allowed_posting_kinds allow-list');
    assert.match(sql, /allowed_accounts\s+text\[\]/i, 'allowed_accounts allow-list');
    assert.match(sql, /confidence_floor\s+numeric/i, 'confidence floor');
    assert.match(sql, /evidence_required\s+boolean/i, 'evidence requirement');
    // Lifecycle + governance (mirror 040): status enum, source enum, dies-with-client, RLS.
    assert.match(sql, /check\s*\(\s*status\s+in\s*\(\s*'proposed'\s*,\s*'active'\s*,\s*'suspended'\s*,\s*'revoked'\s*\)\s*\)/i, 'grant status vocabulary');
    assert.match(sql, /check\s*\(\s*source\s+in\s*\(\s*'operator_one_click'\s*,\s*'accountant_approval'\s*,\s*'learned_from_pattern'\s*\)\s*\)/i, 'source vocabulary');
    assert.match(sql, /references\s+clients\(id\)\s+on\s+delete\s+cascade/i, 'a grant dies with its client');
    assert.match(sql, /enable\s+row\s+level\s+security/i, 'RLS-native governance table');
  });

  await test('084 adds the inventory posting-incidents record — the durable D-POST-14 escalation home (P7 §12)', () => {
    const sql = readMigration('084_inventory_posting_incidents.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+inventory_posting_incidents\b/i, 'creates the incidents table');
    // CHECK vocabularies pinned to the runtime taxonomy (postingIncidents.js) — no drift.
    assert.match(sql, /check\s*\(\s*incident_kind\s+in\s*\(/i, 'incident_kind has a CHECK');
    for (const k of INVENTORY_INCIDENT_KINDS) assert.match(sql, new RegExp(String.raw`'${k}'`), `incident_kind CHECK includes '${k}'`);
    assert.match(sql, /check\s*\(\s*status\s+in\s*\(/i, 'status has a CHECK');
    for (const s of INVENTORY_INCIDENT_STATUSES) assert.match(sql, new RegExp(String.raw`'${s}'`), `status CHECK includes '${s}'`);
    // The owning path is REQUIRED (an incident must be owned — never a dead end), and resolved
    // must carry its resolver + timestamp (nothing silently disappears).
    assert.match(sql, /target_queue\s+text\s+not\s+null/i, 'target_queue required');
    assert.match(sql, /opened_by_actor_id\s+text\s+not\s+null/i, 'opening actor required');
    assert.match(
      sql,
      /check\s*\(\s*status\s*<>\s*'resolved'\s+or\s+\(\s*resolved_by_actor_id\s+is\s+not\s+null\s+and\s+resolved_at\s+is\s+not\s+null\s*\)\s*\)/i,
      'resolved carries actor + timestamp'
    );
    // The idempotent natural key: ONE unresolved incident per (operation, kind, incident_kind,
    // reason) — partial over the unresolved statuses so a resolved incident frees the key.
    assert.match(
      sql,
      /create\s+unique\s+index\s+if\s+not\s+exists\s+inventory_posting_incidents_natural_idx[\s\S]*?on\s+inventory_posting_incidents\s*\(\s*firm_id\s*,\s*client_id\s*,\s*operation_id\s*,\s*posting_kind\s*,\s*incident_kind\s*,\s*coalesce\(reason_code,\s*''\)\s*\)\s*where\s+status\s+in\s*\(\s*'open'\s*,\s*'acknowledged'\s*\)/i,
      'partial-unique natural key over the unresolved statuses'
    );
    // reason_code / posting_kind / waiter_type / target_queue deliberately NOT CHECKed (default-
    // blocker doctrine; provenance CHECKs live on the attempts log).
    assert.doesNotMatch(sql, /check\s*\(\s*reason_code\s+in/i, 'reason_code stays un-CHECKed');
    assert.doesNotMatch(sql, /check\s*\(\s*posting_kind\s+in/i, 'posting_kind stays un-CHECKed here');
    // Provenance link + governance posture: traces the head attempt, dies with its client, RLS.
    assert.match(sql, /source_attempt_id\s+bigint\s+references\s+inventory_posting_attempts\(id\)\s+on\s+delete\s+set\s+null/i, 'traces the source attempt (SET NULL, not cascade)');
    assert.match(sql, /references\s+clients\(id\)\s+on\s+delete\s+cascade/i, 'an incident dies with its client');
    assert.match(sql, /alter\s+table\s+inventory_posting_incidents\s+enable\s+row\s+level\s+security/i, 'RLS-native ops table');
  });

  await test('085 creates the memories store — memory.v1 vocabularies pinned, structural invariants in the table', () => {
    const sql = readMigration('085_memories.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+memories\b/i, 'creates memories');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+memory_relations\b/i, 'creates memory_relations');
    // CHECK vocabularies pinned to memoryModel.js — no drift.
    for (const s of MEMORY_SCOPE_TYPES) assert.match(sql, new RegExp(String.raw`'${s}'`), `scope_type CHECK includes '${s}'`);
    for (const l of LIFECYCLE_OWNER_TYPES) assert.match(sql, new RegExp(String.raw`'${l}'`), `lifecycle CHECK includes '${l}'`);
    for (const k of MEMORY_V1_KINDS) assert.match(sql, new RegExp(String.raw`'${k}'`), `kind CHECK includes '${k}'`);
    for (const s of MEMORY_RECORD_STATES) assert.match(sql, new RegExp(String.raw`'${s}'`), `record_state CHECK includes '${s}'`);
    for (const s of MEMORY_EPISTEMIC_STATES) assert.match(sql, new RegExp(String.raw`'${s}'`), `epistemic_state CHECK includes '${s}'`);
    for (const r of MEMORY_RELATION_TYPES) assert.match(sql, new RegExp(String.raw`'${r}'`), `relation CHECK includes '${r}'`);
    for (const o of MEMORY_ASSERTION_ORIGINS) assert.match(sql, new RegExp(String.raw`'${o}'`), `assertion_origin CHECK includes '${o}'`);
    for (const c of CONFIDENTIALITY_CLASSES) assert.match(sql, new RegExp(String.raw`'${c}'`), `confidentiality CHECK includes '${c}'`);
    for (const p of PERSONAL_DATA_CLASSES) assert.match(sql, new RegExp(String.raw`'${p}'`), `personal_data_class CHECK includes '${p}'`);
    // The REFUSED predicate classes must not be representable as rows (the §8
    // boundary is structural, not just validator behaviour).
    assert.doesNotMatch(sql, /'prohibited_secret'/, 'prohibited_secret cannot rest in the table');
    assert.doesNotMatch(sql, /'preference_candidate'/, 'preference_candidate routes out, never rests here');
    // One active version per logical slot (§3).
    assert.match(
      sql,
      /create\s+unique\s+index\s+if\s+not\s+exists\s+memories_one_active_per_key\s+on\s+memories\s*\(\s*memory_key\s*\)\s*where\s+record_state\s*=\s*'active'/i,
      'partial unique index: one active version per memory_key'
    );
    assert.match(sql, /create\s+unique\s+index\s+if\s+not\s+exists\s+memories_key_revision_idx/i, 'unique (memory_key, revision) backstop');
    // The structural invariants.
    assert.match(sql, /constraint\s+memories_one_lifecycle_root\s+check/i, 'exactly-one-lifecycle-root CHECK');
    assert.match(sql, /constraint\s+memories_erased_is_scrubbed\s+check/i, 'erased-is-scrubbed CHECK');
    assert.match(sql, /constraint\s+memories_quarantine_confirmed\s+check/i, 'quarantine-confirmed CHECK');
    assert.match(sql, /constraint\s+memories_user_private_user_lifecycle\s+check/i, 'user_private ⇒ user lifecycle CHECK');
    // Tenant boundary cascades; lifecycle roots are PLAIN columns (explicit purge,
    // the firm_facts pattern — never a silent clients cascade).
    assert.match(sql, /tenant_id\s+text\s+not\s+null\s+references\s+firms\(id\)\s+on\s+delete\s+cascade/i, 'tenant FK cascades');
    assert.doesNotMatch(sql, /references\s+clients\(id\)/i, 'no clients FK — lifecycle death is the explicit purge');
    // The §8 amendment-18 candidate columns, target vocabulary pinned to the runtime.
    assert.match(sql, /alter\s+table\s+memory_candidates\s+add\s+column\s+if\s+not\s+exists\s+target_contract/i, 'candidates gain target_contract');
    for (const t of MEMORY_CANDIDATE_TARGET_CONTRACTS) assert.match(sql, new RegExp(String.raw`'${t}'`), `target_contract CHECK includes '${t}'`);
    assert.match(sql, /add\s+column\s+if\s+not\s+exists\s+contract_payload\s+jsonb/i, 'candidates gain contract_payload');
    assert.match(sql, /add\s+column\s+if\s+not\s+exists\s+minted_memory_id/i, 'candidates gain minted_memory_id');
    // Governance posture.
    assert.match(sql, /alter\s+table\s+memories\s+enable\s+row\s+level\s+security/i, 'RLS on memories');
    assert.match(sql, /alter\s+table\s+memory_relations\s+enable\s+row\s+level\s+security/i, 'RLS on memory_relations');
  });

  await test('086 memory_history_epochs: the §F/§N-D hard-fence table (2c-iii)', () => {
    const sql = readMigration('086_memory_history_epochs.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+memory_history_epochs/i, 'table exists');
    // The full §N-C activation tuple + the fence boundary.
    for (const col of ['tenant_id', 'client_id', 'audience', 'purpose', 'epoch_seq', 'mode_entered', 'boundary_at', 'boundary_message_id']) {
      assert.match(sql, new RegExp(String.raw`\b${col}\b`, 'i'), `column ${col}`);
    }
    // mode_entered is pinned to the runtime's fence modes (v2 / legacy).
    for (const mode of MEMORY_HISTORY_EPOCH_MODES) assert.match(sql, new RegExp(String.raw`'${mode}'`), `mode_entered CHECK includes '${mode}'`);
    // Monotonic per-tuple epoch_seq + latest-epoch lookup.
    assert.match(sql, /create\s+unique\s+index\s+if\s+not\s+exists\s+memory_history_epochs_tuple_seq_idx/i, 'unique (tuple, epoch_seq)');
    assert.match(sql, /create\s+index\s+if\s+not\s+exists\s+memory_history_epochs_active_idx/i, 'latest-epoch index');
    // Tenant cascade; NO clients FK (explicit purge, the firm_facts / memories pattern).
    assert.match(sql, /tenant_id\s+text\s+not\s+null\s+references\s+firms\(id\)\s+on\s+delete\s+cascade/i, 'tenant FK cascades');
    assert.doesNotMatch(sql, /references\s+clients\(id\)/i, 'no clients FK');
    assert.match(sql, /alter\s+table\s+memory_history_epochs\s+enable\s+row\s+level\s+security/i, 'RLS on');
  });

  await test('087 memory_replay_evidence: the §16 immutable replay-evidence store (2c-iii Slice A)', () => {
    const sql = readMigration('087_memory_replay_evidence.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+memory_replay_evidence/i, 'table exists');
    // evidence_id is the primary key → the insert-once / append-only guard.
    assert.match(sql, /evidence_id\s+text\s+primary\s+key/i, 'evidence_id is the PK (insert-once)');
    // Immutable linkage + the historically-sufficient body + self-verifying hash.
    for (const col of ['firm_id', 'client_id', 'session_id', 'source_turn_message_id', 'answer_message_id', 'as_of', 'bundle_fingerprint', 'record_hash', 'evidence']) {
      assert.match(sql, new RegExp(String.raw`\b${col}\b`, 'i'), `column ${col}`);
    }
    // Append-only: no updated_at (a correction is a new row, never an update).
    assert.doesNotMatch(sql, /\bupdated_at\b/i, 'append-only: no updated_at');
    // The producer scan + session-resolution indexes.
    assert.match(sql, /create\s+index\s+if\s+not\s+exists\s+memory_replay_evidence_scan_idx/i, 'producer scan index');
    assert.match(sql, /create\s+index\s+if\s+not\s+exists\s+memory_replay_evidence_session_idx/i, 'session-resolution index');
    // Tenant cascade; NO clients FK (explicit purge, the firm_facts / memories / 086 pattern).
    assert.match(sql, /firm_id\s+text\s+not\s+null\s+references\s+firms\(id\)\s+on\s+delete\s+cascade/i, 'tenant FK cascades');
    assert.doesNotMatch(sql, /references\s+clients\(id\)/i, 'no clients FK');
    assert.match(sql, /alter\s+table\s+memory_replay_evidence\s+enable\s+row\s+level\s+security/i, 'RLS on (restricted store)');
  });

  await test('089 Singapore core: gst_returns lifecycle + corppass_mandates, mirroring the 066/067 pair', () => {
    const sql = readMigration('089_singapore_gst_core.sql');
    // gst_returns — the CLOSED lifecycle, pinned to the SG runtime's enum.
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+gst_returns\b/i, 'creates gst_returns');
    for (const status of GST_RETURN_STATUSES) {
      assert.match(sql, new RegExp(String.raw`'${status}'`), `gst_returns status CHECK includes '${status}'`);
    }
    // Singapore has NO annual GST accounting period — the CHECK pins month|quarter only.
    assert.match(sql, /check\s*\(\s*period_type\s+in\s*\(\s*'month'\s*,\s*'quarter'\s*\)\s*\)/i, 'period_type CHECK is month|quarter (no year)');
    for (const field of ['period_key', 'starts_on', 'ends_on', 'verdict', 'model', 'filing_receipt', 'authority_basis', 'filed_at', 'filed_by', 'cancelled_at', 'cancel_reason']) {
      assert.match(sql, new RegExp(String.raw`\b${field}\b`, 'i'), `gst_returns carries ${field}`);
    }
    assert.match(sql, /create\s+unique\s+index\s+if\s+not\s+exists\s+gst_returns_live_period_idx/i, 'creates the live-period unique index');
    assert.match(sql, /on\s+gst_returns\s*\(\s*firm_id\s*,\s*client_id\s*,\s*period_key\s*\)/i, 'unique over (firm, client, period_key)');
    assert.match(sql, /where\s+status\s+in\s*\(\s*'draft_pending_confirmation'\s*,\s*'filed'\s*\)/i, 'partial index spans the live states only');
    // corppass_mandates — the two-state grant store, pinned to the SG runtime.
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+corppass_mandates\b/i, 'creates corppass_mandates');
    for (const status of CORPPASS_MANDATE_STATUSES) {
      assert.match(sql, new RegExp(String.raw`'${status}'`), `corppass_mandates status CHECK includes '${status}'`);
    }
    for (const field of ['scope', 'granted_on', 'expires_on', 'revoked_on', 'revoke_reason', 'reference', 'provenance', 'recorded_by']) {
      assert.match(sql, new RegExp(String.raw`\b${field}\b`, 'i'), `corppass_mandates carries ${field}`);
    }
    assert.match(sql, new RegExp(String.raw`default\s+'${CORPPASS_SCOPE_GST}'`, 'i'), 'scope defaults to the IRAS GST e-Service');
    assert.match(sql, /create\s+unique\s+index\s+if\s+not\s+exists\s+corppass_mandates_active_scope_idx/i, 'creates the active-grant unique index');
    assert.match(sql, /on\s+corppass_mandates\s*\(\s*firm_id\s*,\s*client_id\s*,\s*scope\s*\)/i, 'unique over (firm, client, scope)');
    assert.match(sql, /where\s+status\s*=\s*'active'/i, 'partial index spans active only');
    // Both tables cascade with the client (firm-memory-dies-with-its-client).
    const cascades = sql.match(/references\s+clients\(id\)\s+on\s+delete\s+cascade/gi) || [];
    assert.equal(cascades.length, 2, 'both tables cascade on client delete');
  });

  await test('090 outbound parties: identity + effective-dated channels/attributes + suggest-and-confirm merges', () => {
    const sql = readMigration('090_outbound_parties.sql');
    // client_parties — the identity row, CHECK pinned to the store runtime.
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+client_parties\b/i, 'creates client_parties');
    for (const status of PARTY_STATUSES) {
      assert.match(sql, new RegExp(String.raw`'${status}'`), `client_parties status CHECK includes '${status}'`);
    }
    for (const field of ['normalized_name', 'is_customer', 'is_supplier', 'business_id', 'business_id_scheme',
      'preferred_language', 'payment_terms_days', 'do_not_contact', 'merged_into_party_id', 'provenance']) {
      assert.match(sql, new RegExp(String.raw`\b${field}\b`, 'i'), `client_parties carries ${field}`);
    }
    // party_channels — effective-dated, one ACTIVE row per (party, kind, value).
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+party_channels\b/i, 'creates party_channels');
    for (const kind of PARTY_CHANNEL_KINDS) {
      assert.match(sql, new RegExp(String.raw`'${kind}'`), `party_channels channel_kind CHECK includes '${kind}'`);
    }
    assert.match(sql, /create\s+unique\s+index\s+if\s+not\s+exists\s+party_channels_active_value_idx/i, 'active-channel unique index');
    assert.match(sql, /where\s+valid_until\s+is\s+null/i, 'partial index spans active rows only');
    // party_attributes — append-only history with one active row per attribute.
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+party_attributes\b/i, 'creates party_attributes');
    assert.match(sql, /create\s+unique\s+index\s+if\s+not\s+exists\s+party_attributes_active_idx/i, 'active-attribute unique index');
    // party_merge_suggestions — suggest-and-confirm lane.
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+party_merge_suggestions\b/i, 'creates party_merge_suggestions');
    for (const status of PARTY_MERGE_SUGGESTION_STATUSES) {
      assert.match(sql, new RegExp(String.raw`'${status}'`), `merge suggestion status CHECK includes '${status}'`);
    }
    // Everything dies with its client (firm-memory-dies-with-its-client).
    const cascades = sql.match(/references\s+clients\(id\)\s+on\s+delete\s+cascade/gi) || [];
    assert.equal(cascades.length, 4, 'all four tables cascade on client delete');
    for (const table of ['client_parties', 'party_channels', 'party_attributes', 'party_merge_suggestions']) {
      assert.match(sql, new RegExp(String.raw`alter\s+table\s+${table}\s+enable\s+row\s+level\s+security`, 'i'), `RLS on ${table}`);
    }
  });

  await test('091 outbound actions: closed enums, idempotency, receipts at the marketing bar, per-client suppression', () => {
    const sql = readMigration('091_outbound_actions.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+outbound_actions\b/i, 'creates outbound_actions');
    for (const actionType of OUTBOUND_ACTION_TYPES) {
      assert.match(sql, new RegExp(String.raw`'${actionType}'`), `action_type CHECK includes '${actionType}'`);
    }
    for (const verdict of OUTBOUND_GATE_VERDICTS) {
      assert.match(sql, new RegExp(String.raw`'${verdict}'`), `gate_verdict CHECK includes '${verdict}'`);
    }
    for (const status of OUTBOUND_ACTION_STATUSES) {
      assert.match(sql, new RegExp(String.raw`'${status}'`), `status CHECK includes '${status}'`);
    }
    assert.match(sql, /create\s+unique\s+index\s+if\s+not\s+exists\s+outbound_actions_idempotency_idx/i, 'idempotency unique index');
    for (const field of ['target_party_id', 'anchor_type', 'anchor_id', 'pack_id', 'gate_basis',
      'scheduled_for', 'cadence_step', 'idempotency_key', 'claimed_at', 'cancel_reason',
      'approved_by_actor_type', 'config_snapshot_id']) {
      assert.match(sql, new RegExp(String.raw`\b${field}\b`, 'i'), `outbound_actions carries ${field}`);
    }
    // Receipts — the marketing bar (050): attribution NOT NULL, exact content,
    // provider id; outcomes pinned to the runtime enum.
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+outbound_action_receipts\b/i, 'creates receipts');
    for (const outcome of OUTBOUND_RECEIPT_OUTCOMES) {
      assert.match(sql, new RegExp(String.raw`'${outcome}'`), `receipt outcome CHECK includes '${outcome}'`);
    }
    assert.match(sql, /approved_by\s+text\s+not\s+null/i, 'approved_by NOT NULL');
    assert.match(sql, /authority\s+text\s+not\s+null/i, 'authority NOT NULL');
    assert.match(sql, /model\s+text\s+not\s+null/i, 'model NOT NULL');
    for (const field of ['rendered_subject', 'rendered_body', 'provider_message_id', 'checks']) {
      assert.match(sql, new RegExp(String.raw`\b${field}\b`, 'i'), `receipts carry ${field}`);
    }
    // Suppression — per (firm, client, channel, value).
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+outbound_suppression\b/i, 'creates suppression');
    assert.match(sql, /create\s+unique\s+index\s+if\s+not\s+exists\s+outbound_suppression_value_idx/i, 'suppression unique index');
    // Everything dies with its client; RLS on.
    const cascades = sql.match(/references\s+clients\(id\)\s+on\s+delete\s+cascade/gi) || [];
    assert.equal(cascades.length, 3, 'all three tables cascade on client delete');
    for (const table of ['outbound_actions', 'outbound_action_receipts', 'outbound_suppression']) {
      assert.match(sql, new RegExp(String.raw`alter\s+table\s+${table}\s+enable\s+row\s+level\s+security`, 'i'), `RLS on ${table}`);
    }
  });

  await test('092 receivable cases: chase state alongside computed settlement, statuses pinned to the runtime', () => {
    const sql = readMigration('092_receivable_cases.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+receivable_cases\b/i, 'creates receivable_cases');
    for (const status of RECEIVABLE_CASE_STATUSES) {
      assert.match(sql, new RegExp(String.raw`'${status}'`), `status CHECK includes '${status}'`);
    }
    for (const anchor of RECEIVABLE_CASE_ANCHOR_TYPES) {
      assert.match(sql, new RegExp(String.raw`'${anchor}'`), `anchor_type CHECK includes '${anchor}'`);
    }
    for (const field of ['current_step', 'next_due_at', 'pack_id', 'invoice_number', 'due_date',
      'last_action_id', 'last_sent_at', 'status_reason', 'settled_at', 'closed_at']) {
      assert.match(sql, new RegExp(String.raw`\b${field}\b`, 'i'), `receivable_cases carries ${field}`);
    }
    // One case per anchor: re-detection is idempotent.
    assert.match(sql, /create\s+unique\s+index\s+if\s+not\s+exists\s+receivable_cases_anchor_idx/i, 'anchor unique index');
    // Dies with its client; RLS on.
    assert.match(sql, /references\s+clients\(id\)\s+on\s+delete\s+cascade/i, 'cascades on client delete');
    assert.match(sql, /alter\s+table\s+receivable_cases\s+enable\s+row\s+level\s+security/i, 'RLS on receivable_cases');
  });

  await test('093 outbound owner surface: bearer tokens + the owner-digest ledger', () => {
    const sql = readMigration('093_outbound_owner_surface.sql');
    assert.match(sql, /add\s+column\s+if\s+not\s+exists\s+approval_token/i, 'approval_token on outbound_actions');
    assert.match(sql, /add\s+column\s+if\s+not\s+exists\s+unsubscribe_token/i, 'unsubscribe_token on outbound_actions');
    assert.match(sql, /create\s+unique\s+index\s+if\s+not\s+exists\s+outbound_actions_approval_token_idx/i, 'approval token unique index');
    assert.match(sql, /create\s+unique\s+index\s+if\s+not\s+exists\s+outbound_actions_unsubscribe_token_idx/i, 'unsubscribe token unique index');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+outbound_digests\b/i, 'creates outbound_digests');
    for (const field of ['content_hash', 'pending_count', 'must_review_count', 'needs_input_count', 'provider_message_id']) {
      assert.match(sql, new RegExp(String.raw`\b${field}\b`, 'i'), `outbound_digests carries ${field}`);
    }
    assert.match(sql, /references\s+clients\(id\)\s+on\s+delete\s+cascade/i, 'digests cascade on client delete');
    assert.match(sql, /alter\s+table\s+outbound_digests\s+enable\s+row\s+level\s+security/i, 'RLS on outbound_digests');
  });

  await test('094 outbound metrics: one row per client-day, keyed and honest about attribution', () => {
    const sql = readMigration('094_outbound_metrics.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+outbound_metrics_daily\b/i, 'creates outbound_metrics_daily');
    for (const field of ['metric_date', 'reminders_sent', 'actions_executed', 'approval_taps',
      'cases_opened', 'cases_settled', 'collected_after_chase_amount',
      'false_chase_candidates', 'minutes_saved', 'avg_days_late_at_settlement']) {
      assert.match(sql, new RegExp(String.raw`\b${field}\b`, 'i'), `outbound_metrics_daily carries ${field}`);
    }
    assert.match(sql, /create\s+unique\s+index\s+if\s+not\s+exists\s+outbound_metrics_daily_key_idx/i, 'client-day unique key');
    assert.match(sql, /references\s+clients\(id\)\s+on\s+delete\s+cascade/i, 'cascades on client delete');
    assert.match(sql, /alter\s+table\s+outbound_metrics_daily\s+enable\s+row\s+level\s+security/i, 'RLS on');
    // §3's attribution honesty is part of the schema's contract — pinned in
    // the migration prose so a future reader inherits it.
    assert.match(sql, /settled\s+AFTER\s+at\s+least\s+one\s+reminder/i, 'attribution honesty documented');
  });

  await test('095 M2: the D6 grant generalization + D4 pay-links, vocabularies pinned to the runtimes', () => {
    const sql = readMigration('095_outbound_actions_m2.sql');
    // action_authority_grants — ONE engine with a domain scope (no fourth copy).
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+action_authority_grants\b/i, 'creates action_authority_grants');
    for (const domain of ACTION_GRANT_DOMAINS) {
      assert.match(sql, new RegExp(String.raw`'${domain}'`), `domain CHECK includes '${domain}'`);
    }
    for (const kind of ACTION_GRANT_SCOPE_KINDS) {
      assert.match(sql, new RegExp(String.raw`'${kind}'`), `scope_kind CHECK includes '${kind}'`);
    }
    for (const source of ACTION_GRANT_SOURCES) {
      assert.match(sql, new RegExp(String.raw`'${source}'`), `source CHECK includes '${source}'`);
    }
    for (const status of ACTION_GRANT_STATUSES) {
      assert.match(sql, new RegExp(String.raw`'${status}'`), `status CHECK includes '${status}'`);
    }
    for (const field of ['amount_ceiling', 'correction_count', 'use_count', 'review_after', 'provenance']) {
      assert.match(sql, new RegExp(String.raw`\b${field}\b`, 'i'), `grants carry ${field}`);
    }
    assert.match(sql, /amount_ceiling\s+numeric\s+not\s+null\s+check\s*\(amount_ceiling\s*>\s*0\)/i, 'ceiling required and positive');

    // outbound_payment_links + append-only events.
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+outbound_payment_links\b/i, 'creates outbound_payment_links');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+outbound_payment_link_events\b/i, 'creates outbound_payment_link_events');
    for (const status of PAY_LINK_STATUSES) {
      assert.match(sql, new RegExp(String.raw`'${status}'`), `link status CHECK includes '${status}'`);
    }
    for (const anchor of PAY_LINK_ANCHOR_TYPES) {
      assert.match(sql, new RegExp(String.raw`'${anchor}'`), `link anchor CHECK includes '${anchor}'`);
    }
    for (const provider of PAY_LINK_PROVIDERS) {
      assert.match(sql, new RegExp(String.raw`'${provider}'`), `provider CHECK includes '${provider}'`);
    }
    assert.match(sql, /create\s+unique\s+index\s+if\s+not\s+exists\s+outbound_payment_links_anchor_idx/i, 'one link per anchor');
    assert.match(sql, /create\s+unique\s+index\s+if\s+not\s+exists\s+outbound_payment_link_events_event_idx/i, 'idempotent webhook events');

    // §3 issuance counters follow the milestone.
    assert.match(sql, /add\s+column\s+if\s+not\s+exists\s+invoices_issued/i, 'invoices_issued on outbound_metrics_daily');
    assert.match(sql, /add\s+column\s+if\s+not\s+exists\s+quotes_sent/i, 'quotes_sent on outbound_metrics_daily');

    for (const table of ['action_authority_grants', 'outbound_payment_links', 'outbound_payment_link_events']) {
      assert.match(sql, new RegExp(String.raw`alter\s+table\s+${table}\s+enable\s+row\s+level\s+security`, 'i'), `RLS on ${table}`);
    }
    assert.match(sql, /references\s+clients\(id\)\s+on\s+delete\s+cascade/i, 'dies with its client');
  });

  await test('103 makes "one live ask draft per client" a database refusal (F-19)', () => {
    const sql = readMigration('103_ask_lane_live_draft_uniqueness.sql');
    // The repair MUST precede the constraint — a book that already raced would
    // otherwise fail the index creation and block the whole migration.
    const repairAt = sql.search(/update\s+client_ask_batches/i);
    const indexAt = sql.search(/create\s+unique\s+index/i);
    assert.ok(repairAt >= 0, 'supersedes pre-existing duplicate live drafts');
    assert.ok(indexAt >= 0, 'creates the uniqueness index');
    assert.ok(repairAt < indexAt, 'repair runs before the constraint');
    assert.match(
      sql,
      /create\s+unique\s+index\s+if\s+not\s+exists\s+client_ask_batches_one_live_draft_idx\s+on\s+client_ask_batches\s*\(\s*firm_id\s*,\s*client_id\s*\)\s*where\s+status\s*=\s*'draft'/i,
      'partial unique on the live (draft) rows only'
    );
    // Terminal history must stay repeatable — the index must not cover it.
    for (const terminal of ['sent', 'superseded', 'cancelled']) {
      assert.ok(
        !new RegExp(String.raw`where\s+status\s*=\s*'${terminal}'`, 'i').test(sql),
        `terminal status '${terminal}' is not constrained`
      );
    }
  });

  await test('104 owner-invoice commands: the G13 trust cluster, vocabularies pinned to the runtime', () => {
    const sql = readMigration('104_owner_invoice_commands.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+owner_invoice_commands/i, 'creates the table');

    // (a) THE natural key — the whole point of the table. It must be UNIQUE and
    // it must include the client, because the customer boundary is client<->client
    // and a channel message id is only unique within its channel.
    assert.match(
      sql,
      /create\s+unique\s+index\s+if\s+not\s+exists\s+owner_invoice_commands_source_idx\s+on\s+owner_invoice_commands\s*\(\s*firm_id\s*,\s*client_id\s*,\s*source_channel\s*,\s*source_message_id\s*\)/i,
      'one command per source message, per client'
    );

    // (c) a command has a human author — enforced by the column, not by hope.
    assert.match(
      sql,
      /principal_actor_type\s+text\s+not\s+null\s*\n?\s*check\s*\(\s*principal_actor_type\s*<>\s*'system'\s*\)/i,
      "principal_actor_type may never be 'system'"
    );
    for (const col of ['principal_actor_id', 'channel_binding', 'field_provenance', 'model']) {
      assert.match(sql, new RegExp(`\\b${col}\\b`, 'i'), `carries ${col}`);
    }

    // Status + channel vocabularies pinned to the runtime's exported constants:
    // a value the runtime writes but the column rejects is a silent write failure.
    for (const status of OWNER_COMMAND_STATUSES) {
      assert.match(sql, new RegExp(String.raw`'${status}'`), `status CHECK includes '${status}'`);
    }
    for (const channel of OWNER_COMMAND_CHANNELS) {
      assert.match(sql, new RegExp(String.raw`'${channel}'`), `channel CHECK includes '${channel}'`);
    }

    // (d) the fingerprint column is ADDITIVE — every existing row keeps NULL,
    // and NULL is the executor's documented no-op.
    assert.match(
      sql,
      /alter\s+table\s+outbound_actions\s*\n?\s*add\s+column\s+if\s+not\s+exists\s+approved_consequence_fingerprint\s+text/i,
      'the fingerprint column is added, not backfilled'
    );

    assert.match(sql, /references\s+clients\(id\)\s+on\s+delete\s+cascade/i, 'dies with its client');
    assert.match(
      sql,
      /alter\s+table\s+owner_invoice_commands\s+enable\s+row\s+level\s+security/i,
      'RLS on owner_invoice_commands'
    );
  });

  await test('105 llm_raw_response retention: the redaction receipt + the self-shrinking sweep index', () => {
    const sql = readMigration('105_llm_raw_response_retention.sql');
    assert.match(
      sql,
      /alter\s+table\s+llm_decisions\s+add\s+column\s+if\s+not\s+exists\s+llm_raw_response_redacted_at\s+timestamptz/i,
      'adds the per-row redaction receipt, nullable'
    );
    // PARTIAL on the un-redacted population: it shrinks as the sweep works, and
    // (design note §1) it is empty on creation because nothing writes the column.
    assert.match(
      sql,
      /create\s+index\s+if\s+not\s+exists\s+idx_llm_decisions_raw_response_retention\s+on\s+llm_decisions\s*\(\s*created_at\s*\)\s*where\s+llm_raw_response\s+is\s+not\s+null/i,
      'the sweep index is partial on llm_raw_response is not null'
    );
  });

  await test('105 the exemption is REDACTION-SHAPED — a one-way destruction, never an edit hatch', () => {
    const sql = readMigration('105_llm_raw_response_retention.sql');
    assert.match(sql, /create\s+or\s+replace\s+function\s+llm_decisions_freeze_prediction/i, 'replaces 045s freeze function');
    assert.match(sql, /before\s+update\s+on\s+llm_decisions/i, 'still fires BEFORE UPDATE');
    // The fail-closed subtraction survives — a future prediction column stays frozen.
    assert.match(
      sql,
      /to_jsonb\(old\)\s*-\s*exempt\)?\s*is\s+distinct\s+from\s*\(?\s*to_jsonb\(new\)\s*-\s*exempt/i,
      'still compares rows minus the exempt set (fail-closed by subtraction)'
    );
    // All FOUR clauses of the redaction predicate. Drop any one and the exemption
    // widens into something it must never be:
    //   old not null  — without it, null → null no-ops could stamp a forged receipt
    //   new is null   — without it, an EDIT of the raw response is permitted
    //   old stamp null— without it, the receipt is re-writable (not write-once)
    //   new stamp set — without it, a redaction can be SILENT
    assert.match(sql, /old\.llm_raw_response\s+is\s+not\s+null/i, 'clause 1: there was something to redact');
    assert.match(sql, /new\.llm_raw_response\s+is\s+null/i, 'clause 2: destroyed, not edited');
    assert.match(sql, /old\.llm_raw_response_redacted_at\s+is\s+null/i, 'clause 3: write-once');
    assert.match(sql, /new\.llm_raw_response_redacted_at\s+is\s+not\s+null/i, 'clause 4: the stamp is mandatory');
    // The exemption applies to EXACTLY the two redaction columns, and only inside
    // the redaction branch.
    assert.match(
      sql,
      /exempt\s*:=\s*allowed\s*\|\|\s*array\[\s*'llm_raw_response'\s*,\s*'llm_raw_response_redacted_at'\s*\]/i,
      'the redaction branch exempts exactly the two redaction columns'
    );
    assert.match(sql, /else\s*\n\s*exempt\s*:=\s*allowed\s*;/i, 'outside a redaction, the exempt set is 045s allow-list unchanged');
  });

  await test('105 does NOT widen 045s annotation allow-list (the load-bearing guard)', () => {
    const sql = readMigration('105_llm_raw_response_retention.sql');
    // The six annotation columns, and ONLY those six, remain in `allowed`. Adding
    // llm_raw_response here instead of using the transition-shaped exemption would
    // make it editable to anything, at any time, by any writer — the exact hatch
    // the design refuses. This test is what stops that edit landing quietly.
    for (const col of ['human_outcome', 'human_outcome_at', 'reversal_metadata', 'louis_verdict', 'louis_evaluated_at', 'resolved_at']) {
      assert.match(sql, new RegExp(`'${col}'`, 'i'), `allow-list still includes ${col}`);
    }
    const allowedArray = sql.match(/allowed\s+constant\s+text\[\]\s*:=\s*array\[([\s\S]*?)\]/i);
    assert.ok(allowedArray, 'the allow-list array is present');
    const allowedCols = (allowedArray[1].match(/'([a-z_]+)'/g) || []).map((s) => s.replace(/'/g, ''));
    assert.deepEqual(
      allowedCols.sort(),
      ['human_outcome', 'human_outcome_at', 'louis_evaluated_at', 'louis_verdict', 'resolved_at', 'reversal_metadata'].sort(),
      'the annotation allow-list is EXACTLY 045s six — llm_raw_response is exempted by transition shape, never by membership'
    );
    // And no prediction column sneaked in alongside them.
    assert.doesNotMatch(
      allowedArray[1],
      /'(decision_type|final_state|config_snapshot_id|model_name|previous_decision_id|llm_reasoning|llm_raw_response)'/i,
      'no prediction column is allow-listed'
    );
  });

  await test('105 stays scoped to TIER 3 — llm_reasoning is 107s business, not 105s', () => {
    const sql = readMigration('105_llm_raw_response_retention.sql');
    // HISTORY, so this test is not misread: when 105 landed, decision 4 retained
    // llm_reasoning INDEFINITELY, and this test guarded against a session
    // widening a dated decision on its own initiative. Kari SUPERSEDED that on
    // 2026-07-28 (docs/donna-data-lifecycle-policy.md) — tier 2 now gets the same
    // 90-day clock — and migration 107 implements it.
    //
    // The assertion below is unchanged and still correct: 105's own SQL remains
    // scoped to tier 3. Each migration owns exactly one tier, which is what keeps
    // them independently reviewable and independently revertible.
    assert.doesNotMatch(sql, /exempt\s*:=[^\n]*llm_reasoning/i, '105 does not exempt llm_reasoning — 107 does');
    assert.doesNotMatch(sql, /set\s+llm_reasoning/i, '105 does not clear llm_reasoning');
    assert.doesNotMatch(sql, /drop\s+column[^\n]*llm_reasoning/i, '105 does not drop llm_reasoning');
  });

  await test('106 adds the telemetry columns to llm_decisions — all additive, all nullable', () => {
    const sql = readMigration('106_llm_decision_telemetry.sql');
    for (const col of [
      'usage jsonb',
      'root_execution_type text',
      'root_execution_id text',
      'parent_execution_type text',
      'parent_execution_id text',
      'latency_ms integer',
      'attempt_count integer',
      'provider_attempt_id text',
      'prompt_sections jsonb'
    ]) {
      const [name, type] = col.split(' ');
      assert.match(
        sql,
        new RegExp(`alter\\s+table\\s+llm_decisions\\s+add\\s+column\\s+if\\s+not\\s+exists\\s+${name}\\s+${type}`, 'i'),
        `adds ${name} as nullable ${type}`
      );
    }
    // Nullable means nullable: a NOT NULL here would break every existing row
    // and every un-instrumented writer.
    assert.doesNotMatch(sql, /add\s+column\s+if\s+not\s+exists\s+\w+\s+\w+\s+not\s+null/i, 'no column is NOT NULL');
  });

  await test('106 attributes via a TYPED (type, id) PAIR — never the stale 4-way nullable union', () => {
    const sql = readMigration('106_llm_decision_telemetry.sql');
    // technical-plan §S1 specifies `{work_ref | case_id | run_id | action_id}`;
    // gap-analysis G3 REVISED that to "ONE typed root_execution_ref + optional
    // parent (never a nullable union)", and S1 was never updated to say so. G3
    // is binding: four nullable columns are not one identity and cannot be
    // joined on. This test is what stops the stale shape being built later.
    for (const unionColumn of ['work_ref', 'case_id', 'run_id', 'action_id']) {
      assert.doesNotMatch(
        sql,
        new RegExp(`add\\s+column\\s+if\\s+not\\s+exists\\s+${unionColumn}\\b`, 'i'),
        `${unionColumn} is the stale S1 union shape — G3 revised it away`
      );
    }
    // The join that makes tokens_per_outcome a query rather than a project.
    assert.match(
      sql,
      /create\s+index\s+if\s+not\s+exists\s+idx_llm_decisions_root_execution\s+on\s+llm_decisions\s*\(\s*root_execution_type\s*,\s*root_execution_id\s*\)\s*where\s+root_execution_id\s+is\s+not\s+null/i,
      'the typed pair is indexed TOGETHER, partial on the instrumented population'
    );
  });

  await test('106 changes NO trigger — 045s fail-closed subtraction freezes the new columns for free', () => {
    const sql = readMigration('106_llm_decision_telemetry.sql');
    // Migration 045 (as amended by 105) freezes by SUBTRACTION, so any column
    // added later is immutable on arrival. That is why this migration needs no
    // trigger change — and it is exactly the kind of invariant that stays true
    // by accident until someone changes the mechanism, so it gets a test.
    assert.doesNotMatch(sql, /create\s+or\s+replace\s+function\s+llm_decisions_freeze_prediction/i, '106 must not redefine the freeze function');
    assert.doesNotMatch(sql, /create\s+trigger/i, '106 defines no trigger');
    // And it must not smuggle a new column into the annotation allow-list.
    assert.doesNotMatch(sql, /allowed\s+constant\s+text\[\]/i, '106 does not touch the allow-list');
  });

  await test('106 stores section SIZES, never section contents (G14s mitigation)', () => {
    const sql = readMigration('106_llm_decision_telemetry.sql');
    // The measurement slice must not re-widen the data surface migration 105's
    // retention control just narrowed. There is exactly ONE section column and
    // it holds the accounting, not the prompt.
    assert.match(sql, /prompt_sections\s+jsonb/i, 'the section accounting column exists');
    assert.doesNotMatch(sql, /add\s+column\s+if\s+not\s+exists\s+prompt_(text|body|content)\b/i, 'no prompt CONTENT column');
    assert.doesNotMatch(sql, /add\s+column\s+if\s+not\s+exists\s+\w*raw\w*\b/i, 'no new raw-payload column');
  });

  await test('107 adds the tier-2 redaction receipt + its self-shrinking sweep index', () => {
    const sql = readMigration('107_llm_reasoning_retention.sql');
    assert.match(
      sql,
      /alter\s+table\s+llm_decisions\s+add\s+column\s+if\s+not\s+exists\s+llm_reasoning_redacted_at\s+timestamptz/i,
      'tier 2 gets its OWN stamp — the tiers have independent lifecycles'
    );
    assert.match(
      sql,
      /create\s+index\s+if\s+not\s+exists\s+idx_llm_decisions_reasoning_retention\s+on\s+llm_decisions\s*\(\s*created_at\s*\)\s*where\s+llm_reasoning\s+is\s+not\s+null/i,
      'partial on the un-redacted population, so it shrinks as the sweep converges'
    );
  });

  await test('107 gates the two tiers INDEPENDENTLY — a reasoning redaction cannot smuggle a raw edit', () => {
    const sql = readMigration('107_llm_reasoning_retention.sql');
    // Both predicates present, each with all four clauses. Drop any clause and
    // the exemption widens into something it must never be: without clause 2 an
    // EDIT is permitted; without clause 3 the receipt is re-writable; without
    // clause 4 a redaction can be SILENT.
    for (const column of ['llm_reasoning', 'llm_raw_response']) {
      assert.match(sql, new RegExp(`old\\.${column}\\s+is\\s+not\\s+null`, 'i'), `${column}: there was something to redact`);
      assert.match(sql, new RegExp(`new\\.${column}\\s+is\\s+null`, 'i'), `${column}: destroyed, not edited`);
      assert.match(sql, new RegExp(`old\\.${column}_redacted_at\\s+is\\s+null`, 'i'), `${column}: write-once`);
      assert.match(sql, new RegExp(`new\\.${column}_redacted_at\\s+is\\s+not\\s+null`, 'i'), `${column}: the stamp is mandatory`);
    }
    // Each branch appends ONLY its own pair — that independence is what stops a
    // correctly-shaped redaction of one tier exempting the other.
    assert.match(sql, /if\s+raw_redaction\s+then\s*\n\s*exempt\s*:=\s*exempt\s*\|\|\s*array\['llm_raw_response',\s*'llm_raw_response_redacted_at'\]/i);
    assert.match(sql, /if\s+reasoning_redaction\s+then\s*\n\s*exempt\s*:=\s*exempt\s*\|\|\s*array\['llm_reasoning',\s*'llm_reasoning_redacted_at'\]/i);
    // Still fail-closed by subtraction, so a future column is frozen for free.
    assert.match(
      sql,
      /to_jsonb\(old\)\s*-\s*exempt\)?\s*is\s+distinct\s+from\s*\(?\s*to_jsonb\(new\)\s*-\s*exempt/i,
      'the fail-closed subtraction survives'
    );
  });

  await test('107 does NOT weaken the ordinary writers immutability rule', () => {
    const sql = readMigration('107_llm_reasoning_retention.sql');
    // The six annotation columns, and ONLY those six, remain in `allowed`.
    // Putting a prose column there instead of using the transition-shaped
    // exemption would make it editable to anything, at any time, by any writer.
    const allowedArray = sql.match(/allowed\s+constant\s+text\[\]\s*:=\s*array\[([\s\S]*?)\]/i);
    assert.ok(allowedArray, 'the allow-list array is present');
    const allowedCols = (allowedArray[1].match(/'([a-z_]+)'/g) || []).map((v) => v.replace(/'/g, ''));
    assert.deepEqual(
      allowedCols.sort(),
      ['human_outcome', 'human_outcome_at', 'louis_evaluated_at', 'louis_verdict', 'resolved_at', 'reversal_metadata'].sort(),
      'the annotation allow-list is EXACTLY 045s six — prose is exempted by transition SHAPE, never by membership'
    );
    assert.doesNotMatch(
      allowedArray[1],
      /'(llm_reasoning|llm_raw_response|final_state|previous_decision_id|model_name|config_snapshot_id)'/i,
      'no prediction column is allow-listed'
    );
  });

  await test('107 leaves the TIER 1 structured receipt entirely alone', () => {
    const sql = readMigration('107_llm_reasoning_retention.sql');
    // The three-tier split is the policy: what a dispute is answered from is
    // retained. 107 may only ever destroy prose.
    for (const col of ['final_state', 'previous_decision_id', 'correction_reason', 'model_name', 'confidence', 'deterministic_signals']) {
      assert.doesNotMatch(sql, new RegExp(`drop\\s+column[^\\n]*${col}`, 'i'), `does not drop ${col}`);
      assert.doesNotMatch(sql, new RegExp(`exempt[^\\n]*'${col}'`, 'i'), `does not exempt ${col}`);
    }
    assert.doesNotMatch(sql, /delete\s+from\s+llm_decisions/i, 'no row deletion — the correction chain survives');
  });

  await test('109 creates the K1 knowledge base — vocabularies pinned, the three structural laws in the tables', () => {
    const sql = readMigration('109_knowledge_base.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+knowledge_sources\b/i, 'creates knowledge_sources');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+knowledge_passages\b/i, 'creates knowledge_passages');

    // CHECK vocabularies pinned to knowledgeBase.js — a value the writer emits
    // but the column rejects is a silent fail.
    for (const j of KNOWLEDGE_JURISDICTIONS) assert.match(sql, new RegExp(String.raw`'${j}'`), `jurisdiction CHECK includes '${j}'`);
    for (const c of KNOWLEDGE_AUTHORITY_CLASSES) assert.match(sql, new RegExp(String.raw`'${c}'`), `authority_class CHECK includes '${c}'`);
    for (const t of KNOWLEDGE_TOPICS) assert.match(sql, new RegExp(String.raw`'${t}'`), `topic CHECK includes '${t}'`);
    for (const s of KNOWLEDGE_ANSWER_SHAPES) assert.match(sql, new RegExp(String.raw`'${s}'`), `answer_shape CHECK includes '${s}'`);
    for (const s of KNOWLEDGE_STATUSES) assert.match(sql, new RegExp(String.raw`'${s}'`), `status CHECK includes '${s}'`);
    for (const s of KNOWLEDGE_TRANSLATION_STATUSES) assert.match(sql, new RegExp(String.raw`'${s}'`), `translation_status CHECK includes '${s}'`);
  });

  // LAW 1, and the reason this test reads the file rather than trusting a
  // convention: K1 is GLOBAL (design §3). The Finnish VAT Act is not a fact
  // about a customer, so the ABSENCE of a tenant column is the invariant. A
  // future migration that "helpfully" adds firm_id here would break the plane
  // silently; this fails instead.
  await test('109 carries NO tenant identifier and NO tenant foreign key', () => {
    const sql = readMigration('109_knowledge_base.sql');
    // Strip comments — the header explains the rule using the very words the
    // assertions forbid, and a test that matched prose would be vacuous.
    const code = sql.replace(/--[^\n]*/g, '');

    assert.doesNotMatch(code, /\bfirm_id\b/i, 'no firm_id column');
    assert.doesNotMatch(code, /\bclient_id\b/i, 'no client_id column');
    assert.doesNotMatch(code, /\btenant_id\b/i, 'no tenant_id column');
    assert.doesNotMatch(code, /references\s+firms\s*\(/i, 'no FK to firms');
    assert.doesNotMatch(code, /references\s+clients\s*\(/i, 'no FK to clients');
  });

  // LAW 2: append-mostly with supersession, never purge.
  await test('109 makes supersession linear and withdrawal explained', () => {
    const sql = readMigration('109_knowledge_base.sql');
    for (const table of ['knowledge_sources', 'knowledge_passages']) {
      assert.match(
        sql,
        new RegExp(String.raw`create\s+unique\s+index\s+if\s+not\s+exists\s+${table}_supersedes_unique\s+on\s+${table}\s*\(\s*supersedes\s*\)\s*where\s+supersedes\s+is\s+not\s+null`, 'i'),
        `${table}: a row may be superseded exactly once (the chain does not fork)`
      );
      assert.match(
        sql,
        new RegExp(String.raw`constraint\s+${table}_withdrawal_explains\s+check`, 'i'),
        `${table}: a withdrawal states its reason`
      );
    }
    // 'withdrawn' and 'superseded' are terminal HISTORY that stays readable —
    // the migration must not offer a deletion path for either.
    assert.doesNotMatch(sql.replace(/--[^\n]*/g, ''), /delete\s+from\s+knowledge_/i, 'no deletion path');
  });

  // LAW 3: active means reviewed, snapshotted and honest — 'active' is the only
  // status retrieval ever reads.
  await test('109 gates ACTIVE on review, snapshot and verification honesty', () => {
    const sql = readMigration('109_knowledge_base.sql');
    assert.match(sql, /constraint\s+knowledge_sources_active_is_reviewed\s+check/i, 'active ⇒ reviewer + date');
    assert.match(sql, /constraint\s+knowledge_sources_active_is_snapshotted\s+check/i, 'active ⇒ content_hash + snapshot_ref');
    assert.match(sql, /constraint\s+knowledge_sources_unconfirmed_explains\s+check/i, 'unconfirmed ⇒ a verification note');
    assert.match(sql, /constraint\s+knowledge_passages_active_is_reviewed\s+check/i, 'passages too');
    assert.match(sql, /constraint\s+knowledge_passages_question_forms_nonempty\s+check/i, 'question_forms non-empty');
    for (const table of ['knowledge_sources', 'knowledge_passages']) {
      assert.match(
        sql,
        new RegExp(String.raw`constraint\s+${table}_window_ordered\s+check`, 'i'),
        `${table}: a window that closes before it opens is a curation error`
      );
    }
  });

  await test('110 closes the RLS gap 109 left on the knowledge tables', () => {
    const sql = readMigration('110_knowledge_base_rls.sql');
    for (const table of ['knowledge_sources', 'knowledge_passages']) {
      assert.match(
        sql,
        new RegExp(String.raw`alter\s+table\s+${table}\s+enable\s+row\s+level\s+security`, 'i'),
        `${table}: RLS enabled`
      );
      assert.match(sql, new RegExp(String.raw`revoke\s+all\s+on\s+${table}\s+from\s+anon`, 'i'), `${table}: anon revoked`);
      assert.match(
        sql,
        new RegExp(String.raw`revoke\s+all\s+on\s+${table}\s+from\s+authenticated`, 'i'),
        `${table}: authenticated revoked`
      );
    }
    // Comments stripped: the header explains the rule using the very words the
    // assertions forbid, and a test satisfied by prose is vacuous.
    const code = sql.replace(/--[^\n]*/g, '');
    // Adding a browser policy would re-open the very PostgREST path this closes
    // (032's posture: lockdown with NO browser data policies).
    assert.doesNotMatch(code, /create\s+policy/i, 'no browser policy is created');
    // ENABLE, never FORCE — the table-owner server role must stay exempt or the
    // server's own connection loses access.
    assert.doesNotMatch(code, /force\s+row\s+level\s+security/i, 'ENABLE, not FORCE');
  });

  // THE RATCHET. 032's event-trigger backstop is SKIPPED on the live project
  // (CREATE EVENT TRIGGER needs superuser, and Supabase's migration role is not
  // one), and its §1 static scan only covered tables existing at 032. So for
  // anything created later, the per-migration RLS block is the ONLY guard — and
  // until now that was discipline, not a rail. 109 created two tables without
  // one, which is exactly the failure this test now prevents.
  //
  // The LEGACY_RLS_DEBT list below is NOT an exemption anyone should extend: it
  // is a named, dated inventory of tables that already shipped without a block
  // (migrations 055–089; 091+ are all clean). Several hold tenant data —
  // `client_chat_messages`, `issued_invoices`, `alv_returns`, `suomifi_mandates`
  // — so this is real debt, not cosmetics. Closing it is its own slice, and the
  // list must only ever SHRINK. A NEW table may never be added here.
  await test('every public table created after 032 has an explicit RLS block (ratchet)', () => {
    const dir = resolvePath(repoRoot, 'db', 'migrations');
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const everySql = files.map((f) => readFileSync(resolvePath(dir, f), 'utf8')).join('\n');

    // Known debt, migrations 055–089. Shrink only.
    const LEGACY_RLS_DEBT = new Set([
      'procountor_connections', 'procountor_accounts', 'procountor_dimensions', 'procountor_vendors',
      'procountor_customers', 'procountor_sync_runs', 'procountor_journal_mirrors',
      'procountor_business_partners', 'procountor_bank_accounts',
      'client_chat_messages', 'fiscal_years', 'issued_invoices', 'issued_invoice_counters',
      'alv_returns', 'suomifi_mandates', 'prepayment_register_checks', 'issued_quotes',
      'issued_quote_counters',
      'inventory_units_of_measure', 'inventory_uom_conversions', 'inventory_products',
      'inventory_items', 'inventory_barcodes', 'inventory_supplier_identifiers',
      'inventory_locations', 'inventory_aliases', 'inventory_substitutions',
      'inventory_command_receipts', 'inventory_operations', 'inventory_item_levels',
      'inventory_anomalies', 'inventory_purchase_orders', 'inventory_purchase_order_lines',
      'inventory_supplier_acknowledgements', 'inventory_sales_orders', 'inventory_sales_order_lines',
      'inventory_reservations', 'inventory_allocations', 'inventory_backorders',
      'inventory_count_sessions', 'inventory_count_lines', 'inventory_posting_attempts',
      'inventory_posting_journals', 'inventory_journal_allocations', 'inventory_valuation_allowances',
      'gst_returns', 'corppass_mandates'
    ]);

    const unguarded = [];
    for (const file of files) {
      const version = Number.parseInt(file.slice(0, 3), 10);
      if (!Number.isFinite(version) || version <= 32) continue;
      const code = readFileSync(resolvePath(dir, file), 'utf8').replace(/--[^\n]*/g, '');
      const createRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/gi;
      let match;
      while ((match = createRe.exec(code))) {
        const table = match[1];
        if (LEGACY_RLS_DEBT.has(table)) continue;
        const guarded = new RegExp(
          String.raw`alter\s+table\s+${table}\s+enable\s+row\s+level\s+security`,
          'i'
        ).test(everySql);
        if (!guarded) unguarded.push(`${file} → ${table}`);
      }
    }

    assert.deepEqual(
      unguarded,
      [],
      `tables created after 032 with no RLS block anywhere in the migration tree:\n  ${unguarded.join('\n  ')}`
    );
  });

  // MTD-2 (GB VAT profile + obligation persistence). Renumbered 109 → 111 on the
  // 2026-07-29 rebase: 109/110 were taken by the K1 knowledge base and its RLS
  // fix while that branch sat on an older base.
  await test('111 creates the MTD-2 VAT projection with its vocabularies pinned to the runtime', () => {
    const sql = readMigration('111_vat_profiles_and_periods.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+vat_customer_profiles\b/i, 'creates vat_customer_profiles');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+vat_periods\b/i, 'creates vat_periods');
    // The closed obligation state vocabulary, pinned to hmrcVatObligations.js —
    // a status the writer emits but the column rejects is a silent fail.
    for (const s of VAT_PERIOD_STATUSES) {
      assert.match(sql, new RegExp(String.raw`'${s}'`), `status CHECK includes '${s}'`);
    }
    // Tenant-scoped, unlike K1: these rows ARE about a customer, so they carry
    // the tenant boundary and die with it.
    assert.match(sql, /firm_id\s+text\s+not\s+null\s+references\s+firms\(id\)\s+on\s+delete\s+cascade/i, 'firm cascade');
    assert.match(sql, /client_id\s+text\s+not\s+null\s+references\s+clients\(id\)\s+on\s+delete\s+cascade/i, 'client cascade');
  });

  await test('111 is additive, and does NOT pin a period to one row forever', () => {
    const sql = readMigration('111_vat_profiles_and_periods.sql');
    const code = sql.replace(/--[^\n]*/g, '');
    // An authority may legitimately restate a period; a forever-unique
    // (client, period_key) constraint would refuse the restatement rather than
    // record it.
    assert.doesNotMatch(code, /unique[^\n]*period_key/i, 'no forever-unique period constraint');
    assert.doesNotMatch(code, /create\s+unique\s+index[^\n]*period_key/i, 'and none as a unique index');
    // Additive only: this migration may not reshape existing data.
    assert.doesNotMatch(code, /drop\s+table|drop\s+column|alter\s+column/i, 'additive only');
  });

  // The RLS convention is enforced fleet-wide by the ratchet below (added in
  // #1160); this pins 111's own block so a rebase or edit cannot quietly drop it
  // while the ratchet still passes on some other table's block.
  await test('111 carries its own RLS block, and creates no browser policy', () => {
    const sql = readMigration('111_vat_profiles_and_periods.sql');
    const code = sql.replace(/--[^\n]*/g, '');
    for (const table of ['vat_customer_profiles', 'vat_periods']) {
      assert.match(
        code,
        new RegExp(String.raw`alter\s+table\s+${table}\s+enable\s+row\s+level\s+security`, 'i'),
        `${table}: RLS enabled`
      );
      assert.match(code, new RegExp(String.raw`revoke\s+all\s+on\s+${table}\s+from\s+anon`, 'i'), `${table}: anon revoked`);
      assert.match(
        code,
        new RegExp(String.raw`revoke\s+all\s+on\s+${table}\s+from\s+authenticated`, 'i'),
        `${table}: authenticated revoked`
      );
    }
    // 032's posture: blanket lockdown with NO browser data policies. A policy
    // here would re-open the very PostgREST path the block closes — so the
    // ratchet deliberately does NOT ask for tenant policies, and neither do we.
    assert.doesNotMatch(code, /create\s+policy/i, 'no browser policy');
    assert.doesNotMatch(code, /force\s+row\s+level\s+security/i, 'ENABLE, not FORCE');
  });

  await test('115 creates user_feedback with its kind vocabulary pinned to the runtime', () => {
    const sql = readMigration('115_user_feedback.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+user_feedback/i, 'creates user_feedback');
    const checkMatch = sql.match(/kind\s+text\s+not\s+null\s+check\s*\(kind\s+in\s*\(([^)]*)\)\)/i);
    assert.ok(checkMatch, 'kind carries a CHECK vocabulary');
    const sqlKinds = [...checkMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    assert.deepEqual(sqlKinds, [...FEEDBACK_KINDS].sort(), 'CHECK matches FEEDBACK_KINDS');
    assert.match(sql, /status\s+text\s+not\s+null\s+default\s+'new'/i, "status defaults to 'new' (on Kari)");
  });

  await test('116 creates model_challenger_runs with the outcome CHECK pinned to the runtime and RLS-native', () => {
    const sql = readMigration('116_model_challenger_runs.sql');
    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+model_challenger_runs/i, 'creates model_challenger_runs');
    const checkMatch = sql.match(/outcome\s+text\s+not\s+null\s+check\s*\(outcome\s+in\s*\(([^)]*)\)\)/i);
    assert.ok(checkMatch, 'outcome carries a CHECK vocabulary');
    const sqlOutcomes = [...checkMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    assert.deepEqual(sqlOutcomes, [...CHALLENGER_OUTCOMES].sort(), 'CHECK matches CHALLENGER_OUTCOMES');
    // Both FK cascades: a deleted client's challenger receipts die with it
    // (they are R&D telemetry about that book, not survivable memory).
    assert.match(sql, /firm_id\s+text\s+not\s+null\s+references\s+firms\(id\)\s+on\s+delete\s+cascade/i);
    assert.match(sql, /client_id\s+text\s+not\s+null\s+references\s+clients\(id\)\s+on\s+delete\s+cascade/i);
    // RLS-native: ENABLE + guarded revoke, never FORCE (the house pattern).
    assert.match(sql, /alter\s+table\s+model_challenger_runs\s+enable\s+row\s+level\s+security/i, 'enables RLS');
    assert.match(sql, /revoke\s+all\s+on\s+model_challenger_runs\s+from\s+anon/i, 'revokes anon');
    assert.doesNotMatch(sql, /force\s+row\s+level\s+security/i, 'never FORCE — owner stays exempt');
  });

  await test('117 extends client_assignments for specialist roles (S2) with vocabularies pinned to the runtime', () => {
    const sql = readMigration('117_specialist_role_assignments.sql');
    // assignment_kind: the two-kind split, capability rows backfilled by default.
    assert.match(sql, /add\s+column\s+if\s+not\s+exists\s+assignment_kind\s+text\s+not\s+null\s+default\s+'capability'/i);
    const kindMatch = sql.match(/check\s*\(assignment_kind\s+in\s*\(([^)]*)\)\)/i);
    assert.ok(kindMatch, 'assignment_kind carries a CHECK vocabulary');
    assert.deepEqual(
      [...kindMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort(),
      ['capability', 'specialist_role']
    );
    // status: pinned to the RoleAssignment shape law (roleRegistry.ASSIGNMENT_STATUSES).
    const statusMatch = sql.match(/check\s*\(status\s+in\s*\(([^)]*)\)\)/i);
    assert.ok(statusMatch, 'status carries a CHECK vocabulary');
    assert.deepEqual(
      [...statusMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort(),
      [...ASSIGNMENT_STATUSES].sort(),
      'status CHECK matches ASSIGNMENT_STATUSES'
    );
    // AI occupants become a principal type; humans keep theirs.
    const principalMatch = sql.match(/check\s*\(principal_type\s+in\s*\(([^)]*)\)\)/i);
    assert.ok(principalMatch, 'principal_type carries a CHECK vocabulary');
    assert.deepEqual(
      [...principalMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort(),
      ['ai_occupant', 'firm_collaborator', 'firm_member']
    );
    // The unique split: the day-one key becomes capability-only (selfProvisionDb's
    // conflict target), and specialist rows get one-occupant-per-role-per-client.
    assert.match(sql, /drop\s+constraint\s+if\s+exists\s+client_assignments_client_id_principal_type_principal_id_key/i);
    assert.match(sql, /create\s+unique\s+index\s+if\s+not\s+exists\s+client_assignments_capability_uniq[\s\S]*?where\s+assignment_kind\s*=\s*'capability'/i);
    assert.match(sql, /create\s+unique\s+index\s+if\s+not\s+exists\s+client_assignments_specialist_role_uniq[\s\S]*?where\s+assignment_kind\s*=\s*'specialist_role'/i);
    // The extended 042 source CHECK carries the hire flow's provenance value.
    const sourceMatch = sql.match(/check\s*\(source\s+in\s*\(([^)]*)\)\)/i);
    assert.ok(sourceMatch, 'client_capability_config.source carries the extended CHECK');
    const sources = [...sourceMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.ok(sources.includes(ROLE_HIRE_CONFIG_SOURCE), `source CHECK includes '${ROLE_HIRE_CONFIG_SOURCE}'`);
    assert.ok(['default', 'cohort', 'manual', 'emergency_override'].every((s) => sources.includes(s)),
      'the pre-117 source vocabulary survives');
    // No new table, no new store — the INV-S4/no-new-spine posture of the slice.
    assert.doesNotMatch(sql, /create\s+table/i, '117 creates no table');
  });

  await test('126 creates separated host/entity readiness read models and immutable host attempts', () => {
    const sql = readMigration('126_runtime_readiness.sql');
    for (const table of [
      'runtime_host_readiness_attempts',
      'runtime_host_readiness',
      'entity_readiness_sagas'
    ]) {
      assert.match(sql, new RegExp(String.raw`create\s+table\s+if\s+not\s+exists\s+${table}\b`, 'i'), `creates ${table}`);
      assert.match(sql, new RegExp(String.raw`alter\s+table\s+${table}\s+enable\s+row\s+level\s+security`, 'i'), `RLS on ${table}`);
    }
    assert.match(sql, /entity_readiness_sagas[\s\S]*primary\s+key\s*\(firm_id,\s*client_id\)/i,
      'one entity saga per firm/client');
    assert.match(sql, /latest_attempt_id\s+bigint\s+not\s+null\s+references\s+audit_events\(id\)/i,
      'entity current state points into the existing audit substrate');
    assert.match(sql, /runtime_host_readiness_attempts_append_only_guard/i, 'host attempts have a database immutability guard');
    assert.doesNotMatch(sql, /force\s+row\s+level\s+security/i, 'server owner remains RLS-exempt');
  });

  await test('127 invalidates ready entity generations on every load-bearing dependency plane', () => {
    const sql = readMigration('127_entity_readiness_admission.sql');
    assert.match(sql, /create\s+or\s+replace\s+function\s+invalidate_entity_readiness_dependency/i);
    assert.match(sql, /pg_advisory_xact_lock[\s\S]*entity-readiness:/i,
      'dependency writer shares the provisioning/admission serialization key');
    assert.match(sql, /'entity\.readiness\.invalidated'/i, 'invalidation appends an existing-audit receipt');
    assert.match(sql, /state\s*=\s*'failed'[\s\S]*reason_code\s*=\s*'entity_dependency_changed'/i);
    for (const trigger of [
      'clients_invalidate_entity_readiness',
      'client_assignments_invalidate_entity_readiness',
      'ledger_accounts_invalidate_entity_readiness',
      'client_capability_config_invalidate_entity_readiness',
      'reconciliation_grants_invalidate_entity_readiness',
      'action_grants_invalidate_entity_readiness',
      'firm_members_invalidate_entity_readiness',
      'firm_collaborators_invalidate_entity_readiness'
    ]) assert.match(sql, new RegExp(String.raw`create\s+trigger\s+${trigger}\b`, 'i'), `creates ${trigger}`);
    assert.match(sql, /flag_key\s*=\s*'ENTITY_READINESS_ADMISSION'/i,
      'the admitted rollout extension does not invalidate the certified dependency digest');
    assert.doesNotMatch(sql, /create\s+table/i, 'reuses saga and audit substrates; no second store');
  });

  await test('129 de-links deleted-client decision receipts without weakening append-only evidence', () => {
    const sql = readMigration('129_llm_decision_client_detachment.sql');
    assert.match(sql, /alter\s+table\s+llm_decisions\s+alter\s+column\s+client_id\s+drop\s+not\s+null/i,
      'the archival receipt can match audit_events by dropping its live client link');
    assert.match(sql, /add\s+column\s+if\s+not\s+exists\s+client_detached_at\s+timestamptz/i,
      'the one-way de-link has its own durable per-row receipt');
    assert.match(sql, /old\.client_id\s+is\s+not\s+null[\s\S]*new\.client_id\s+is\s+null/i);
    assert.match(sql, /old\.client_detached_at\s+is\s+null[\s\S]*new\.client_detached_at\s+is\s+not\s+null/i);
    assert.match(sql, /current_setting\('donna\.allow_llm_decision_client_detachment',\s*true\)/i,
      'the exception requires the named transaction-local authority signal');
    assert.match(sql, /new\.llm_reasoning\s+is\s+null[\s\S]*new\.llm_raw_response\s+is\s+null/i,
      'no receipt de-links until both prose tiers are destroyed');
    assert.match(sql, /d\.created_at\s+is\s+null\s+or\s+d\.created_at\s*<\s*c\.created_at/i,
      'the backfill distinguishes prior receipts from current-generation decisions');
    assert.match(sql, /not\s+exists\s*\([\s\S]*from\s+clients/i,
      'already-orphaned receipts are healed too');
    assert.match(sql, /llm_decision\.client_detachment_backfill/i, 'the repair has a firm-level audit receipt');
    assert.doesNotMatch(sql, /delete\s+from\s+llm_decisions/i, 'Tier-1 evidence survives; it is minimized, not deleted');
  });

  await test('132 adds the AR-4E explicit fallback, approval contract and exact delivery receipt', () => {
    const sql = readMigration('132_outbound_language_receipts.sql');
    assert.match(sql, /alter\s+table\s+client_parties[\s\S]*fallback_language\s+text/i);
    assert.match(sql, /alter\s+table\s+outbound_actions[\s\S]*approved_delivery_contract_version\s+integer/i);
    assert.match(sql, /approved_delivery_contract_fingerprint\s+text/i);
    for (const field of [
      'requested_language', 'actual_language', 'language_source',
      'language_fallback_basis', 'correspondence_locale', 'template_name',
      'template_catalog_id', 'template_catalog_version', 'rendered_html',
      'attachment_manifest', 'content_fingerprint', 'delivery_contract_version',
      'delivery_contract_fingerprint'
    ]) {
      assert.match(sql, new RegExp(String.raw`\b${field}\b`, 'i'), `delivery receipt carries ${field}`);
    }
    assert.match(sql, /attachment_manifest\s+jsonb\s+not\s+null\s+default\s+'\[\]'::jsonb/i);
    assert.doesNotMatch(sql, /add\s+.*arabic|correspondence.*ar/i,
      'the delivery substrate does not declare Arabic support');
  });

  await test('133 scopes the dependency fence to foreign writes and restores host-charged sagas with receipts (RT-09)', () => {
    const sql = readMigration('133_entity_readiness_admitted_write_scope.sql');
    assert.match(sql, /create\s+or\s+replace\s+function\s+invalidate_entity_readiness_dependency/i,
      'the one function every 127 trigger funnels through is replaced in place');
    assert.doesNotMatch(sql, /create\s+trigger/i, 'no trigger is redefined; 127 owns them');
    assert.doesNotMatch(sql, /create\s+table/i, 'reuses saga and audit substrates; no second store');
    assert.match(sql, /current_setting\('donna\.admitted_generation',\s*true\)/i,
      'the scope is the transaction-local GUC the admission helper sets');
    assert.match(sql, /admitted_generation\s*=\s*saga\.ready_dependency_digest/i,
      'only the EXACT ready generation digest scopes the fence — a stale value invalidates');
    assert.match(sql, /'entity\.readiness\.admitted_write_scoped'/i, 'a scoped write is receipted, never silent');
    assert.match(sql, /pg_advisory_xact_lock[\s\S]*entity-readiness:/i, 'the lock order of 127 is preserved');
    assert.match(sql, /'entity\.readiness\.invalidated'[\s\S]*reason_code\s*=\s*'entity_dependency_changed'/i,
      'the foreign-write invalidation branch is unchanged');
    assert.match(sql, /pg_get_constraintdef\(oid\)\s+ilike\s+'%retry_state = ''scheduled''%next_retry_at is not null%'/i,
      '126\'s unnamed "a scheduled retry has a clock" shape constraint is located by definition, not by auto-generated name');
    assert.match(sql, /add\s+constraint\s+entity_readiness_sagas_scheduled_retry_check[\s\S]*next_retry_at\s+is\s+not\s+null\s+or\s+reason_code\s+like\s+'host\\_%'/i,
      'a clockless scheduled retry must name the host it waits for');
    assert.match(sql, /'entity\.readiness\.host_wait_budget_restored'/i, 'host-charged rows are restored with a receipt');
    assert.match(sql, /state\s*=\s*'failed'[\s\S]*reason_code\s+in\s*\([\s\S]*'host_certificate_not_pass'[\s\S]*'host_certificate_expired'/i,
      'the restore is scoped to failed sagas resting on a host-wait reason');
    assert.match(sql, /attempt_count\s*=\s*0,\s*retry_state\s*=\s*'scheduled',\s*next_retry_at\s*=\s*null/i,
      'restored rows take the clockless host-wait resting shape the heal selects');
    assert.match(sql, /attempt_count\s*<>\s*0\s+or\s+retry_state\s*<>\s*'scheduled'\s+or\s+next_retry_at\s+is\s+not\s+null/i,
      'idempotent: a row already at rest is left alone');
    assert.doesNotMatch(sql, /set\s+state\s*=\s*'ready'/i, 'no row is promoted to ready by a migration');
    assert.match(sql, /with\s+candidates\s+as\s*\(\s*select[\s\S]*where\s+state\s*=\s*'failed'/i,
      'the restore selects failed rows only; ready rows are never rewritten');
    assert.doesNotMatch(sql, /'entity_dependency_changed'\s*\)/i, 'entity-side failures keep their explicit reopen exit');
  });

  console.log(`\nmigrations: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
};

runTests();
