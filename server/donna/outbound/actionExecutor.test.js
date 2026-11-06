// Action executor (M0.3, A3 interlocks). Mock-pg harness over the REAL US
// pack (render truth included). Pins:
//   - shadow stage: due work produces ONE would-execute audit, zero mutation;
//   - an owner-APPROVED row sends under per_send_owner_approval authority
//     with the receipt carrying exact rendered content + provider id, and the
//     cadence advances (next pack step minted, scheduled from due_date);
//   - a SCHEDULED row whose fresh verdict is not auto_execute is HELD back to
//     the owner at send time (stage regressed ⇒ no send);
//   - approved does NOT override paid-truth: missing verdict holds, settled
//     cancels with a receipt (ambiguity holds, never sends; a cancel is a
//     terminal, not a silent skip);
//   - a suppressed recipient cancels at send time even when approved;
//   - a provider error lands 'failed' + receipt; a render refusal lands
//     'failed' without leaking a placeholder;
//   - cadence exhaustion audits the escalation to the OWNER;
//   - stale executing leases are surfaced, never auto-retried.

import assert from 'node:assert/strict';
import test from 'node:test';

import { executeDueOutboundActions } from './actionExecutor.js';
import { FSI, LRI, PDI, stripBidiControls } from './bidiText.js';

const FIRM = 'firm-1';
const CLIENT = 'client-1';
const NOW = Date.parse('2026-07-24T00:00:00Z');
// G8: the unsubscribe URL resolves from token + base URL; the US templates
// require {{unsubscribe_url}}, so the env carries the deployment base.
const ENV = { OUTBOUND_PUBLIC_BASE_URL: 'https://donna.test' };

const actionRow = (over = {}) => ({
  id: 'a-1', firm_id: FIRM, client_id: CLIENT,
  action_type: 'send_receivable_reminder', target_party_id: 'p-1',
  anchor_type: 'document', anchor_id: 'doc-1', pack_id: 'us',
  template: 'reminder_step_1', language: null,
  payload: {
    due_date: '2026-07-01',
    render_values: {
      owner_business_name: 'Roofline Co', invoice_number: 'INV-14',
      amount_due: '1,250.00', due_date: 'Jul 1, 2026',
      payment_instructions: 'ACH routing 021000021, account 1234'
    }
  },
  amount: 1250, currency: 'USD', confidence: 0.9,
  status: 'approved', approved_by_actor_type: 'owner', approved_by_actor_id: 'kari',
  scheduled_for: '2026-07-08T00:00:00Z', cadence_step: 1,
  model: null, config_snapshot_id: null,
  unsubscribe_token: 'ut-1', approval_token: 'at-1',
  ...over
});

