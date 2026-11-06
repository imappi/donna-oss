// AE VAT lane self-start (RT-19, forensics F-23) — the real-PostgreSQL
// acceptance fixture.
//
// The bug, stated as the row it left behind: a UAE client with an FTA VAT
// payment coded on its statement, no registration record and therefore an
// empty ae_vat_periods table, rested on NOBODY — the threshold watch asks
// only once turnover crosses AED 375,000, the return lane's period-intake
// ask covers registrants only, and nothing else asked. This fixture runs the
// REAL jurisdiction-neutral sweep (packs → bindings → firmDb re-export → the
// lane drain) against a migrated scratch database and proves:
//
//   1. a client with a coded FTA VAT payment and no registration → exactly
//      ONE open statutory VAT-registration ask, evidence named in its
//      payload, audit-as-precondition, and it survives a second sweep
//      (dedup on the open ask);
//   2. the reply with TRN + effective date + period → the registration
//      record, an ae_vat_periods row whose TRN came from the RECORD (the
//      writer's rule), the actor-attributed audit, the ask resolved — and the
//      drain now discharges the client;
//   3. a "not registered" reply → recorded; no re-ask for 90 days even with
//      the contradicting evidence still in the book; re-asked on day 90 with
//      the contradiction named; a not-registered client with NO activity is
//      never re-asked from this lane;
//   4. a registered reply with no period hands the row to the return lane's
//      intake ask (the same deterministic id its daily drain mints), so the
//      client moves from one owner question to the next, never to nobody;
//   5. a structurally invalid TRN is refused before any write.
//
// OPT-IN like its siblings: set DONNA_PG_TEST_URL to a scratch PostgreSQL
// whose role may CREATE DATABASE; without it the test SKIPS loudly. Every
// migration is applied VERBATIM to a throwaway database and firmDb is
// pointed at it via DATABASE_URL, so the bindings' own withFirmDbClient and
// the reply path's writers run for real.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import {
  __endFirmDbPoolForTests
} from './firmDb.js';
import {
  drainAeVatRegistrationEscalations,
  drainAeVatReturnDeadlineEscalations
} from './statutoryRegistry.js';
import { runStatutoryObligationSweep } from './outbound/statutoryObligations.js';
import { recordAeVatRegistrationReply } from './ae/vatRegistrationReply.js';
import { AE_VAT_REGISTRATION_REASK_DAYS } from './ae/vatRegistrationEscalation.js';
import { aeVatReturnPeriodIntakeAskId } from './ae/vatReturnDeadlines.js';
import { toLocalIsoDay } from './dates.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const FIRM = 'firm-aevat';
const OWNER = 'owner@desert-rose.example';
const TRN = '100 1234 5678 9012';
const plusDays = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

