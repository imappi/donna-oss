// Donna — K1, the sourced knowledge base: the WRITERS over migration 109
// (docs/design-donna-knowledge-base.md §4/§8; slice K1-1). The contract layer
// is knowledgeBase.js.
//
// THIS IS A CURATION LOADER, NOT A RUNTIME PATH. v1 ingestion is a
// human-authored, reviewed corpus committed as data (§8): not a crawler, not a
// scraper, and above all not a model-generated corpus — "a model-generated
// knowledge base is a laundering machine. It converts the training corpus into
// rows that LOOK sourced," which is precisely the failure the whole design
// exists to prevent, and it would be undetectable afterwards. These writers are
// run by a curator against a reviewed corpus; nothing in the request path calls
// them. That is also why there is no rollout flag here: the rollout gate
// (KNOWLEDGE_BASE_RETRIEVAL, born off, config-plane, never an env pair) belongs
// to the READ side in K1-4. A loader only a curator runs is not a rollout.
//
// THE DISCIPLINE, each machine-checked by knowledgeBaseDb.test.js:
//
//   - VALIDATION IS A PRECONDITION. Every write goes through the knowledgeBase
//     validators first. A refused draft produces NO row — in particular a draft
//     carrying a tenant identifier is refused before any SQL runs (design §3:
//     "the K1 writer refuses any row carrying a client, firm, or party
//     identifier. That is a lint and a test, not a convention").
//
//   - NO HARD DELETE, ANYWHERE. There is deliberately no purge function and no
//     `delete from knowledge_…` in this file. A global corpus's owning scope is
//     the PLATFORM, so it does not die with a tenant; a wrong or dead row is
//     WITHDRAWN (kept, never retrieved) and a changed one is SUPERSEDED (new
//     row + link). Deleting would orphan the receipts of every answer the row
//     ever grounded. Compare firm_facts, which are purged with their client
//     precisely because their owning scope DOES die — same rail, opposite
//     outcome, because the scope differs.
//
//   - NEVER A SILENT OVERWRITE. Re-loading an identical passage is a no-op
//     ('unchanged'); re-loading DIFFERENT content against an existing id is a
//     CONFLICT that directs the curator to supersede. Content under a receipted
//     id never changes, so an answer given last March stays explicable.
//
//   - ACTIVATION IS A SEPARATE, ATTRIBUTED ACT. A loader may write 'draft' or
//     'pending_review' only. Reaching 'active' — the only status retrieval ever
//     reads — requires a named reviewer, a snapshot + content hash, and an
//     honest verification note. "A passage nobody read is not a source."
//
//   - ONE TRANSACTION PER LOGICAL WRITE. A supersede flips the prior row and
//     inserts the successor together, or neither happens; a source withdrawal
//     takes its passages with it in the same transaction (a passage whose
//     source is withdrawn must not keep grounding answers).
//
// WHY NO audit_events ROWS: `audit_events.firm_id` is NOT NULL with an ON
// DELETE CASCADE to firms (migration 001). K1 has no firm. Writing curation
// events there would either invent a tenant identifier on a tenant-free plane
// (the refusal above) or let one tenant's deletion cascade away the provenance
// of platform-wide knowledge. So the curation trail lives IN THE ROWS:
// append-mostly + supersession links + reviewer attribution + withdrawal
// reasons. If a future slice wants a queryable curation log, it needs its own
// tenant-free table — never a borrowed firm_id.

import {
  validateKnowledgeSourceDraft,
  validateKnowledgePassageDraft,
  knowledgeContentFingerprint
} from './knowledgeBase.js';

const SOURCE_COLUMNS = Object.freeze([
  'id', 'schema_version', 'authority', 'authority_class', 'jurisdiction', 'title', 'citation',
  'source_url', 'content_hash', 'snapshot_ref', 'language', 'translation_status',
  'published_at', 'effective_from', 'effective_until', 'as_of', 'review_due_at',
  'confirmed_against_primary', 'verification_note', 'reviewed_by', 'reviewed_at',
  'withdrawn_reason', 'status', 'supersedes'
]);