const makeExecClient = ({ stage = 'canary', action = actionRow(), overrides = [] } = {}) => {
  const calls = [];
  const handlers = [
    ...overrides,
    { match: 'for update skip locked', rows: () => [action] },
    { match: 'order by coalesce(scheduled_for, created_at) asc', rows: () => [action] },
    { match: 'from client_capability_config', rows: [
      { flag_key: 'OUTBOUND_DUNNING', stage, source: 'test', client_id: CLIENT }
    ] },
    { match: 'from cohort_capability_config', rows: [] },
    { match: 'from client_parties where firm_id = $1 and client_id = $2 and id = $3',
      rows: [{ id: 'p-1', display_name: 'Acme LLC', do_not_contact: false, preferred_language: null }] },
    { match: 'from party_channels where firm_id',
      rows: [{ id: 'ch-1', channel_kind: 'email', normalized_value: 'ap@acme-com.example', is_primary: true }] },
    { match: 'from outbound_suppression', rows: [] },
    { match: "set status = 'executed'", rows: [action] },
    { match: "set status = 'failed'", rows: [action] },
    { match: "set status = 'cancelled'", rows: [action] },
    { match: "set status = 'hold_for_approval'", rows: [action] },
    { match: "status = 'executing' and claimed_at", rows: [] },
    { match: 'insert into outbound_action_receipts', rows: [] },
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

// Audit actions travel as a bind parameter in the store writers but as an
// inline SQL literal in the executor's direct inserts — accept either.
const audited = (client, action) => client.calls.filter(
  (c) => c.sql.includes('insert into audit_events')
    && (c.sql.includes(`'${action}'`) || (c.params || []).includes(action))
);

const receipts = (client) => client.calls.filter(
  (c) => c.sql.includes('insert into outbound_action_receipts')
);

const okDeliverer = { email: async () => ({ providerMessageId: 'rs-9' }) };
const unpaid = async () => 'unpaid';

test('shadow stage: one would-execute audit, zero mutation', async () => {
  const client = makeExecClient({ stage: 'shadow' });
  const stats = await executeDueOutboundActions({
    client, firmId: FIRM, clientId: CLIENT, env: ENV, now: NOW,
    deliverers: okDeliverer, paidTruthCheck: unpaid
  });
  assert.equal(stats.shadow_would_send, 1);
  assert.equal(stats.sent, 0);
  assert.equal(audited(client, 'outbound_action.would_execute').length, 1);
  assert.ok(!client.calls.some((c) => c.sql.includes("set status = 'executing'")), 'nothing claimed');
});

test('approved row sends under owner authority; receipt carries exact content + provider id; cadence advances', async () => {
  const client = makeExecClient({ stage: 'canary' });
  const sent = [];
  const stats = await executeDueOutboundActions({
    client, firmId: FIRM, clientId: CLIENT, env: ENV, now: NOW,
    deliverers: { email: async (args) => { sent.push(args); return { providerMessageId: 'rs-9' }; } },
    paidTruthCheck: unpaid
  });
  assert.equal(stats.sent, 1, JSON.stringify(stats));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].recipient, 'ap@acme-com.example');
  assert.equal(sent[0].subject, 'Friendly reminder: invoice INV-14 from Roofline Co');
  assert.equal(sent[0].text, [
    'Hi Acme LLC,',
    '',
    'This is a friendly reminder that invoice INV-14 for 1,250.00 USD was due on Jul 1, 2026. If you\'ve already sent payment, thank you — no action is needed.',
    '',
    'Payment details:',
    'ACH routing 021000021, account 1234',
    '',
    'If anything about this invoice looks off, just reply to this email and we\'ll sort it out.',
    '',
    'Best regards,',
    'Roofline Co',
    '',
    '--',
    'This reminder was sent by Donna on behalf of Roofline Co. To stop receiving payment reminders about this invoice: https://donna.test/api/donna/outbound/unsubscribe?token=ut-1'
  ].join('\n'), 'AR-4E leaves the established English subject/plain-text bytes unchanged');
  assert.ok(sent[0].body.includes('Acme LLC'), 'counterparty name rendered from the party row');
  assert.ok(sent[0].body.includes('INV-14'));
  assert.ok(!sent[0].body.includes('{{'), 'no leaked placeholders');
  assert.equal(sent[0].text, sent[0].body, 'the compatibility body and provider text are identical');
  assert.match(sent[0].html, /^<!doctype html><html lang="en" dir="ltr">/);
  assert.ok(sent[0].html.includes('Acme LLC'));

  const receipt = receipts(client).find((c) => c.params.includes('sent'));
  assert.ok(receipt, 'sent receipt written');
  assert.ok(receipt.params.includes('owner:kari'), 'approver attributed');
  assert.ok(receipt.params.includes('per_send_owner_approval'), 'authority basis');
  assert.ok(receipt.params.includes('rs-9'), 'provider message id');
  // The model id tracks the pack version (v6 = the chart-of-accounts +
  // statutory-obligations legs; v5 was the quote_pdf artifact set).
  assert.ok(receipt.params.includes('deterministic:pack:us@v6'), 'model id names the deterministic renderer');
  assert.deepEqual(JSON.parse(receipt.params[27]), [],
    'a non-attachment template persists an explicit empty manifest');

  // Cadence: step 1 → step 2, scheduled due_date + 14d.
  const mint = client.calls.find((c) => c.sql.includes('insert into outbound_actions'));
  assert.ok(mint, 'next cadence step minted');
  assert.equal(mint.params[18], 2, 'cadence step 2');
  assert.equal(Date.parse(mint.params[17]), Date.parse('2026-07-15T00:00:00Z'), 'scheduled from due date + step delta');
  assert.equal(stats.cadence_minted, 1);
});

test('a scheduled row whose fresh verdict is not auto_execute is held back to the owner', async () => {
  const client = makeExecClient({ stage: 'canary', action: actionRow({ status: 'scheduled', approved_by_actor_type: null, approved_by_actor_id: null }) });
  const stats = await executeDueOutboundActions({
    client, firmId: FIRM, clientId: CLIENT, env: ENV, now: NOW,
    deliverers: okDeliverer, paidTruthCheck: unpaid
  });
  assert.equal(stats.held, 1, JSON.stringify(stats));
  assert.equal(stats.sent, 0);
  assert.ok(client.calls.some((c) => c.sql.includes("set status = 'hold_for_approval'")));
  assert.equal(audited(client, 'outbound_action.held_at_send').length, 1);
});

test('approval does not override paid-truth: missing holds, settled cancels with receipt', async () => {
  const missing = makeExecClient({ stage: 'canary' });
  const missingStats = await executeDueOutboundActions({
    client: missing, firmId: FIRM, clientId: CLIENT, env: ENV, now: NOW,
    deliverers: okDeliverer, paidTruthCheck: async () => null
  });
  assert.equal(missingStats.held, 1);
  assert.equal(missingStats.sent, 0);

  const settled = makeExecClient({ stage: 'canary' });
  const settledStats = await executeDueOutboundActions({
    client: settled, firmId: FIRM, clientId: CLIENT, env: ENV, now: NOW,
    deliverers: okDeliverer, paidTruthCheck: async () => 'settled'
  });
  assert.equal(settledStats.cancelled, 1);
  const receipt = receipts(settled).find((c) => c.params.includes('cancelled'));
  assert.ok(receipt, 'cancel receipted');
  assert.ok(receipt.params.some((p) => String(p).includes('already_settled')));
});

test('a suppressed recipient cancels at send time even when approved', async () => {
  const client = makeExecClient({
    stage: 'canary',
    overrides: [{ match: 'from outbound_suppression', rows: [{ 1: 1 }] }]
  });
  const stats = await executeDueOutboundActions({
    client, firmId: FIRM, clientId: CLIENT, env: ENV, now: NOW,
    deliverers: okDeliverer, paidTruthCheck: unpaid
  });
  assert.equal(stats.cancelled, 1);
  assert.equal(stats.sent, 0);
});

