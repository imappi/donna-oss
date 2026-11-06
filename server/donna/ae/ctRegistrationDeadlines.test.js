// AE — pure deadline rows for the FTA corporate-tax registration timeline.
//   node --test server/donna/ae/ctRegistrationDeadlines.test.js
//
// The load-bearing invariant is the row contract (gb/vatDeadlines.js's):
// every row is terminal 'scheduled' or 'on_owner' — nothing else — and the
// only limb ever COMPUTED is the one the profile can honestly settle
// (post-2024-03-01 incorporation + 3 months). Everything else refuses to the
// owner by name.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AE_CT_LATE_REGISTRATION_PENALTY_AED,
  AE_CT_LATE_REGISTRATION_PENALTY_PROVENANCE,
  AE_CT_REGISTRATION_TIMELINE_EFFECTIVE_FROM,
  AE_CT_REGISTRATION_TIMELINE_PROVENANCE,
  buildAeCtRegistrationDeadlineRows
} from './ctRegistrationDeadlines.js';

const ON_DATE = '2026-08-30';

const assertRowContract = (rows) => {
  for (const r of rows) {
    assert.ok(['scheduled', 'on_owner'].includes(r.terminal), `illegal terminal ${JSON.stringify(r.terminal)}`);
    if (r.terminal === 'scheduled') assert.match(r.due_date, /^\d{4}-\d{2}-\d{2}$/);
    if (r.terminal === 'on_owner') assert.equal(r.due_date, null);
  }
};

// ── Provenance discipline ───────────────────────────────────────────────────

test('the statutory statements ride frozen VERIFY provenance with as_of dates', () => {
  for (const p of [AE_CT_REGISTRATION_TIMELINE_PROVENANCE, AE_CT_LATE_REGISTRATION_PENALTY_PROVENANCE]) {
    assert.ok(Object.isFrozen(p));
    assert.equal(p.confirmedAgainstPrimary, false);
    assert.equal(p.asOf, '2026-08-30');
  }
  assert.equal(AE_CT_LATE_REGISTRATION_PENALTY_AED, 10000);
  assert.equal(AE_CT_REGISTRATION_TIMELINE_EFFECTIVE_FROM, '2024-03-01');
});

// ── The discharged limb ─────────────────────────────────────────────────────

test('an effective registration yields no rows — the standing record is the evidence', () => {
  const rows = buildAeCtRegistrationDeadlineRows({
    profile: { ct_registration: { status: 'registered', registered_from: '2026-01-01' } },
    onDate: ON_DATE
  });
  assert.deepEqual(rows, []);
});

test('a future-effective registration also yields no rows — the application exists', () => {
  const rows = buildAeCtRegistrationDeadlineRows({
    profile: { ct_registration: { status: 'registered', registered_from: '2026-12-01' } },
    onDate: ON_DATE
  });
  assert.deepEqual(rows, []);
});

// ── The unknown limb ────────────────────────────────────────────────────────

test('no record is an on_owner refusal — unknown never reads as either answer', () => {
  const rows = buildAeCtRegistrationDeadlineRows({ profile: {}, onDate: ON_DATE, refusalCodes: { ctRegistration: 'AE_CT_REG_UNKNOWN' } });
  assertRowContract(rows);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'ct_registration');
  assert.equal(rows[0].terminal, 'on_owner');
  assert.equal(rows[0].reason_code, 'AE_CT_REG_UNKNOWN');
});

test('an unusable or incomplete record refuses the same way, never a computed guess', () => {
  for (const ct_registration of ['garbage', { status: 'vibes' }, { status: 'registered' }]) {
    const rows = buildAeCtRegistrationDeadlineRows({ profile: { ct_registration }, onDate: ON_DATE });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].terminal, 'on_owner');
    assert.equal(rows[0].key, 'ct_registration');
  }
});

// ── The live-duty limbs ─────────────────────────────────────────────────────

test('not_registered + post-cutover incorporation schedules incorporation + 3 months', () => {
  const rows = buildAeCtRegistrationDeadlineRows({
    profile: { ct_registration: { status: 'not_registered' }, incorporation_date: '2026-05-15' },
    onDate: ON_DATE
  });
  assertRowContract(rows);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'ct_registration');
  assert.equal(rows[0].terminal, 'scheduled');
  assert.equal(rows[0].due_date, '2026-08-15');
});

test('month arithmetic clamps to the target month\'s end — conservative, never later', () => {
  const dueFor = (incorporation_date) => buildAeCtRegistrationDeadlineRows({
    profile: { ct_registration: { status: 'not_registered' }, incorporation_date },
    onDate: ON_DATE
  })[0].due_date;
  assert.equal(dueFor('2026-11-30'), '2027-02-28'); // Feb clamp, not a rollover to March
  assert.equal(dueFor('2026-01-31'), '2026-04-30'); // 30-day-month clamp
  assert.equal(dueFor('2024-03-01'), '2024-06-01'); // the cutover day itself is on the 3-month clock
});

test('a past due date stays a scheduled row — overdue-ness is the consumer\'s reading', () => {
  const rows = buildAeCtRegistrationDeadlineRows({
    profile: { ct_registration: { status: 'not_registered' }, incorporation_date: '2025-01-10' },
    onDate: ON_DATE
  });
  assert.equal(rows[0].terminal, 'scheduled');
  assert.equal(rows[0].due_date, '2025-04-10');
});

test('not_registered with no incorporation date refuses by name — natural persons included', () => {
  const rows = buildAeCtRegistrationDeadlineRows({
    profile: { ct_registration: { status: 'not_registered' } },
    onDate: ON_DATE,
    refusalCodes: { ctRegistrationDeadline: 'AE_CT_REG_DEADLINE_UNKNOWN' }
  });
  assertRowContract(rows);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'ct_registration_deadline');
  assert.equal(rows[0].terminal, 'on_owner');
  assert.equal(rows[0].reason_code, 'AE_CT_REG_DEADLINE_UNKNOWN');
});

test('a pre-2024-03-01 incorporation refuses — the licence-month schedule is an owner fact', () => {
  const rows = buildAeCtRegistrationDeadlineRows({
    profile: { ct_registration: { status: 'not_registered' }, incorporation_date: '2023-06-01' },
    onDate: ON_DATE
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'ct_registration_deadline');
  assert.equal(rows[0].terminal, 'on_owner');
});

test('a deregistered record refuses to the owner — re-arising is not a computable clock', () => {
  const rows = buildAeCtRegistrationDeadlineRows({
    profile: {
      ct_registration: { status: 'deregistered', registered_from: '2025-01-01', registered_until: '2026-01-31' },
      incorporation_date: '2024-06-01'
    },
    onDate: ON_DATE
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'ct_registration_deadline');
  assert.equal(rows[0].terminal, 'on_owner');
});

// ── Purity / caller-bug boundary ────────────────────────────────────────────

test('entity_type and free-zone standing play no part — same rows either way', () => {
  const base = { ct_registration: { status: 'not_registered' }, incorporation_date: '2026-05-15' };
  const plain = buildAeCtRegistrationDeadlineRows({ profile: base, onDate: ON_DATE });
  const decorated = buildAeCtRegistrationDeadlineRows({
    profile: { ...base, entity_type: 'ae-free-zone-co', free_zone: 'DMCC' },
    onDate: ON_DATE
  });
  assert.deepEqual(decorated, plain);
});

test('a missing onDate throws — a caller bug, not a data state', () => {
  assert.throws(() => buildAeCtRegistrationDeadlineRows({ profile: {} }), /requires an onDate/);
});