test(
  'AE VAT lane self-starts on real PG: coded FTA VAT payment → one statutory ask → reply records registration + period through the audited writer; "not registered" holds for 90 days',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — real-PG AE VAT self-start not exercised in this run' },
  async () => {
    const dbName = `donna_aevat_${Date.now().toString(36)}_${process.pid}`;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    const scratchUrl = new URL(PG_URL);
    scratchUrl.pathname = `/${dbName}`;
    const seed = new pg.Client({ connectionString: scratchUrl.toString() });
    await seed.connect();
    const priorDatabaseUrl = process.env.DATABASE_URL;
    try {
      await seed.query(`
        create schema if not exists storage;
        create table if not exists storage.buckets (
          id text primary key, name text, public boolean,
          file_size_limit bigint, allowed_mime_types text[]);
        create table if not exists storage.objects (
          id uuid default gen_random_uuid() primary key,
          bucket_id text references storage.buckets(id), name text, metadata jsonb);
      `);
      const migrations = (await readdir(path.join(ROOT, 'db', 'migrations')))
        .filter((file) => file.endsWith('.sql'))
        .sort();
      for (const file of migrations) {
        await seed.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
      }
      process.env.DATABASE_URL = scratchUrl.toString();

      await seed.query(`insert into firms (id, name, slug) values ($1, 'AE VAT Firm', 'ae-vat-firm')`, [FIRM]);
      const mintClient = async (id, name, profile = {}) => {
        await seed.query(
          `insert into clients (id, firm_id, company_name, jurisdiction, profile)
           values ($1, $2, $3, 'AE', $4::jsonb)`,
          [id, FIRM, name, JSON.stringify({ jurisdiction: 'ae', ...profile })]
        );
        await seed.query(
          `insert into ledger_accounts (id, firm_id, client_id, code, name, account_type, normal_balance, currency, canonical_role, status)
           values ($1, $2, $3, '2200', 'VAT payable', 'liability', 'credit', 'AED', 'liability.sales_tax_payable', 'active')`,
          [`la-vat-${id}`, FIRM, id]
        );
      };
      const codeFtaPayment = async (clientId, txId) => seed.query(
        `insert into transactions (id, firm_id, client_id, transaction_date, description, money_out, currency, account_code, payload)
         values ($1, $2, $3, '2026-04-28', 'FTA VAT PAYMENT EMARATAX', 1250.00, 'AED', '2200',
                 '{"ai_suggestion": {"proposed_account": "VAT payable", "confidence": 0.94}}'::jsonb)`,
        [txId, FIRM, clientId]
      );
      const openAsks = async (clientId, evidenceType = 'vat_registration_status') => (await seed.query(
        `select id, status, question, request_payload, response_payload
           from client_evidence_requests
          where firm_id = $1 and client_id = $2 and evidence_type = $3
          order by created_at asc`,
        [FIRM, clientId, evidenceType]
      )).rows;

      // A: desert rose — coded FTA VAT payment, no registration record.
      await mintClient('desert-rose', 'Desert Rose Cafe LLC');
      await codeFtaPayment('desert-rose', 'tx-fta-dr');
      // B: same evidence; will answer "not registered".
      await mintClient('palm-court', 'Palm Court Trading LLC');
      await codeFtaPayment('palm-court', 'tx-fta-pc');
      // C: no VAT activity at all; will answer "not registered".
      await mintClient('quiet-shop', 'Quiet Shop FZ-LLC');
      // D: will answer registered WITHOUT a period.
      await mintClient('gulf-studio', 'Gulf Studio LLC');
      await codeFtaPayment('gulf-studio', 'tx-fta-gs');

      // ── 1. The hourly sweep, end to end through the real bindings ────────
      const hourly = await runStatutoryObligationSweep({ cadence: 'hourly' });
      assert.equal(hourly.cadence, 'hourly');
      assert.deepEqual(hourly.obligations.map((o) => [o.binding, o.outcome]), [['ae_vat_registration_escalation', 'ran']]);
      const receipt = hourly.obligations[0].summary;
      assert.deepEqual(
        { scanned: receipt.scanned, evidence_seen: receipt.evidence_seen, minted: receipt.minted, errors: receipt.errors },
        { scanned: 4, evidence_seen: 3, minted: 4, errors: 0 },
        `receipt: ${JSON.stringify(receipt)}`
      );
      const drAsks = await openAsks('desert-rose');
      assert.equal(drAsks.length, 1, 'exactly one statutory VAT-registration ask');
      assert.equal(drAsks[0].status, 'open');
      assert.match(drAsks[0].question, /Your books show a bank line coded to your VAT payable account on 2026-04-28 \(AED 1,250\.00\)/);
      assert.equal(drAsks[0].request_payload.reason, 'status_unknown_with_activity');
      assert.deepEqual(drAsks[0].request_payload.vat_activity_evidence.map((e) => [e.kind, e.ref]), [['vat_control_account_coding', 'tx-fta-dr']]);
      const askAudit = await seed.query(
        `select actor_type, actor_id, resource_id, metadata from audit_events
          where firm_id = $1 and client_id = 'desert-rose' and action = 'vat_registration.status_asked'`,
        [FIRM]
      );
      assert.equal(askAudit.rows.length, 1);
      assert.equal(askAudit.rows[0].resource_id, drAsks[0].id);
      assert.equal(askAudit.rows[0].metadata.authority_basis, 'statutory_obligation:ae_vat_registration');
      // The quiet client is asked the plain onboarding question.
      const qsAsks = await openAsks('quiet-shop');
      assert.equal(qsAsks.length, 1);
      assert.equal(qsAsks[0].request_payload.reason, 'status_unknown');

      // Dedup: the daily sweep the next day mints nothing new for any of them.
      const nextDay = await drainAeVatRegistrationEscalations({ client: seed, asOf: '2026-09-02', deliverAsksImpl: async () => { throw new Error('must not deliver'); } });
      assert.deepEqual({ minted: nextDay.minted, skip_reasons: nextDay.skip_reasons }, { minted: 0, skip_reasons: { ask_open: 4 } });
      assert.equal((await openAsks('desert-rose')).length, 1);

      // ── 2. The reply: TRN + effective date + FTA period ──────────────────
      const replied = await recordAeVatRegistrationReply({
        firmId: FIRM,
        clientId: 'desert-rose',
        evidenceRequestId: drAsks[0].id,
        actorId: OWNER,
        actorType: 'client',
        reply: 'Yes registered. TRN 100 1234 5678 9012 since 1 Jan 2026, quarter Apr-Jun 2026 due 28 Jul.',
        source: 'portal',
        answer: {
          registered: true,
          trn: TRN,
          registered_from: '2026-01-01',
          vat_return_period: 'quarterly',
          periods: [{ period_key: 'Apr-Jun 2026', start_date: '2026-04-01', end_date: '2026-06-30', due_date: '2026-07-28' }]
        },
        deliverAsksImpl: async () => {}
      });
      assert.equal(replied.registration.registered, true);
      assert.equal(replied.registration.registrationId, TRN);
      assert.equal(replied.registration.confirmedAgainstPrimary, false, 'an owner attestation is not a primary-source verification');
      assert.deepEqual(replied.periods.map((p) => [p.periodKey, p.status, p.dueDateNote]), [['Apr-Jun 2026', 'open', null]]);
      assert.deepEqual(replied.ask, { id: drAsks[0].id, status: 'resolved' });
      assert.equal(replied.intakeAsk, null);

      const profile = (await seed.query(`select profile from clients where firm_id = $1 and id = 'desert-rose'`, [FIRM])).rows[0].profile;
      assert.equal(profile.vat_registration.status, 'registered');
      assert.equal(profile.vat_registration.vat_registration_number, TRN);
      assert.equal(profile.vat_registration.registered_from, '2026-01-01');
      assert.equal(profile.vat_registration.vat_return_period, 'quarter');
      assert.match(profile.vat_registration.verified_from, /owner attestation — reply to ask vat-registration-status-firm-aevat-desert-rose-/);
      assert.equal(profile.vat_registration.verified_at, null);
      assert.equal(profile.jurisdiction, 'ae', 'the single-key merge keeps the rest of the profile');

      const periods = (await seed.query(`select trn, period_key, start_date::text as start_date, end_date::text as end_date, due_date::text as due_date, status, source from ae_vat_periods where firm_id = $1 and client_id = 'desert-rose'`, [FIRM])).rows;
      assert.equal(periods.length, 1);
      assert.equal(periods[0].trn, TRN, 'the TRN on the period is the RECORD\'s, written by the audited writer');
      assert.deepEqual([periods[0].period_key, periods[0].start_date, periods[0].end_date, periods[0].due_date, periods[0].status],
        ['Apr-Jun 2026', '2026-04-01', '2026-06-30', '2026-07-28', 'open']);
      assert.equal(periods[0].source.recorded_by, OWNER);
      assert.match(periods[0].source.recorded_from, /^owner reply to ask vat-registration-status-firm-aevat-desert-rose-.* via portal$/);
      const periodAudit = (await seed.query(
        `select actor_type, actor_id, metadata from audit_events where firm_id = $1 and client_id = 'desert-rose' and action = 'ae_vat.period_recorded'`,
        [FIRM]
      )).rows;
      assert.equal(periodAudit.length, 1);
      assert.deepEqual([periodAudit[0].actor_type, periodAudit[0].actor_id, periodAudit[0].metadata.trn], ['operator', OWNER, TRN]);
      const replyAudit = (await seed.query(
        `select action, actor_type, actor_id from audit_events where firm_id = $1 and client_id = 'desert-rose'
           and action in ('vat_registration.recorded_from_reply', 'vat_registration.reply_recorded') order by action`,
        [FIRM]
      )).rows;
      assert.deepEqual(replyAudit, [
        { action: 'vat_registration.recorded_from_reply', actor_type: 'client', actor_id: OWNER },
        { action: 'vat_registration.reply_recorded', actor_type: 'client', actor_id: OWNER }
      ]);
      const resolvedAsk = (await openAsks('desert-rose'))[0];
      assert.equal(resolvedAsk.status, 'resolved');
      assert.deepEqual(resolvedAsk.response_payload.recorded, {
        registration_status: 'registered', registered_from: '2026-01-01', trn_recorded: true, period_keys: ['Apr-Jun 2026']
      });
      assert.equal(resolvedAsk.response_payload.answer_recorded_by, OWNER);

      // A second reply to the same ask is refused — the answer is not overwritten by a chat verb.
      await assert.rejects(
        recordAeVatRegistrationReply({ firmId: FIRM, clientId: 'desert-rose', evidenceRequestId: drAsks[0].id, actorId: OWNER, answer: { registered: false } }),
        (error) => error.code === 'AE_VAT_REGISTRATION_ASK_NOT_OPEN' && error.statusCode === 409
      );
      // A duplicate period key refuses through the writer's own rule.
      await assert.rejects(
        recordAeVatRegistrationReply({
          firmId: FIRM, clientId: 'desert-rose', evidenceRequestId: 'vat-registration-status-nope', actorId: OWNER, answer: { registered: true, trn: TRN, registered_from: '2026-01-01' }
        }),
        (error) => error.code === 'AE_VAT_REGISTRATION_ASK_NOT_FOUND'
      );

      // The drain now discharges the client; the return lane sees a recorded period and mints no intake ask.
      const afterReply = await drainAeVatRegistrationEscalations({ client: seed, firmId: FIRM, asOf: '2026-09-02', deliverAsksImpl: async () => {} });
      assert.equal(afterReply.skip_reasons.registered, 1);
      const returnLane = await drainAeVatReturnDeadlineEscalations({ client: seed, firmId: FIRM, asOf: '2026-09-02', deliverAsksImpl: async () => {} });
      assert.equal(returnLane.intake_minted, 0);
      assert.equal((await openAsks('desert-rose', 'vat_return_period_intake')).length, 0);

      // ── 3. "Not registered" holds for the window ─────────────────────────
      const pcAsk = (await openAsks('palm-court'))[0];
      const notRegistered = await recordAeVatRegistrationReply({
        firmId: FIRM, clientId: 'palm-court', evidenceRequestId: pcAsk.id, actorId: OWNER, reply: 'not registered', answer: { registered: false }
      });
      assert.equal(notRegistered.registration.registered, false);
      assert.equal(notRegistered.registration.reason, 'not_registered');
      const pcProfile = (await seed.query(`select profile from clients where firm_id = $1 and id = 'palm-court'`, [FIRM])).rows[0].profile;
      assert.equal(pcProfile.vat_registration.status, 'not_registered');
      assert.equal(pcProfile.vat_registration.vat_registration_number, null);
      const qsAsk = (await openAsks('quiet-shop'))[0];
      await recordAeVatRegistrationReply({ firmId: FIRM, clientId: 'quiet-shop', evidenceRequestId: qsAsk.id, actorId: OWNER, answer: { registered: false } });

      // The same "today" the reply path stamps (host wall clock, dates.js).
      const today = toLocalIsoDay(new Date());
      const inside = await drainAeVatRegistrationEscalations({ client: seed, firmId: FIRM, asOf: plusDays(today, AE_VAT_REGISTRATION_REASK_DAYS - 1), deliverAsksImpl: async () => { throw new Error('must not deliver'); } });
      assert.equal(inside.minted, 0, `inside the window: ${JSON.stringify(inside.skip_reasons)}`);
      assert.equal(inside.skip_reasons.answered_recently, 2, 'palm-court (with activity) and quiet-shop (without) both hold');
      assert.equal((await openAsks('palm-court')).length, 1);

      const after = await drainAeVatRegistrationEscalations({ client: seed, firmId: FIRM, asOf: plusDays(today, AE_VAT_REGISTRATION_REASK_DAYS), deliverAsksImpl: async () => {} });
      assert.equal(after.minted, 1, `after the window only the contradicted answer re-asks: ${JSON.stringify(after.skip_reasons)}`);
      assert.equal(after.skip_reasons.not_registered_no_activity, 1, 'quiet-shop is the threshold watch\'s, never this lane\'s');
      const pcAsks = await openAsks('palm-court');
      assert.equal(pcAsks.length, 2);
      assert.equal(pcAsks[1].status, 'open');
      assert.equal(pcAsks[1].request_payload.reason, 'not_registered_but_vat_activity');
      assert.equal(pcAsks[1].request_payload.previous_ask_id, pcAsk.id);
      assert.match(pcAsks[1].question, /You told me on \d{4}-\d{2}-\d{2} that you are not VAT registered, but your books now show/);
      assert.equal((await openAsks('quiet-shop')).length, 1);

      // ── 4. Registered without a period → the return lane's intake ask ────
      const gsAsk = (await openAsks('gulf-studio'))[0];
      const handedOver = await recordAeVatRegistrationReply({
        firmId: FIRM, clientId: 'gulf-studio', evidenceRequestId: gsAsk.id, actorId: 'kari@books.example', actorType: 'firm', source: 'phone',
        answer: { registered: true, trn: '100 9876 5432 1098', registered_from: '2025-07-01' }, deliverAsksImpl: async () => {}
      });
      const expectedIntakeId = aeVatReturnPeriodIntakeAskId({ firmId: FIRM, clientId: 'gulf-studio', year: Number(today.slice(0, 4)) });
      assert.deepEqual(handedOver.intakeAsk, { id: expectedIntakeId, status: 'open' });
      const gsIntake = await openAsks('gulf-studio', 'vat_return_period_intake');
      assert.equal(gsIntake.length, 1);
      assert.equal(gsIntake[0].request_payload.opened_by_reply_to, gsAsk.id);
      // The daily return-lane drain would mint the SAME id — on conflict, nothing doubles.
      const gsReturnLane = await drainAeVatReturnDeadlineEscalations({ client: seed, firmId: FIRM, asOf: today, deliverAsksImpl: async () => { throw new Error('must not deliver'); } });
      assert.equal(gsReturnLane.intake_minted, 0);
      assert.equal((await openAsks('gulf-studio', 'vat_return_period_intake')).length, 1);

      // ── 5. A bad TRN is refused before any write ─────────────────────────
      await seed.query(`insert into clients (id, firm_id, company_name, jurisdiction, profile) values ('bad-trn', $1, 'Bad TRN LLC', 'AE', '{"jurisdiction":"ae"}')`, [FIRM]);
      await drainAeVatRegistrationEscalations({ client: seed, firmId: FIRM, asOf: today, deliverAsksImpl: async () => {} });
      const badAsk = (await openAsks('bad-trn'))[0];
      await assert.rejects(
        recordAeVatRegistrationReply({ firmId: FIRM, clientId: 'bad-trn', evidenceRequestId: badAsk.id, actorId: OWNER, answer: { registered: true, trn: '12345', registered_from: '2026-01-01' } }),
        (error) => error.code === 'AE_VAT_REGISTRATION_REPLY_INVALID' && error.statusCode === 400
      );
      const badProfile = (await seed.query(`select profile from clients where firm_id = $1 and id = 'bad-trn'`, [FIRM])).rows[0].profile;
      assert.equal(badProfile.vat_registration, undefined, 'nothing written');
      assert.equal((await openAsks('bad-trn'))[0].status, 'open');
      await assert.rejects(
        recordAeVatRegistrationReply({ firmId: FIRM, clientId: 'bad-trn', evidenceRequestId: badAsk.id, actorId: '', answer: { registered: false } }),
        (error) => error.code === 'AE_VAT_REGISTRATION_REPLY_ACTOR_REQUIRED'
      );

      // Two-terminal-states check on the fixture's end state: every AE client
      // is either recorded (terminal 1 for this duty) or has an open owner ask.
      const rest = (await seed.query(
        `select c.id, c.profile->'vat_registration'->>'status' as status,
                (select count(*)::int from client_evidence_requests r where r.firm_id = c.firm_id and r.client_id = c.id and r.status in ('draft','open','replied')) as open_asks
           from clients c where c.firm_id = $1 order by c.id`,
        [FIRM]
      )).rows;
      for (const row of rest) {
        assert.ok(row.status === 'registered' || row.status === 'not_registered' || row.open_asks > 0, `client ${row.id} rests on nobody: ${JSON.stringify(row)}`);
      }
    } finally {
      process.env.DATABASE_URL = priorDatabaseUrl;
      await __endFirmDbPoolForTests().catch(() => {});
      await seed.end().catch(() => {});
      await admin.query(`drop database if exists "${dbName}" with (force)`).catch(() => {});
      await admin.end().catch(() => {});
    }
  }
);