test('a provider error lands failed with a receipt carrying the rendered content', async () => {
  const client = makeExecClient({ stage: 'canary' });
  const stats = await executeDueOutboundActions({
    client, firmId: FIRM, clientId: CLIENT, env: ENV, now: NOW,
    deliverers: { email: async () => { throw new Error('resend 500'); } },
    paidTruthCheck: unpaid
  });
  assert.equal(stats.failed, 1);
  const receipt = receipts(client).find((c) => c.params.includes('failed'));
  assert.ok(receipt);
  assert.ok(receipt.params.some((p) => String(p).includes('resend 500')));
});

test('a render refusal lands failed and never leaks a placeholder', async () => {
  const broken = actionRow();
  broken.payload = { ...broken.payload, render_values: { ...broken.payload.render_values } };
  delete broken.payload.render_values.payment_instructions;
  const client = makeExecClient({ stage: 'canary', action: broken });
  const sends = [];
  const stats = await executeDueOutboundActions({
    client, firmId: FIRM, clientId: CLIENT, env: ENV, now: NOW,
    deliverers: { email: async (args) => { sends.push(args); return {}; } },
    paidTruthCheck: unpaid
  });
  assert.equal(stats.failed, 1);
  assert.equal(sends.length, 0, 'nothing sent');
  const receipt = receipts(client)[0];
  assert.ok(receipt.params.some((p) => String(p).includes('render')), 'render check on the receipt');
});

test('cadence exhaustion audits the escalation to the owner', async () => {
  const finalStep = actionRow({ cadence_step: 3, template: 'reminder_step_3' });
  const client = makeExecClient({ stage: 'canary', action: finalStep });
  const stats = await executeDueOutboundActions({
    client, firmId: FIRM, clientId: CLIENT, env: ENV, now: NOW,
    deliverers: okDeliverer, paidTruthCheck: unpaid
  });
  assert.equal(stats.sent, 1);
  assert.equal(stats.cadence_escalations, 1);
  const escalation = audited(client, 'outbound_action.cadence_exhausted');
  assert.equal(escalation.length, 1);
  assert.ok(escalation[0].params.some((p) => String(p).includes('"escalate_to":"owner"')));
});

test('stale executing leases are surfaced, never auto-retried', async () => {
  const client = makeExecClient({
    stage: 'canary', action: actionRow(),
    overrides: [
      { match: 'order by coalesce(scheduled_for, created_at) asc', rows: [] },
      { match: "status = 'executing' and claimed_at", rows: [{ id: 'a-stale' }] }
    ]
  });
  const warnings = [];
  const stats = await executeDueOutboundActions({
    client, firmId: FIRM, clientId: CLIENT, env: ENV, now: NOW,
    deliverers: okDeliverer, paidTruthCheck: unpaid,
    logger: { warn: (msg) => warnings.push(msg) }
  });
  assert.equal(stats.stale_executing, 1);
  assert.ok(warnings.some((w) => String(w).includes('stale')));
  assert.ok(!client.calls.some((c) => c.sql.includes("set status = 'executing'")), 'no retry claim');
});

test('an off flag leaves due rows untouched (kill switch stops acting, does not cancel)', async () => {
  const client = makeExecClient({ stage: 'off' });
  const stats = await executeDueOutboundActions({
    client, firmId: FIRM, clientId: CLIENT, env: ENV, now: NOW,
    deliverers: okDeliverer, paidTruthCheck: unpaid
  });
  assert.equal(stats.considered, 1);
  assert.equal(stats.sent + stats.held + stats.cancelled + stats.failed + stats.shadow_would_send, 0);
  assert.ok(!client.calls.some((c) => c.sql.includes("set status = 'executing'")));
});

// ── M3: the abstraction proof at executor level. Finland runs through THE
// pipeline — same executor, same gate, same claim/finalize shape — with only
// pack data changed: packs/fi templates render natively in Finnish, the viite
// travels from the mint's render_values into the counterparty's inbox, and
// the receipt's deterministic model id names the FI pack version. Zero
// executor edits were needed for any of this (the tracker records the one
// detector-side seam separately).

const fiActionRow = (over = {}) => actionRow({
  pack_id: 'fi', template: 'reminder_step_1',
  payload: {
    due_date: '2026-07-01',
    render_values: {
      owner_business_name: 'Northwind Ventures Oy', invoice_number: '2026007',
      reference_number: '20260071', amount_due: '745,00',
      due_date: '1.7.2026',
      payment_instructions: 'IBAN FI49 5000 9420 0287 30 (BIC OKOYFIHH)'
    }
  },
  amount: 745, currency: 'EUR',
  ...over
});

test('M3 proof: an FI reminder renders natively and sends through the unchanged executor', async () => {
  const sends = [];
  const client = makeExecClient({
    stage: 'canary', action: fiActionRow(),
    overrides: [
      { match: 'from client_capability_config', rows: [
        { flag_key: 'OUTBOUND_DUNNING', stage: 'canary', source: 'test', client_id: CLIENT }
      ] },
      { match: 'from client_parties where firm_id = $1 and client_id = $2 and id = $3',
        rows: [{ id: 'p-1', display_name: 'Esimerkki Oy', do_not_contact: false, preferred_language: null }] }
    ]
  });
  const stats = await executeDueOutboundActions({
    client, firmId: FIRM, clientId: CLIENT, env: ENV, now: NOW,
    deliverers: { email: async (payload) => { sends.push(payload); return { providerMessageId: 're-fi-1' }; } },
    paidTruthCheck: unpaid
  });
  assert.equal(stats.sent, 1, JSON.stringify(stats));
  assert.equal(sends.length, 1);
  // Native Finnish (the pack default language — the party has no preference).
  assert.match(sends[0].subject, /^Maksumuistutus: lasku 2026007$/);
  assert.ok(sends[0].body.includes('Hyvä Esimerkki Oy'));
  assert.ok(sends[0].body.includes('viitenumeroa 20260071'), 'the viite reaches the inbox');
  assert.ok(sends[0].body.includes('FI49 5000 9420 0287 30'));
  assert.ok(!sends[0].body.includes('{{'), 'no leaked placeholder');
  // The receipt's model id names the FI pack version (the model id is part of
  // the receipt — deterministic:pack:fi@v8 since the per-correspondence-
  // language locale contract).
  const receipt = receipts(client)[0];
  assert.ok(receipt.params.some((p) => String(p) === 'deterministic:pack:fi@v8'),
    'receipt carries deterministic:pack:fi@v8');
});

