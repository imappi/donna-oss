// Party store (M0.2, G1). Mock-pg harness (substring handlers, the
// askReaskCadence.test.js shape). Pins:
//   - normalizePartyName is conservative: case/punctuation collapse, NO
//     legal-suffix stripping (two legal entities never collapse by cosmetics);
//   - resolvePartyCandidate: business id is identity (match ⇒ enrich); a name
//     match with a CONFLICTING business id creates a NEW party (never merges);
//     a shared email with differing names creates + PROPOSES a merge
//     suggestion (suggest-and-confirm); otherwise creates;
//   - applyPartyMerge refuses conflicting business ids unconditionally and
//     refuses a system actor (a merge is a confirmed decision);
//   - setPartyAttribute is a closed set with validation, closes the prior
//     history row, denormalizes the current value, audits in-transaction;
//   - addPartyChannel is idempotent on the active (party, kind, value);
//   - listPartyChannels is a CLIENT-SCOPED read: it refuses without
//     firm/client and filters on them in SQL (the send path resolves a real
//     third-party recipient from it — a party id is not a tenancy proof);
//   - backfill soft-fails absent source tables and isolates poisoned
//     candidates in their own transactions.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizePartyName, normalizeChannelValue, resolvePartyCandidate,
  applyPartyMerge, setPartyAttribute, addPartyChannel, listPartyChannels,
  listCustomerPartyCandidates,
  backfillPartiesForClient, PARTY_ATTRIBUTES
} from './partyStore.js';

