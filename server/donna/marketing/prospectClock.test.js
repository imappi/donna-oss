// Prospect clock (M2) — coverage for the pure dueness classification (the
// two-terminal-states table applied on a timer) and the sweep's behavior:
// quiet when nothing is due, receipt + nudge when something is, cooldown
// idempotence, kill switch, and loud (never silent) degradation when the
// nudge cannot be delivered. All impls injected — no pg, no Resend.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DUE_KINDS,
  classifyProspectDueness,
  runMarketingProspectsDueSweep,
  summarizeDueness
} from './prospectClock.js';

const NOW = new Date('2026-07-24T12:00:00Z');
const DAYS = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

// ── Classification ───────────────────────────────────────────────────────────

test('legal rests classify as null: terminals, research_only, fresh transients, undated on_kari, live clocks', () => {
  for (const prospect of [
    { status: 'converted' },
    { status: 'unfit' },
    { status: 'suppressed' },
    { status: 'closed_no_reply' },
    { status: 'research_only', updated_at: DAYS(90) }, // parked deliberately, never clock-due
    { status: 'on_kari', updated_at: DAYS(30) }, // his queue IS the surface
    { status: 'on_kari', next_action_at: DAYS(-3) }, // future revisit date
    { status: 'contacted_awaiting_reply', next_action_at: DAYS(-1) }, // live clock
    { status: 'candidate', updated_at: DAYS(2) },
    { status: 'investigating', updated_at: DAYS(2) },
    { status: 'approved_for_draft', updated_at: DAYS(2) }
  ]) {
    assert.equal(classifyProspectDueness(prospect, { now: NOW }), null, JSON.stringify(prospect));
  }
});

test('expired clocks and stalled rests classify to their due kind', () => {
  assert.equal(
    classifyProspectDueness({ status: 'on_kari', next_action_at: DAYS(1) }, { now: NOW }).due_kind,
    'revisit_due'
  );
  assert.equal(
    classifyProspectDueness({ status: 'contacted_awaiting_reply', next_action_at: DAYS(1) }, { now: NOW }).due_kind,
    'follow_up_due'
  );
  assert.equal(
    classifyProspectDueness({ status: 'candidate', updated_at: DAYS(8) }, { now: NOW }).due_kind,
    'stalled_transient'
  );
  assert.equal(
    classifyProspectDueness({ status: 'investigating', updated_at: DAYS(8) }, { now: NOW }).due_kind,
    'stalled_transient'
  );
  assert.equal(
    classifyProspectDueness({ status: 'approved_for_send', updated_at: DAYS(8) }, { now: NOW }).due_kind,
    'blocked_on_sends'
  );
});

test('contacted_awaiting_reply WITHOUT a clock is due immediately — a missing clock is a violation, not a rest', () => {
  const verdict = classifyProspectDueness(
    { status: 'contacted_awaiting_reply', next_action_at: null, updated_at: DAYS(1) },
    { now: NOW }
  );
  assert.equal(verdict.due_kind, 'follow_up_due');
});

test('summarizeDueness counts by kind and carries the render fields', () => {
  const { due, counts, due_total } = summarizeDueness(
    [
      { id: 'a', company_name: 'Acme', status: 'on_kari', tier: 'green', next_action_at: DAYS(1) },
      { id: 'b', company_name: 'Beta', status: 'candidate', tier: 'yellow', updated_at: DAYS(9) },
      { id: 'c', company_name: 'Cato', status: 'on_kari', tier: 'green', updated_at: DAYS(1) }
    ],
    { now: NOW }
  );
  assert.equal(due_total, 2);
  assert.equal(counts.revisit_due, 1);
  assert.equal(counts.stalled_transient, 1);
  assert.deepEqual(Object.keys(counts).sort(), [...DUE_KINDS].sort());
  assert.deepEqual(due.map((d) => d.id).sort(), ['a', 'b']);
  assert.ok(due.every((d) => d.company_name && d.status && d.due_kind));
});

// ── The sweep ────────────────────────────────────────────────────────────────

