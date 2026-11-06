// Receivable cases (M1, G5). Mock-pg harness over the REAL US pack. Pins:
//   - the detector opens a case + mints the step-1 reminder through the gate
//     for an overdue, unpaid, home-currency parsed sales invoice, with
//     pack-locale-formatted render values and scheduled_for anchored at
//     due_date + step-1 delta (floored at now);
//   - a doc with a named gap (no payment_instructions) opens its case WITH
//     the status_reason and mints NOTHING — the gap rests on the owner via
//     the G9 digest, never as a render failure at send time;
//   - a foreign-currency doc is skipped and COUNTED (no silent caps);
//   - shadow mode: one would-open audit, zero mutation;
//   - off mode: fully dark;
//   - case sync: after-send stamps step + next due; exhaustion escalates to
//     the owner; an already_settled cancel settles the case, a suppression
//     cancel stops it (both audited terminals);
//   - owner verbs (pause/dispute) require a non-system principal;
//   - store writers soft-fail when migration 092 has not run (42P01).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RECEIVABLE_CASE_STATUSES, detectOverdueReceivables,
  openReceivableCase, markReceivableCaseSent, escalateReceivableCase,
  settleReceivableCase, stopReceivableCase, pauseReceivableCase,
  markReceivableCaseDisputed, syncReceivableCaseAfterSend,
  syncReceivableCaseAfterCancel
} from './receivableCases.js';

const FIRM = 'firm-1';
const CLIENT = 'client-1';
const NOW = Date.parse('2026-07-24T00:00:00Z');

const docRow = (over = {}) => ({
  id: 'doc-1', customer_name: 'Acme LLC', due_date: '2026-07-01',
  total_amount: '1250', currency: 'USD', reference_number: 'INV-14',
  ...over
});