const makeMockClient = (handlers = []) => {
  const calls = [];
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

const insertedPartyRow = ({ sql, params }) => [{
  id: params[0], firm_id: params[1], client_id: params[2],
  display_name: params[3], normalized_name: params[4],
  is_customer: params[5], is_supplier: params[6],
  business_id: params[7], status: 'active'
}];

const BASE = { firmId: 'firm-1', clientId: 'client-1' };

// True when an audit_events insert carrying this action was issued (the
// action travels as a bind parameter, not SQL text).
const audited = (client, action) => client.calls.some(
  (c) => c.sql.includes('insert into audit_events') && (c.params || []).includes(action)
);

test('normalizePartyName collapses case/punctuation but never legal suffixes', () => {
  assert.equal(normalizePartyName('ACME, LLC'), normalizePartyName('Acme LLC'));
  assert.equal(normalizePartyName('  Köivu   Ventures  Oy '), 'köivu ventures oy');
  assert.notEqual(normalizePartyName('Acme Oy'), normalizePartyName('Acme Inc'));
  assert.equal(normalizePartyName(''), '');
  assert.equal(normalizeChannelValue('email', ' Kari@Example.COM '), 'kari@example.com');
  assert.equal(normalizeChannelValue('phone', '+358 40-123 456'), '+35840123456');
});

test('resolvePartyCandidate: business id is identity — match enriches, never duplicates', async () => {
  const client = makeMockClient([
    { match: "and business_id = $3", rows: [{ id: 'p-1', normalized_name: 'acme llc', business_id: 'EIN-11', status: 'active' }] },
    { match: 'and id = $3', rows: [{ id: 'p-1', business_id: 'EIN-11', is_customer: true, status: 'active' }] },
    { match: 'insert into party_channels', rows: ({ params }) => [{ id: params[0] }] }
  ]);
  const result = await resolvePartyCandidate(client, {
    ...BASE,
    candidate: { displayName: 'Acme LLC', businessId: 'EIN-11', email: 'ap@acme-com.example', isCustomer: true }
  });
  assert.equal(result.action, 'matched_business_id');
  assert.ok(client.calls.some((c) => c.sql.includes('update client_parties')), 'enriches the matched party');
  assert.ok(!client.calls.some((c) => c.sql.includes('insert into client_parties')), 'no duplicate identity');
});

test('resolvePartyCandidate: name match with CONFLICTING business id creates a new party, never merges', async () => {
  const client = makeMockClient([
    { match: 'and business_id = $3', rows: [] },
    { match: 'and normalized_name = $3', rows: [{ id: 'p-1', normalized_name: 'acme llc', business_id: 'EIN-11', status: 'active' }] },
    { match: 'insert into client_parties', rows: insertedPartyRow },
    { match: 'insert into party_channels', rows: ({ params }) => [{ id: params[0] }] }
  ]);
  const result = await resolvePartyCandidate(client, {
    ...BASE,
    candidate: { displayName: 'Acme LLC', businessId: 'EIN-99', isCustomer: true }
  });
  assert.equal(result.action, 'created_conflicting_business_id');
  assert.ok(client.calls.some((c) => c.sql.includes('insert into client_parties')));
  assert.ok(!client.calls.some((c) => c.sql.includes('party_merge_suggestions')), 'no merge suggestion across conflicting ids');
});

test('resolvePartyCandidate: shared email with differing names creates + proposes (suggest-and-confirm)', async () => {
  const client = makeMockClient([
    { match: 'and normalized_name = $3', rows: [] },
    { match: 'join party_channels', rows: [{ id: 'p-existing', normalized_name: 'acme holdings', status: 'active' }] },
    { match: 'insert into client_parties', rows: insertedPartyRow },
    { match: 'insert into party_channels', rows: ({ params }) => [{ id: params[0] }] },
    { match: 'insert into party_merge_suggestions', rows: ({ params }) => [{ id: params[0], status: 'proposed' }] }
  ]);
  const result = await resolvePartyCandidate(client, {
    ...BASE,
    candidate: { displayName: 'Acme Services', email: 'billing@acme-com.example', isCustomer: true }
  });
  assert.equal(result.action, 'created_with_merge_suggestion');
  assert.ok(result.suggestionId, 'suggestion minted');
  assert.ok(audited(client, 'outbound_party.merge_suggested'), 'suggestion audited');
});

test('resolvePartyCandidate: unknown identity creates with provenance + primary email channel', async () => {
  const client = makeMockClient([
    { match: 'insert into client_parties', rows: insertedPartyRow },
    { match: 'insert into party_channels', rows: ({ params }) => [{ id: params[0] }] }
  ]);
  const result = await resolvePartyCandidate(client, {
    ...BASE,
    candidate: { displayName: 'New Vendor Inc', email: 'ar@newvendor-com.example', isSupplier: true, source: 'xero_contacts', sourceRef: 'xc-9' }
  });
  assert.equal(result.action, 'created');
  const insert = client.calls.find((c) => c.sql.includes('insert into client_parties'));
  assert.ok(String(insert.params[13]).includes('xc-9'), 'provenance carries source_ref');
  assert.ok(audited(client, 'outbound_party.created'), 'creation audited');
});

test('resolvePartyCandidate skips an unresolvable candidate', async () => {
  const client = makeMockClient([]);
  const result = await resolvePartyCandidate(client, { ...BASE, candidate: { displayName: '  ' } });
  assert.equal(result.action, 'skipped_unresolvable');
  assert.equal(client.calls.length, 0);
});

test('applyPartyMerge refuses conflicting business ids unconditionally', async () => {
  const parties = {
    'p-a': { id: 'p-a', business_id: 'EIN-11', status: 'active' },
    'p-b': { id: 'p-b', business_id: 'EIN-99', status: 'active' }
  };
  const client = makeMockClient([
    { match: 'and id = $3', rows: ({ params }) => [parties[params[2]]].filter(Boolean) }
  ]);
  await assert.rejects(
    () => applyPartyMerge(client, {
      ...BASE, sourcePartyId: 'p-a', targetPartyId: 'p-b', actorType: 'owner', actorId: 'kari'
    }),
    /conflicting business ids/
  );
  assert.ok(!client.calls.some((c) => c.sql.includes("status = 'merged'")), 'nothing merged');
});

test('applyPartyMerge refuses a system actor', async () => {
  const client = makeMockClient([]);
  await assert.rejects(
    () => applyPartyMerge(client, { ...BASE, sourcePartyId: 'p-a', targetPartyId: 'p-b', actorType: 'system' }),
    /non-system acting principal/
  );
});

test('applyPartyMerge moves channels, enriches target, closes source, receipts the suggestion', async () => {
  const parties = {
    'p-a': { id: 'p-a', business_id: null, status: 'active' },
    'p-b': { id: 'p-b', business_id: 'EIN-11', status: 'active' }
  };
  const client = makeMockClient([
    { match: 'and id = $3', rows: ({ params }) => [parties[params[2]]].filter(Boolean) },
    { match: 'select * from party_channels where firm_id', rows: [{ id: 'ch-1', channel_kind: 'email' }] },
    { match: 'update party_channels set party_id', rows: [{ id: 'ch-1' }] },
    { match: 'update party_merge_suggestions', rows: [{ id: 'sug-1', status: 'confirmed' }] }
  ]);
  const result = await applyPartyMerge(client, {
    ...BASE, sourcePartyId: 'p-a', targetPartyId: 'p-b',
    suggestionId: 'sug-1', actorType: 'owner', actorId: 'kari'
  });
  assert.equal(result.merged, true);
  assert.ok(client.calls.some((c) => c.sql.includes("set status = 'merged'")), 'source closed as merged');
  assert.ok(client.calls.some((c) => c.sql.includes('update party_merge_suggestions')), 'suggestion receipted');
  assert.ok(audited(client, 'outbound_party.merged'), 'merge audited');
});

test('listPartyChannels is client-scoped: refuses an unscoped read, filters in SQL', async () => {
  const client = makeMockClient([
    { match: 'from party_channels', rows: [{ id: 'ch-1', channel_kind: 'email' }] }
  ]);

  // The send path resolves a real recipient from this read, so an unnamed
  // scope REFUSES rather than reading across the customer boundary (F-1).
  await assert.rejects(
    () => listPartyChannels(client, { clientId: 'c-1', partyId: 'p-1' }),
    /requires firmId and clientId/
  );
  await assert.rejects(
    () => listPartyChannels(client, { firmId: 'f-1', partyId: 'p-1' }),
    /requires firmId and clientId/
  );
  await assert.rejects(
    () => listPartyChannels(client, { firmId: 'f-1', clientId: 'c-1' }),
    /requires partyId/
  );
  assert.equal(client.calls.length, 0, 'a refused read never reaches the database');

  const rows = await listPartyChannels(client, {
    firmId: 'f-1', clientId: 'c-1', partyId: 'p-1'
  });
  assert.equal(rows.length, 1);
  const [call] = client.calls;
  const sql = call.sql.replace(/\s+/g, ' ').toLowerCase();
  assert.ok(sql.includes('where firm_id = $1 and client_id = $2 and party_id = $3'),
    'the scope is enforced in SQL, not just in the arguments');
  assert.deepEqual(call.params.slice(0, 3), ['f-1', 'c-1', 'p-1']);
});

test('setPartyAttribute: closed set, validation, close-prior, denormalize, audit', async () => {
  const client = makeMockClient([]);
  await setPartyAttribute(client, {
    ...BASE, partyId: 'p-1', attribute: 'payment_terms_days', value: 30,
    actorType: 'owner', actorId: 'kari'
  });
  const sqls = client.calls.map((c) => c.sql.replace(/\s+/g, ' '));
  assert.ok(sqls.some((s) => s.includes('update party_attributes set valid_until = now()')), 'closes prior row');
  assert.ok(sqls.some((s) => s.includes('insert into party_attributes')), 'inserts history row');
  assert.ok(sqls.some((s) => s.includes('update client_parties set payment_terms_days')), 'denormalizes current value');
  assert.ok(audited(client, 'outbound_party.attribute_set'), 'audited');

  await assert.rejects(
    () => setPartyAttribute(client, { ...BASE, partyId: 'p-1', attribute: 'credit_limit', value: 5 }),
    /unknown attribute/
  );
  await assert.rejects(
    () => setPartyAttribute(client, { ...BASE, partyId: 'p-1', attribute: 'payment_terms_days', value: -3 }),
    /invalid value/
  );
  await assert.rejects(
    () => setPartyAttribute(client, { ...BASE, partyId: 'p-1', attribute: 'preferred_language', value: 'english' }),
    /invalid value/
  );
  await assert.rejects(
    () => setPartyAttribute(client, { ...BASE, partyId: 'p-1', attribute: 'fallback_language', value: 'English' }),
    /invalid value/
  );
  await setPartyAttribute(client, {
    ...BASE, partyId: 'p-1', attribute: 'fallback_language', value: 'en',
    actorType: 'owner', actorId: 'kari'
  });
  assert.ok(client.calls.some((call) => call.sql.includes('update client_parties set fallback_language')),
    'the explicit fallback is denormalized through the same effective-dated writer');
  await assert.rejects(
    () => setPartyAttribute(client, { ...BASE, partyId: 'p-1', attribute: 'do_not_contact', value: 'yes' }),
    /invalid value/
  );
  assert.deepEqual([...PARTY_ATTRIBUTES], [
    'preferred_language', 'fallback_language', 'payment_terms_days', 'do_not_contact', 'tax_registration'
  ]);
});

test('addPartyChannel is idempotent on the active (party, kind, value)', async () => {
  const client = makeMockClient([
    { match: 'insert into party_channels', rows: [] },
    { match: 'select * from party_channels where party_id = $1 and channel_kind', rows: [{ id: 'ch-existing' }] }
  ]);
  const result = await addPartyChannel(client, {
    ...BASE, partyId: 'p-1', channelKind: 'email', channelValue: 'AP@Acme-com.example'
  });
  assert.equal(result.created, false);
  assert.equal(result.channel.id, 'ch-existing');
  assert.ok(!client.calls.some((c) => c.sql.includes('audit_events')), 'no audit for a no-op');
  await assert.rejects(
    () => addPartyChannel(client, { ...BASE, partyId: 'p-1', channelKind: 'fax', channelValue: 'x' }),
    /unknown channel_kind/
  );
});

test('backfill soft-fails absent tables and isolates poisoned candidates', async () => {
  const absent = Object.assign(new Error('relation does not exist'), { code: '42P01' });
  const client = makeMockClient([
    { match: 'from issued_invoices', rows: [
      { buyer_name: 'Acme LLC', buyer_email: 'ap@acme-com.example', business_id: null, id: 'inv-1' },
      { buyer_name: 'Poison Co', buyer_email: null, business_id: null, id: 'inv-2' }
    ] },
    { match: 'from xero_contacts', throw: absent },
    { match: 'from qbo_customers', throw: absent },
    { match: 'from qbo_vendors', throw: absent },
    { match: 'from procountor_business_partners', throw: absent },
    { match: 'insert into client_parties', rows: ({ params }) => {
      if (params[3] === 'Poison Co') throw new Error('boom');
      return insertedPartyRow({ params });
    } },
    { match: 'insert into party_channels', rows: ({ params }) => [{ id: params[0] }] }
  ]);
  const stats = await backfillPartiesForClient({ client, ...BASE });
  assert.equal(stats.considered, 2);
  assert.equal(stats.created, 1);
  assert.equal(stats.errors, 1);
  assert.equal(stats.sources.xero_contacts.absent, true);
  const rollbacks = client.calls.filter((c) => c.sql === 'rollback');
  assert.equal(rollbacks.length, 1, 'poisoned candidate rolled back alone');
});


// ── The owner-command buyer roster (kernel-audit M2) ────────────────────────

test('listCustomerPartyCandidates is client-scoped and offers only invoiceable customers', async () => {
  const client = makeMockClient([
    {
      match: 'from client_parties p',
      rows: [{ id: 'p-1', display_name: 'Acme Ltd', email: 'ap@acme.test', business_id: '123' }]
    }
  ]);

  await assert.rejects(
    () => listCustomerPartyCandidates(client, { clientId: 'c-1' }),
    /requires firmId and clientId/
  );
  await assert.rejects(
    () => listCustomerPartyCandidates(client, { firmId: 'f-1' }),
    /requires firmId and clientId/
  );
  assert.equal(client.calls.length, 0, 'a refused read never reaches the database');

  const rows = await listCustomerPartyCandidates(client, { firmId: 'f-1', clientId: 'c-1' });
  assert.deepEqual(rows, [{ id: 'p-1', display_name: 'Acme Ltd', email: 'ap@acme.test', business_id: '123' }]);

  const sql = client.calls[0].sql.replace(/\s+/g, ' ').toLowerCase();
  assert.ok(sql.includes('p.firm_id = $1 and p.client_id = $2'), 'scope enforced in SQL');
  // Only customers, only active, only with a live email channel, never a
  // do-not-contact party: a candidate that cannot be invoiced would produce a
  // match that refuses at the mint.
  assert.ok(sql.includes('p.is_customer = true'));
  assert.ok(sql.includes("p.status = 'active'"));
  assert.ok(sql.includes("c.channel_kind = 'email'"));
  assert.ok(sql.includes('c.valid_until is null'));
  assert.ok(sql.includes('do_not_contact'));
  // The join is scoped on BOTH sides — party_id alone is not a tenancy proof.
  assert.ok(sql.includes('c.firm_id = p.firm_id and c.client_id = p.client_id'));
  assert.equal(client.calls[0].params[2], 50, 'bounded by default');
});

test('listCustomerPartyCandidates clamps its limit', async () => {
  const client = makeMockClient([{ match: 'from client_parties p', rows: [] }]);
  await listCustomerPartyCandidates(client, { firmId: 'f-1', clientId: 'c-1', limit: 10_000 });
  assert.equal(client.calls[0].params[2], 200);
  // Same clamp convention as listPartiesForClient above: a nonsense positive
  // floor is 1, and only a non-numeric limit falls back to the default.
  await listCustomerPartyCandidates(client, { firmId: 'f-1', clientId: 'c-1', limit: -5 });
  assert.equal(client.calls[1].params[2], 1);
  await listCustomerPartyCandidates(client, { firmId: 'f-1', clientId: 'c-1', limit: 'lots' });
  assert.equal(client.calls[2].params[2], 50);
});