const sweepHarness = ({ prospects = [], lastRunAt = null, sendResult = { ok: true }, env = {} } = {}) => {
  const calls = { started: [], finished: [], emails: [] };
  return {
    calls,
    run: (overrides = {}) =>
      runMarketingProspectsDueSweep({
        now: NOW,
        env: { MARKETING_CLOCK_NUDGE_TO: 'kari@books.example', ...env },
        logger: { error: () => {}, warn: () => {} },
        listClockProspectsImpl: async () => prospects,
        lastClockRunAtImpl: async () => lastRunAt,
        startSourceRunImpl: async (args) => {
          calls.started.push(args);
          return { id: 'run-1' };
        },
        finishSourceRunImpl: async (args) => {
          calls.finished.push(args);
        },
        sendEmailImpl: async (args) => {
          calls.emails.push(args);
          return sendResult;
        },
        ...overrides
      })
  };
};

const DUE_PROSPECT = { id: 'p1', company_name: 'Acme', status: 'on_kari', tier: 'green', next_action_at: DAYS(1) };

test('kill switch: MARKETING_CLOCK_FORCE_DISABLE stops the sweep before any read', async () => {
  const h = sweepHarness({ env: { MARKETING_CLOCK_FORCE_DISABLE: '1' } });
  const summary = await h.run({
    listClockProspectsImpl: async () => {
      throw new Error('must not be called');
    }
  });
  assert.equal(summary.disabled, true);
  assert.equal(h.calls.started.length, 0);
});

test('quiet clock: nothing due → no receipt row, no email', async () => {
  const h = sweepHarness({ prospects: [{ status: 'on_kari', updated_at: DAYS(1) }] });
  const summary = await h.run();
  assert.equal(summary.due_total, 0);
  assert.equal(summary.receipt_run_id, null);
  assert.equal(h.calls.started.length, 0);
  assert.equal(h.calls.emails.length, 0);
});

test('due work → receipt run + nudge email, counts in the receipt params', async () => {
  const h = sweepHarness({ prospects: [DUE_PROSPECT] });
  const summary = await h.run();
  assert.equal(summary.due_total, 1);
  assert.equal(summary.nudge_sent, true);
  assert.equal(summary.receipt_run_id, 'run-1');
  assert.equal(h.calls.started[0].source, 'prospect_clock');
  assert.equal(h.calls.started[0].params.due_total, 1);
  assert.equal(h.calls.started[0].startedBy, 'system:prospect_clock');
  assert.match(h.calls.emails[0].subject, /Prospect clock: 1 item due/);
  assert.match(h.calls.emails[0].text, /Acme/);
  assert.equal(h.calls.finished[0].error, null);
});

test('cooldown: a recent clock receipt suppresses the round entirely (no second receipt, no email)', async () => {
  const h = sweepHarness({ prospects: [DUE_PROSPECT], lastRunAt: DAYS(0.5) });
  const summary = await h.run();
  assert.equal(summary.due_total, 1);
  assert.equal(summary.nudge_skipped_recent, true);
  assert.equal(h.calls.started.length, 0);
  assert.equal(h.calls.emails.length, 0);
});

test('cooldown expired: the clock escalates again while items stay due', async () => {
  const h = sweepHarness({ prospects: [DUE_PROSPECT], lastRunAt: DAYS(2) });
  const summary = await h.run();
  assert.equal(summary.nudge_sent, true);
  assert.equal(h.calls.started.length, 1);
});

test('no recipient configured: receipt still minted, skip is loud in summary AND on the receipt', async () => {
  const h = sweepHarness({ prospects: [DUE_PROSPECT], env: { MARKETING_CLOCK_NUDGE_TO: '' } });
  const summary = await h.run();
  assert.equal(summary.nudge_sent, false);
  assert.equal(summary.nudge_skipped_no_recipient, true);
  assert.equal(summary.receipt_run_id, 'run-1');
  assert.match(h.calls.finished[0].error, /MARKETING_CLOCK_NUDGE_TO/);
  assert.equal(summary.errors.length, 1);
});

test('email failure: recorded on the receipt and in the summary, never thrown', async () => {
  const h = sweepHarness({ prospects: [DUE_PROSPECT], sendResult: { ok: false, error: 'resend down' } });
  const summary = await h.run();
  assert.equal(summary.nudge_sent, false);
  assert.match(h.calls.finished[0].error, /resend down/);
  assert.equal(summary.errors.length, 1);
});
