// G15/D12 — the owner Actions surface (workspace tab). Mock-pg harness. Pins:
//   - the READ is the digest gather (same sections, same display copy),
//     shaped for display, with bearer tokens WITHHELD and the sent-FYI
//     showing the whole recent window (includeNotifiedAutoSent — the email's
//     notified-once ledger governs email only, and is not even read here);
//   - approve/decline route to the EXISTING writers with the same
//     idempotency the digest links have (already-decided reports, never
//     re-decides); a decline syncs the receivable case;
//   - the owner EDIT verb goes through editHeldOutboundActionDraft, which
//     RECORDS the reserved D1 correction ('edited_held_draft') at the writer
//     — no surface can skip it — refuses non-editable keys fail-closed, and
//     only touches held drafts;
//   - pause/dispute wire to the existing receivable-case owner writers;
//   - the digest email gains the workspace deep link when base URL + client
//     id exist, and the one-tap approve links are unchanged either way.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readOwnerActionsSurface, decideOwnerAction, editOwnerHeldDraft,
  actOnOwnerReceivableCase, markOwnerAutoSentWrong, reverseOwnerAutoSentPost,
  setOwnerActionPartyLanguage
} from './ownerActionsSurface.js';
import {
  editHeldOutboundActionDraft, EDITABLE_DRAFT_RENDER_KEYS
} from './actionStore.js';
import { renderOwnerDigestEmail } from './ownerDigest.js';

const FIRM = 'firm-1';
const CLIENT = 'client-1';

const heldAction = (over = {}) => ({
  id: 'a-1', action_type: 'send_receivable_reminder', status: 'hold_for_approval',
  party_name: 'Acme LLC', cadence_step: 2, amount: 1250, currency: 'USD',
  approval_token: 'secret-approve-token', unsubscribe_token: 'secret-unsub-token',
  target_party_id: 'p-1', anchor_type: 'document', anchor_id: 'doc-1',
  gate_basis: { held_at_send: ['paid_truth_ambiguous'] },
  model: 'deterministic:pack:us@v3', config_snapshot_id: null,
  payload: {
    render_values: {
      invoice_number: 'INV-14', amount_due: '1,250.00',
      payment_instructions: 'Wire to account 123'
    }
  },
  created_at: '2026-07-23T10:00:00Z',
  ...over
});

