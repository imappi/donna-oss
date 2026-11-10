// Follow-ups to interfaceRawValues.test.js (#49): every value on these screens
// reads in the interface language, through a catalog label with a catalog
// fallback for an unknown code. Each surface is rendered for real (esbuild
// bundle + jsdom + react-dom/client) in English and in Finnish:
//   1. the ask-client pill: the preview and the draft Send transmits are one
//      text, written in the client OWNER's language (the ownerLanguage.js
//      rule), and the screen says which language that is;
//   2. TeamPanel, CloudPilotReadinessCard, ClientOwnerAccessCard and
//      ClientPortalChatPanel: stored statuses, reasons and kinds;
//   3. feed action cards never name an internal function;
//   4. the transaction audit panel turns a transport failure into a sentence
//      a person can act on.
// Synthetic data only.
import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

let dom, directory, root, createRoot, m, requests, responder;
const original = new Map(['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'MutationObserver', 'IS_REACT_ACT_ENVIRONMENT', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame']
  .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const flush = async () => act(async () => { await new Promise((r) => setTimeout(r, 15)); });
const $ = (id) => document.querySelector(`[data-testid="${id}"]`);
const text = (node) => (node?.textContent || '').replace(/[  ]/g, ' ');
const LOCALES = ['en', 'fi'];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const click = async (node) => { await act(async () => node.click()); await flush(); };
const button = (pattern) => [...document.querySelectorAll('button')].find((b) => pattern.test(text(b)));

const render = async (element, { locale = 'en' } = {}) => {
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(m.LocaleProvider, { initialPreferences: { locale } }, element)));
  await flush();
};

