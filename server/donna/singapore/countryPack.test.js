import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadOutboundPack, listAvailablePackIds, resolvePackIdForJurisdiction,
  homeCurrencyForJurisdiction, materialityCeilingForJurisdiction,
  dispositionCeilingForJurisdiction, validateOutboundPackManifest,
  statutoryObligationsForPack, fallbackAccountNamesForPack
} from '../outbound/packs.js';
import { runStatutoryObligationSweep } from '../outbound/statutoryObligations.js';
import { resolveOwnerInvoiceSellerContext } from '../ownerInvoiceSellerContext.js';
import { buildOutboundInvoiceModel } from '../outbound/issuance.js';
import { resolveCodingPolicy } from '../codingPolicy.js';
import { TAX_VOCABULARY_REGISTRY } from '../taxVocabularyRegistry.js';
import { SG_CODING_POLICY } from './codingPolicy.js';
import { SG_ENTITY_TYPES, singaporeEntityType, assertSingaporeCompanyOnly } from './entity.js';
import { ENTITY_TYPES_BY_JURISDICTION, legalFormCompatibility } from '../../../src/lib/legalForms.js';

const load = () => loadOutboundPack('sg', { bypassCache: true });
const obligationIds = [
  'sg_gst_registration', 'sg_gst_return', 'sg_eci', 'sg_corporate_income_tax',
  'sg_acra_agm', 'sg_acra_annual_return', 'sg_xbrl_financial_statements',
  'sg_sole_proprietor_income_tax', 'sg_llp_partner_income_tax',
  'sg_gst_invoicenow', 'sg_gst_tax_invoicing',
  'sg_llp_acra_annual_declaration', 'sg_sole_proprietor_business_renewal'
];

test('SG-1: explicit country registration reaches the real loader and currency/policy readers', () => {
  assert.ok(listAvailablePackIds().includes('sg'));
  assert.equal(resolvePackIdForJurisdiction(' SG '), 'sg');
  const pack = load();
  assert.deepEqual(validateOutboundPackManifest(pack), { ok: true, errors: [] });
  assert.equal(homeCurrencyForJurisdiction('SG'), 'SGD');
  assert.equal(pack.locale.number_locale, 'en-SG');
  assert.equal(pack.locale.date_format, 'dmy');
  assert.deepEqual(materialityCeilingForJurisdiction('sg'), { pack_id: 'sg', ceiling: 500, currency: 'SGD' });
  assert.deepEqual(dispositionCeilingForJurisdiction('sg'), { pack_id: 'sg', ceiling: 500, currency: 'SGD' });
  assert.equal(resolvePackIdForJurisdiction('au'), null);
  assert.equal(homeCurrencyForJurisdiction('au'), null);
});

test('SG-1: form declarations agree with actual admission and company-only guards', () => {
  assert.deepEqual([...SG_ENTITY_TYPES].sort(), [...ENTITY_TYPES_BY_JURISDICTION.sg].sort());
  const pack = load();
  const axes = ['sole_prop', 'pte_ltd', 'llp'];
  for (const [i, entityType] of SG_ENTITY_TYPES.entries()) {
    assert.ok(pack.pack.note.includes(`${entityType} (${axes[i]})`));
    assert.equal(legalFormCompatibility({ jurisdiction: 'SG', entityType }).canonical, entityType);
    const client = { profile: { entity_type: entityType } };
    assert.equal(singaporeEntityType(client), axes[i]);
    if (entityType === 'sg-pte') assert.equal(assertSingaporeCompanyOnly({ client }), 'pte_ltd');
    else assert.throws(() => assertSingaporeCompanyOnly({ client }), { code: 'SINGAPORE_ENTITY_UNSUPPORTED' });
  }
  for (const entityType of ['sg-llc', 'sg-partnership', 'fi-oy']) {
    assert.equal(singaporeEntityType({ entity_type: entityType }), null);
    assert.throws(() => assertSingaporeCompanyOnly({ client: { entity_type: entityType }, failClosedOnUnknown: true }),
      { code: 'SINGAPORE_ENTITY_TYPE_UNKNOWN' });
  }
});