const makeClient = ({
  stage = 'canary', pending = [heldAction()], failed = [], stale = [],
  cases = [], autoSentReceipts = [], earned = [], actionById = null,
  overrides = []
} = {}) => {
  const calls = [];
  const handlers = [
    ...overrides,
    { match: 'from client_capability_config', rows: [
      { flag_key: 'OUTBOUND_DUNNING', stage, source: 'test', client_id: CLIENT }
    ] },
    { match: 'from cohort_capability_config', rows: [] },
    { match: 'select * from outbound_actions where id =', rows: actionById ? [actionById] : [] },
    { match: 'select status from outbound_actions where id =', rows: actionById ? [actionById] : [] },
    { match: "a.status = 'hold_for_approval'", rows: pending },
    { match: "a.status = 'failed'", rows: failed },
    { match: "status = 'executing' and claimed_at", rows: stale },
    { match: 'from receivable_cases', rows: ({ params }) => {
      const statuses = params.find((p) => Array.isArray(p));
      return cases.filter((c) => !statuses || statuses.includes(c.status));
    } },
    { match: 'from outbound_action_receipts', rows: autoSentReceipts },
    { match: 'from outbound_earned_auto', rows: earned },
    { match: 'insert into audit_events', rows: [] }
  ];
  return {
    calls,
    query: async (sql, params = []) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
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

// ── The read ─────────────────────────────────────────────────────────────────

test('read renders the digest gather: sections, digest copy, no bearer tokens', async () => {
  const client = makeClient({
    cases: [
      { id: 'rc-1', status: 'escalated', invoice_number: 'INV-9', current_step: 3, anchor_id: 'doc-9', amount: 900, currency: 'USD' },
      { id: 'rc-2', status: 'open', invoice_number: 'INV-7', current_step: 0, anchor_id: 'doc-7', amount: 300, currency: 'USD', status_reason: 'no_recipient_channel' }
    ],
    earned: [{ id: 'ea-1', action_type: 'send_receivable_reminder', state: 'earned', clean_streak: 7, clean_target: null }]
  });
  const surface = await readOwnerActionsSurface(client, { firmId: FIRM, clientId: CLIENT, env: {} });

  assert.equal(surface.pipeline_active, true);
  assert.equal(surface.pending.length, 1);
  const row = surface.pending[0];
  assert.ok(row.description.includes('Payment reminder (step 2) to Acme LLC'),
    'description is the digest copy');
  assert.ok(row.hold_copy.includes('may already be paid'), 'hold copy is the digest copy');
  assert.deepEqual(row.editable_values, { payment_instructions: 'Wire to account 123' },
    'editable values expose ONLY the bounded keys');
  const serialized = JSON.stringify(surface);
  assert.ok(!serialized.includes('secret-approve-token'), 'approval token never leaves the server');
  assert.ok(!serialized.includes('secret-unsub-token'), 'unsubscribe token never leaves the server');

  assert.equal(surface.escalated.length, 1);
  assert.equal(surface.needs_input.length, 1);
  assert.ok(surface.needs_input[0].gaps[0].copy.includes('no email address'),
    'gap copy is the digest copy');
  assert.equal(surface.earned.length, 1);
  assert.equal(surface.earned[0].clean_target, 7, 'default target rendered');
  assert.deepEqual(surface.editable_keys, [...EDITABLE_DRAFT_RENDER_KEYS]);
});

test('AR-4E: unavailable requested language blocks approve and offers only pack-supported fallbacks', async () => {
  const client = makeClient({
    pending: [heldAction({
      pack_id: 'ae', language: 'fr',
      party_preferred_language: 'fr', party_fallback_language: null
    })]
  });
  const surface = await readOwnerActionsSurface(client, { firmId: FIRM, clientId: CLIENT, env: {} });
  const row = surface.pending[0];
  assert.equal(row.approval_blocked, true);
  assert.equal(row.language.reason, 'requested_language_unavailable');
  assert.equal(row.language.requested_language, 'fr');
  assert.deepEqual(row.language.fallback_options, ['en', 'ar']);
  assert.match(row.hold_copy, /requested language is not available/);
  assert.equal(JSON.stringify(row).includes('secret-approve-token'), false);
});

test('AR-4E: owner language controls are action-scoped, pack-validated and writer-attributed', async () => {
  const action = {
    id: 'a-1', action_type: 'send_receivable_reminder', status: 'hold_for_approval',
    target_party_id: 'p-1', pack_id: 'ae',
    preferred_language: 'fr', fallback_language: null
  };
  const client = makeClient({
    overrides: [{
      match: 'from outbound_actions a join client_parties', rows: [action]
    }]
  });
  const updated = await setOwnerActionPartyLanguage(client, {
    firmId: FIRM, clientId: CLIENT, actionId: 'a-1',
    attribute: 'fallback_language', language: 'en',
    actorType: 'owner', actorId: 'kari@books.example'
  });
  assert.deepEqual(updated, { updated: true, attribute: 'fallback_language', language: 'en' });
  const attribute = client.calls.find((call) => call.sql.includes('insert into party_attributes'));
  assert.ok(attribute);
  assert.ok(attribute.params.includes('fallback_language'));
  assert.ok(attribute.params.includes('owner'));
  assert.ok(attribute.params.includes('kari@books.example'));

  const same = makeClient({
    overrides: [{
      match: 'from outbound_actions a join client_parties',
      rows: [{ ...action, fallback_language: 'en' }]
    }]
  });
  assert.deepEqual(await setOwnerActionPartyLanguage(same, {
    firmId: FIRM, clientId: CLIENT, actionId: 'a-1',
    attribute: 'fallback_language', language: 'en',
    actorType: 'owner', actorId: 'kari@books.example'
  }), { updated: false, attribute: 'fallback_language', language: 'en' });
  assert.ok(!same.calls.some((call) => call.sql.includes('insert into party_attributes')));

  await assert.rejects(
    () => setOwnerActionPartyLanguage(makeClient({
      overrides: [{ match: 'from outbound_actions a join client_parties', rows: [action] }]
    }), {
      firmId: FIRM, clientId: CLIENT, actionId: 'a-1',
      attribute: 'preferred_language', language: 'fr',
      actorType: 'owner', actorId: 'kari@books.example'
    }),
    (error) => error.code === 'OUTBOUND_PARTY_LANGUAGE_UNSUPPORTED'
  );

  const preference = makeClient({
    overrides: [{ match: 'from outbound_actions a join client_parties', rows: [action] }]
  });
  assert.deepEqual(await setOwnerActionPartyLanguage(preference, {
    firmId: FIRM, clientId: CLIENT, actionId: 'a-1',
    attribute: 'preferred_language', language: 'en',
    actorType: 'owner', actorId: 'kari@books.example'
  }), { updated: true, attribute: 'preferred_language', language: 'en' });
  const preferenceWrite = preference.calls.find((call) => call.sql.includes('insert into party_attributes'));
  assert.ok(preferenceWrite.params.includes('preferred_language'));
});

test('read shows the whole recent auto-sent window and never reads the email ledger', async () => {
  const client = makeClient({
    pending: [],
    autoSentReceipts: [heldAction({
      id: 'a-9', status: 'executed', receipt_created_at: '2026-07-23T09:00:00Z'
    })]
  });
  const surface = await readOwnerActionsSurface(client, { firmId: FIRM, clientId: CLIENT, env: {} });
  assert.equal(surface.auto_sent.length, 1, 'already-notified sends still render on the tab');
  const ledgerReads = client.calls.filter((c) => c.sql.toLowerCase().includes('from outbound_digests'));
  assert.equal(ledgerReads.length, 0,
    'the tab read does not touch payload.notified_ids — that ledger is the EMAIL digest\'s');
});

test('a dark pipeline reads pipeline_active=false (persisted rows still render)', async () => {
  const client = makeClient({ stage: 'off', pending: [] });
  const surface = await readOwnerActionsSurface(client, { firmId: FIRM, clientId: CLIENT, env: {} });
  assert.equal(surface.pipeline_active, false);
});

// ── Decide (approve / decline through the existing writers) ──────────────────

test('approve routes to approveOutboundAction with the non-system principal', async () => {
  const held = heldAction();
  const client = makeClient({
    actionById: held,
    overrides: [
      { match: "set status = 'approved'", rows: [{ ...held, status: 'approved' }] }
    ]
  });
  const result = await decideOwnerAction(client, {
    firmId: FIRM, clientId: CLIENT, actionId: held.id,
    decision: 'approve', actorType: 'owner', actorId: 'kari@books.example'
  });
  assert.deepEqual(result, { decided: true, decision: 'approve', status: 'approved' });
  const update = client.calls.find((c) => c.sql.toLowerCase().includes("set status = 'approved'"));
  assert.ok(update, 'the EXISTING approve writer ran');
  assert.ok(update.params.includes('owner') && update.params.includes('kari@books.example'),
    'principal threaded into the writer');
});

test('decline routes to cancelOutboundAction and syncs the receivable case', async () => {
  const held = heldAction();
  const client = makeClient({
    actionById: held,
    overrides: [
      { match: "set status = 'cancelled'", rows: [{ ...held, status: 'cancelled', prior_status: 'hold_for_approval' }] },
      { match: 'insert into outbound_earned_auto', rows: [{ id: 'ea-1', state: 'counting', clean_streak: 0 }] },
      { match: "set status = 'stopped'", rows: [] }
    ]
  });
  const result = await decideOwnerAction(client, {
    firmId: FIRM, clientId: CLIENT, actionId: held.id,
    decision: 'decline', actorType: 'owner', actorId: 'kari@books.example'
  });
  assert.deepEqual(result, { decided: true, decision: 'decline', status: 'cancelled' });
  assert.ok(client.calls.some((c) => c.sql.toLowerCase().includes('insert into outbound_earned_auto')),
    'the owner decline is a D1 counted correction (recorded by the cancel writer)');
  assert.ok(client.calls.some((c) => c.sql.toLowerCase().includes('insert into outbound_action_receipts')),
    'the cancel is receipted');
  assert.ok(client.calls.some((c) => c.sql.toLowerCase().includes('update receivable_cases')),
    'the receivable case is synced after the decline');
});

test('a second decision reports the already-decided state (same idempotency as the digest links)', async () => {
  const client = makeClient({ actionById: heldAction({ status: 'approved' }) });
  const result = await decideOwnerAction(client, {
    firmId: FIRM, clientId: CLIENT, actionId: 'a-1',
    decision: 'approve', actorType: 'owner', actorId: 'kari@books.example'
  });
  assert.deepEqual(result, { decided: false, already: 'approved' });
  assert.ok(!client.calls.some((c) => c.sql.toLowerCase().includes("set status = 'approved'")),
    'no writer runs on an already-decided action');
});

test('unknown decision refuses with a 400', async () => {
  const client = makeClient({});
  await assert.rejects(
    decideOwnerAction(client, {
      firmId: FIRM, clientId: CLIENT, actionId: 'a-1',
      decision: 'maybe', actorType: 'owner'
    }),
    (error) => error.code === 'OUTBOUND_DECISION_UNKNOWN' && error.statusCode === 400
  );
});

// ── The edit verb (D1 contract: the recorder lives at the writer) ────────────

test('editing a held draft patches bounded keys and records the edited_held_draft correction', async () => {
  const held = heldAction();
  const client = makeClient({
    overrides: [
      { match: 'jsonb_set', rows: [{
        ...held,
        payload: { render_values: { ...held.payload.render_values, payment_instructions: 'IBAN FI21 1234' } }
      }] },
      { match: 'insert into outbound_earned_auto', rows: [{ id: 'ea-1', state: 'counting', clean_streak: 0 }] }
    ]
  });
  const edited = await editHeldOutboundActionDraft(client, {
    firmId: FIRM, clientId: CLIENT, actionId: held.id,
    renderValues: { payment_instructions: 'IBAN FI21 1234' },
    actorType: 'owner', actorId: 'kari@books.example'
  });
  assert.ok(edited, 'held draft edited');
  const correction = client.calls.find((c) => c.sql.toLowerCase().includes('insert into outbound_earned_auto'));
  assert.ok(correction, 'recordOutboundCorrection ran INSIDE the writer');
  const payload = correction.params.find((p) => typeof p === 'string' && p.includes('edited_held_draft'));
  assert.ok(payload, 'the correction carries the reserved kind edited_held_draft');
  assert.ok(client.calls.some((c) => c.sql.toLowerCase().includes('insert into audit_events')
    && c.params.some((p) => String(p).includes('draft_edited'))), 'edit is audited');
});

test('non-editable keys refuse fail-closed; nothing is written', async () => {
  const client = makeClient({});
  await assert.rejects(
    editHeldOutboundActionDraft(client, {
      firmId: FIRM, clientId: CLIENT, actionId: 'a-1',
      renderValues: { amount_due: '1.00' },
      actorType: 'owner', actorId: 'kari@books.example'
    }),
    (error) => error.code === 'OUTBOUND_EDIT_KEY_FORBIDDEN'
  );
  assert.ok(!client.calls.some((c) => c.sql.toLowerCase().includes('update outbound_actions')),
    'no write on a forbidden key');
});

test('a system principal cannot edit (the edit is an OWNER correction by definition)', async () => {
  const client = makeClient({});
  await assert.rejects(
    editHeldOutboundActionDraft(client, {
      firmId: FIRM, clientId: CLIENT, actionId: 'a-1',
      renderValues: { payment_instructions: 'x' }, actorType: 'system'
    }),
    /non-system acting principal/
  );
});

test('editing a non-held action reports the already-decided state instead of writing', async () => {
  const client = makeClient({ actionById: { status: 'executed' } });
  const result = await editOwnerHeldDraft(client, {
    firmId: FIRM, clientId: CLIENT, actionId: 'a-1',
    renderValues: { payment_instructions: 'x' },
    actorType: 'owner', actorId: 'kari@books.example'
  });
  assert.deepEqual(result, { edited: false, already: 'executed' });
});

// ── Case verbs (existing writers) ────────────────────────────────────────────

test('pause and dispute route to the existing case writers', async () => {
  const client = makeClient({
    overrides: [
      { match: "set status = 'paused'", rows: [{ id: 'rc-1', status: 'paused' }] }
    ]
  });
  const paused = await actOnOwnerReceivableCase(client, {
    firmId: FIRM, clientId: CLIENT, caseId: 'rc-1', verb: 'pause',
    actorType: 'owner', actorId: 'kari@books.example'
  });
  assert.deepEqual(paused, { applied: true, status: 'paused' });

  const client2 = makeClient({
    overrides: [
      { match: "set status = 'disputed'", rows: [{ id: 'rc-1', status: 'disputed' }] }
    ]
  });
  const disputed = await actOnOwnerReceivableCase(client2, {
    firmId: FIRM, clientId: CLIENT, caseId: 'rc-1', verb: 'dispute',
    actorType: 'owner', actorId: 'kari@books.example'
  });
  assert.deepEqual(disputed, { applied: true, status: 'disputed' });
});

test('unknown case verb refuses; a missing case is a 404', async () => {
  const client = makeClient({});
  await assert.rejects(
    actOnOwnerReceivableCase(client, {
      firmId: FIRM, clientId: CLIENT, caseId: 'rc-1', verb: 'nuke', actorType: 'owner'
    }),
    (error) => error.code === 'RECEIVABLE_CASE_VERB_UNKNOWN'
  );
  await assert.rejects(
    actOnOwnerReceivableCase(client, {
      firmId: FIRM, clientId: CLIENT, caseId: 'rc-missing', verb: 'pause', actorType: 'owner'
    }),
    (error) => error.code === 'RECEIVABLE_CASE_NOT_FOUND'
  );
});

// ── The digest deep link ─────────────────────────────────────────────────────

test('the digest email carries the workspace deep link when base URL + client id exist', () => {
  const digest = {
    pending: [heldAction()], failed: [], stale: [], escalated: [], needsInput: [],
    autoSent: [], earned: []
  };
  const rendered = renderOwnerDigestEmail({
    digest, baseUrl: 'https://donna.example', clientName: 'Roofline Co', clientId: CLIENT
  });
  assert.ok(rendered.text.includes(`https://donna.example/client/${CLIENT}#list`),
    'deep link into the mounted owner actions list');
  assert.ok(rendered.text.includes('token=secret-approve-token'),
    'one-tap approve links unchanged');

  const withoutBase = renderOwnerDigestEmail({
    digest, baseUrl: '', clientName: 'Roofline Co', clientId: CLIENT
  });
  assert.ok(!withoutBase.text.includes('/client/'), 'no base URL, no dead link');

  const withoutClient = renderOwnerDigestEmail({
    digest, baseUrl: 'https://donna.example', clientName: 'Roofline Co'
  });
  assert.ok(!withoutClient.text.includes('/client/'), 'no client id, no link');
});

// ── reply_if_wrong: the one corrective verb on the sent-FYI rows ─────────────

const executedAutoSend = (over = {}) => ({
  id: 'a-42', action_type: 'send_receivable_reminder', status: 'executed',
  party_name: 'Acme LLC', target_party_id: 'p-1',
  anchor_type: 'document', anchor_id: 'doc-1',
  approval_token: 'secret-approve-token', unsubscribe_token: 'secret-unsub-token',
  payload: {}, receipt_created_at: '2026-07-23T09:00:00Z',
  ...over
});

test('sent-FYI rows surface marked_wrong_at — and still never a bearer token', async () => {
  const client = makeClient({
    pending: [],
    autoSentReceipts: [
      executedAutoSend(),
      executedAutoSend({ id: 'a-43', payload: { owner_marked_wrong_at: '2026-07-24T08:00:00Z' } })
    ]
  });
  const surface = await readOwnerActionsSurface(client, { firmId: FIRM, clientId: CLIENT, env: {} });
  assert.equal(surface.auto_sent.length, 2);
  assert.equal(surface.auto_sent[0].marked_wrong_at, null, 'unmarked row renders the verb');
  assert.equal(surface.auto_sent[1].marked_wrong_at, '2026-07-24T08:00:00Z',
    'a marked row renders the acknowledgement, not the button');
  assert.ok(!JSON.stringify(surface).includes('secret-'), 'tokens stay server-side');
});

test('mark-wrong routes to the writer (which records the D1 correction) and reports idempotently', async () => {
  const client = makeClient({
    overrides: [
      { match: 'update outbound_actions', rows: [{
        id: 'a-42', action_type: 'send_receivable_reminder', status: 'executed',
        payload: { owner_marked_wrong_at: '2026-07-24T08:00:00Z' }
      }] },
      { match: 'insert into outbound_earned_auto', rows: [{ id: 'ea-1', state: 'counting' }] }
    ]
  });
  const result = await markOwnerAutoSentWrong(client, {
    firmId: FIRM, clientId: CLIENT, actionId: 'a-42', actorType: 'owner', actorId: 'kari@books.example'
  });
  assert.deepEqual(result, { marked: true, marked_wrong_at: '2026-07-24T08:00:00Z' });
  const correction = client.calls.find((c) => c.sql.includes('insert into outbound_earned_auto'));
  assert.ok(correction, 'the correction is recorded at the writer, through this surface');
  assert.ok(JSON.stringify(correction.params).includes('reply_if_wrong'));

  // Already marked: the writer matches zero rows; the probe reports it.
  const already = makeClient({
    overrides: [
      { match: 'update outbound_actions', rows: [] },
      { match: 'select status, payload from outbound_actions', rows: [{
        status: 'executed', payload: { owner_marked_wrong_at: '2026-07-24T08:00:00Z' }
      }] }
    ]
  });
  assert.deepEqual(
    await markOwnerAutoSentWrong(already, {
      firmId: FIRM, clientId: CLIENT, actionId: 'a-42', actorType: 'owner', actorId: 'kari@books.example'
    }),
    { marked: false, already: 'marked' }
  );
  assert.ok(!already.calls.some((c) => c.sql.includes('insert into outbound_earned_auto')),
    'a second click records NO second correction');

  // Not executed (still held): honest already-report, no correction.
  const held = makeClient({
    overrides: [
      { match: 'update outbound_actions', rows: [] },
      { match: 'select status, payload from outbound_actions', rows: [{
        status: 'hold_for_approval', payload: {}
      }] }
    ]
  });
  assert.deepEqual(
    await markOwnerAutoSentWrong(held, {
      firmId: FIRM, clientId: CLIENT, actionId: 'a-42', actorType: 'owner', actorId: 'kari@books.example'
    }),
    { marked: false, already: 'hold_for_approval' }
  );

  // Unknown action: 404.
  const missing = makeClient({
    overrides: [
      { match: 'update outbound_actions', rows: [] },
      { match: 'select status, payload from outbound_actions', rows: [] }
    ]
  });
  await assert.rejects(
    () => markOwnerAutoSentWrong(missing, {
      firmId: FIRM, clientId: CLIENT, actionId: 'nope', actorType: 'owner', actorId: 'kari@books.example'
    }),
    (error) => error.code === 'OUTBOUND_ACTION_NOT_FOUND' && error.statusCode === 404
  );
});

// ── post_send_reversal: the "undo the books entry" verb on invoice FYIs ──────

test('sent-FYI invoice rows surface the AR post state; non-invoice rows never carry it', async () => {
  const client = makeClient({
    pending: [],
    autoSentReceipts: [
      executedAutoSend({
        id: 'a-50', action_type: 'issue_invoice', anchor_type: 'issued_invoice', anchor_id: 'inv-1',
        payload: { ar_journal_id: 'journal-1' }
      }),
      executedAutoSend({
        id: 'a-51', action_type: 'issue_invoice', anchor_type: 'issued_invoice', anchor_id: 'inv-2',
        payload: { ar_journal_id: 'journal-2', ar_post_reversed_at: '2026-07-25T09:00:00Z' }
      }),
      // A reminder never carries the reverse verb even if a payload key leaked.
      executedAutoSend({ id: 'a-52', payload: { ar_journal_id: 'journal-x' } })
    ]
  });
  const surface = await readOwnerActionsSurface(client, { firmId: FIRM, clientId: CLIENT, env: {} });
  assert.equal(surface.auto_sent.length, 3);
  assert.equal(surface.auto_sent[0].ar_journal_id, 'journal-1', 'a posted invoice row carries the verb');
  assert.equal(surface.auto_sent[0].ar_post_reversed_at, null);
  assert.equal(surface.auto_sent[1].ar_post_reversed_at, '2026-07-25T09:00:00Z',
    'a reversed row renders the acknowledgement, not the button');
  assert.equal(surface.auto_sent[2].ar_journal_id, null, 'non-invoice rows never carry the reverse verb');
});

test('reverse-post routes to the writer (books motion + D1 correction) and reports idempotently', async () => {
  const client = makeClient({
    overrides: [
      { match: 'update outbound_actions', rows: ({ sql, params }) => (
        sql.includes("(payload->>'ar_post_reversed_at') is null")
          ? [{
              id: params[0], action_type: 'issue_invoice', status: 'executed',
              payload: { ar_journal_id: 'journal-1', ar_post_reversed_at: '2026-07-25T09:00:00Z' }
            }]
          : [{ id: params[0] }]
      ) },
      { match: 'insert into outbound_earned_auto', rows: [{ id: 'ea-1', state: 'counting' }] },
      // The firmDb reversal writer's queries (lazy-imported REAL writer runs
      // against this fake — the same posture as the finalize's markIssued).
      { match: 'reversal_of_journal_id = $3', rows: [] },
      { match: 'from ledger_journals', rows: [{
        id: 'journal-1', source_type: 'sales_invoice', source_id: '2026004',
        journal_date: '2026-07-20', currency: 'USD', status: 'posted', memo: 'Invoice 2026004'
      }] },
      { match: 'from close_periods', rows: [] },
      { match: 'from ledger_lines ll', rows: [
        { id: 'l-1', account_id: 'acc-ar', account_code: '1100', account_name: 'Accounts receivable', line_no: 1, direction: 'debit', debit: 500, credit: 0, amount: 500, currency: 'USD', tax_type: 'NONE', memo: 'x', payload: {}, account_type: 'receivable', normal_balance: 'debit' },
        { id: 'l-2', account_id: 'acc-rev', account_code: '4000', account_name: 'Sales revenue', line_no: 2, direction: 'credit', debit: 0, credit: 500, amount: 500, currency: 'USD', tax_type: 'NONE', memo: 'x', payload: {}, account_type: 'revenue', normal_balance: 'credit' }
      ] },
      { match: 'insert into ledger_accounts', rows: [] },
      { match: 'insert into ledger_journals', rows: [] },
      { match: 'insert into ledger_lines', rows: [] }
    ]
  });
  const result = await reverseOwnerAutoSentPost(client, {
    firmId: FIRM, clientId: CLIENT, actionId: 'a-50', actorType: 'owner', actorId: 'kari@books.example'
  });
  assert.equal(result.reversed, true);
  assert.ok(result.reversal_journal_id, 'the reversal journal id is reported');
  const correction = client.calls.find((c) => c.sql.includes('insert into outbound_earned_auto'));
  assert.ok(correction, 'the correction is recorded at the writer, through this surface');
  assert.ok(JSON.stringify(correction.params).includes('post_send_reversal'));

  // Already reversed: the writer matches zero rows; the probe reports it.
  const already = makeClient({
    overrides: [
      { match: 'update outbound_actions', rows: [] },
      { match: 'select status, action_type, payload from outbound_actions', rows: [{
        status: 'executed', action_type: 'issue_invoice',
        payload: { ar_journal_id: 'journal-1', ar_post_reversed_at: '2026-07-25T09:00:00Z' }
      }] }
    ]
  });
  assert.deepEqual(
    await reverseOwnerAutoSentPost(already, {
      firmId: FIRM, clientId: CLIENT, actionId: 'a-50', actorType: 'owner', actorId: 'kari@books.example'
    }),
    { reversed: false, already: 'reversed' }
  );

  // A skipped AR leg (no journal): honest no_ar_post report, nothing touched.
  const noPost = makeClient({
    overrides: [
      { match: 'update outbound_actions', rows: [] },
      { match: 'select status, action_type, payload from outbound_actions', rows: [{
        status: 'executed', action_type: 'issue_invoice', payload: {}
      }] }
    ]
  });
  assert.deepEqual(
    await reverseOwnerAutoSentPost(noPost, {
      firmId: FIRM, clientId: CLIENT, actionId: 'a-50', actorType: 'owner', actorId: 'kari@books.example'
    }),
    { reversed: false, already: 'no_ar_post' }
  );

  // Unknown action: 404.
  const missing = makeClient({
    overrides: [
      { match: 'update outbound_actions', rows: [] },
      { match: 'select status, action_type, payload from outbound_actions', rows: [] }
    ]
  });
  await assert.rejects(
    () => reverseOwnerAutoSentPost(missing, {
      firmId: FIRM, clientId: CLIENT, actionId: 'nope', actorType: 'owner', actorId: 'kari@books.example'
    }),
    (error) => error.code === 'OUTBOUND_ACTION_NOT_FOUND' && error.statusCode === 404
  );
});

test('v2: the read carries needs-owner replies as a standing window with the digest copy', async () => {
  const client = makeClient({
    pending: [],
    overrides: [
      { match: 'from outbound_owner_replies', rows: ({ params }) => {
        assert.equal(params[2], true, 'the tab reads the WHOLE recent window (notified included)');
        return [{
          id: 'r-1', subject: 'Re: Donna digest',
          classification: { intent: 'send_was_wrong', action_id: null, reason: 'ambiguous' },
          received_at: '2026-07-23T10:00:00Z', created_at: '2026-07-23T10:00:00Z',
          owner_notified_at: '2026-07-23T13:40:00Z'
        }];
      } }
    ]
  });
  const surface = await readOwnerActionsSurface(client, { firmId: FIRM, clientId: CLIENT, env: {} });
  assert.equal(surface.owner_replies.length, 1);
  assert.ok(surface.owner_replies[0].description.includes("couldn't tell which send you meant"),
    'the tab renders THE digest phrasing off the persisted verdict');
});
