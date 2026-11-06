// The statutory-obligations leg (country-pack contract gap 3 / kernel-audit
// G12's core). Pins the properties that make this a country-pack leg rather
// than a second country fork:
//
//   - the binding NAME vocabulary (packs.js) and the IMPLEMENTATION registry
//     (this module) are equal in BOTH directions, so widening one alone fails
//     CI — the same discipline KNOWN_INVOICE_MANDATORY_FIELDS gets;
//   - a pack declaring an unknown binding refuses at LOAD, not at sweep;
//   - a 'declared_unbuilt' obligation is REPORTED on every run, never skipped
//     silently — the GB pack declares six and the sweep surfaces all six;
//   - an UNSURVEYED market is distinguishable from a market with no duties;
//   - Finland's two duties dispatch in the same order the country-named cron
//     ran them, and the implementation's own summary rides out verbatim;
//   - one failing obligation does not stop another market's;
//   - no cron task carries a country name any more.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  STATUTORY_OBLIGATION_BINDINGS, planStatutoryObligationSweep, runStatutoryObligationSweep
} from './statutoryObligations.js';
import {
  KNOWN_OBLIGATION_BINDINGS, KNOWN_OBLIGATION_STATUSES, KNOWN_OBLIGATION_SURVEY_STATES,
  loadOutboundPack, listAvailablePackIds, statutoryObligationsForPack, obligationSurveyForPack
} from './packs.js';
import { SUPPORTED_CRON_TASKS } from '../api.js';

// ── The registry contract ───────────────────────────────────────────────────

test('the binding vocabulary and the implementation registry are equal in both directions', () => {
  assert.deepEqual(
    Object.keys(STATUTORY_OBLIGATION_BINDINGS).sort(),
    [...KNOWN_OBLIGATION_BINDINGS].sort(),
    'widen KNOWN_OBLIGATION_BINDINGS (packs.js) and STATUTORY_OBLIGATION_BINDINGS together'
  );
  for (const [name, binding] of Object.entries(STATUTORY_OBLIGATION_BINDINGS)) {
    assert.equal(typeof binding.run, 'function', `${name} must bind a run()`);
  }
});

// ── Authored packs ──────────────────────────────────────────────────────────

test('every authored pack declares the obligations leg (never a missing key)', () => {
  for (const packId of listAvailablePackIds()) {
    const pack = loadOutboundPack(packId, { bypassCache: true });
    const survey = obligationSurveyForPack(pack);
    assert.ok(
      KNOWN_OBLIGATION_SURVEY_STATES.includes(survey.survey),
      `pack '${packId}' must declare obligations.survey`
    );
    for (const obligation of statutoryObligationsForPack(pack)) {
      assert.ok(KNOWN_OBLIGATION_STATUSES.includes(obligation.status));
      // Provenance travels with the duty wherever it surfaces (D5).
      assert.ok(obligation.authority && obligation.source && obligation.asOf);
    }
  }
});

test('FI declares its two bound duties — the exact pair the country-named cron ran', () => {
  const pack = loadOutboundPack('fi', { bypassCache: true });
  const bound = statutoryObligationsForPack(pack).filter((o) => o.status === 'bound');
  assert.deepEqual(bound.map((o) => o.binding),
    ['fi_alv_threshold_escalation', 'fi_scope_drift_ask_delivery']);
});