test('SG-1: discovery preserves the current coding palette and tax vocabulary without enabling rich GST posting', () => {
  const pack = load();
  const policy = resolveCodingPolicy({ jurisdiction: 'sg', businessDate: '2026-09-24' });
  assert.equal(pack.tax.vocabulary, TAX_VOCABULARY_REGISTRY.sg.marker);
  assert.equal(pack.tax.vocabulary, SG_CODING_POLICY.taxVocabulary);
  assert.deepEqual(fallbackAccountNamesForPack(pack), SG_CODING_POLICY.accountOptions);
  assert.deepEqual(policy.accountOptions, SG_CODING_POLICY.accountOptions);
  assert.deepEqual(policy.taxTreatmentOptions, SG_CODING_POLICY.taxTreatmentOptions);
  assert.equal(pack.chart_of_accounts.fallback_accounts.some(row => row.role === 'liability.sales_tax_payable'), false,
    'the legacy Tax payable label must not acquire a new GST control role');
  assert.deepEqual(pack.payment_rails.map(row => row.kind), ['remit_instructions']);
  assert.equal(pack.einvoice.lane, 'none');
  assert.equal(pack.einvoice.operator, 'none');
});

test('SG-1: real daily and hourly discovery report every SG duty unbuilt without invoking an SG handler', async () => {
  const pack = load();
  assert.equal(pack.obligations.survey, 'surveyed');
  assert.deepEqual(statutoryObligationsForPack(pack).map(row => row.id), obligationIds);
  for (const item of pack.obligations.items) {
    assert.equal(item.status, 'declared_unbuilt');
    assert.equal(item.binding, null);
    assert.equal(item.as_of, '2026-09-24');
    assert.ok(item.source && item.authority && item.note);
  }
  for (const cadence of ['daily', 'hourly']) {
    // Real discovery + loader + sweep, with no injected fixture manifest.
    // Empty handlers prevent unrelated countries from doing real work.
    const result = await runStatutoryObligationSweep({ cadence, bindings: {} });
    assert.equal(result.ran, 0);
    assert.deepEqual(result.unbuilt.filter(row => row.packId === 'sg').map(row => row.obligationId), obligationIds);
    assert.equal(result.unsurveyed.some(row => row.packId === 'sg'), false);
    assert.equal(result.unloadable.some(row => row.packId === 'sg'), false);
  }
  const missing = structuredClone(pack);
  delete missing.obligations.items[0].source;
  assert.equal(validateOutboundPackManifest(missing).ok, false);
  const fakeBinding = structuredClone(pack);
  fakeBinding.obligations.items[0].status = 'bound';
  fakeBinding.obligations.items[0].binding = 'sg_gst_registration_watch';
  assert.equal(validateOutboundPackManifest(fakeBinding).ok, false);
});

test('SG-1: obligation applicability and unverified module evidence survive the public reader', () => {
  const byId = Object.fromEntries(statutoryObligationsForPack(load()).map(row => [row.id, row]));
  for (const id of ['sg_gst_registration', 'sg_gst_return']) {
    for (const form of SG_ENTITY_TYPES) assert.ok(byId[id].note.includes(form));
  }
  for (const id of ['sg_eci', 'sg_corporate_income_tax', 'sg_acra_agm', 'sg_acra_annual_return', 'sg_xbrl_financial_statements']) {
    assert.ok(byId[id].note.includes('sg-pte'));
    assert.ok(byId[id].note.includes('confirmedAgainstPrimary remains false'));
  }
  assert.match(byId.sg_eci.note, /both annual revenue and nil/);
  assert.match(byId.sg_acra_agm.note, /exemption\/dispensation/);
  assert.match(byId.sg_xbrl_financial_statements.note, /solvency, size and public-accountability/);
  assert.match(byId.sg_sole_proprietor_income_tax.note, /Form B\/B1/);
  assert.match(byId.sg_llp_partner_income_tax.note, /Form P/);
});

test('SG-1: real seller and invoice builder enforce the declared floor without inventing buyer GST identity', () => {
  const pack = load();
  assert.equal(pack.documents.mandatory_fields.invoice_when_buyer_tax_registered, undefined);
  const build = (registration, overrides = {}) => {
    const ctx = resolveOwnerInvoiceSellerContext({ jurisdiction: 'SG', company_name: 'SG fixture', profile: {
      address: '1 Fixture Street', gst_registration: registration
    } }, { onDate: '2026-09-24' });
    assert.equal(ctx.packId, 'sg');
    return buildOutboundInvoiceModel({ pack: ctx.pack, seller: ctx.seller,
      buyer: { name: 'Buyer', address: '2 Fixture Street' }, invoiceNumber: 'SG-TEST-1',
      date: '2026-09-24', dueDate: '2026-10-24', paymentInstructionsResolved: true,
      lines: [{ description: 'Fixture service', quantity: 1, unit_price: 100 }], taxTotal: 0, ...overrides });
  };
  assert.equal(build({ status: 'not_registered' }).ok, true);
  assert.equal(build({ status: 'registered', registered_from: '2024-01-01' }).ok, false,
    'missing seller GST identity/rate cannot pass the registered floor');
  const valid = build({ status: 'registered', registered_from: '2024-01-01', gst_registration_number: 'M90312345A' }, {
    lines: [{ description: 'Fixture service', quantity: 1, unit_price: 100, tax_rate: 9, tax_amount: 9 }], taxTotal: 9
  });
  assert.equal(valid.ok, true, JSON.stringify(valid.errors));
  // A successful model build is NOT a compliant rendered tax invoice (open gap below).
});

