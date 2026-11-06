import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadOutboundPack, resolvePackIdForJurisdiction, validateOutboundPackManifest } from './packs.js';
import { createOutboundInvoiceDraft, buildOutboundInvoiceModel, advanceIssuanceAfterSend, checkCurrentInvoiceFacts } from './issuance.js';
import { createParty, addPartyChannel } from './partyStore.js';
import { mintOutboundAction, approveOutboundAction } from './actionStore.js';
import { executeDueOutboundActions } from './actionExecutor.js';
import { readOwnerActionsSurface, decideOwnerAction, editOwnerHeldDraft } from './ownerActionsSurface.js';
import { gatherOwnerDigest, renderOwnerDigestEmail } from './ownerDigest.js';
import { __createIssuedInvoiceDraftWithClient } from '../issuanceRegistry.js';
import { prepareCiHostPostgres } from '../../../scripts/prepare_ci_host_postgres.js';

const now = Date.parse('2026-09-24T12:00:00Z');
const scope = { firmId: 'sg1a-firm', clientId: 'sg1a-client' };
const actorId = 'sg1a-owner';
const seller = { name: 'Synthetic SG seller', businessId: null, address: '10 Fixture Street',
  taxRegistered: true, taxRegistrationId: 'M90312345A' };
const buyer = { name: 'Synthetic buyer', address: '20 Fixture Street', email: 'buyer@example.invalid' };
const line = { description: 'Synthetic service', quantity: 1, unit_price: 100, tax_rate: 9, tax_amount: 9 };
const profile = { address: seller.address, email: 'owner@example.invalid', accounting_basis: 'cash',
  payment_instructions: 'Fixture bank transfer',
  gst_registration: { status: 'registered', registered_from: '2024-01-01', gst_registration_number: seller.taxRegistrationId } };

// Main has no SG declaration. Stage only a synthetic manifest through the real
// loader's existing packsRoot seam. The combined #2245 proof uses its actual
// shipping declaration instead. Never install a fixture into production packs.
const sgPackForProof = async (directory) => {
  if (resolvePackIdForJurisdiction('sg')) return loadOutboundPack('sg');
  const pack = structuredClone(loadOutboundPack('us'));
  pack.pack = { id: 'sg', country: 'SG', version: 1 };
  pack.currency.home = 'SGD';
  pack.locale = { number_locale: 'en-SG', date_format: 'dmy' };
  pack.documents.mandatory_fields = {
    invoice: ['invoice_number', 'issue_date', 'due_date', 'total', 'currency', 'seller_name',
      'buyer_name', 'line_description', 'line_quantity', 'line_unit_price', 'payment_instructions'],
    invoice_when_tax_registered: ['seller_address', 'seller_tax_registration_id', 'buyer_address',
      'line_tax_rate', 'total_excluding_tax', 'tax_amount'],
    invoice_forbidden_when_not_tax_registered: ['seller_tax_registration_id', 'line_tax_rate']
  };
  pack.documents.statutory_titles = { invoice_when_tax_registered: 'Tax Invoice', invoice_otherwise: 'Invoice' };
  for (const template of ['invoice_pdf', 'invoice_issue']) {
    const row = pack.documents.templates[template].en;
    row.subject = '{{document_title}} {{invoice_number}}';
    row.body = '{{document_title}}\n' + row.body;
  }
  assert.deepEqual(validateOutboundPackManifest(pack), { ok: true, errors: [] });
  await mkdir(path.join(directory, 'sg'));
  await writeFile(path.join(directory, 'sg', 'capabilities.json'), JSON.stringify({ outbound: { manifest: 'manifest.json' } }));
  await writeFile(path.join(directory, 'sg', 'manifest.json'), JSON.stringify(pack));
  return loadOutboundPack('sg', { packsRoot: directory });
};