test('GB declares what the market requires — one duty bound, the rest honestly unbuilt', () => {
  const pack = loadOutboundPack('gb', { bypassCache: true });
  const items = statutoryObligationsForPack(pack);
  const ids = items.map((o) => o.id);
  for (const required of ['gb_vat_return_mtd', 'gb_confirmation_statement', 'gb_corporation_tax_return']) {
    assert.ok(ids.includes(required), `GB must declare ${required}`);
  }
  // The anti-goal made mechanical: the pack is NOT trimmed to what the engine
  // can serve. Every GB duty stays declared whether or not core can serve it.
  assert.ok(items.length > 0);

  // The registration-threshold watch is bound (2026-07-27) — GB's first real
  // statutory duty, and the evidence the obligations leg generalises beyond FI.
  const threshold = items.find((o) => o.id === 'gb_vat_registration_threshold');
  assert.equal(threshold.status, 'bound');
  assert.equal(threshold.binding, 'gb_vat_threshold_escalation');

  // Everything else remains unbuilt AND declared — binding one duty must never
  // become the excuse to quietly drop the ones core still cannot serve.
  const rest = items.filter((o) => o.id !== 'gb_vat_registration_threshold');
  assert.ok(rest.length >= 5);
  assert.ok(rest.every((o) => o.status === 'declared_unbuilt' && o.binding === null));
});

test('an unsurveyed market is distinguishable from one with no duties', () => {
  const us = loadOutboundPack('us', { bypassCache: true });
  assert.deepEqual(obligationSurveyForPack(us), { survey: 'not_surveyed', asOf: null });
  assert.deepEqual(statutoryObligationsForPack(us), []);

  const plan = planStatutoryObligationSweep();
  assert.ok(plan.unsurveyed.some((u) => u.packId === 'us'),
    'an unsurveyed pack must ride out in the plan, not read as clean');
  assert.ok(!plan.unsurveyed.some((u) => u.packId === 'fi' || u.packId === 'gb'));
});

// ── The plan ────────────────────────────────────────────────────────────────

test('the plan sorts the authored packs into runnable / unbuilt / unsurveyed', () => {
  const plan = planStatutoryObligationSweep();
  // Packs sweep in sorted id order (AE's four in manifest order, then FI's
  // two, then GB's one).
  assert.deepEqual(plan.runnable.map((r) => r.binding),
    ['ae_vat_threshold_escalation', 'ae_vat_registration_escalation', 'ae_vat_return_deadline_escalation', 'ae_ct_registration_escalation', 'fi_alv_threshold_escalation', 'fi_scope_drift_ask_delivery', 'gb_vat_threshold_escalation']);
  // Three jurisdictions now dispatch through the same jurisdiction-neutral
  // engine — the leg's generalisation evidence compounding.
  assert.deepEqual([...new Set(plan.runnable.map((r) => r.packId))], ['ae', 'fi', 'gb']);
  // AE's and GB's remaining duties stay unbuilt and REPORTED — the whole point
  // of declaring them. Binding one must not shrink what the sweep surfaces.
  // (The floor moved 9 → 8 when ae_vat_return bound, then 8 → 7 when
  // ae_corporate_tax_registration bound, 2026-08-31 — each deliberately.)
  assert.ok(plan.unbuilt.length >= 7);
  assert.ok(plan.unbuilt.some((u) => u.packId === 'gb'));
  assert.ok(plan.unbuilt.some((u) => u.packId === 'ae'));
  assert.ok(plan.unbuilt.every((u) => u.authority && u.source && u.asOf));
  assert.deepEqual(plan.unloadable, []);
});

test('AE declares what the market requires — four duties bound, the rest honestly unbuilt', () => {
  const pack = loadOutboundPack('ae', { bypassCache: true });
  const items = statutoryObligationsForPack(pack);
  const ids = items.map((o) => o.id);
  for (const required of ['ae_vat_return', 'ae_corporate_tax_registration', 'ae_corporate_tax_return', 'ae_einvoicing_mandate']) {
    assert.ok(ids.includes(required), `AE must declare ${required}`);
  }
  // The registration-threshold watch bound 2026-08-30 (the third market on
  // the fi/gb threshold-watch shape); the VAT return bound the same day,
  // preparation-first (the deadline watch — the owner files in EmaraTax);
  // the corporate-tax REGISTRATION duty bound 2026-08-31 on its pure halves
  // (the registry watch — the owner registers in EmaraTax); the VAT
  // REGISTRATION duty declared and bound 2026-09-01 (RT-19 — the status ask
  // that lets the VAT lane self-start: the owner supplies the TRN and the
  // FTA-assigned period, the audited period writer records them).
  const bound = items.filter((o) => o.status === 'bound');
  assert.deepEqual(bound.map((o) => o.binding),
    ['ae_vat_threshold_escalation', 'ae_vat_registration_escalation', 'ae_vat_return_deadline_escalation', 'ae_ct_registration_escalation']);
  assert.deepEqual(bound.map((o) => o.id),
    ['ae_vat_registration_threshold', 'ae_vat_registration', 'ae_vat_return', 'ae_corporate_tax_registration']);
  const rest = items.filter((o) => o.status !== 'bound');
  assert.ok(rest.every((o) => o.status === 'declared_unbuilt' && o.binding === null));
});