const PASSAGE_COLUMNS = Object.freeze([
  'id', 'schema_version', 'source_id', 'jurisdiction', 'topic', 'question_forms',
  'source_excerpt', 'source_anchor', 'curated_proposition', 'answer_shape', 'caveats',
  'effective_from', 'effective_until', 'reviewed_by', 'reviewed_at', 'withdrawn_reason',
  'status', 'supersedes'
]);

const PASSAGE_JSONB = new Set(['question_forms']);

const refusal = (errors) => ({ status: 'refused', errors: [].concat(errors), record: null });

const withTransaction = async (client, manageTransaction, fn) => {
  if (!manageTransaction) return fn();
  await client.query('begin');
  try {
    const out = await fn();
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback');
    throw err;
  }
};

export const knowledgeTablesPresent = async (client) => {
  const { rows } = await client.query(
    `select to_regclass('public.knowledge_sources') as sources,
            to_regclass('public.knowledge_passages') as passages`
  );
  return Boolean(rows?.[0]?.sources && rows?.[0]?.passages);
};

export const readKnowledgeSource = async (client, id) => {
  const { rows } = await client.query(
    `select id, schema_version, authority, authority_class, jurisdiction, title, citation,
            source_url, content_hash, snapshot_ref, language, translation_status,
            published_at, effective_from, effective_until, as_of, review_due_at,
            confirmed_against_primary, verification_note, reviewed_by, reviewed_at,
            withdrawn_reason, status, supersedes
       from knowledge_sources
      where id = $1`,
    [id]
  );
  return rows?.[0] || null;
};

export const readKnowledgePassage = async (client, id) => {
  const { rows } = await client.query(
    `select id, schema_version, source_id, jurisdiction, topic, question_forms,
            source_excerpt, source_anchor, curated_proposition, answer_shape, caveats,
            effective_from, effective_until, reviewed_by, reviewed_at, withdrawn_reason,
            status, supersedes
       from knowledge_passages
      where id = $1`,
    [id]
  );
  return rows?.[0] || null;
};

const insertRow = async (client, table, columns, record, jsonbFields = new Set()) => {
  const values = columns.map((col) => {
    const v = record[col] ?? null;
    return jsonbFields.has(col) && v !== null ? JSON.stringify(v) : v;
  });
  const placeholders = columns.map((col, i) => (jsonbFields.has(col) ? `$${i + 1}::jsonb` : `$${i + 1}`));
  await client.query(
    `insert into ${table} (${columns.join(', ')}) values (${placeholders.join(', ')})`,
    values
  );
};

// ─── Sources ────────────────────────────────────────────────────────────────

export const loadKnowledgeSource = async ({ client, source = {}, manageTransaction = true } = {}) => {
  const { record, errors } = validateKnowledgeSourceDraft({ source });
  if (errors.length) return refusal(errors);

  const existing = await readKnowledgeSource(client, record.id);
  if (existing) {
    // Same document, already curated. Provenance fields may legitimately be
    // re-read (a fresh as_of), but CONTENT under a receipted id never changes
    // here — a changed source is a supersession.
    if (existing.source_url === record.source_url && existing.title === record.title) {
      return { status: 'unchanged', errors: [], record: existing };
    }
    return refusal([
      `source ${record.id} already exists with different content — supersede it (supersedeKnowledgeSource), never overwrite`
    ]);
  }

  return withTransaction(client, manageTransaction, async () => {
    await insertRow(client, 'knowledge_sources', SOURCE_COLUMNS, record);
    return { status: 'loaded', errors: [], record };
  });
};