test('M3 proof: the FI→SV launch case — a Swedish-preference counterparty gets the native Swedish reminder', async () => {
  const sends = [];
  const client = makeExecClient({
    stage: 'canary', action: fiActionRow(),
    overrides: [
      { match: 'from client_parties where firm_id = $1 and client_id = $2 and id = $3',
        rows: [{ id: 'p-1', display_name: 'Exempel Ab', do_not_contact: false, preferred_language: 'sv' }] }
    ]
  });
  const stats = await executeDueOutboundActions({
    client, firmId: FIRM, clientId: CLIENT, env: ENV, now: NOW,
    deliverers: { email: async (payload) => { sends.push(payload); return { providerMessageId: 're-sv-1' }; } },
    paidTruthCheck: unpaid
  });
  assert.equal(stats.sent, 1, JSON.stringify(stats));
  assert.match(sends[0].subject, /^Betalningspåminnelse: faktura 2026007$/);
  assert.ok(sends[0].body.includes('Bästa Exempel Ab'));
  assert.ok(sends[0].body.includes('referensnummer 20260071'));
});

test('M3 proof: a render refusal on a missing viite fails closed — nothing leaks to the counterparty', async () => {
  const sends = [];
  const noReference = fiActionRow();
  delete noReference.payload.render_values.reference_number;
  const client = makeExecClient({ stage: 'canary', action: noReference });
  const stats = await executeDueOutboundActions({
    client, firmId: FIRM, clientId: CLIENT, env: ENV, now: NOW,
    deliverers: { email: async (payload) => { sends.push(payload); return { providerMessageId: 'x' }; } },
    paidTruthCheck: unpaid
  });
  assert.equal(stats.failed, 1, JSON.stringify(stats));
  assert.equal(sends.length, 0, 'the deliverer is never called');
});

const aeActionRow = (over = {}) => actionRow({
  pack_id: 'ae', template: 'reminder_step_1', currency: 'AED', amount: 1250,
  payload: {
    due_date: '2026-07-01',
    render_values: {
      owner_business_name: 'Roofline FZ-LLC', invoice_number: 'AE-INV-41',
      amount_due: 'AED 1,250.00', due_date: '1 Jul 2026',
      payment_instructions: 'IBAN AE07 0331 2345 6789 0123 456'
    }
  },
  ...over
});

test('AR-4F: real AE action with an unsupported request holds with a receipt and zero provider call', async () => {
  const sends = [];
  const client = makeExecClient({
    action: aeActionRow(),
    overrides: [{
      match: 'from client_parties where firm_id = $1 and client_id = $2 and id = $3',
      rows: [{
        id: 'p-1', display_name: 'شركة المثال', do_not_contact: false,
        preferred_language: 'fr', fallback_language: null
      }]
    }]
  });
  const stats = await executeDueOutboundActions({
    client, firmId: FIRM, clientId: CLIENT, env: ENV, now: NOW,
    deliverers: { email: async (payload) => { sends.push(payload); return { providerMessageId: 'never' }; } },
    paidTruthCheck: unpaid
  });
  assert.equal(stats.held_language_unavailable, 1, JSON.stringify(stats));
  assert.equal(sends.length, 0);
  const receipt = receipts(client)[0];
  assert.ok(receipt.params.includes('requested_language_unavailable'));
  assert.ok(receipt.params.includes('fr'));
  assert.ok(receipt.params.includes('party_preference'));
});

test('AR-4F: explicit AE fallback sends text + HTML and receipts requested versus actual language', async () => {
  const sends = [];
  const client = makeExecClient({
    action: aeActionRow(),
    overrides: [{
      match: 'from client_parties where firm_id = $1 and client_id = $2 and id = $3',
      rows: [{
        id: 'p-1', display_name: 'شركة المثال', do_not_contact: false,
        preferred_language: 'fr', fallback_language: 'en'
      }]
    }]
  });
  const stats = await executeDueOutboundActions({
    client, firmId: FIRM, clientId: CLIENT, env: ENV, now: NOW,
    deliverers: { email: async (payload) => { sends.push(payload); return { providerMessageId: 'ae-fallback-1' }; } },
    paidTruthCheck: unpaid
  });
  assert.equal(stats.sent, 1, JSON.stringify(stats));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, sends[0].body);
  assert.match(sends[0].html, /^<!doctype html><html lang="en" dir="ltr">/);
  assert.ok(sends[0].text.includes('شركة المثال'), 'logical Arabic name is not weakened in plain text');
  const receipt = receipts(client).find((call) => call.params.includes('sent'));
  assert.ok(receipt.params.includes('fr'));
  assert.ok(receipt.params.includes('en'));
  assert.ok(receipt.params.includes('party_explicit_fallback'));
  assert.ok(receipt.params.some((value) => /^sha256:[0-9a-f]{64}$/.test(String(value))));
});