before(async () => {
  dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/firms', pretendToBeVisual: true });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (cb) => setTimeout(cb, 0), cancelAnimationFrame: (id) => clearTimeout(id) })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  ({ createRoot } = await import('react-dom/client'));
  globalThis.fetch = async (url, init = {}) => {
    const address = new URL(String(url), 'http://localhost');
    requests.push({ url: address, ...init });
    return (responder && await responder(address, init)) || new Response('{}', { status: 404 });
  };
  // The bundle lives in the system temp directory, never the repository; a
  // node_modules link next to it lets its external imports resolve.
  directory = await mkdtemp(join(tmpdir(), 'interface-raw-values-followups-'));
  await symlink(resolve('node_modules'), join(directory, 'node_modules'), 'dir');
  await build({
    stdin: {
      contents: [
        "export {LocaleProvider} from './src/i18n/LocaleProvider.jsx';",
        "export {default as TransactionArtifact} from './src/components/financials/transaction-artifact.jsx';",
        "export {default as TeamPanel} from './src/components/TeamPanel.jsx';",
        "export {default as CloudPilot} from './src/components/settings/CloudPilotReadinessCard.jsx';",
        "export {default as OwnerAccess} from './src/components/ClientOwnerAccessCard.jsx';",
        "export {default as PortalChat} from './src/components/ClientPortalChatPanel.jsx';",
        "export {default as FeedChat} from './src/components/financials/feed-chat.jsx';",
        "export {default as AuditTimeline} from './src/components/financials/transaction-audit-timeline.jsx';"
      ].join('\n'),
      resolveDir: process.cwd()
    },
    outfile: join(directory, 'bundle.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'import.meta.env': '{}' }, logLevel: 'silent'
  });
  m = await import(pathToFileURL(join(directory, 'bundle.mjs')));
});
afterEach(async () => { if (root) await act(async () => root.unmount()); root = null; requests = []; responder = null; document.body.innerHTML = '<div id="root"></div>'; });
after(async () => {
  dom?.window.close();
  for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  if (directory) await rm(directory, { recursive: true, force: true });
});
requests = [];

// ── 1. Ask-client: one text, in the owner's language ──────────────────────
const askArtifact = (client) => ({
  type: 'transaction',
  data: {
    clientId: 'client-synthetic',
    client,
    transaction: { id: 'tx-synthetic-1', client_id: 'client-synthetic', transaction_date: '2026-08-18', description: 'CARD PURCHASE NORTHWIND SUPPLIES', money_in: 0, money_out: 250, account_currency: 'EUR', reconciliation_status: 'unreconciled' },
    match: null,
    previewExplanation: { confidence: 'uncertain', actions: ['ask_client'] }
  }
});
const OWNERS = {
  // Finnish company, no explicit owner language: the country default.
  fi: { id: 'client-synthetic', companyName: 'Esimerkki Oy', persisted_identity: { jurisdiction: 'FI' } },
  // Finnish company whose owner chose English: English wins.
  en: { id: 'client-synthetic', companyName: 'Esimerkki Oy', locale: 'en', persisted_identity: { jurisdiction: 'FI' } }
};
const OWNER_QUESTION = {
  fi: /^Hei! Tarkistaisin vielä tapahtuman .+ \(18\.8\.2026, −250,00 €\)\. Kertoisitko, mihin se liittyi\? Onko kyseessä liiketoiminnan kulu\? Kiitos!$/,
  en: /^Hi — quick check on the .+ transaction on Aug 18, 2026 for \(EUR 250\.00\)\. Could you let me know what this was for and confirm whether it’s a business expense\? Thanks!$/
};
const PREVIEW_PREFIX = {
  en: { fi: 'To the client, in Finnish: ', en: 'To the client, in English: ' },
  fi: { fi: 'Asiakkaalle suomeksi: ', en: 'Asiakkaalle englanniksi: ' }
};
const COMPOSER_LANGUAGE = {
  en: { fi: 'Written in Finnish, the client’s language.', en: 'Written in English, the client’s language.' },
  fi: { fi: 'Kirjoitettu suomeksi, asiakkaan kielellä.', en: 'Kirjoitettu englanniksi, asiakkaan kielellä.' }
};
for (const locale of LOCALES) {
  for (const owner of ['fi', 'en']) {
    test(`ask-client (${locale} interface, ${owner} owner): the preview is the text Send transmits, in the owner's language`, async () => {
      responder = (address) => {
        if (address.pathname.endsWith('/transaction-chat/ask-client')) return json({ user_message: null, system_message: null });
        if (address.pathname.endsWith('/transaction-chat')) return json({ messages: [] });
        return null;
      };
      await render(React.createElement(m.TransactionArtifact, { artifact: askArtifact(OWNERS[owner]), setArtifact: () => {} }), { locale });
      const pill = [...document.querySelectorAll('button[title]')].find((b) => b.title.startsWith(PREVIEW_PREFIX[locale][owner]));
      assert.ok(pill, `a pill previews the question as "${PREVIEW_PREFIX[locale][owner]}…": ${[...document.querySelectorAll('button[title]')].map((b) => b.title).join(' | ')}`);
      const previewed = pill.title.slice(PREVIEW_PREFIX[locale][owner].length);
      assert.match(previewed, OWNER_QUESTION[owner]);
      await click(pill);
      const draft = document.querySelector('textarea')?.value || '';
      assert.equal(draft, previewed, 'the composer holds exactly the previewed text');
      assert.ok(text(document.body).includes(COMPOSER_LANGUAGE[locale][owner]), `the composer says which language: ${text(document.body)}`);
      const send = [...document.querySelectorAll('button')].find((b) => /Send to client|Lähetä asiakkaalle/.test(text(b)));
      assert.ok(send, 'the client-mode send button renders');
      await click(send);
      const sent = requests.find((r) => r.url.pathname.endsWith('/transaction-chat/ask-client'));
      assert.ok(sent, 'Send posts the question');
      assert.equal(JSON.parse(sent.body).question, previewed, 'what is sent is what was previewed');
    });
  }
}

// ── 2a. TeamPanel ──────────────────────────────────────────────────────────
const rosterResponder = (address) => {
  if (address.pathname.endsWith('/roles/roster')) {
    return json({ roster: { bench: { mode: 'act' }, roles: [{
      id: 'invoicing_collections', action_set: ['send_receivable_reminder'], assignment: { status: 'active' },
      grants: [
        { id: 'g-1', action_type: 'send_receivable_reminder', scope_key: 'counterparty:asiakas-esimerkki', amount_ceiling: 1200, currency: 'EUR', review_after: '2026-12-01T00:00:00Z', status: 'suspended' },
        { id: 'g-2', action_type: 'something_new', scope_key: null, amount_ceiling: null, currency: null, status: 'paused_somehow' }
      ]
    }] } });
  }
  if (address.pathname.endsWith('/seats')) {
    return json({ entities: [], seats: [
      { id: 's-1', source: 'seat', name: 'Testi Henkilö', email: 'invited@example.test', seat_role: 'auditor', status: 'invited', invite_email_status: 'failed', invite_email_reason: 'send_failed', affiliation: 'internal', client_ids: [] }
    ] });
  }
  return null;
};
const TEAM_EXPECTED = {
  en: ['Send payment reminders for counterparty:asiakas-esimerkki up to €1,200.00 review 1 Dec 2026', 'Suspended', 'Another action', 'Status not recognised', 'Role not recognised', 'Invite email failed to send'],
  fi: ['Lähetä maksumuistutuksia', 'counterparty:asiakas-esimerkki', '1 200,00 €', 'Keskeytetty', 'Muu toimenpide', 'Tuntematon tila', 'Rooli tuntematon', 'Kutsusähköpostin lähetys epäonnistui']
};
for (const locale of LOCALES) {
  test(`team panel (${locale}): grant actions, statuses, amounts and dates, seat roles and invite email status read as labels`, async () => {
    responder = rosterResponder;
    await render(React.createElement(m.TeamPanel, { clients: [{ id: 'client-synthetic', companyName: 'Esimerkki Oy' }], selectedClientId: 'client-synthetic', dataSource: 'database' }), { locale });
    const open = button(/^(Open desk|Avaa työpöytä)$/);
    assert.ok(open, `the hired role's desk opens: ${text(document.body)}`);
    await click(open);
    const shown = text(document.body);
    for (const expected of TEAM_EXPECTED[locale]) assert.ok(shown.includes(expected), `${expected} in: ${shown}`);
    for (const raw of ['send receivable reminder', 'something new', 'paused_somehow', 'suspended', 'auditor', 'Invite email failed', '2026-12-01']) {
      if (raw === 'Invite email failed' && locale === 'en') continue;
      assert.ok(!shown.includes(raw), `raw ${raw} shown: ${shown}`);
    }
    const reasonTitle = [...document.querySelectorAll('[title]')].map((n) => n.title).join(' | ');
    assert.ok(!reasonTitle.includes('send_failed'), `raw reason in a tooltip: ${reasonTitle}`);
  });
}

// ── 2b. CloudPilotReadinessCard ────────────────────────────────────────────
const pilotReview = {
  firm_id: 'firm-synthetic', client_id: 'client-fi', actor_id: 'user-synthetic', review_digest: 'digest-1', host_ready: false, entity_ready: false,
  checks: [
    { id: 'database_schema', status: 'INCOMPLETE', reason: 'postgresql_not_configured' },
    { id: 'evidence_storage', status: 'PASS', reason: null },
    { id: 'model_routes', status: 'FAIL', reason: 'response_unverified' },
    { id: 'spend_meter', status: 'SOMETHING', reason: 'brand_new_reason' }
  ],
  changes: [], legacy_configuration: { LEGACY_FLAG: null }
};
const PILOT_EXPECTED = {
  en: ['Database schema: Incomplete (The database is not configured)', 'Private file storage: Passed', 'Model routes: Failed (No verified provider response yet)', 'Usage measurement: Status not recognised (Another reason, code brand_new_reason)', 'LEGACY_FLAG: not set'],
  fi: ['Tietokantarakenne: Kesken (Tietokantaa ei ole määritetty)', ': Läpäisty', ': Epäonnistui (Palveluntarjoajan vastausta ei ole vielä varmennettu)', ': Tuntematon tila (Muu syy, koodi brand_new_reason)', 'LEGACY_FLAG: ei asetettu']
};
for (const locale of LOCALES) {
  test(`cloud pilot readiness (${locale}): a check's status and reason read as labels`, async () => {
    responder = (address) => (address.pathname.includes('/cloud-pilot/review') ? json(pilotReview) : null);
    await render(React.createElement(m.CloudPilot, { firm: { id: 'firm-synthetic' }, clients: [{ id: 'client-fi', companyName: 'Esimerkki Oy', jurisdiction: 'FI' }], selectedClientId: 'client-fi', dataSource: 'database' }), { locale });
    const review = button(/Refresh readiness review|Päivitä valmiuden tarkistus/);
    assert.ok(review, `the review button renders: ${text(document.body)}`);
    await click(review);
    const shown = text(document.body);
    for (const expected of PILOT_EXPECTED[locale]) assert.ok(shown.includes(expected), `${expected} in: ${shown}`);
    for (const raw of ['INCOMPLETE', 'PASS', 'FAIL', 'postgresql_not_configured', 'response_unverified', 'unset']) assert.ok(!shown.includes(raw), `raw ${raw} shown: ${shown}`);
  });
}

// ── 2c. ClientOwnerAccessCard ──────────────────────────────────────────────
const OWNER_ACCESS_EXPECTED = {
  en: ['Owner portal access', 'Invited', 'Link valid until 30 Nov 2026.', 'The invitation email was not sent from this deployment.'],
  fi: ['Omistajan pääsy portaaliin', 'Kutsuttu', 'Linkki on voimassa 30. marrask. 2026 asti.', 'Kutsusähköpostia ei lähetetty tästä palvelusta.']
};
for (const locale of LOCALES) {
  test(`owner portal access card (${locale}): the invite's email status reads as a sentence in the interface language`, async () => {
    responder = (address) => (address.pathname.endsWith('/owner-access') ? json({
      state: 'invited', owners: [], invite: { name: 'Testi Omistaja', email: 'owner@example.test', expired: false, expires_at: '2026-11-30T12:00:00Z', invite_email_status: 'skipped' }
    }) : null);
    await render(React.createElement(m.OwnerAccess, { clientId: 'client-synthetic' }), { locale });
    const shown = text($('client-owner-access'));
    for (const expected of OWNER_ACCESS_EXPECTED[locale].map((s) => s.replace(/ /g, ' '))) {
      assert.ok(shown.replace(/\s+/g, ' ').includes(expected), `${expected} in: ${shown}`);
    }
    assert.ok(!/Email skipped|skipped/.test(shown), `raw email status shown: ${shown}`);
    if (locale === 'fi') assert.doesNotMatch(shown, /Owner portal access|Resend|Revoke|Link valid/, `English in Finnish: ${shown}`);
  });
}

// ── 2d. ClientPortalChatPanel (the owner's portal chat) ─────────────────────
const portalPreview = {
  open: true,
  messages: [
    { id: 'pm-1', role: 'assistant', content: 'Synthetic answer', created_at: '2026-09-01T08:11:00Z', payload: { actions: [
      { type: 'answer_evidence_request', status: 'withdrawn_somehow', reply_text: 'Synthetic reply', evidence_request_id: 'er-1' }
    ] } }
  ],
  evidenceTopics: [{ evidence_request_id: 'er-2', status: 'open', channel: 'whatsapp', current_need: 'Synthetic need', recent_turns: [] }],
  ownerIntentCandidates: [{
    proposal_id: 'p-1', status: 'proposed', intent_kind: 'commitment', summary: 'Synthetic summary',
    memory_candidate: { status: 'suggested' },
    preflight: {
      status: 'blocked',
      apply_plan: { selected_mutation: { verb: 'ask_client', writer: 'createClientEvidenceRequestInDb' } },
      consequence_diff: { status: 'not_computed' },
      authority: { status: 'owner_confirmation_required' },
      execution_gate: { status: 'blocked', writer_invoked: false, apply_receipt_required: true },
      blockers: [{ code: 'apply_executor_not_enabled', detail: 'Owner-intent apply executor is not enabled in this slice; no mutation writer is invoked.' }, { code: 'brand_new_blocker' }]
    }
  }]
};
const PORTAL_EXPECTED = {
  en: ['Commitment', 'Memory candidate: Suggested', 'Preflight: Blocked', 'Planned route: Ask client', 'Consequence diff: Not worked out yet', 'Authority: Needs your confirmation', 'Execution: Blocked', 'Applying is not switched on yet', 'Another check is still open', 'WhatsApp', 'Answer not filed'],
  fi: ['Sitoumus', 'Muistiehdokas: Ehdotettu', 'Esitarkistus: Estetty', 'Suunniteltu reitti: Kysy asiakkaalta', 'Muutosten vaikutus: Ei vielä laskettu', 'Valtuutus: Tarvitsee vahvistuksesi', 'Toteutus: Estetty', 'Käyttöönottoa ei ole vielä kytketty päälle', 'Jokin tarkistus on vielä kesken', 'WhatsApp', 'Vastausta ei kirjattu']
};
for (const locale of LOCALES) {
  test(`portal chat (${locale}): intent kinds, statuses, the planned route, blockers and channels read as labels`, async () => {
    await render(React.createElement(m.PortalChat, { clientId: 'client-synthetic', previewState: portalPreview }), { locale });
    const shown = text(document.body);
    for (const expected of PORTAL_EXPECTED[locale]) assert.ok(shown.includes(expected), `${expected} in: ${shown}`);
    for (const raw of ['commitment', 'createClientEvidenceRequestInDb', 'ask_client', 'not_computed', 'owner_confirmation_required', 'blocked', 'suggested', 'apply_executor_not_enabled', 'brand_new_blocker', 'whatsapp', 'withdrawn_somehow', 'Owner-intent apply executor']) {
      assert.ok(!shown.includes(raw), `raw ${raw} shown: ${shown}`);
    }
  });
}

// ── 3. Feed action cards never name an internal function ──────────────────
const feedMessages = [
  { id: 'feed-user', role: 'user', content: 'Synthetic question', created_at: '2026-09-01T08:10:00Z', payload: {} },
  { id: 'feed-assistant', role: 'assistant', content: 'Synthetic answer', created_at: '2026-09-01T08:11:00Z', payload: { actions: [
    { type: 'apply_category', status: 'proposed', transaction_ids: ['tx-1'], account_name: 'Office supplies', account_code: '6200' },
    { type: 'retry_parse', status: 'proposed', document_ids: ['doc-1'] }
  ] } }
];
for (const locale of LOCALES) {
  test(`firm feed (${locale}): an action card describes the change without an internal function name`, async () => {
    await render(React.createElement(m.FeedChat, { clientId: 'client-synthetic', previewMessages: feedMessages, previewAppliableActionTypes: ['apply_category', 'retry_parse'] }), { locale });
    const shown = text(document.body);
    assert.ok(shown.includes('6200'), `the card renders: ${shown}`);
    assert.doesNotMatch(shown, /InDb\b|→\s*[a-z]+[A-Z]\w+/, `an internal function name is shown: ${shown}`);
  });
}

// ── 4. The audit panel turns a transport failure into a sentence ──────────
const AUDIT_EXPECTED = {
  404: { en: 'The audit trail for this line could not be found. It may have been removed; refresh the client to see its current lines.', fi: 'Tämän rivin kirjausketjua ei löytynyt. Rivi on ehkä poistettu; päivitä asiakkaan näkymä nähdäksesi nykyiset rivit.' },
  401: { en: 'Your session has ended. Sign in again to see the audit trail.', fi: 'Istuntosi on päättynyt. Kirjaudu uudelleen nähdäksesi kirjausketjun.' },
  503: { en: 'The server did not answer. The audit trail loads again by itself in a moment.', fi: 'Palvelin ei vastannut. Kirjausketju latautuu hetken kuluttua itsestään uudelleen.' }
};
for (const locale of LOCALES) {
  for (const status of [404, 401, 503]) {
    test(`audit panel (${locale}, ${status}): a failed load reads as a sentence a person can act on`, async () => {
      responder = (address) => (address.pathname.endsWith('/case-snapshot') ? json({}, status) : null);
      await render(React.createElement(m.AuditTimeline, { clientId: 'client-synthetic', transactionId: 'tx-synthetic-1' }), { locale });
      const shown = text(document.body);
      assert.ok(shown.includes(AUDIT_EXPECTED[status][locale]), `${AUDIT_EXPECTED[status][locale]} in: ${shown}`);
      assert.doesNotMatch(shown, /request failed with|\b\d{3}\b/, `a transport error is shown: ${shown}`);
    });
  }
}