// ── Cadences (RT-19) ────────────────────────────────────────────────────────

test('the hourly cadence dispatches only the bindings that declared hourly: true', async () => {
  const daily = planStatutoryObligationSweep();
  const hourly = planStatutoryObligationSweep({ cadence: 'hourly' });
  assert.equal(daily.cadence, 'daily');
  assert.equal(hourly.cadence, 'hourly');
  assert.deepEqual(hourly.runnable.map((r) => r.binding), ['ae_vat_registration_escalation']);
  // The daily plan stays the full inventory; hourly never widens it.
  assert.ok(daily.runnable.length > hourly.runnable.length);
  assert.ok(hourly.runnable.every((h) => daily.runnable.some((d) => d.binding === h.binding)));
  // The hourly tick reports the unbuilt inventory exactly as the daily one
  // does — a cadence must never hide an undischarged duty.
  assert.deepEqual(hourly.unbuilt, daily.unbuilt);
  for (const binding of hourly.runnable.map((r) => r.binding)) {
    assert.equal(STATUTORY_OBLIGATION_BINDINGS[binding].hourly, true);
  }
  const ran = [];
  const summary = await runStatutoryObligationSweep({
    cadence: 'hourly',
    bindings: Object.fromEntries(Object.entries(STATUTORY_OBLIGATION_BINDINGS).map(([name, binding]) => [
      name, { ...binding, run: async () => { ran.push(name); return { name }; } }
    ]))
  });
  assert.equal(summary.cadence, 'hourly');
  assert.deepEqual(ran, ['ae_vat_registration_escalation']);
  assert.throws(() => planStatutoryObligationSweep({ cadence: 'weekly' }), /Unknown statutory sweep cadence/);
});

test('the hourly cadence has its own cron task, and the daily one keeps its schedule', () => {
  assert.equal(SUPPORTED_CRON_TASKS.has('statutory_watches_hourly'), true);
  const crons = JSON.parse(readFileSync(new URL('../../../vercel.json', import.meta.url), 'utf8')).crons;
  const daily = crons.find((c) => c.path.endsWith('task=statutory_watches'));
  const hourly = crons.find((c) => c.path.endsWith('task=statutory_watches_hourly'));
  assert.equal(daily?.schedule, '15 4 * * *');
  assert.equal(hourly?.schedule, '45 * * * *');
});

test('a bound obligation whose binding is not in the registry lands in unbuilt, never silently dropped', () => {
  const plan = planStatutoryObligationSweep({
    packIds: ['zz'],
    loadPack: () => ({
      obligations: {
        survey: 'surveyed',
        as_of: '2026-07-27',
        items: [{
          id: 'zz_thing', name: 'A duty', authority: 'Authority', source: 'Statute',
          as_of: '2026-07-27', status: 'bound', binding: 'zz_never_registered'
        }]
      }
    })
  });
  assert.deepEqual(plan.runnable, []);
  assert.equal(plan.unbuilt.length, 1);
  assert.equal(plan.unbuilt[0].unresolvedBinding, true);
});