test('AR-4F: shipping Arabic reminder forces Latin values into islands and maps them to HTML bdi', async () => {
  const sends = [];
  const client = makeExecClient({
    action: aeActionRow(),
    overrides: [{
      match: 'from client_parties where firm_id = $1 and client_id = $2 and id = $3',
      rows: [{
        id: 'p-1', display_name: 'Acme LLC', do_not_contact: false,
        preferred_language: 'ar', fallback_language: null
      }]
    }]
  });
  const stats = await executeDueOutboundActions({
    client, firmId: FIRM, clientId: CLIENT, env: ENV, now: NOW,
    deliverers: { email: async (payload) => { sends.push(payload); return { providerMessageId: 'rtl-1' }; } },
    paidTruthCheck: unpaid
  });
  assert.equal(stats.sent, 1, JSON.stringify(stats));
  assert.ok(sends[0].text.includes(`${LRI}AE-INV-41${PDI}`));
  assert.ok(sends[0].text.includes(`${FSI}Acme LLC${PDI}`), 'even an all-Latin name gets a first-strong boundary under RTL');
  assert.ok(sends[0].html.includes('<bdi dir="ltr">AE-INV-41</bdi>'));
  assert.ok(sends[0].html.includes('<bdi dir="auto">Acme LLC</bdi>'));
  assert.ok(stripBidiControls(sends[0].text).includes('الفاتورة AE-INV-41'));
  assert.match(sends[0].html, /^<!doctype html><html lang="ar" dir="rtl">/);
  const receipt = receipts(client).find((call) => call.params.includes('sent'));
  assert.ok(receipt.params.includes('ar-AE'));
  assert.ok(receipt.params.includes(6), 'the receipt names the AE v6 template catalog');
});

test('AR-4E: approval-time delivery contract drift re-holds before the provider', async () => {
  const sends = [];
  const client = makeExecClient({
    action: actionRow({
      approved_delivery_contract_version: 2,
      approved_delivery_contract_fingerprint: `sha256:${'0'.repeat(64)}`
    })
  });
  const stats = await executeDueOutboundActions({
    client, firmId: FIRM, clientId: CLIENT, env: ENV, now: NOW,
    deliverers: { email: async (payload) => { sends.push(payload); return { providerMessageId: 'never' }; } },
    paidTruthCheck: unpaid
  });
  assert.equal(stats.held_delivery_contract_changed, 1, JSON.stringify(stats));
  assert.equal(sends.length, 0);
  assert.ok(receipts(client)[0].params.includes('approved_delivery_contract_changed'));
});

test('AR-4E: an existing version-1 approval is not invalidated by the version-2 contract', async () => {
  const sends = [];
  const client = makeExecClient({
    action: actionRow({
      approved_delivery_contract_version: 1,
      approved_delivery_contract_fingerprint: `sha256:${'0'.repeat(64)}`
    })
  });
  const stats = await executeDueOutboundActions({
    client, firmId: FIRM, clientId: CLIENT, env: ENV, now: NOW,
    deliverers: { email: async (payload) => { sends.push(payload); return { providerMessageId: 'legacy-v1' }; } },
    paidTruthCheck: unpaid
  });
  assert.equal(stats.sent, 1, JSON.stringify(stats));
  assert.equal(sends.length, 1);
  assert.equal(stats.held_delivery_contract_changed, 0);
});

// ── M4: owner-directed payable notices through THE executor ──────────────────

const payableActionRow = (over = {}) => actionRow({
  id: 'a-pay-1', action_type: 'send_payable_notice',
  anchor_type: 'document', anchor_id: 'bill-1',
  template: 'payable_notice', language: 'en',
  status: 'scheduled', approved_by_actor_type: null, approved_by_actor_id: null,
  cadence_step: 0, confidence: null,
  payload: {
    due_date: '2026-07-28',
    render_values: {
      owner_business_name: 'Roofline Co', amount_due: '840.00', due_date: 'Jul 28, 2026'
    }
  },
  amount: 840, currency: 'USD',
  ...over
});

const payableHandlers = ({ billStatus = 'unpaid', party = null } = {}) => [
  { match: 'from client_capability_config', rows: [
    { flag_key: 'OUTBOUND_PAYABLES', stage: 'canary', source: 'test', client_id: CLIENT }
  ] },
  { match: 'from clients where firm_id',
    rows: [{ company_name: 'Roofline Co', profile: { email: 'owner@roofline-co.example' } }] },
  { match: 'select payment_status from documents', rows: [{ payment_status: billStatus }] },
  { match: 'from client_parties where firm_id = $1 and client_id = $2 and id = $3',
    rows: [party || { id: 'p-1', display_name: 'Lumber Depot', do_not_contact: false, preferred_language: 'fi' }] }
];