// The reviewer's act. This is the ONLY path to 'active', and it demands the
// three things the design makes structural: a named reviewer, the captured
// artifact, and an honest verification statement.
export const reviewKnowledgeSource = async ({
  client,
  sourceId,
  reviewedBy,
  reviewedAt = new Date(),
  confirmedAgainstPrimary = false,
  verificationNote = null,
  contentHash = null,
  snapshotRef = null,
  manageTransaction = true
} = {}) => {
  const errors = [];
  if (!reviewedBy) errors.push('reviewed_by: required — activation is an attributed act');

  const existing = await readKnowledgeSource(client, sourceId);
  if (!existing) return refusal([`source ${sourceId} not found`]);
  if (existing.status === 'withdrawn' || existing.status === 'superseded') {
    return refusal([`source ${sourceId} is ${existing.status} — a terminal row is never reactivated; load a new one`]);
  }

  const hash = contentHash ?? existing.content_hash;
  const snapshot = snapshotRef ?? existing.snapshot_ref;
  if (!hash || !snapshot) {
    errors.push(
      'content_hash + snapshot_ref: required to activate — official pages are edited silently, so an activated source must be reconstructable'
    );
  }

  const note = verificationNote ?? existing.verification_note;
  if (!confirmedAgainstPrimary && !note) {
    errors.push('verification_note: required when confirmed_against_primary is false — say why it could not be verified');
  }
  if (errors.length) return refusal(errors);

  return withTransaction(client, manageTransaction, async () => {
    await client.query(
      `update knowledge_sources
          set status = 'active',
              reviewed_by = $2,
              reviewed_at = $3,
              confirmed_against_primary = $4,
              verification_note = $5,
              content_hash = $6,
              snapshot_ref = $7,
              updated_at = now()
        where id = $1`,
      [sourceId, reviewedBy, new Date(reviewedAt).toISOString(), confirmedAgainstPrimary === true, note, hash, snapshot]
    );
    return { status: 'activated', errors: [], record: await readKnowledgeSource(client, sourceId) };
  });
};

// A changed source is a NEW row plus a link — never an in-place edit. Both
// halves in one transaction: the prior row must not be left flipped without its
// successor, nor the successor inserted while the prior still reads 'active'.
export const supersedeKnowledgeSource = async ({ client, priorId, source = {}, manageTransaction = true } = {}) => {
  const prior = await readKnowledgeSource(client, priorId);
  if (!prior) return refusal([`source ${priorId} not found`]);
  if (prior.status === 'superseded') {
    return refusal([`source ${priorId} is already superseded — the chain does not fork`]);
  }

  const { record, errors } = validateKnowledgeSourceDraft({ source: { ...source, supersedes: priorId } });
  if (errors.length) return refusal(errors);
  if (record.id === priorId) {
    return refusal(['the successor must be a distinct row — a supersession that reuses the prior id is an in-place edit']);
  }

  return withTransaction(client, manageTransaction, async () => {
    await insertRow(client, 'knowledge_sources', SOURCE_COLUMNS, record);
    await client.query(
      `update knowledge_sources set status = 'superseded', updated_at = now() where id = $1`,
      [priorId]
    );
    return { status: 'superseded', errors: [], record };
  });
};

// Withdrawal takes the source's passages with it, in the same transaction: a
// passage whose source is withdrawn must never keep grounding answers.
export const withdrawKnowledgeSource = async ({ client, sourceId, reason, manageTransaction = true } = {}) => {
  if (!reason) return refusal(['reason: required — a silent withdrawal is unexplainable later']);
  const existing = await readKnowledgeSource(client, sourceId);
  if (!existing) return refusal([`source ${sourceId} not found`]);

  return withTransaction(client, manageTransaction, async () => {
    await client.query(
      `update knowledge_sources
          set status = 'withdrawn', withdrawn_reason = $2, updated_at = now()
        where id = $1`,
      [sourceId, reason]
    );
    await client.query(
      `update knowledge_passages
          set status = 'withdrawn',
              withdrawn_reason = $2,
              updated_at = now()
        where source_id = $1 and status <> 'withdrawn'`,
      [sourceId, `source withdrawn: ${reason}`]
    );
    return { status: 'withdrawn', errors: [], record: await readKnowledgeSource(client, sourceId) };
  });
};

// ─── Passages ───────────────────────────────────────────────────────────────