test('SG-1: unsupported invoice rendering remains an explicit contract gap, never a false buyer GST requirement', () => {
  const pack = load();
  const unsupported = structuredClone(pack);
  unsupported.documents.templates.invoice_pdf.en.body += '\n{{seller_address}}\n{{seller_tax_registration_block}}\n{{invoice_tax_totals_block}}';
  assert.equal(validateOutboundPackManifest(unsupported).ok, false);
  unsupported.documents.invoice_statutory_labels = { en: {
    seller_tax_registration: 'GST registration number', buyer_tax_registration: 'Buyer GST registration number',
    subtotal: 'Subtotal', tax_total: 'GST', line_tax: 'GST', line_payable: 'Payable'
  } };
  const verdict = validateOutboundPackManifest(unsupported);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some(error => error.includes('buyer registration floor')));
  assert.match(pack.documents.note, /not compliant SG GST invoice issuance/);
  assert.ok(pack.obligations.items.some(row => row.id === 'sg_gst_tax_invoicing' && row.binding === null));
});

// Actual production entry point; only the external model transport is stubbed.
// The real lower mint must also refuse retained tax facts under SG-1A.
// No sender/provider is invoked.
test('SG-1 real PG: registered owner commands refuse GST issuance; unregistered neighbor drafts an ordinary invoice', async (t) => {
  const { default: pg } = await import('pg');
  const { mkdtemp, readdir, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { default: path } = await import('node:path');
  const { runOwnerInvoiceCommandTurn } = await import('../db/issuance.js');
  const { createParty, addPartyChannel } = await import('../outbound/partyStore.js');
  const { createOutboundInvoiceDraft } = await import('../outbound/issuance.js');
  const pgUrl = process.env.DONNA_PG_TEST_URL;
  assert.ok(pgUrl, 'INCOMPLETE: DONNA_PG_TEST_URL must identify disposable PostgreSQL');
  const database = `sg1_issuance_${process.pid}`;
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  await admin.query(`create database "${database}"`);
  const scratchUrl = new URL(pgUrl); scratchUrl.pathname = `/${database}`;
  const client = new pg.Client({ connectionString: scratchUrl.toString() });
  await client.connect();
  const cleanConfig = await mkdtemp(path.join(tmpdir(), 'sg1-command-'));
  const oldCwd = process.cwd(); const oldKey = process.env.OPENAI_API_KEY;
  process.chdir(cleanConfig); process.env.OPENAI_API_KEY = 'fixture-never-sent';
  t.after(async () => {
    process.chdir(oldCwd);
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
    await client.end(); await admin.query(`drop database "${database}"`); await admin.end();
    await rm(cleanConfig, { recursive: true, force: true });
  });
  await client.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
  const migrations = new URL('../../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) {
    await client.query(await readFile(new URL(file, migrations), 'utf8'));
  }
  const firmId = 'sg1-firm'; const clientId = 'sg1-client'; const actorId = 'sg1-owner';
  await client.query("insert into firms(id,name,slug) values($1,'SG pack test','sg1-pack-test')", [firmId]);
  const profile = { jurisdiction: 'sg', entity_type: 'sg-pte', address: '10 SG Seller Street',
    payment_instructions: 'Transfer to fixture account',
    gst_registration: { status: 'registered', registered_from: '2024-01-01', gst_registration_number: 'M90312345A' } };
  await client.query("insert into clients(id,firm_id,company_name,jurisdiction,profile) values($1,$2,'SG Seller','sg',$3::jsonb)",
    [clientId, firmId, JSON.stringify(profile)]);
  const party = await createParty(client, { firmId, clientId, displayName: 'Acme', isCustomer: true, actorType: 'owner', actorId });
  await addPartyChannel(client, { firmId, clientId, partyId: party.id, channelKind: 'email', channelValue: 'buyer@example.invalid', isPrimary: true, actorType: 'owner', actorId });
  const baseReading = { is_invoice_command: true, buyer_party_id: party.id,
    buyer_name_stated: null, buyer_email_stated: null, buyer_address_stated: '20 SG Buyer Street',
    buyer_tax_registration: null, supply_date_stated: null, supply_date_evidence: null,
    lines: [{ description: 'consulting', quantity: 1, unit_price: 100 }],
    currency_code: 'SGD', currency_evidence: 'SGD', due_date: null, payment_terms_days: null,
    tax_amount_stated: null, chase_until_paid: false, ambiguities: [], reason: 'Explicit fixture instruction' };
  const base = { firmId, clientId, principalActorType: 'firm_collaborator', principalActorId: actorId,
    sourceChannel: 'whatsapp', channelBinding: { phone_hash: 'sg1-fixture' }, env: {}, now: Date.parse('2026-09-24T12:00:00Z') };
  const turn = async (id, reading) => {
    await client.query('begin');
    try {
      const result = await runOwnerInvoiceCommandTurn(client, { ...base, sourceMessageId: id,
        messageText: 'Invoice Acme SGD 100 for consulting. Buyer address 20 SG Buyer Street.'
          + (reading.tax_amount_stated == null ? '' : ' Tax rate 9%, line GST 9, total GST 9.'),
        fetchImpl: async (url) => {
          assert.equal(url, 'https://api.openai.com/v1/responses');
          return new Response(JSON.stringify({ output_text: JSON.stringify(reading), usage: { input_tokens: 1, output_tokens: 1 } }),
            { status: 200, headers: { 'content-type': 'application/json' } });
        } });
      await client.query('commit'); return result;
    } catch (error) { await client.query('rollback'); throw error; }
  };
  assert.equal((await turn('flags-off', baseReading)).reason, 'flag_off');
  for (const flag of ['OWNER_INVOICE_COMMAND', 'OUTBOUND_INVOICING']) {
    await client.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,$2,$3,$1,'canary','manual')",
      [flag, firmId, clientId]);
  }
  const taxed = await turn('registered-tax', { ...baseReading, tax_amount_stated: 9,
    lines: [{ description: 'consulting', quantity: 1, unit_price: 100, tax_rate: 9, tax_amount: 9 }] });
  assert.equal(taxed.status, 'refused', JSON.stringify(taxed));
  assert.equal(taxed.reason, 'tax_not_supported');
  const unrated = await turn('registered-unrated', baseReading);
  assert.equal(unrated.status, 'refused', JSON.stringify(unrated));
  assert.equal(unrated.reason, 'draft_invalid');
  assert.match(unrated.error, /Singapore tax-invoice rendering is not supported/);
  assert.equal((await client.query('select count(*)::int n from issued_invoices')).rows[0].n, 0);
  assert.equal((await client.query('select count(*)::int n from outbound_actions')).rows[0].n, 0);

  // SG-1A closes the previously reproduced lower-mint gap without trimming
  // the declaration. Its real-PG lifecycle test also runs with this actual
  // pack and covers taxable/zero-rated recurrence plus owner-facing refusal.
  const pack = load();
  const ctx = resolveOwnerInvoiceSellerContext({ jurisdiction: 'sg', company_name: 'SG Seller', profile }, { onDate: '2026-09-24' });
  for (const rate of [9, 0]) {
    await assert.rejects(createOutboundInvoiceDraft(client, { firmId, clientId, pack, seller: ctx.seller,
      buyer: { name: 'Acme', email: 'buyer@example.invalid', address: '20 SG Buyer Street' },
      lines: [{ description: 'consulting', quantity: 1, unit_price: 100, tax_rate: rate, tax_amount: rate }], taxTotal: rate,
      paymentInstructions: profile.payment_instructions, actorId, now: base.now }),
    { code: 'OUTBOUND_INVOICE_INVALID', reason: 'invoice_tax_rendering_unsupported' });
  }
  assert.equal((await client.query('select count(*)::int n from issued_invoices')).rows[0].n, 0);
  assert.equal((await client.query('select count(*)::int n from outbound_actions')).rows[0].n, 0);

  await client.query("update clients set profile = jsonb_set(profile,'{gst_registration}', '{\"status\":\"not_registered\"}'::jsonb) where id=$1", [clientId]);
  const ordinary = await turn('unregistered-neighbor', baseReading);
  assert.equal(ordinary.status, 'drafted', JSON.stringify(ordinary));
  assert.equal(ordinary.action.status, 'hold_for_approval');
  assert.equal(ordinary.action.payload.render_values.document_title, 'Invoice');
  assert.equal(ordinary.draft.draft.invoice.seller.taxRegistered, false);
  assert.equal((await client.query("select count(*)::int n from outbound_action_receipts where outcome='sent'")).rows[0].n, 0);
});