test('M4: an owner-directed payable notice sends to the OWNER at canary — no approval hold, no unsubscribe plumbing', async () => {
  const sends = [];
  const client = makeExecClient({
    action: payableActionRow(),
    overrides: payableHandlers({})
  });
  const stats = await executeDueOutboundActions({
    client, firmId: FIRM, clientId: CLIENT, env: ENV, now: NOW,
    deliverers: { email: async (payload) => { sends.push(payload); return { providerMessageId: 'own-1' }; } },
    paidTruthCheck: async () => null
  });
  assert.equal(stats.sent, 1, JSON.stringify(stats));
  assert.equal(stats.held, 0, 'the recipient IS the approver — no hold lane');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].recipient, 'owner@roofline-co.example', 'the OWNER profile email, never a party channel');
  assert.equal(sends[0].identity, null, 'Donna\'s own operational identity — no counterparty From');
  assert.deepEqual(sends[0].headers, {}, 'no unsubscribe headers on owner mail');
  // The supplier's preferred_language (fi) must NOT pick the render language.
  assert.match(sends[0].subject, /Lumber Depot's bill is due Jul 28, 2026/);
  assert.ok(sends[0].body.includes('in 4 days'), 'days_until_due derived fresh at render');
  assert.ok(!sends[0].body.includes('{{'), 'no leaked tokens');
  const receipt = receipts(client)[0];
  assert.ok(receipt.params.includes('owner_directed_notice:OUTBOUND_PAYABLES'),
    'the receipt names the owner-directed authority basis');
});

test('AR-4F: an Arabic owner/pack payable notice ignores the supplier language and receipts the RTL envelope', async () => {
  const sends = [];
  const action = payableActionRow({
    pack_id: 'ae', language: 'ar', currency: 'AED', amount: 840,
    payload: {
      due_date: '2026-07-28',
      render_values: {
        owner_business_name: 'شركة روفلاين ذ.م.م', amount_due: '840.00',
        due_date: '28 يوليو 2026'
      }
    }
  });
  const client = makeExecClient({
    action,
    overrides: payableHandlers({ party: {
      id: 'p-1', display_name: 'Lumber Depot', do_not_contact: false,
      preferred_language: 'fr', fallback_language: 'en'
    } })
  });
  const stats = await executeDueOutboundActions({
    client, firmId: FIRM, clientId: CLIENT, env: ENV, now: NOW,
    deliverers: { email: async (payload) => { sends.push(payload); return { providerMessageId: 'own-ar-1' }; } },
    paidTruthCheck: async () => null
  });
  assert.equal(stats.sent, 1, JSON.stringify(stats));
  assert.equal(sends[0].recipient, 'owner@roofline-co.example');
  assert.match(stripBidiControls(sends[0].subject), /تنبيه: تستحق فاتورة المورد Lumber Depot/);
  assert.match(sends[0].html, /^<!doctype html><html lang="ar" dir="rtl">/);
  assert.ok(sends[0].html.includes('<bdi dir="auto">Lumber Depot</bdi>'));
  const receipt = receipts(client).find((row) => row.params.includes('sent'));
  assert.ok(receipt.params.includes('action_language'));
  assert.ok(receipt.params.includes('ar-AE'));
  assert.ok(receipt.params.includes(6));
  assert.equal(receipt.params.includes('party_explicit_fallback'), false,
    'supplier preference/fallback never controls owner-directed mail');
});

test('M4: a bill settled by send time cancels with a named reason, never a stale notice', async () => {
  const sends = [];
  const client = makeExecClient({
    action: payableActionRow(),
    overrides: payableHandlers({ billStatus: 'paid' })
  });
  const stats = await executeDueOutboundActions({
    client, firmId: FIRM, clientId: CLIENT, env: ENV, now: NOW,
    deliverers: { email: async (payload) => { sends.push(payload); return { providerMessageId: 'x' }; } },
    paidTruthCheck: async () => null
  });
  assert.equal(stats.cancelled, 1, JSON.stringify(stats));
  assert.equal(sends.length, 0, 'the deliverer is never called');
  const cancel = client.calls.find((c) => c.sql.includes("set status = 'cancelled'"));
  assert.ok(cancel.params.includes('bill_settled'), 'the cancel names bill_settled');
});

// ── D1: the earned-auto ladder counts owner-approved sends, and only those ──

test('D1: an owner-approved send records a clean ladder count in the finalize txn', async () => {
  const client = makeExecClient({
    stage: 'canary',
    overrides: [
      { match: 'insert into outbound_earned_auto',
        rows: ({ params }) => [{ id: params[0], state: 'counting', clean_streak: 1, total_clean: 1, clean_target: null }] }
    ]
  });
  const stats = await executeDueOutboundActions({
    client, firmId: FIRM, clientId: CLIENT, env: ENV, now: NOW,
    deliverers: okDeliverer, paidTruthCheck: unpaid
  });
  assert.equal(stats.sent, 1, JSON.stringify(stats));
  assert.equal(stats.clean_sends_recorded, 1, 'the owner-approved send counted');
  assert.ok(client.calls.some((c) => c.sql.includes('insert into outbound_earned_auto')));
});

test('D1: a stage-auto send does NOT count toward the ladder — and the deterministic verdict clears the floor', async () => {
  // A scheduled (never approved) reminder at stage auto with confidence null:
  // the explicit 'unpaid' verdict satisfies the auto confidence floor (D1's
  // clause), the send goes out under stage authority, and the ladder counts
  // nothing (it counts OWNER approvals only).
  const client = makeExecClient({
    stage: 'auto',
    action: actionRow({ status: 'scheduled', approved_by_actor_type: null, approved_by_actor_id: null, confidence: null })
  });
  const stats = await executeDueOutboundActions({
    client, firmId: FIRM, clientId: CLIENT, env: ENV, now: NOW,
    deliverers: okDeliverer, paidTruthCheck: unpaid
  });
  assert.equal(stats.sent, 1, JSON.stringify(stats));
  assert.equal(stats.held, 0, 'the null-confidence mint must not hold a graduated client');
  assert.equal(stats.clean_sends_recorded, 0);
  assert.ok(!client.calls.some((c) => c.sql.includes('insert into outbound_earned_auto')));
  const receipt = receipts(client)[0];
  assert.ok(receipt.params.includes('stage:auto:OUTBOUND_DUNNING'), 'stage authority, not owner approval');
});