export const loadKnowledgePassage = async ({ client, passage = {}, manageTransaction = true } = {}) => {
  const sourceRow = passage.source_id ? await readKnowledgeSource(client, passage.source_id) : null;
  if (passage.source_id && !sourceRow) {
    return refusal([`source ${passage.source_id} not found — a passage is never loaded without its source`]);
  }

  const { record, errors } = validateKnowledgePassageDraft({ passage, source: sourceRow });
  if (errors.length) return refusal(errors);

  const existing = await readKnowledgePassage(client, record.id);
  if (existing) {
    const same =
      knowledgeContentFingerprint({
        ...existing,
        question_forms: Array.isArray(existing.question_forms) ? existing.question_forms : []
      }) === knowledgeContentFingerprint(record);
    if (same) return { status: 'unchanged', errors: [], record: existing };
    return refusal([
      `passage ${record.id} already exists with different content — supersede it (supersedeKnowledgePassage), never overwrite`
    ]);
  }

  return withTransaction(client, manageTransaction, async () => {
    await insertRow(client, 'knowledge_passages', PASSAGE_COLUMNS, record, PASSAGE_JSONB);
    return { status: 'loaded', errors: [], record };
  });
};

export const reviewKnowledgePassage = async ({
  client,
  passageId,
  reviewedBy,
  reviewedAt = new Date(),
  manageTransaction = true
} = {}) => {
  if (!reviewedBy) return refusal(['reviewed_by: required — activation is an attributed act']);

  const existing = await readKnowledgePassage(client, passageId);
  if (!existing) return refusal([`passage ${passageId} not found`]);
  if (existing.status === 'withdrawn' || existing.status === 'superseded') {
    return refusal([`passage ${passageId} is ${existing.status} — a terminal row is never reactivated`]);
  }

  // A passage may not outrank its source: activating one under a source that is
  // not itself active would ground an answer on unreviewed provenance.
  const sourceRow = await readKnowledgeSource(client, existing.source_id);
  if (!sourceRow || sourceRow.status !== 'active') {
    return refusal([
      `source ${existing.source_id} is ${sourceRow ? sourceRow.status : 'missing'} — activate the source first; a passage never outranks its provenance`
    ]);
  }

  return withTransaction(client, manageTransaction, async () => {
    await client.query(
      `update knowledge_passages
          set status = 'active', reviewed_by = $2, reviewed_at = $3, updated_at = now()
        where id = $1`,
      [passageId, reviewedBy, new Date(reviewedAt).toISOString()]
    );
    return { status: 'activated', errors: [], record: await readKnowledgePassage(client, passageId) };
  });
};

export const supersedeKnowledgePassage = async ({ client, priorId, passage = {}, manageTransaction = true } = {}) => {
  const prior = await readKnowledgePassage(client, priorId);
  if (!prior) return refusal([`passage ${priorId} not found`]);
  if (prior.status === 'superseded') {
    return refusal([`passage ${priorId} is already superseded — the chain does not fork`]);
  }

  const sourceId = passage.source_id || prior.source_id;
  const sourceRow = await readKnowledgeSource(client, sourceId);
  if (!sourceRow) return refusal([`source ${sourceId} not found`]);

  const { record, errors } = validateKnowledgePassageDraft({
    passage: { ...passage, source_id: sourceId, supersedes: priorId },
    source: sourceRow
  });
  if (errors.length) return refusal(errors);
  if (record.id === priorId) {
    return refusal(['the successor must be a distinct row — a supersession that reuses the prior id is an in-place edit']);
  }

  return withTransaction(client, manageTransaction, async () => {
    await insertRow(client, 'knowledge_passages', PASSAGE_COLUMNS, record, PASSAGE_JSONB);
    await client.query(
      `update knowledge_passages set status = 'superseded', updated_at = now() where id = $1`,
      [priorId]
    );
    return { status: 'superseded', errors: [], record };
  });
};

export const withdrawKnowledgePassage = async ({ client, passageId, reason, manageTransaction = true } = {}) => {
  if (!reason) return refusal(['reason: required — a silent withdrawal is unexplainable later']);
  const existing = await readKnowledgePassage(client, passageId);
  if (!existing) return refusal([`passage ${passageId} not found`]);

  return withTransaction(client, manageTransaction, async () => {
    await client.query(
      `update knowledge_passages
          set status = 'withdrawn', withdrawn_reason = $2, updated_at = now()
        where id = $1`,
      [passageId, reason]
    );
    return { status: 'withdrawn', errors: [], record: await readKnowledgePassage(client, passageId) };
  });
};