const makeDetectorClient = ({
  stage = 'canary', docs = [docRow()], profile = { jurisdiction: 'US', payment_instructions: 'ACH routing 021000021, account 1234' },
  overrides = []
} = {}) => {
  const calls = [];
  const handlers = [
    ...overrides,
    { match: 'from clients where firm_id', rows: [{ company_name: 'Roofline Co', profile, jurisdiction: profile.jurisdiction || null }] },
    { match: 'from documents d', rows: docs },
    { match: 'from client_capability_config', rows: [
      { flag_key: 'OUTBOUND_DUNNING', stage, source: 'test', client_id: CLIENT }
    ] },
    { match: 'from cohort_capability_config', rows: [] },
    // Party resolution: no existing party by name/id/channel → mint fresh.
    { match: 'from client_parties where firm_id = $1 and client_id = $2 and business_id', rows: [] },
    { match: 'from client_parties where firm_id = $1 and client_id = $2 and normalized_name', rows: [] },
    { match: 'insert into client_parties', rows: ({ params }) => [{ id: params[0] }] },
    { match: 'from client_parties where firm_id = $1 and client_id = $2 and id = $3',
      rows: [{ id: 'p-1', display_name: 'Acme LLC', do_not_contact: false, preferred_language: null }] },
    { match: 'from party_channels where firm_id',
      rows: [{ id: 'ch-1', channel_kind: 'email', normalized_value: 'ap@acme-com.example', is_primary: true }] },
    { match: 'from outbound_suppression', rows: [] },
    { match: 'insert into receivable_cases', rows: ({ params }) => [{ id: params[0], status_reason: params[12] }] },
    { match: 'insert into outbound_actions', rows: ({ params }) => [{ id: params[0], status: params[16] }] },
    { match: 'insert into audit_events', rows: [] }
  ];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (text === 'begin' || text === 'commit' || text === 'rollback') return { rows: [], rowCount: 0 };
      for (const h of handlers) {
        if (text.includes(h.match)) {
          if (h.throw) throw h.throw;
          const rows = typeof h.rows === 'function' ? h.rows({ sql: text, params }) : (h.rows || []);
          return { rows, rowCount: rows.length };
        }
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

const makeMockClient = (handlers = []) => makeDetectorClient({ overrides: handlers });

const audited = (client, action) => client.calls.filter(
  (c) => c.sql.includes('insert into audit_events')
    && (c.sql.includes(`'${action}'`) || (c.params || []).includes(action))
);

test('status vocabulary is closed and pinned', () => {
  assert.deepEqual(
    [...RECEIVABLE_CASE_STATUSES],
    ['open', 'paused', 'disputed', 'escalated', 'settled', 'stopped']
  );
});

test('detector opens a case and mints the gated step-1 reminder with pack-locale values', async () => {
  const client = makeDetectorClient({});
  const stats = await detectOverdueReceivables({
    client, firmId: FIRM, clientId: CLIENT, env: {}, now: NOW,
    paidTruthCheck: async () => 'unpaid'
  });
  assert.equal(stats.cases_opened, 1, JSON.stringify(stats));
  assert.equal(stats.actions_minted, 1);

  const caseInsert = client.calls.find((c) => c.sql.includes('insert into receivable_cases'));
  assert.ok(caseInsert, 'case row inserted');
  assert.equal(caseInsert.params[3], 'document');
  assert.equal(caseInsert.params[4], 'doc-1');

  const mint = client.calls.find((c) => c.sql.includes('insert into outbound_actions'));
  assert.ok(mint, 'step-1 action minted');
  const payload = JSON.parse(mint.params[10]);
  assert.equal(payload.due_date, '2026-07-01');
  assert.equal(payload.render_values.owner_business_name, 'Roofline Co');
  assert.equal(payload.render_values.invoice_number, 'INV-14');
  assert.equal(payload.render_values.amount_due, '1,250.00', 'amount formatted per pack locale');
  assert.ok(payload.render_values.due_date.includes('2026'), 'display due date rendered');
  assert.ok(payload.render_values.payment_instructions.includes('ACH'));
  // Step 1 fires at due_date + 7d — already past at NOW, so floored to now.
  assert.equal(Date.parse(mint.params[17]), NOW, 'past-due step-1 schedules immediately');
  assert.equal(mint.params[18], 1, 'cadence step 1');
  assert.ok(audited(client, 'receivable_case.opened').length === 1);
});

test('a named gap opens the case with status_reason and mints nothing (rests on the owner)', async () => {
  const client = makeDetectorClient({
    profile: { jurisdiction: 'US' } // no payment_instructions
  });
  const stats = await detectOverdueReceivables({
    client, firmId: FIRM, clientId: CLIENT, env: {}, now: NOW,
    paidTruthCheck: async () => 'unpaid'
  });
  assert.equal(stats.cases_opened, 1);
  assert.equal(stats.actions_minted, 0);
  assert.equal(stats.needs_owner_input, 1);
  const caseInsert = client.calls.find((c) => c.sql.includes('insert into receivable_cases'));
  assert.ok(String(caseInsert.params[12]).includes('missing_payment_instructions'));
  assert.ok(!client.calls.some((c) => c.sql.includes('insert into outbound_actions')), 'no mint');
});

test('a foreign-currency doc is skipped and counted, never silently dropped', async () => {
  const client = makeDetectorClient({ docs: [docRow({ currency: 'EUR' })] });
  const stats = await detectOverdueReceivables({
    client, firmId: FIRM, clientId: CLIENT, env: {}, now: NOW
  });
  assert.equal(stats.skipped_foreign_currency, 1, JSON.stringify(stats));
  assert.equal(stats.cases_opened, 0);
});

test('shadow mode: one would-open audit, zero mutation; off mode: dark', async () => {
  const shadow = makeDetectorClient({ stage: 'shadow' });
  const shadowStats = await detectOverdueReceivables({
    client: shadow, firmId: FIRM, clientId: CLIENT, env: {}, now: NOW
  });
  assert.equal(shadowStats.shadow_would_open, 1);
  assert.equal(shadowStats.cases_opened, 0);
  assert.equal(audited(shadow, 'receivable_case.would_open').length, 1);
  assert.ok(!shadow.calls.some((c) => c.sql.includes('insert into receivable_cases')));

  const off = makeDetectorClient({ stage: 'off' });
  const offStats = await detectOverdueReceivables({
    client: off, firmId: FIRM, clientId: CLIENT, env: {}, now: NOW
  });
  assert.equal(offStats.skipped, true);
  assert.equal(offStats.reason, 'flag_off');
});

test('a jurisdiction without an authored pack refuses to detect (fail-closed)', async () => {
  const client = makeDetectorClient({ profile: { jurisdiction: 'DE' } });
  const stats = await detectOverdueReceivables({
    client, firmId: FIRM, clientId: CLIENT, env: {}, now: NOW
  });
  assert.equal(stats.skipped, true);
  assert.equal(stats.reason, 'no_pack_for_jurisdiction');
});

test('after-send sync stamps step + next due; exhaustion escalates to the owner', async () => {
  const client = makeMockClient([
    { match: "update receivable_cases set current_step", rows: [{ id: 'rc-1' }] },
    { match: "set status = 'escalated'", rows: [{ id: 'rc-1' }] }
  ]);
  const action = {
    id: 'a-1', action_type: 'send_receivable_reminder',
    anchor_type: 'document', anchor_id: 'doc-1', cadence_step: 1
  };
  await syncReceivableCaseAfterSend(client, {
    firmId: FIRM, clientId: CLIENT, action,
    nextDueAt: '2026-07-15T00:00:00Z', exhausted: false
  });
  const stamp = client.calls.find((c) => c.sql.includes('update receivable_cases'));
  assert.ok(stamp, 'case stamped');
  assert.equal(stamp.params[4], 1, 'step recorded');
  assert.equal(stamp.params[7], '2026-07-15T00:00:00Z', 'next due recorded');

  const exhausted = makeMockClient([
    { match: 'update receivable_cases set current_step', rows: [{ id: 'rc-1' }] },
    { match: "set status = 'escalated'", rows: [{ id: 'rc-1' }] }
  ]);
  await syncReceivableCaseAfterSend(exhausted, {
    firmId: FIRM, clientId: CLIENT, action: { ...action, cadence_step: 3 },
    nextDueAt: null, exhausted: true
  });
  assert.ok(exhausted.calls.some((c) => c.sql.includes("set status = 'escalated'")));
  assert.equal(audited(exhausted, 'receivable_case.escalated').length, 1);
});

test('cancel sync: already_settled settles the case; suppression stops it', async () => {
  const action = {
    id: 'a-1', action_type: 'send_receivable_reminder',
    anchor_type: 'document', anchor_id: 'doc-1'
  };
  const settled = makeMockClient([
    { match: 'update receivable_cases', rows: [{ id: 'rc-1' }] }
  ]);
  await syncReceivableCaseAfterCancel(settled, {
    firmId: FIRM, clientId: CLIENT, action, reasons: ['already_settled']
  });
  assert.equal(audited(settled, 'receivable_case.settled').length, 1);

  const stopped = makeMockClient([
    { match: 'update receivable_cases', rows: [{ id: 'rc-1' }] }
  ]);
  await syncReceivableCaseAfterCancel(stopped, {
    firmId: FIRM, clientId: CLIENT, action, reasons: ['recipient_suppressed']
  });
  assert.equal(audited(stopped, 'receivable_case.stopped').length, 1);
});

test('sync helpers soft-fail when migration 092 has not run', async () => {
  const missing = { code: '42P01' };
  const client = makeMockClient([
    { match: 'update receivable_cases', throw: Object.assign(new Error('relation missing'), missing) }
  ]);
  const action = {
    id: 'a-1', action_type: 'send_receivable_reminder',
    anchor_type: 'document', anchor_id: 'doc-1', cadence_step: 1
  };
  const result = await syncReceivableCaseAfterSend(client, {
    firmId: FIRM, clientId: CLIENT, action, nextDueAt: null, exhausted: false
  });
  assert.equal(result, null, 'absent table is tolerated');
});

test('owner verbs require a non-system principal', async () => {
  const client = makeMockClient([]);
  await assert.rejects(
    () => pauseReceivableCase(client, { firmId: FIRM, clientId: CLIENT, caseId: 'rc-1', actorType: 'system' }),
    /non-system/
  );
  await assert.rejects(
    () => markReceivableCaseDisputed(client, { firmId: FIRM, clientId: CLIENT, caseId: 'rc-1', actorType: null }),
    /non-system/
  );
});

test('open/close store writers audit their transitions', async () => {
  const open = makeMockClient([
    { match: 'insert into receivable_cases', rows: ({ params }) => [{ id: params[0] }] }
  ]);
  const { case: caseRow, deduped } = await openReceivableCase(open, {
    firmId: FIRM, clientId: CLIENT, anchorType: 'document', anchorId: 'doc-9',
    packId: 'us', invoiceNumber: 'INV-9', amount: 100, currency: 'USD', dueDate: '2026-07-01'
  });
  assert.ok(caseRow && !deduped);
  assert.equal(audited(open, 'receivable_case.opened').length, 1);

  const settle = makeMockClient([
    { match: 'update receivable_cases', rows: [{ id: 'rc-2' }] }
  ]);
  await settleReceivableCase(settle, {
    firmId: FIRM, clientId: CLIENT, anchorType: 'document', anchorId: 'doc-9',
    reason: 'paid_truth_settled'
  });
  assert.equal(audited(settle, 'receivable_case.settled').length, 1);

  const stop = makeMockClient([
    { match: 'update receivable_cases', rows: [{ id: 'rc-3' }] }
  ]);
  await stopReceivableCase(stop, {
    firmId: FIRM, clientId: CLIENT, anchorType: 'document', anchorId: 'doc-9',
    reason: 'owner_declined'
  });
  assert.equal(audited(stop, 'receivable_case.stopped').length, 1);

  const escalate = makeMockClient([
    { match: 'update receivable_cases', rows: [{ id: 'rc-4' }] }
  ]);
  await escalateReceivableCase(escalate, {
    firmId: FIRM, clientId: CLIENT, anchorType: 'document', anchorId: 'doc-9'
  });
  assert.equal(audited(escalate, 'receivable_case.escalated').length, 1);

  const sent = makeMockClient([
    { match: 'update receivable_cases', rows: [{ id: 'rc-5' }] }
  ]);
  const row = await markReceivableCaseSent(sent, {
    firmId: FIRM, clientId: CLIENT, anchorType: 'document', anchorId: 'doc-9',
    step: 2, actionId: 'a-7', nextDueAt: '2026-08-01T00:00:00Z'
  });
  assert.ok(row);
});

// ── M3: Finland lights up over the REAL packs/fi (the abstraction proof at
// detector level). The one core seam the proof forced open — the issued
// lane's viite surfacing — is pinned here, together with its generic
// fail-closed sibling: a reference-scheme pack whose anchor has no reference
// rests on the owner as a named gap, never a reminder that would refuse (or
// state a wrong reference) at render time.

const FI_PROFILE = {
  jurisdiction: 'FI',
  payment_instructions: 'IBAN FI49 5000 9420 0287 30 (BIC OKOYFIHH)'
};

const issuedInvoiceRow = (over = {}) => ({
  id: 'inv-7', buyer_name: 'Esimerkki Oy', buyer_email: 'talous@esimerkki-fi.example',
  invoice_number: '2026007', due_date: '2026-07-01', currency: 'EUR',
  total_amount: '745', reference_number: '20260071',
  ...over
});

test('FI issued invoice mints step-1 with the draft viite in render_values (the M3 seam)', async () => {
  const client = makeDetectorClient({
    profile: FI_PROFILE, docs: [],
    overrides: [{ match: 'from issued_invoices ii', rows: [issuedInvoiceRow()] }]
  });
  const stats = await detectOverdueReceivables({
    client, firmId: FIRM, clientId: CLIENT, env: {}, now: NOW,
    paidTruthCheck: async () => 'unpaid'
  });
  assert.equal(stats.issued_scanned, 1, JSON.stringify(stats));
  assert.equal(stats.cases_opened, 1);
  assert.equal(stats.actions_minted, 1);

  // The issued-lane SELECT reads the viite where the FI lane persists it
  // (draft.finvoice.invoiceDetails.referenceNumber; scheme-neutral fallback
  // draft.invoice.referenceNumber) — pin the query, not just the mock.
  const issuedSelect = client.calls.find((c) => c.sql.includes('from issued_invoices ii'));
  assert.ok(issuedSelect.sql.includes("draft->'finvoice'->'invoiceDetails'->>'referenceNumber'"));
  assert.ok(issuedSelect.sql.includes("draft->'invoice'->>'referenceNumber'"));

  const mint = client.calls.find((c) => c.sql.includes('insert into outbound_actions'));
  const payload = JSON.parse(mint.params[10]);
  assert.equal(payload.render_values.reference_number, '20260071');
  assert.equal(payload.render_values.invoice_number, '2026007');
  assert.ok(payload.render_values.payment_instructions.includes('FI49'));
  // Pack-locale (fi-FI) amount formatting: decimal comma.
  assert.ok(payload.render_values.amount_due.includes('745'));
  assert.ok(payload.render_values.amount_due.includes(','));
});

test('FI parsed doc without a structured viite rests on the owner as missing_reference_number — no mint', async () => {
  const client = makeDetectorClient({
    profile: FI_PROFILE,
    docs: [docRow({ currency: 'EUR' })]
  });
  const stats = await detectOverdueReceivables({
    client, firmId: FIRM, clientId: CLIENT, env: {}, now: NOW,
    paidTruthCheck: async () => 'unpaid'
  });
  assert.equal(stats.cases_opened, 1, JSON.stringify(stats));
  assert.equal(stats.actions_minted, 0, 'no reminder mints without the viite');
  assert.equal(stats.needs_owner_input, 1);
  const caseInsert = client.calls.find((c) => c.sql.includes('insert into receivable_cases'));
  assert.ok(String(caseInsert.params[12]).includes('missing_reference_number'),
    `status_reason names the gap: ${caseInsert.params[12]}`);
});

test('an FI issued invoice the guard already sees settled never opens a case (issued-lane pre-check)', async () => {
  const client = makeDetectorClient({
    profile: FI_PROFILE, docs: [],
    overrides: [{ match: 'from issued_invoices ii', rows: [issuedInvoiceRow()] }]
  });
  const stats = await detectOverdueReceivables({
    client, firmId: FIRM, clientId: CLIENT, env: {}, now: NOW,
    paidTruthCheck: async () => 'settled'
  });
  assert.equal(stats.skipped_settled, 1);
  assert.equal(stats.cases_opened, 0);
  assert.ok(!client.calls.some((c) => c.sql.includes('insert into receivable_cases')));
});

test('US behavior is untouched by the reference seam (scheme none: no gap, no value forced)', async () => {
  const client = makeDetectorClient({});
  await detectOverdueReceivables({
    client, firmId: FIRM, clientId: CLIENT, env: {}, now: NOW,
    paidTruthCheck: async () => 'unpaid'
  });
  const mint = client.calls.find((c) => c.sql.includes('insert into outbound_actions'));
  const payload = JSON.parse(mint.params[10]);
  assert.ok(!('reference_number' in payload.render_values),
    'a US parsed doc mints exactly as before — reference_number absent, not null');
});

// ── G12's invoice-side sibling (migration 101): the parsed-doc lane rides the
// SAME mint-time coalesce the issued lane opened (M3's generic seam) ─────────

test('FI parsed doc WITH a captured structured_reference mints step-1 with the viite (the 101 coalesce)', async () => {
  const client = makeDetectorClient({
    profile: FI_PROFILE,
    docs: [docRow({ currency: 'EUR', structured_reference: '20260073' })]
  });
  const stats = await detectOverdueReceivables({
    client, firmId: FIRM, clientId: CLIENT, env: {}, now: NOW,
    paidTruthCheck: async () => 'unpaid'
  });
  assert.equal(stats.cases_opened, 1, JSON.stringify(stats));
  assert.equal(stats.actions_minted, 1, 'the captured viite closes the missing_reference_number gap');
  assert.equal(stats.needs_owner_input, 0);

  // The candidates SELECT reads the persisted capture location (101).
  const candidateSelect = client.calls.find((c) => c.sql.includes('from documents d'));
  assert.ok(candidateSelect.sql.includes('d.structured_reference'),
    'the doc lane reads documents.structured_reference');

  const mint = client.calls.find((c) => c.sql.includes('insert into outbound_actions'));
  const payload = JSON.parse(mint.params[10]);
  assert.equal(payload.render_values.reference_number, '20260073');
});

test('pre-101 grace: the candidates SELECT retries without the capture column — the detector still chases', async () => {
  let firstDocQuery = true;
  const client = makeDetectorClient({
    overrides: [
      { match: 'from documents d', rows: ({ sql }) => {
        if (firstDocQuery) {
          firstDocQuery = false;
          assert.ok(sql.includes('d.structured_reference'), 'first attempt reads the capture column');
          throw Object.assign(new Error('column d.structured_reference does not exist'), { code: '42703' });
        }
        assert.ok(sql.includes('null as structured_reference'), 'retry omits the capture column');
        return [docRow()];
      } }
    ]
  });
  const stats = await detectOverdueReceivables({
    client, firmId: FIRM, clientId: CLIENT, env: {}, now: NOW,
    paidTruthCheck: async () => 'unpaid'
  });
  assert.equal(stats.cases_opened, 1, JSON.stringify(stats));
  assert.equal(stats.actions_minted, 1, 'a pre-101 database chases exactly as before');
});

test('a case resting as missing_reference_number re-mints once the doc capture lands (gap heal)', async () => {
  const client = makeDetectorClient({
    profile: FI_PROFILE, docs: [],
    overrides: [
      { match: 'from receivable_cases rc', rows: [{
        case_id: 'case-9', anchor_type: 'document', anchor_id: 'doc-1',
        status_reason: 'missing_reference_number',
        doc_customer_name: 'Esimerkki Oy', doc_reference_number: 'L-2026007',
        doc_structured_reference: '20260073',
        doc_total_amount: '745', doc_currency: 'EUR', doc_due_date: '2026-07-01'
      }] }
    ]
  });
  const stats = await detectOverdueReceivables({
    client, firmId: FIRM, clientId: CLIENT, env: {}, now: NOW,
    paidTruthCheck: async () => 'unpaid'
  });
  assert.equal(stats.remint_minted, 1, JSON.stringify(stats));
  const gapSelect = client.calls.find((c) => c.sql.includes('rc.status_reason is not null'));
  assert.ok(gapSelect.sql.includes('doc_structured_reference'),
    're-mint reads the capture location too — a pre-capture case heals');
  const mint = client.calls.find((c) => c.sql.includes('insert into outbound_actions'));
  const payload = JSON.parse(mint.params[10]);
  assert.equal(payload.render_values.reference_number, '20260073');
  const cleared = client.calls.find((c) => c.sql.includes('set status_reason = null'));
  assert.ok(cleared, 'the healed case stops resting on the owner');
});
