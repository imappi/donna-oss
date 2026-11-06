import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  createInboundCountryRegistry, resolveCountryInboundReply, resolveCountryOpeningBinding,
  resolveInboundCountry, startInvoiceIssuance, createIlmoitinSubmitAlvReturn, createIrasSubmitGstF5,
  receiveEInvoiceDocument, FINLAND_EINVOICE_RECEIVE_FLAG_KEY
} from './inboundCountryRegistry.js';
import { startInvoiceIssuance as fiStart } from './finland/invoiceIssuanceRoute.js';
import { createIlmoitinSubmitAlvReturn as fiSubmit } from './finland/omavero/submitAlvReturn.js';
import { createIrasSubmitGstF5 as sgSubmit } from './singapore/iras/submitGstF5.js';
import { receiveEInvoiceDocument as fiReceive, FINLAND_EINVOICE_RECEIVE_FLAG_KEY as fiReceiveFlag } from './finland/verkkolaskuReceive.js';

test('registered ask kinds preserve historical reply/opening precedence and exact factory identities', () => {
  for (const kind of ['invoice_issuance', 'alv_return', 'gst_return']) {
    assert.equal(resolveCountryInboundReply({ evidence_type: kind }).id, kind);
  }
  assert.equal(resolveCountryInboundReply({ evidence_type: 'invoice_issuance', request_payload: { kind: 'gst_return' } }).id, 'invoice_issuance');
  assert.equal(resolveCountryOpeningBinding({ evidence_type: 'gb_opening_balance', request_payload: { kind: 'opening_balance' } }).resolverKey, 'resolveGbOpeningBalanceInbound');
  assert.equal(resolveCountryOpeningBinding({ evidence_type: 'opening_balance' }).resolverKey, 'resolveOpeningBalanceInbound');
  assert.equal(startInvoiceIssuance, fiStart);
  assert.equal(createIlmoitinSubmitAlvReturn, fiSubmit);
  assert.equal(createIrasSubmitGstF5, sgSubmit);
  assert.equal(receiveEInvoiceDocument, fiReceive);
  assert.equal(FINLAND_EINVOICE_RECEIVE_FLAG_KEY, fiReceiveFlag);
});

test('missing/unsupported country or ordinary evidence never inherits a country ask from flags', () => {
  for (const jurisdiction of [null, '', 'unknown', 'us', 'au', 'nz']) assert.equal(resolveInboundCountry(jurisdiction), null);
  for (const jurisdiction of ['fi', 'gb', 'sg', 'ae']) assert.equal(resolveInboundCountry(jurisdiction).jurisdiction, jurisdiction);
  assert.equal(resolveInboundCountry('UK').jurisdiction, 'gb');
  const ordinary = { evidence_type: 'receipt', FINLAND_INVOICING: true, SINGAPORE_GST_FILING: true };
  assert.equal(resolveCountryInboundReply(ordinary), null);
  assert.equal(resolveCountryOpeningBinding(ordinary), null);
});

test('an additional registered reply dispatches once without editing shared country branching', async () => {
  const input = { actorId: 'fixture-owner', authorityBasis: { source: 'fixture', messageId: 'reply-1' } };
  const seen = [];
  const run = async (args) => { seen.push(args); return { action: 'fixture_recorded', authorityBasis: args.authorityBasis }; };
  const registry = createInboundCountryRegistry([{ jurisdiction: 'nz', replies: [{ id: 'nz_fixture', matches: ask => ask?.evidence_type === 'nz_fixture', run }] }]);
  assert.equal(resolveInboundCountry('NZ', { registry }).jurisdiction, 'nz');
  const resolved = resolveCountryInboundReply({ evidence_type: 'nz_fixture' }, { registry });
  assert.equal(resolved.run, run);
  assert.deepEqual(await resolved.run(input), { action: 'fixture_recorded', authorityBasis: input.authorityBasis });
  assert.deepEqual(seen, [input]);
  assert.equal(resolveCountryInboundReply({ evidence_type: 'alv_return' }, { registry }), null);
});

test('malformed/duplicate operation registrations fail visibly', () => {
  const valid = { jurisdiction: 'nz', replies: [{ id: 'fixture', matches: () => true, run: async () => null }] };
  assert.throws(() => createInboundCountryRegistry([valid, valid]), /Duplicate/);
  assert.throws(() => createInboundCountryRegistry([{ jurisdiction: 'unknown', replies: [] }]), /canonical/);
  assert.throws(() => createInboundCountryRegistry([{ ...valid, replies: [{ id: 'fixture', matches: true, run: () => null }] }]), /operation/);
  assert.throws(() => createInboundCountryRegistry([{ ...valid, replies: [valid.replies[0], valid.replies[0]] }]), /unique/);
  assert.throws(() => createInboundCountryRegistry([{ ...valid, opening: { matches: () => true } }]), /writer/);
});

test('country-owned inbound adapters load before or after the shared channel/firmDb import cycle', () => {
  for (const entry of ['./finland/inboundHandlers.js', './singapore/inboundHandlers.js', './gb/inboundHandlers.js', './inboundCountryRegistry.js']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL(entry, import.meta.url).href)});`], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('persisted historical ask identity stays with its consumer when current-country hints differ', () => {
  // Renaming/rerouting old conversations would strand their existing lifecycle.
  // This selection is not filing authority: the owned route checks its draft,
  // flag, mandate and owner receipt before any transmit or named writer call.
  for (const jurisdiction of [null, 'GB', 'AE', 'NZ']) {
    assert.equal(resolveCountryInboundReply({ evidence_type: 'alv_return', jurisdiction,
      profile: { jurisdiction } }).id, 'alv_return');
    assert.equal(resolveCountryInboundReply({ evidence_type: 'gst_return', jurisdiction,
      profile: { jurisdiction } }).id, 'gst_return');
    assert.equal(resolveCountryOpeningBinding({ evidence_type: 'gb_opening_balance', jurisdiction }).resolverKey,
      'resolveGbOpeningBalanceInbound');
  }
});
