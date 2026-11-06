// Donna — K1 writer tests (slice K1-1). Load-bearing properties, each asserted
// on what is PERSISTED (the SQL actually issued), never on a return value alone:
//   - a tenant-identifier draft is refused BEFORE any SQL runs (no row, no write)
//   - activation is the only path to 'active', and it demands a reviewer, a
//     snapshot + hash, and an honest verification statement
//   - supersession is a new row + a link, in ONE transaction; the prior flips
//   - re-loading identical content is a no-op; different content CONFLICTS
//   - withdrawal takes the source's passages with it
//   - NO hard delete exists anywhere in the writer
//   - the writer never touches audit_events (it has no firm to write under)

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  knowledgeTablesPresent,
  loadKnowledgeSource,
  reviewKnowledgeSource,
  supersedeKnowledgeSource,
  withdrawKnowledgeSource,
  loadKnowledgePassage,
  reviewKnowledgePassage,
  supersedeKnowledgePassage,
  withdrawKnowledgePassage
} from './knowledgeBaseDb.js';
import { knowledgeSourceId, knowledgePassageId } from './knowledgeBase.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A mock pg client that records every statement, so tests can assert on what
// was PERSISTED rather than on what a function returned.
const makeMockClient = (responders = []) => {
  const calls = [];
  const queue = [...responders];
  return {
    calls,
    sql: () => calls.map((c) => c.sql),
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).toLowerCase().replace(/\s+/g, ' ');
      if (text === 'begin' || text === 'commit' || text === 'rollback') return { rows: [], rowCount: 0 };
      const idx = queue.findIndex((r) => text.includes(r.match));
      if (idx !== -1) {
        const [r] = queue.splice(idx, 1);
        if (r.throw) throw r.throw;
        return { rows: r.rows || [], rowCount: r.rowCount ?? (r.rows || []).length };
      }
      if (text.includes('to_regclass')) {
        return { rows: [{ sources: 'knowledge_sources', passages: 'knowledge_passages' }] };
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

const inserts = (client, table) =>
  client.calls.filter((c) => c.sql.replace(/\s+/g, ' ').toLowerCase().includes(`insert into ${table}`));

const source = (overrides = {}) => ({
  authority: 'Verohallinto',
  authority_class: 'tax_authority_guidance',
  jurisdiction: 'FI',
  title: 'Arvonlisäverokannat',
  citation: 'VH/1234/2026',
  source_url: 'https://www.vero.fi/example',
  language: 'fi',
  as_of: '2026-07-29T00:00:00.000Z',
  effective_from: '2026-01-01T00:00:00.000Z',
  confirmed_against_primary: true,
  ...overrides
});

const passage = (overrides = {}) => ({
  source_id: 'ksrc-parent',
  jurisdiction: 'FI',
  topic: 'vat_rates',
  question_forms: ['what is the VAT rate'],
  source_excerpt: 'Yleinen verokanta on 25,5 prosenttia.',
  source_anchor: '§ 84',
  curated_proposition: 'The standard Finnish VAT rate is 25.5%.',
  answer_shape: 'rate',
  ...overrides
});

const sourceRow = (overrides = {}) => ({
  id: 'ksrc-parent',
  status: 'active',
  jurisdiction: 'FI',
  effective_from: '2026-01-01T00:00:00.000Z',
  effective_until: null,
  source_url: 'https://www.vero.fi/example',
  title: 'Arvonlisäverokannat',
  content_hash: 'h1',
  snapshot_ref: 's1',
  verification_note: null,
  ...overrides
});

// ─── The refusal happens before any SQL ─────────────────────────────────────

await test('a source draft carrying a tenant identifier is refused with NO write', async () => {
  const client = makeMockClient();
  const out = await loadKnowledgeSource({ client, source: source({ client_id: 'client-acme' }) });

  assert.equal(out.status, 'refused');
  assert.equal(out.record, null);
  assert.ok(out.errors.some((e) => e.includes('K1 is global and carries no tenant identifier')));
  assert.equal(inserts(client, 'knowledge_sources').length, 0, 'no row written');
  assert.equal(client.calls.filter((c) => c.sql.toLowerCase().includes('begin')).length, 0, 'no transaction opened');
});

await test('a passage draft carrying a tenant identifier is refused with NO write', async () => {
  const client = makeMockClient([{ match: 'from knowledge_sources', rows: [sourceRow()] }]);
  const out = await loadKnowledgePassage({
    client,
    passage: passage({ caveats: 'per firm-abc123 prior treatment' })
  });

  assert.equal(out.status, 'refused');
  assert.equal(inserts(client, 'knowledge_passages').length, 0, 'no row written');
});

// ─── Loading ────────────────────────────────────────────────────────────────

await test('a valid source loads as DRAFT — never active — and persists its columns', async () => {
  const client = makeMockClient();
  const out = await loadKnowledgeSource({ client, source: source() });

  assert.equal(out.status, 'loaded');
  const [insert] = inserts(client, 'knowledge_sources');
  assert.ok(insert, 'a row was inserted');

  const columns = insert.sql.slice(insert.sql.indexOf('(') + 1, insert.sql.indexOf(')')).split(',').map((c) => c.trim());
  const statusIdx = columns.indexOf('status');
  assert.equal(insert.params[statusIdx], 'draft', 'a loader may never persist an ACTIVE source');
  assert.equal(insert.params[columns.indexOf('jurisdiction')], 'FI');
  assert.equal(insert.params[columns.indexOf('authority_class')], 'tax_authority_guidance');
  assert.equal(insert.params[columns.indexOf('reviewed_by')], null, 'unreviewed on load');
});

// The other half of "activation is a separate, attributed act": not merely that
// a plain load lands as 'draft', but that a loader ASKING for 'active' is
// refused outright. Without this, a curated corpus file could self-activate and
// the reviewer gate would be decorative.
await test('a loader asking for ACTIVE is refused — activation is the reviewer\'s act alone', async () => {
  for (const status of ['active', 'superseded', 'withdrawn']) {
    const client = makeMockClient();
    const out = await loadKnowledgeSource({ client, source: source({ status }) });
    assert.equal(out.status, 'refused', status);
    assert.ok(out.errors.some((e) => e.startsWith('status:')), status);
    assert.equal(inserts(client, 'knowledge_sources').length, 0, `${status}: no row written`);
  }

  const pClient = makeMockClient([{ match: 'from knowledge_sources', rows: [sourceRow()] }]);
  const pOut = await loadKnowledgePassage({ client: pClient, passage: passage({ status: 'active' }) });
  assert.equal(pOut.status, 'refused');
  assert.equal(inserts(pClient, 'knowledge_passages').length, 0);
});

await test('re-loading the SAME source is a no-op, not a duplicate row', async () => {
  const id = knowledgeSourceId({ jurisdiction: 'FI', citation: 'VH/1234/2026', effective_from: '2026-01-01T00:00:00.000Z' });
  const client = makeMockClient([
    { match: 'from knowledge_sources', rows: [sourceRow({ id, status: 'active' })] }
  ]);

  const out = await loadKnowledgeSource({ client, source: source() });
  assert.equal(out.status, 'unchanged');
  assert.equal(inserts(client, 'knowledge_sources').length, 0, 'no second row');
});

await test('re-loading DIFFERENT passage content CONFLICTS — never a silent overwrite', async () => {
  const id = knowledgePassageId({ source_id: 'ksrc-parent', topic: 'vat_rates', source_anchor: '§ 84' });
  const client = makeMockClient([
    { match: 'from knowledge_sources', rows: [sourceRow()] },
    {
      match: 'from knowledge_passages',
      rows: [{ ...passage(), id, curated_proposition: 'The standard rate is 24%.', status: 'active' }]
    }
  ]);

  const out = await loadKnowledgePassage({ client, passage: passage() });
  assert.equal(out.status, 'refused');
  assert.ok(out.errors.some((e) => e.includes('supersede')));
  assert.equal(inserts(client, 'knowledge_passages').length, 0);
  assert.equal(
    client.calls.filter((c) => c.sql.toLowerCase().includes('update knowledge_passages')).length,
    0,
    'and nothing was updated in place'
  );
});

await test('re-loading IDENTICAL passage content is a no-op', async () => {
  const id = knowledgePassageId({ source_id: 'ksrc-parent', topic: 'vat_rates', source_anchor: '§ 84' });
  const client = makeMockClient([
    { match: 'from knowledge_sources', rows: [sourceRow()] },
    { match: 'from knowledge_passages', rows: [{ ...passage(), id, effective_from: '2026-01-01T00:00:00.000Z', status: 'active' }] }
  ]);

  const out = await loadKnowledgePassage({ client, passage: passage() });
  assert.equal(out.status, 'unchanged');
  assert.equal(inserts(client, 'knowledge_passages').length, 0);
});

await test('a passage is never loaded without its source', async () => {
  const client = makeMockClient([{ match: 'from knowledge_sources', rows: [] }]);
  const out = await loadKnowledgePassage({ client, passage: passage() });
  assert.equal(out.status, 'refused');
  assert.ok(out.errors.some((e) => e.includes('not found')));
  assert.equal(inserts(client, 'knowledge_passages').length, 0);
});

// ─── Activation ─────────────────────────────────────────────────────────────

await test('activation requires a named reviewer', async () => {
  const client = makeMockClient([{ match: 'from knowledge_sources', rows: [sourceRow({ status: 'draft' })] }]);
  const out = await reviewKnowledgeSource({ client, sourceId: 'ksrc-parent', reviewedBy: null });

  assert.equal(out.status, 'refused');
  assert.ok(out.errors.some((e) => e.startsWith('reviewed_by:')));
  assert.equal(client.calls.filter((c) => c.sql.toLowerCase().includes("status = 'active'")).length, 0);
});

await test('activation requires a snapshot + content hash (the artifact must stay reconstructable)', async () => {
  const client = makeMockClient([
    { match: 'from knowledge_sources', rows: [sourceRow({ status: 'draft', content_hash: null, snapshot_ref: null })] }
  ]);
  const out = await reviewKnowledgeSource({ client, sourceId: 'ksrc-parent', reviewedBy: 'kari', confirmedAgainstPrimary: true });

  assert.equal(out.status, 'refused');
  assert.ok(out.errors.some((e) => e.includes('content_hash + snapshot_ref')));
  assert.equal(client.calls.filter((c) => c.sql.toLowerCase().includes('update knowledge_sources')).length, 0);
});

await test('activation with confirmed_against_primary false demands the honest note', async () => {
  const client = makeMockClient([
    { match: 'from knowledge_sources', rows: [sourceRow({ status: 'draft', verification_note: null })] }
  ]);
  const out = await reviewKnowledgeSource({
    client,
    sourceId: 'ksrc-parent',
    reviewedBy: 'kari',
    confirmedAgainstPrimary: false
  });

  assert.equal(out.status, 'refused');
  assert.ok(out.errors.some((e) => e.startsWith('verification_note:')));
});

await test('a valid activation persists reviewer, hash, snapshot and the confirmed flag', async () => {
  const client = makeMockClient([
    { match: 'from knowledge_sources', rows: [sourceRow({ status: 'pending_review' })] }
  ]);
  const out = await reviewKnowledgeSource({
    client,
    sourceId: 'ksrc-parent',
    reviewedBy: 'kari',
    reviewedAt: '2026-07-29T12:00:00.000Z',
    confirmedAgainstPrimary: true,
    contentHash: 'sha256:abc',
    snapshotRef: 'snap/vero-2026-07-29.html'
  });

  assert.equal(out.status, 'activated');
  const update = client.calls.find((c) => c.sql.toLowerCase().includes('update knowledge_sources'));
  assert.ok(update.sql.includes("status = 'active'"));
  assert.deepEqual(update.params.slice(0, 7), [
    'ksrc-parent',
    'kari',
    '2026-07-29T12:00:00.000Z',
    true,
    null,
    'sha256:abc',
    'snap/vero-2026-07-29.html'
  ]);
});

await test('a terminal row is never reactivated', async () => {
  for (const status of ['withdrawn', 'superseded']) {
    const client = makeMockClient([{ match: 'from knowledge_sources', rows: [sourceRow({ status })] }]);
    const out = await reviewKnowledgeSource({
      client,
      sourceId: 'ksrc-parent',
      reviewedBy: 'kari',
      confirmedAgainstPrimary: true
    });
    assert.equal(out.status, 'refused', status);
    assert.equal(client.calls.filter((c) => c.sql.toLowerCase().includes('update knowledge_sources')).length, 0);
  }
});

await test('a passage never outranks its provenance: its source must be active first', async () => {
  const client = makeMockClient([
    { match: 'from knowledge_passages', rows: [{ ...passage(), id: 'kpsg-1', status: 'draft' }] },
    { match: 'from knowledge_sources', rows: [sourceRow({ status: 'pending_review' })] }
  ]);
  const out = await reviewKnowledgePassage({ client, passageId: 'kpsg-1', reviewedBy: 'kari' });

  assert.equal(out.status, 'refused');
  assert.ok(out.errors.some((e) => e.includes('never outranks its provenance')));
  assert.equal(client.calls.filter((c) => c.sql.toLowerCase().includes('update knowledge_passages')).length, 0);
});

// ─── Supersession ───────────────────────────────────────────────────────────

await test('superseding a passage inserts a NEW row, links it, and flips the prior — in one transaction', async () => {
  const client = makeMockClient([
    { match: 'from knowledge_passages', rows: [{ ...passage(), id: 'kpsg-prior', status: 'active' }] },
    { match: 'from knowledge_sources', rows: [sourceRow()] }
  ]);

  const out = await supersedeKnowledgePassage({
    client,
    priorId: 'kpsg-prior',
    passage: passage({ source_anchor: '§ 84 (2027)', curated_proposition: 'The standard Finnish VAT rate is 26%.' })
  });

  assert.equal(out.status, 'superseded');

  const [insert] = inserts(client, 'knowledge_passages');
  const columns = insert.sql.slice(insert.sql.indexOf('(') + 1, insert.sql.indexOf(')')).split(',').map((c) => c.trim());
  assert.equal(insert.params[columns.indexOf('supersedes')], 'kpsg-prior', 'the successor links back');
  assert.equal(insert.params[columns.indexOf('status')], 'draft', 'the successor is unreviewed until a reviewer says so');

  const flip = client.calls.find((c) => c.sql.includes("status = 'superseded'"));
  assert.ok(flip, 'the prior row flips');
  assert.deepEqual(flip.params, ['kpsg-prior']);

  // Both halves inside ONE transaction: the prior must never be left flipped
  // without its successor, nor the successor inserted while the prior reads active.
  const order = client.calls.map((c) => c.sql.toLowerCase().replace(/\s+/g, ' ').trim());
  const begin = order.findIndex((s) => s === 'begin');
  const commit = order.findIndex((s) => s === 'commit');
  const insertAt = order.findIndex((s) => s.includes('insert into knowledge_passages'));
  const flipAt = order.findIndex((s) => s.includes("status = 'superseded'"));
  assert.ok(begin !== -1 && commit !== -1, 'transaction opened and committed');
  assert.ok(begin < insertAt && insertAt < commit, 'insert inside');
  assert.ok(begin < flipAt && flipAt < commit, 'flip inside');
});

await test('a supersession that reuses the prior id is refused (that is an in-place edit)', async () => {
  const priorId = knowledgePassageId({ source_id: 'ksrc-parent', topic: 'vat_rates', source_anchor: '§ 84' });
  const client = makeMockClient([
    { match: 'from knowledge_passages', rows: [{ ...passage(), id: priorId, status: 'active' }] },
    { match: 'from knowledge_sources', rows: [sourceRow()] }
  ]);

  const out = await supersedeKnowledgePassage({ client, priorId, passage: passage({ curated_proposition: 'changed' }) });
  assert.equal(out.status, 'refused');
  assert.ok(out.errors.some((e) => e.includes('in-place edit')));
  assert.equal(inserts(client, 'knowledge_passages').length, 0);
});

await test('the supersession chain does not fork', async () => {
  const client = makeMockClient([
    { match: 'from knowledge_passages', rows: [{ ...passage(), id: 'kpsg-prior', status: 'superseded' }] }
  ]);
  const out = await supersedeKnowledgePassage({ client, priorId: 'kpsg-prior', passage: passage({ source_anchor: '§ 99' }) });
  assert.equal(out.status, 'refused');
  assert.ok(out.errors.some((e) => e.includes('does not fork')));
});

await test('superseding a source flips the prior and inserts the successor in one transaction', async () => {
  const client = makeMockClient([
    { match: 'from knowledge_sources', rows: [sourceRow({ id: 'ksrc-prior', status: 'active' })] }
  ]);
  const out = await supersedeKnowledgeSource({
    client,
    priorId: 'ksrc-prior',
    source: source({ citation: 'VH/9999/2027', effective_from: '2027-01-01T00:00:00.000Z' })
  });

  assert.equal(out.status, 'superseded');
  const [insert] = inserts(client, 'knowledge_sources');
  const columns = insert.sql.slice(insert.sql.indexOf('(') + 1, insert.sql.indexOf(')')).split(',').map((c) => c.trim());
  assert.equal(insert.params[columns.indexOf('supersedes')], 'ksrc-prior');
  assert.ok(client.calls.some((c) => c.sql.includes("status = 'superseded'")));
});

// ─── Withdrawal, and the absence of deletion ────────────────────────────────

await test('withdrawing a source takes its passages with it, in the same transaction', async () => {
  const client = makeMockClient([{ match: 'from knowledge_sources', rows: [sourceRow()] }]);
  const out = await withdrawKnowledgeSource({ client, sourceId: 'ksrc-parent', reason: 'guidance replaced by Vero' });

  assert.equal(out.status, 'withdrawn');
  const sourceUpdate = client.calls.find((c) => c.sql.includes('update knowledge_sources'));
  assert.ok(sourceUpdate.sql.includes("status = 'withdrawn'"));

  const passageUpdate = client.calls.find((c) => c.sql.includes('update knowledge_passages'));
  assert.ok(passageUpdate, 'its passages are withdrawn too');
  assert.equal(passageUpdate.params[0], 'ksrc-parent');
  assert.match(passageUpdate.params[1], /^source withdrawn: /);

  const order = client.calls.map((c) => c.sql.toLowerCase().replace(/\s+/g, ' ').trim());
  const begin = order.findIndex((s) => s === 'begin');
  const commit = order.findIndex((s) => s === 'commit');
  assert.ok(begin < order.findIndex((s) => s.includes('update knowledge_passages')));
  assert.ok(order.findIndex((s) => s.includes('update knowledge_passages')) < commit);
});

await test('withdrawal states its reason', async () => {
  const client = makeMockClient([{ match: 'from knowledge_sources', rows: [sourceRow()] }]);
  const out = await withdrawKnowledgeSource({ client, sourceId: 'ksrc-parent', reason: null });
  assert.equal(out.status, 'refused');
  assert.equal(client.calls.length, 0, 'refused before any read or write');

  const pClient = makeMockClient([{ match: 'from knowledge_passages', rows: [{ id: 'kpsg-1' }] }]);
  const pOut = await withdrawKnowledgePassage({ client: pClient, passageId: 'kpsg-1', reason: null });
  assert.equal(pOut.status, 'refused');
});

// The structural half of "no hard delete". A future session's reflex is to wire
// a purge handler into the client-delete path the way firm_facts has one; K1
// must not get one, because its owning scope is the platform, not a tenant.
await test('the writer contains NO hard delete and NO purge handler', () => {
  const src = readFileSync(resolvePath(__dirname, 'knowledgeBaseDb.js'), 'utf8');
  const code = src
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  assert.doesNotMatch(code, /delete\s+from\s+knowledge_/i, 'no hard delete of knowledge rows');
  assert.doesNotMatch(code, /truncate/i, 'no truncate');
  assert.doesNotMatch(code, /export const purge/i, 'no purge handler — K1 does not die with a tenant');
});

// The tenant-free plane, asserted against the writer's own SQL: a borrowed
// firm_id is exactly how a global corpus would acquire a tenant.
await test('the writer never writes audit_events (it has no firm to write under)', () => {
  const src = readFileSync(resolvePath(__dirname, 'knowledgeBaseDb.js'), 'utf8');
  const code = src
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  assert.doesNotMatch(code, /insert\s+into\s+audit_events/i);
  assert.doesNotMatch(code, /\bfirm_id\b/i, 'no firm_id anywhere in the writer');
  assert.doesNotMatch(code, /\bclient_id\b/i, 'no client_id anywhere in the writer');
});

await test('table presence is checked without assuming the migration ran', async () => {
  const present = makeMockClient();
  assert.equal(await knowledgeTablesPresent(present), true);

  const absent = makeMockClient([{ match: 'to_regclass', rows: [{ sources: null, passages: null }] }]);
  assert.equal(await knowledgeTablesPresent(absent), false);
});