// ── G13(b): the stale-consequence interlock ──────────────────────────────────
// The interlocks above re-read the anchor's LIFECYCLE. This one re-reads its
// BUSINESS FACTS. Between approval and send, a re-draft can move the recipient,
// the total, the due date or the lines — and the thing that goes out is then not
// the thing the owner approved.

const INVOICE_DRAFT = {
  invoice: {
    invoiceNumber: 'INV-2026-0001', currency: 'USD', total: 1500,
    dueDate: '2026-08-10',
    lines: [{ description: 'May retainer', quantity: 1, unitPrice: 1500, net: 1500 }]
  }
};

// The approved fingerprint for that draft delivered to ap@acme-com.example — computed
// with the same pure function the writer and the executor both use, so the test
// pins the INTERLOCK rather than re-implementing the hash.
const approvedFingerprintFor = async (draft, recipient = 'ap@acme-com.example') => {
  const { fingerprintIssuanceConsequence } = await import('./consequenceFingerprint.js');
  return fingerprintIssuanceConsequence({ recipient, anchorRow: { draft } });
};

const issuanceAction = (over = {}) => actionRow({
  action_type: 'issue_invoice', anchor_type: 'issued_invoice', anchor_id: 'inv-1',
  template: 'invoice_issue', cadence_step: 1,
  payload: {
    issue_date: '2026-07-27', due_date: '2026-08-10',
    render_values: {
      owner_business_name: 'Roofline Co', invoice_number: 'INV-2026-0001',
      invoice_total: '1,500.00', issue_date: 'Jul 27, 2026', due_date: 'Aug 10, 2026',
      lines_block: 'May retainer — 1,500.00',
      payment_instructions: 'ACH routing 021000021, account 1234'
    }
  },
  ...over
});

const makeIssuanceClient = ({ action, anchorDraft = INVOICE_DRAFT }) => makeExecClient({
  stage: 'canary',
  action,
  overrides: [
    { match: 'from client_capability_config', rows: [
      { flag_key: 'OUTBOUND_INVOICING', stage: 'canary', source: 'test', client_id: CLIENT }
    ] },
    { match: 'from issued_invoices', rows: [{
      id: 'inv-1', status: 'draft_pending_confirmation', draft: anchorDraft
    }] }
  ]
});

test('G13(b): a draft whose business facts moved after approval is HELD back to the owner', async () => {
  const approved = await approvedFingerprintFor(INVOICE_DRAFT);
  // The persisted draft now says 1,600 — the owner approved 1,500.
  const drifted = { invoice: { ...INVOICE_DRAFT.invoice, total: 1600 } };
  const client = makeIssuanceClient({
    action: issuanceAction({ approved_consequence_fingerprint: approved }),
    anchorDraft: drifted
  });
  const stats = await executeDueOutboundActions({
    client, firmId: FIRM, clientId: CLIENT, env: ENV, now: NOW,
    deliverers: okDeliverer, paidTruthCheck: unpaid
  });
  assert.equal(stats.sent, 0, 'the stale consequence never leaves');
  assert.equal(stats.held_stale_consequence, 1, JSON.stringify(stats));
  // It RESTS ON THE OWNER — a hold, not a cancel. A cancel would be Donna
  // choosing a terminal on a decision that is the owner's.
  assert.ok(client.calls.some((c) => c.sql.includes("set status = 'hold_for_approval'")));
  assert.ok(!client.calls.some((c) => c.sql.includes("set status = 'cancelled'")));
  // And it is receipted with the NAMED reason, not a silent bounce.
  const receipt = receipts(client).find((r) => (r.params || []).includes('approved_consequence_changed'));
  assert.ok(receipt, 'refusal receipted with the named reason');
});

// These two assert the interlock does NOT fire and the send PROCEEDS past it —
// the mail is actually handed to the deliverer. They deliberately stop there:
// what happens after the send (the issuance finalize + AR leg) is the issuance
// suite's contract, and re-asserting it here would test someone else's code
// through a mock instead of testing this interlock.
test('G13(b): an unchanged draft is not blocked — the mail is handed to the deliverer', async () => {
  const approved = await approvedFingerprintFor(INVOICE_DRAFT);
  const client = makeIssuanceClient({
    action: issuanceAction({ approved_consequence_fingerprint: approved })
  });
  let delivered = null;
  const stats = await executeDueOutboundActions({
    client, firmId: FIRM, clientId: CLIENT, env: ENV, now: NOW,
    deliverers: { email: async (m) => { delivered = m; return { providerMessageId: 'rs-9' }; } },
    paidTruthCheck: unpaid
  });
  assert.equal(stats.held_stale_consequence, 0, JSON.stringify(stats));
  assert.ok(delivered, 'the send was not blocked by the interlock');
  assert.equal(delivered.recipient, 'ap@acme-com.example');
  assert.ok(!client.calls.some((c) => c.sql.includes("set status = 'hold_for_approval'")));
});