test('one malformed pack does not silence another market\'s duties', () => {
  const plan = planStatutoryObligationSweep({
    packIds: ['aa', 'bb'],
    loadPack: (id) => {
      if (id === 'aa') throw new Error('manifest unreadable');
      return {
        obligations: {
          survey: 'surveyed', as_of: '2026-07-27',
          items: [{
            id: 'bb_duty', name: 'B duty', authority: 'Authority', source: 'Statute',
            as_of: '2026-07-27', status: 'bound', binding: 'fi_alv_threshold_escalation'
          }]
        }
      };
    }
  });
  assert.deepEqual(plan.unloadable.map((u) => u.packId), ['aa']);
  assert.deepEqual(plan.runnable.map((r) => r.packId), ['bb']);
});

// ── The sweep ───────────────────────────────────────────────────────────────

const stubBindings = (calls) => ({
  fi_alv_threshold_escalation: {
    run: async () => { calls.push('alv'); return { scanned: 3, minted: 1 }; }
  },
  fi_scope_drift_ask_delivery: {
    run: async () => { calls.push('drift'); return { pending: 0, attempted: 0 }; }
  }
});

test('the sweep dispatches FI\'s duties in order and carries each summary out verbatim', async () => {
  const calls = [];
  const result = await runStatutoryObligationSweep({ bindings: stubBindings(calls) });
  assert.deepEqual(calls, ['alv', 'drift'], 'same two drains, same order as the country-named cron');
  assert.equal(result.dispatched, 2);
  assert.equal(result.ran, 2);
  assert.equal(result.errors, 0);
  // Core does not reinterpret a country implementation's verdict.
  assert.deepEqual(result.obligations.map((o) => o.summary),
    [{ scanned: 3, minted: 1 }, { pending: 0, attempted: 0 }]);
  assert.ok(result.obligations.every((o) => o.outcome === 'ran' && o.authority && o.source));
});

test('unbuilt duties and unsurveyed markets ride out in EVERY sweep summary', async () => {
  const result = await runStatutoryObligationSweep({ bindings: stubBindings([]) });
  assert.ok(result.unbuilt.some((u) => u.obligationId === 'gb_vat_return_mtd'));
  assert.ok(result.unsurveyed.some((u) => u.packId === 'us'));
});

test('a throwing obligation is receipted and the sweep continues', async () => {
  const calls = [];
  const bindings = stubBindings(calls);
  const result = await runStatutoryObligationSweep({
    bindings: {
      ...bindings,
      fi_alv_threshold_escalation: { run: async () => { throw new Error('boom'); } }
    }
  });
  assert.equal(result.ran, 1);
  assert.equal(result.errors, 1);
  assert.equal(result.obligations[0].outcome, 'error');
  assert.match(result.obligations[0].error, /boom/);
  assert.deepEqual(calls, ['drift'], 'the second duty still ran');
});

// ── The cron is jurisdiction-neutral ────────────────────────────────────────

test('the scheduled statutory cron carries no country name', () => {
  const vercel = JSON.parse(readFileSync(new URL('../../../vercel.json', import.meta.url), 'utf8'));
  const tasks = (vercel.crons || [])
    .map((c) => new URLSearchParams(c.path.split('?')[1] || '').get('task'));
  assert.ok(tasks.includes('statutory_watches'));
  assert.ok(!tasks.includes('finland_watches'),
    'the schedule must not name a country — a uk_watches sibling is the corner this leg exists to prevent');
  // No SCHEDULED task may name a country. ('finland_watches' survives in
  // SUPPORTED_CRON_TASKS only as a deprecated deploy-skew alias.)
  for (const task of tasks) {
    assert.ok(!/^(finland|uk|gb|us|singapore|sg|fi)_/.test(String(task)),
      `scheduled cron task '${task}' names a country`);
  }
});

test('statutory_watches is a supported task; finland_watches survives only as the deprecated alias', () => {
  assert.equal(SUPPORTED_CRON_TASKS.has('statutory_watches'), true);
  assert.equal(SUPPORTED_CRON_TASKS.has('finland_watches'), true);
});