test('SG-1A real PG: unsafe mint, held send and recurrence refuse; owner can stop only the blocked next period', async (t) => {
  assert.ok(process.env.DONNA_PG_TEST_URL, 'INCOMPLETE: disposable DONNA_PG_TEST_URL is required');
  const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL });
  await admin.connect();
  const database = `sg1a_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`create database "${database}"`);
  const url = new URL(process.env.DONNA_PG_TEST_URL); url.pathname = `/${database}`;
  const directory = await mkdtemp(path.join(tmpdir(), 'sg1a-proof-'));
  const cwd = process.cwd(); process.chdir(directory);
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  t.after(async () => {
    process.chdir(cwd); await client.end(); await admin.query(`drop database "${database}"`); await admin.end();
    await rm(directory, { recursive: true, force: true });
  });
  await prepareCiHostPostgres({ databaseUrl: url.toString() });
  const migrations = new URL('../../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) {
    await client.query(await readFile(new URL(file, migrations), 'utf8'));
  }
  const pack = await sgPackForProof(directory);
  await client.query("insert into firms(id,name,slug) values($1,'SG1A fixture','sg1a-fixture')", [scope.firmId]);
  await client.query("insert into clients(id,firm_id,company_name,jurisdiction,profile) values($1,$2,$3,'sg',$4)",
    [scope.clientId, scope.firmId, seller.name, profile]);
  for (const flag of ['OWNER_INVOICE_COMMAND', 'OUTBOUND_INVOICING']) {
    await client.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,$2,$3,$1,'canary','manual')",
      [flag, scope.firmId, scope.clientId]);
  }
  const party = await createParty(client, { ...scope, displayName: buyer.name, isCustomer: true, actorType: 'owner', actorId });
  await addPartyChannel(client, { ...scope, partyId: party.id, channelKind: 'email', channelValue: buyer.email, isPrimary: true, actorType: 'owner', actorId });
  const transaction = async (fn) => {
    await client.query('begin');
    try { const result = await fn(); await client.query('commit'); return result; }
    catch (error) { await client.query('rollback'); throw error; }
  };
  const mint = (overrides = {}) => transaction(() => createOutboundInvoiceDraft(client, {
    ...scope, pack, seller, buyer: { ...buyer, partyId: party.id }, lines: [line], taxTotal: 9,
    paymentInstructions: profile.payment_instructions, actorId, now, env: {}, ...overrides
  }));
  const state = async () => {
    const result = {};
    for (const table of ['issued_invoices', 'issued_invoice_counters', 'outbound_actions', 'outbound_action_receipts']) {
      result[table] = (await client.query(`select * from ${table} order by 1`)).rows;
    }
    return result;
  };
  const setRegistration = async (registration) => client.query(
    "update clients set profile=jsonb_set(profile,'{gst_registration}',$1::jsonb) where id=$2",
    [JSON.stringify(registration), scope.clientId]);
  const original = await state();
  for (const overrides of [{}, { seller: { ...seller, taxRegistered: false, taxRegistrationId: null }, taxTotal: 0,
    lines: [{ description: line.description, unit_price: 100 }] },
  { taxTotal: 0, lines: [{ ...line, tax_rate: 0, tax_amount: 0 }] }]) {
    await assert.rejects(mint(overrides), { code: 'OUTBOUND_INVOICE_INVALID', reason: 'invoice_tax_rendering_unsupported' });
    assert.deepEqual(await state(), original, 'no draft, number, action or send receipt on direct refusal');
  }
  await setRegistration({ status: 'not_registered' });
  await assert.rejects(mint(), { reason: 'invoice_tax_rendering_unsupported' }, 'retained registered facts cannot be relabelled after deregistration');
  const ordinarySeller = { ...seller, taxRegistered: false, taxRegistrationId: null };
  const ordinaryLines = [{ description: line.description, quantity: 1, unit_price: 100 }];
  const ordinary = await mint({ seller: ordinarySeller, lines: ordinaryLines, taxTotal: 0 });
  assert.equal(ordinary.action.status, 'hold_for_approval');
  assert.equal(ordinary.action.payload.render_values.document_title, 'Invoice');
  assert.equal(ordinary.draft.draft.invoice.seller.taxRegistered, false);

  // Seed historical typed facts via the real draft writer and action mint;
  // neither fixture setup nor the executor calls a real provider.
  const historical = async ({ historicalPack = pack, registered = true, issued = false, zeroRated = false } = {}) => transaction(async () => {
    const invoiceSeller = registered ? seller : ordinarySeller;
    const lines = registered ? [{ ...line, ...(zeroRated ? { tax_rate: 0, tax_amount: 0 } : {}) }] : ordinaryLines;
    const taxTotal = registered && !zeroRated ? 9 : 0;
    const draft = await __createIssuedInvoiceDraftWithClient({ client, ...scope, actorId,
      buildDraft: ({ sequence }) => {
        const built = buildOutboundInvoiceModel({ pack: historicalPack, seller: invoiceSeller, buyer,
          lines, taxTotal, invoiceNumber: `SG1A-${sequence}`, date: '2026-09-24', dueDate: '2026-10-08', paymentInstructionsResolved: true });
        assert.equal(built.ok, true, JSON.stringify(built.errors));
        return { draft: { invoice: built.invoice, pack_id: historicalPack.pack.id, origin: 'synthetic_history' }, buyerName: buyer.name, buyerEmail: buyer.email };
      } });
    const result = await mintOutboundAction(client, { ...scope, actionType: 'issue_invoice', targetPartyId: party.id,
      anchorType: 'issued_invoice', anchorId: draft.id, packId: historicalPack.pack.id, template: 'invoice_issue',
      cadenceStep: 1, scheduledFor: new Date(now).toISOString(), amount: draft.draft.invoice.total, currency: historicalPack.currency.home,
      payload: { recurrence: { interval: 'monthly' }, render_values: { payment_instructions: profile.payment_instructions } },
      gate: { verdict: 'hold_for_approval', mode: 'act', stage: 'canary', reasons: ['stage_below_auto'] } });
    if (issued) {
      await client.query("update issued_invoices set status='issued' where id=$1", [draft.id]);
      await client.query("update outbound_actions set status='executed' where id=$1", [result.action.id]);
    }
    return { draft, action: result.action };
  });
  const deliveries = [];
  const execute = () => executeDueOutboundActions({ client, ...scope, now, env: { OUTBOUND_PUBLIC_BASE_URL: 'https://fixture.invalid' },
    packLoader: id => id === 'sg' ? pack : loadOutboundPack(id),
    roleDecisionFn: () => ({ allowed: true, reasons: [] }),
    deliverers: { email: async message => { deliveries.push(message); return { providerMessageId: 'synthetic-mail' }; } } });
  // Persisted old drafts cannot be approved or edited through real owner
  // consumers, both before and after a stale scheduled delivery is refused.
  for (const historicalPack of [loadOutboundPack('us'), pack]) {
    const held = await historical({ historicalPack, zeroRated: true });
    const assertBlocked = async () => {
      await assert.rejects(decideOwnerAction(client, { ...scope, actionId: held.action.id, decision: 'approve', actorType: 'owner', actorId }),
        { code: 'OUTBOUND_INVOICE_INVALID', reason: 'invoice_tax_rendering_unsupported' });
      await assert.rejects(editOwnerHeldDraft(client, { ...scope, actionId: held.action.id, renderValues: { payment_instructions: 'Changed' }, actorType: 'owner', actorId }),
        { code: 'OUTBOUND_INVOICE_INVALID', reason: 'invoice_tax_rendering_unsupported' });
      const surface = await readOwnerActionsSurface(client, { ...scope, env: {} });
      assert.ok(surface.blocked_invoices.some(a => a.id === held.action.id));
      assert.ok(!surface.pending.some(a => a.id === held.action.id));
      const digest = await gatherOwnerDigest(client, scope);
      const email = renderOwnerDigestEmail({ digest: { ...digest, pending: digest.pending.filter(a => a.id === held.action.id) }, baseUrl: 'https://fixture.invalid' });
      assert.match(email.text, /Blocked invoices/);
      assert.doesNotMatch(email.text, /NEEDS YOUR APPROVAL|Approve:/);
    };
    await assertBlocked();
    const before = (await client.query('select * from issued_invoices where id=$1', [held.draft.id])).rows[0];
    await client.query("update outbound_actions set status='scheduled' where id=$1", [held.action.id]);
    const result = await execute();
    assert.equal(result.held_stale_consequence, 1, JSON.stringify(result));
    assert.equal(deliveries.length, 0);
    await assertBlocked();
    assert.deepEqual((await client.query('select * from issued_invoices where id=$1', [held.draft.id])).rows[0], before);
    const receipts = (await client.query('select * from outbound_action_receipts where action_id=$1', [held.action.id])).rows;
    assert.ok(receipts.some(r => r.outcome === 'refused' && r.reason === 'invoice_tax_rendering_unsupported'));
    await decideOwnerAction(client, { ...scope, actionId: held.action.id, decision: 'decline', actorType: 'owner', actorId });
  }
  // A profile becoming SG/registered after valid approval is still refused at
  // the executor boundary; a previous approval is not continuing authority.
  await client.query("update clients set jurisdiction='us', profile=$2 where id=$1", [scope.clientId, { ...profile, gst_registration: undefined }]);
  const changed = await historical({ historicalPack: loadOutboundPack('us'), registered: false });
  await transaction(() => approveOutboundAction(client, { ...scope, actionId: changed.action.id, actorType: 'owner', actorId }));
  await client.query("update clients set jurisdiction='sg', profile=$2 where id=$1", [scope.clientId, profile]);
  assert.equal((await execute()).held_stale_consequence, 1);
  assert.equal(deliveries.length, 0);
  await decideOwnerAction(client, { ...scope, actionId: changed.action.id, decision: 'decline', actorType: 'owner', actorId });
  // Current registration becoming taxable also blocks an earlier ordinary draft.
  await setRegistration(profile.gst_registration);
  assert.deepEqual(await checkCurrentInvoiceFacts(client, { ...scope, action: ordinary.action, pack, anchorRow: ordinary.draft }),
    { ok: false, reason: 'invoice_tax_rendering_unsupported' });
  await setRegistration({ status: 'not_registered' });
  for (const zeroRated of [false, true]) {
    const previous = await historical({ issued: true, zeroRated });
    const before = await state();
    const advance = () => transaction(() => advanceIssuanceAfterSend(client, { ...scope, action: previous.action, pack, party,
      snapshot: { OUTBOUND_INVOICING: { stage: 'canary' } }, env: {}, now }));
    const refused = await advance();
    assert.equal(refused.kind, 'recurring_invoice_blocked'); assert.equal(refused.minted, null);
    assert.equal(refused.blocked.status, 'hold_for_approval');
    assert.deepEqual((await state()).issued_invoices, before.issued_invoices);
    assert.deepEqual((await state()).issued_invoice_counters, before.issued_invoice_counters);
    assert.deepEqual((await state()).outbound_actions.filter(a => a.id === previous.action.id), before.outbound_actions.filter(a => a.id === previous.action.id));
    assert.equal((await advance()).blocked.id, refused.blocked.id);
    const receipts = (await client.query('select * from outbound_action_receipts where action_id=$1', [refused.blocked.id])).rows;
    assert.equal(receipts.length, 1); assert.equal(receipts[0].outcome, 'refused');
    const surface = await readOwnerActionsSurface(client, { ...scope, env: {} });
    const shown = surface.blocked_recurrences.find(row => row.id === refused.blocked.id);
    assert.equal(shown.next_issue_date, '2026-10-24'); assert.match(shown.description, /Blocked next recurrence/);
    assert.ok(!surface.pending.some(row => row.id === refused.blocked.id));
    const digest = await gatherOwnerDigest(client, scope);
    const email = renderOwnerDigestEmail({ digest: { ...digest, pending: digest.pending.filter(a => a.id === refused.blocked.id) }, baseUrl: 'https://fixture.invalid' });
    assert.match(email.text, /Stop blocked recurrence/); assert.doesNotMatch(email.text, /NEEDS YOUR APPROVAL|Approve:/);
    await assert.rejects(decideOwnerAction(client, { ...scope, actionId: refused.blocked.id, decision: 'approve', actorType: 'owner', actorId }),
      { code: 'OUTBOUND_INVOICE_RECURRENCE_BLOCKED' });
    await assert.rejects(editOwnerHeldDraft(client, { ...scope, actionId: refused.blocked.id, renderValues: { payment_instructions: 'Changed' }, actorType: 'owner', actorId }),
      { code: 'OUTBOUND_INVOICE_RECURRENCE_BLOCKED' });
    // A stale scheduling/grant consumer cannot send the placeholder or erase it
    // as an already-issued anchor. It returns to the same visible owner hold.
    await client.query("update outbound_actions set status='scheduled', scheduled_for=$2 where id=$1", [refused.blocked.id, new Date(now).toISOString()]);
    assert.equal((await execute()).held_stale_consequence, 1);
    assert.equal(deliveries.length, 0);
    const stopped = await decideOwnerAction(client, { ...scope, actionId: refused.blocked.id, decision: 'decline', actorType: 'owner', actorId });
    assert.equal(stopped.decided, true);
    assert.equal((await advance()).blocked.status, 'cancelled');
    assert.ok(!(await readOwnerActionsSurface(client, { ...scope, env: {} })).blocked_recurrences.some(a => a.id === refused.blocked.id));
    const cancelled = (await client.query("select * from outbound_action_receipts where action_id=$1 and outcome='cancelled'", [refused.blocked.id])).rows[0];
    assert.equal(cancelled.approved_by, `owner:${actorId}`);
    assert.deepEqual((await state()).issued_invoices, before.issued_invoices);
    assert.deepEqual((await state()).issued_invoice_counters, before.issued_invoice_counters);
  }
  assert.equal((await client.query("select count(*)::int n from outbound_action_receipts where outcome='sent'")).rows[0].n, 0);
  // Legacy SG identity is refusal evidence, never a substitute canonical
  // country. Foreign-pack historical actions must not bypass that unresolved
  // or conflicting identity through the shared approval/current-facts readers.
  for (const jurisdiction of [null, 'us']) {
    await client.query("update clients set jurisdiction=$2, profile=$3 where id=$1", [scope.clientId, jurisdiction,
      { ...profile, jurisdiction: 'sg', gst_registration: { status: 'not_registered' } }]);
    const before = await state();
    await assert.rejects(mint({ pack: loadOutboundPack('us'), seller: ordinarySeller, lines: ordinaryLines, taxTotal: 0 }),
      { code: 'OUTBOUND_INVOICE_INVALID' });
    assert.deepEqual(await state(), before);
    const legacy = await historical({ historicalPack: loadOutboundPack('us'), registered: false });
    await assert.rejects(decideOwnerAction(client, { ...scope, actionId: legacy.action.id, decision: 'approve', actorType: 'owner', actorId }),
      { code: 'OUTBOUND_INVOICE_INVALID' });
    assert.equal((await checkCurrentInvoiceFacts(client, { ...scope, action: legacy.action, pack: loadOutboundPack('us'), anchorRow: legacy.draft })).ok, false);
    assert.ok((await readOwnerActionsSurface(client, { ...scope, env: {} })).blocked_invoices.some(a => a.id === legacy.action.id));
    await decideOwnerAction(client, { ...scope, actionId: legacy.action.id, decision: 'decline', actorType: 'owner', actorId });
  }
  await client.query("update clients set jurisdiction='sg', profile=$2 where id=$1", [scope.clientId, profile]);
  // A current registered profile cannot authorize ordinary invoices in another
  // pack, including when legacy profile identity conflicts with the column.
  await setRegistration(profile.gst_registration);
  await client.query("update clients set profile=jsonb_set(profile,'{jurisdiction}','\"us\"') where id=$1", [scope.clientId]);
  await assert.rejects(mint({ pack: loadOutboundPack('us'), seller: ordinarySeller, lines: ordinaryLines, taxTotal: 0 }), { code: 'OUTBOUND_INVOICE_INVALID' });
  if (resolvePackIdForJurisdiction('sg')) {
    await client.query("update clients set profile=$2 where id=$1", [scope.clientId, { ...profile, gst_registration: { status: 'not_registered' } }]);
    await transaction(() => approveOutboundAction(client, { ...scope, actionId: ordinary.action.id, actorType: 'owner', actorId }));
    assert.equal((await execute()).sent, 1, 'actual SG declaration still sends an ordinary unregistered invoice');
    deliveries.length = 0;
  }
  // Existing-country neighbor reaches the real approval/executor/finalization;
  // only delivery is stubbed. No new ledger-writing implementation is involved.
  await client.query("update clients set jurisdiction='us', profile=$2 where id=$1", [scope.clientId, { ...profile, gst_registration: undefined }]);
  const neighbor = await mint({ pack: loadOutboundPack('us'), seller: ordinarySeller, lines: ordinaryLines, taxTotal: 0 });
  await transaction(() => approveOutboundAction(client, { ...scope, actionId: neighbor.action.id, actorType: 'owner', actorId }));
  assert.equal((await execute()).sent, 1); assert.equal(deliveries.length, 1);
});