test('G13(b): a NULL fingerprint is a no-op — pre-104 rows behave exactly as before', async () => {
  const client = makeIssuanceClient({
    action: issuanceAction({ approved_consequence_fingerprint: null })
  });
  let delivered = null;
  const stats = await executeDueOutboundActions({
    client, firmId: FIRM, clientId: CLIENT, env: ENV, now: NOW,
    deliverers: { email: async (m) => { delivered = m; return { providerMessageId: 'rs-9' }; } },
    paidTruthCheck: unpaid
  });
  assert.equal(stats.held_stale_consequence, 0);
  assert.ok(delivered, 'nothing to compare ⇒ nothing blocked');
});

test('G13(b): a moved RECIPIENT is a changed consequence too', async () => {
  // Approved for ap@acme-com.example; the party store now resolves someone else.
  const approved = await approvedFingerprintFor(INVOICE_DRAFT, 'old-ap@acme-com.example');
  const client = makeIssuanceClient({
    action: issuanceAction({ approved_consequence_fingerprint: approved })
  });
  const stats = await executeDueOutboundActions({
    client, firmId: FIRM, clientId: CLIENT, env: ENV, now: NOW,
    deliverers: okDeliverer, paidTruthCheck: unpaid
  });
  assert.equal(stats.sent, 0);
  assert.equal(stats.held_stale_consequence, 1, 'who receives it is part of what was approved');
});

// ── S1 specialist-role leash (INV-S2): the converged decision at the one send
//    path. The real registry passes for every outbound type today (that IS the
//    audit's success criterion); the denial postures ride the injectable
//    roleDecisionFn, and the flag stage decides hold vs would-block. ──

const denyRoleDecision = () => ({
  action_type: 'send_receivable_reminder', role_id: 'invoicing_collections',
  allowed: false, role_allowed: false, in_namespace: true,
  reasons: ['outside_role_action_set']
});

const roleStageOverride = (roleStage) => ({
  match: 'from client_capability_config',
  rows: [
    { flag_key: 'OUTBOUND_DUNNING', stage: 'canary', source: 'test', client_id: CLIENT },
    { flag_key: 'SPECIALIST_ROLE_ENFORCE', stage: roleStage, source: 'test', client_id: CLIENT }
  ]
});

test('S1: a sent receipt carries the role_leash pass check attributed to invoicing_collections (INV-S7)', async () => {
  const client = makeExecClient();
  const stats = await executeDueOutboundActions({
    client, firmId: FIRM, clientId: CLIENT, env: ENV, now: NOW,
    deliverers: okDeliverer, paidTruthCheck: unpaid
  });
  assert.equal(stats.sent, 1, JSON.stringify(stats));
  assert.equal(stats.role_would_block, 0);
  const receipt = receipts(client).find((c) => c.params.some((p) => String(p).includes('role_leash')));
  assert.ok(receipt, 'role_leash check rides the send receipt');
  assert.ok(receipt.params.some((p) => String(p).includes('invoicing_collections')), 'role attributed');
});

test('S1: a role-leash denial under an ACTING stage holds the row to the owner with a named reason', async () => {
  const client = makeExecClient({ overrides: [roleStageOverride('canary')] });
  const stats = await executeDueOutboundActions({
    client, firmId: FIRM, clientId: CLIENT, env: ENV, now: NOW,
    deliverers: okDeliverer, paidTruthCheck: unpaid,
    roleDecisionFn: denyRoleDecision
  });
  assert.equal(stats.sent, 0, JSON.stringify(stats));
  assert.equal(stats.role_leash_held, 1);
  assert.ok(client.calls.some((c) => c.sql.includes("set status = 'hold_for_approval'")), 'held, not errored');
  const receipt = receipts(client).find((c) => c.params.some((p) => String(p).includes('role_leash_denied')));
  assert.ok(receipt, 'the refusal is receipted with its named reason');
});

test('S1: a role-leash denial in SHADOW logs + receipts a would-block and the send proceeds unchanged', async () => {
  const warnings = [];
  const client = makeExecClient({ overrides: [roleStageOverride('shadow')] });
  const stats = await executeDueOutboundActions({
    client, firmId: FIRM, clientId: CLIENT, env: ENV, now: NOW,
    deliverers: okDeliverer, paidTruthCheck: unpaid,
    roleDecisionFn: denyRoleDecision,
    logger: { warn: (...args) => warnings.push(args.join(' ')) }
  });
  assert.equal(stats.sent, 1, JSON.stringify(stats));
  assert.equal(stats.role_would_block, 1);
  assert.equal(stats.role_leash_held, 0);
  assert.ok(warnings.some((w) => w.includes('would-block')), 'the would-block is logged');
  assert.equal(audited(client, 'specialist_role.would_block').length, 1, 'and receipted');
  const receipt = receipts(client).find((c) => c.params.some((p) => String(p).includes('would_block')));
  assert.ok(receipt, 'the send receipt records the observed would-block');
});

test('S1: at OFF a denial only logs — no receipt row, the send proceeds', async () => {
  const warnings = [];
  const client = makeExecClient(); // no SPECIALIST_ROLE_ENFORCE row at all
  const stats = await executeDueOutboundActions({
    client, firmId: FIRM, clientId: CLIENT, env: ENV, now: NOW,
    deliverers: okDeliverer, paidTruthCheck: unpaid,
    roleDecisionFn: denyRoleDecision,
    logger: { warn: (...args) => warnings.push(args.join(' ')) }
  });
  assert.equal(stats.sent, 1, JSON.stringify(stats));
  assert.equal(stats.role_would_block, 1);
  assert.ok(warnings.some((w) => w.includes('would-block')), 'off still logs');
  assert.equal(audited(client, 'specialist_role.would_block').length, 0, 'off writes no audit row');
});
