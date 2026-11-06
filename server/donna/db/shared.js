// server/donna/db/shared.js — table-agnostic helpers every plane shares (deterministic ids, row chunking, null coercion).
//
// RT-17 (2026-09-02): extracted from server/donna/firmDb.js as a pure move. Every public
// symbol keeps its old import path through firmDb.js, which re-exports it; helpers another
// plane needs are exported here and NOT re-exported by firmDb.js. Zero behaviour change.

import { normalizeIntelText } from '../transactionIntel.js';
import { toIsoDay } from '../dates.js';

export const shortHash = (value = '') => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
};

export const slugifyRulePart = (value = '') => normalizeIntelText(value).replace(/\s+/g, '-').slice(0, 64) || 'unknown';

// Shared identity used by chart birth, its observer and the existing journal writer.
// Deterministic ledger record id. The trailing hash is taken over the FULL,
// un-slugified parts, so it is the ONLY faithful disambiguator between two
// inputs that share a long slug prefix (e.g. doc-derived transaction ids with a
// common head, whose 64-char slugs are identical). Reserve room for the hash
// BEFORE truncating to 140 so it can never be sliced off.
//
// The old form — `['ledger', ...slugs, hash].join('-').slice(0, 140)` — appended
// the hash last and then truncated the whole string, so for long inputs the hash
// (and the distinguishing tail of source_id) was cut away and DISTINCT journals
// collapsed onto a single id. Because the journal upsert conflicts on the
// (firm_id, client_id, source_type, source_id) tuple rather than the pkey, the
// collapsed id slipped past `on conflict` and raised `ledger_journals_pkey`
// 23505 on Xero writeback (createXeroBankTransaction had already run, leaving an
// orphan row in Xero while Donna logged an error). Exported for unit tests.

export const ledgerRecordId = (...parts) => {
  const hash = shortHash(parts.join('|'));
  const slug = ['ledger', ...parts.map((part) => slugifyRulePart(String(part || 'unknown')))].join('-');
  return `${slug.slice(0, Math.max(140 - hash.length - 1, 1))}-${hash}`;
};

export const dateOrNull = (value) => {
  if (!value) return null;
  const text = toIsoDay(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
};

export const numberOrNull = (value) => {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

// Postgres caps parameterized statements at 65535 bind values. Batching
// row writes at this chunk size cuts large statement uploads from N
// round-trips down to a handful while staying well under the limit for
// any realistic column count.
export const MULTI_ROW_CHUNK_SIZE = 500;

export const chunk = (array, size) => {
  if (size <= 0 || array.length <= size) return [array];
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
};

// Generates `($1, $2, ...), ($N+1, ...), ...` for `INSERT ... VALUES`
// or `UPDATE ... FROM (VALUES ...)`, along with a flat params array.
// `casts` aligns with the per-row value array — each entry is a type
// cast suffix appended to the matching placeholder (e.g. `'::jsonb'`).
export const buildMultiRowValues = (rows, valueFn, casts = []) => {
  const params = [];
  const tuples = rows.map((row) => {
    const values = valueFn(row);
    const placeholders = values.map((_, i) => `$${params.length + i + 1}${casts[i] || ''}`);
    params.push(...values);
    return `(${placeholders.join(', ')})`;
  });
  return { sql: tuples.join(', '), params };
};
