// Layer 2 — the firm's cross-entity memory (firm_facts).
//
// Three-layer model (06-11 late-night handoff §6):
//   L1 the model — the profession's memory: general bookkeeping
//      knowledge. NEVER rebuilt here; it upgrades free with bumps.
//   L2 this module — the practice's memory: what THIS firm knows about
//      ITS merchants, clients, and jurisdictions. Identity-keyed across
//      the firm's ACTIVE clients; a fact dies with its minting client.
//   L3 the book — client-scoped state; dies with the client row.
//
// Facts are distilled from corrections and client replies by a strong
// model, carry provenance + the distiller's model id, and are
// human-dismissible (readers honour status='active' only — the
// client_rules discipline). Subjects are IDENTITY keys (canonical
// merchant pattern, client UEN/registration number, jurisdiction
// code), never clients.id row ids, so a fact's identity survives a
// client RENAME. MERCHANT facts are additionally keyed to their minting
// LEGAL ENTITY (provenance.entity_client_id, part of the deterministic
// id — G−1(c)): venture A's judgment about a merchant never retrieves
// for venture B; legacy pre-entity rows keep retrieving firm-wide with
// an honest legacy_firm_scope label, and firm-wide merchant memory is
// otherwise an explicit promotion, never a side effect of a name match. But a fact's life is tied to its ASSERTING clients
// (provenance.asserted_by_clients — a distinct-append list; the legacy
// provenance.client_id is pinned to the FIRST asserter, G−1(b)): when a
// client row is deleted/reset, it is stripped from every fact's list
// and the fact is PURGED (hard-deleted) only when it was the SOLE
// asserter, so a delete + fresh re-upload is a genuine clean slate for
// that client — the same fact can be re-taught and lands as a new
// ACTIVE row, instead of silently inheriting (or staying stuck on a
// tombstoned) prior judgment — without collaterally purging what OTHER
// ventures taught. A MANUAL dismiss is different: the client still
// exists, so the row is KEPT (status='dismissed') as the
// governance/audit trail of a human "no" (that path is dismissFirmFact).
//
// (Reversed 2026-06-15 from the original "rebuild-proof / survive
// deletion" posture: the pilot client's reset showed stale facts feeding a
// re-uploaded book is worse than re-teaching a recreated client. See
// purgeFirmFactsForDeletedClient + the reader self-heal sweep below.
// migration 030's comment and the operator-loop PRD/plan still carry the
// old "survives client wipes" wording and want reconciling.)

import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { factIsJurisdictionKnowledge } from './operatorMemoryPolicy.js';
import { canonicalMerchantPattern, normalizeIntelText } from './transactionIntel.js';
import { llmCall } from './llmCall.js';
import { getLane } from './modelLanes.js';
import { resolveTextLaneProvider } from './providerEndpoints.js';
import { anthropicStructuredRequest, openAiStructuredRequest, typedLlmCallFailure } from './structuredRequest.js';

export const FIRM_FACT_SCOPES = ['merchant', 'client', 'jurisdiction', 'firm'];
export const FIRM_FACT_CONFIDENCES = ['low', 'medium', 'high'];

const MAX_FACT_LENGTH = 300;
const MAX_SUBJECT_LENGTH = 120;
const MAX_FACTS_PER_EVENT = 3;
const MAX_FACTS_PER_CONTEXT = 24;

// The identity key per scope. Merchant subjects share the coding
// stack's canonical pattern so a fact written from one bank line
// matches every future line for that merchant; client subjects prefer
// the registration number (survives renames AND recreates), falling
// back to the normalized name.
export const canonicalFactSubject = ({ scope, value } = {}) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (scope === 'merchant') return canonicalMerchantPattern(raw).slice(0, MAX_SUBJECT_LENGTH);
  if (scope === 'jurisdiction') return raw.toLowerCase().slice(0, 12);
  return normalizeIntelText(raw).slice(0, MAX_SUBJECT_LENGTH);
};

// Deterministic id: the same fact about the same subject upserts into
// the same row, across sessions and rebuilds.
//
// Entity dimension (G−1(c) / build-spec PR-3): a MERCHANT fact's logical
// key includes the minting legal entity (`entityClientId`), so the same
// merchant taught different things by two ventures mints two rows —
// venture A's judgment never retrieves for venture B. Non-merchant
// scopes ignore the entity (client/jurisdiction/firm subjects are
// naturally keyed already), and a merchant call WITHOUT an entity stays
// byte-identical to the pre-PR-3 basis — that identity is what makes
// "legacy detection by absence" reliable.
export const buildFirmFactId = ({ firmId, scope, subject, fact, entityClientId = null } = {}) => {
  const normalizedFact = normalizeIntelText(fact).slice(0, MAX_FACT_LENGTH);
  const basis = [firmId, scope, subject, normalizedFact];
  if (scope === 'merchant' && entityClientId) basis.push(String(entityClientId));
  const hash = crypto
    .createHash('sha256')
    .update(basis.join('|'))
    .digest('hex')
    .slice(0, 16);
  const slug = (value) => normalizeIntelText(value).replace(/\s+/g, '-').slice(0, 40) || 'unknown';
  return ['firm-fact', slug(scope), slug(subject), hash].join('-');
};

const sanitizeFact = (candidate = {}) => {
  const scope = FIRM_FACT_SCOPES.includes(candidate.scope) ? candidate.scope : null;
  if (!scope) return null;
  const subject = canonicalFactSubject({ scope, value: candidate.subject });
  const fact = String(candidate.fact || '').trim().slice(0, MAX_FACT_LENGTH);
  if (!subject || !fact) return null;
  return {
    scope,
    subject,
    fact,
    confidence: FIRM_FACT_CONFIDENCES.includes(candidate.confidence) ? candidate.confidence : 'medium'
  };
};

// The effective asserter list of a provenance object: the
// asserted_by_clients list where present, else the legacy single
// client_id lifted into a one-element list, else empty. Kept in JS and
// mirrored by the ASSERTER_LIST_SQL expression below — the two must
// agree, and the PG lifecycle test exercises both against real rows.
const asserterList = (provenance) => {
  if (Array.isArray(provenance?.asserted_by_clients)) {
    return provenance.asserted_by_clients.filter(Boolean).map(String);
  }
  return provenance?.client_id ? [String(provenance.client_id)] : [];
};

// SQL twin of asserterList() for a firm_facts row aliased as `f` (or the
// upsert's locked target row). Legacy rows (pre-list) lift client_id.
const asserterListSql = (rowExpr) => `coalesce(
  ${rowExpr}->'asserted_by_clients',
  case when ${rowExpr} ? 'client_id'
       then jsonb_build_array(${rowExpr}->'client_id')
       else '[]'::jsonb end
)`;

// Upsert. Provenance attribution is a LIST (G−1(b) / build-spec PR-2):
// every asserting client appends to provenance.asserted_by_clients
// (distinct-append, computed atomically under the upsert's row lock so
// two concurrent re-teaches cannot drop each other), and the legacy
// provenance.client_id is pinned to the FIRST asserter for back-compat
// reads — never last-writer-wins. All other provenance keys keep the
// prior newest-wins merge. The conflict path still never touches
// status/confidence/model: re-asserting a dismissed fact does NOT
// resurrect it — a human said no; only a human (or a future explicit
// re-arm flow) flips it back (the opposite of the client_rules
// on-conflict trap, on purpose).
//
// Audit: genuine inserts emit firm_fact.created (as before); a
// re-assertion that appends a NEW asserting client emits
// firm_fact.reasserted (previously silent — the last-writer-wins bug's
// partner). An idempotent re-assert by an already-listed client stays
// silent so re-distillation doesn't spam the trail. Real-actor
// threading on these rows is G−1(d)'s slice; until then actor_type
// stays 'system' with the asserting client attributed via client_id.
// DMEM-R1 W1 (2026-09-04, doctrine INV-01 / INV-03; audit F-02): `teach:
// 'explicit'` is a PRECONDITION. An active fact is minted only by an explicit
// teaching action — the remember_fact verb (a human's own assertion) or a
// governed candidate promotion (a human's "yes" on a staged candidate). Every
// other producer (the distiller, a correction, a reply) STAGES a `suggested`
// candidate through distillAndStageFirmFactCandidates and never reaches this
// writer. A call without the precondition is refused with a named reason —
// never silently minted, never silently dropped.
export const FIRM_FACT_TEACH_EXPLICIT = 'explicit';

export const saveFirmFact = async ({
  client,
  firmId,
  scope,
  subject,
  fact,
  provenance = {},
  confidence = 'medium',
  model = null,
  teach = null,
  expectedClientId = null,
  actorId = null
} = {}) => {
  const clean = sanitizeFact({ scope, subject, fact, confidence });
  if (!client || !firmId || !clean) return null;
  if (teach !== FIRM_FACT_TEACH_EXPLICIT) {
    return { id: null, ...clean, inserted: false, status: null, refused: 'teach_not_explicit' };
  }
  // G-1: a client-scoped governance action may only mint or reassert a target
  // owned by that client. Nonmerchant fact IDs can share a historical firm slot.
  if (expectedClientId !== null && (provenance?.client_id !== expectedClientId
      || (provenance?.entity_client_id && provenance.entity_client_id !== expectedClientId))) {
    return { id: null, ...clean, inserted: false, status: null, refused: 'fact_owner_conflict' };
  }
  // Entity key for merchant facts (G−1(c) / build-spec PR-3): the minting
  // legal entity is provenance.client_id — every real mint path threads it.
  // A merchant mint WITHOUT an entity is REFUSED (null, the invalid-input
  // convention): minting it firm-keyed would be exactly the accidental
  // firm-wide memory the doctrine forbids, and would make legacy-by-absence
  // detection unreliable. Firm-wide merchant memory is the explicit
  // G4-local promotion verb, never a default.
  const entityClientId = clean.scope === 'merchant'
    ? (provenance?.client_id ? String(provenance.client_id) : null)
    : null;
  if (clean.scope === 'merchant' && !entityClientId) return null;
  const id = buildFirmFactId({ firmId, scope: clean.scope, subject: clean.subject, fact: clean.fact, entityClientId });
  // Restore-after-erasure rail (G1c): content erased via eraseFirmFact may
  // never re-mint through ANY save path — a distiller replay, a backup
  // re-ingest, or a re-teach of the byte-same content all compute the same
  // deterministic id, and the erasure tombstone pins that id's hash. This is
  // deliberately STRONGER than the dismissed tombstone (which blocks silent
  // resurrection but keeps content): erasure is a privacy promise, so the
  // block is on the HASH — no content survives to collide with. Since PR-3
  // the block ALSO matches the tombstone's content_sha256: entity re-keying
  // gives the same content a different id per venture, and an erasure is a
  // FIRM-level promise (the tombstone deliberately outlives clients), so a
  // re-teach of erased content under any entity key stays blocked.
  const contentSha = sha256Hex([clean.scope, clean.subject, clean.fact].join('|'));
  const erasedBlock = await client.query(
    `select id from firm_facts
      where firm_id = $1 and status = 'erased'
        and (provenance->>'erased_id_hash' = $2
             or provenance->>'content_sha256' = $3)
      limit 1`,
    [firmId, erasedIdHash(id), contentSha]
  );
  if (erasedBlock.rows.length) {
    return {
      id: null,
      ...clean,
      inserted: false,
      status: 'erased',
      blocked_by_erasure: true,
      tombstone_id: erasedBlock.rows[0].id
    };
  }
  const mintProvenance = {
    ...(provenance || {}),
    asserted_by_clients: asserterList(provenance),
    // The entity key, self-describing on the row (G−1(c)): retrieval
    // filters merchant facts on it, and its ABSENCE is what marks a
    // legacy firm-keyed merchant row (legacy_firm_scope in the packet).
    ...(entityClientId ? { entity_client_id: entityClientId } : {})
  };
  const priorListSql = asserterListSql('firm_facts.provenance');
  const result = await client.query(
    `with prior as (
       select provenance from firm_facts where id = $1
     )
     insert into firm_facts (id, firm_id, scope, subject, fact, provenance, confidence, model, status)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'active')
     on conflict (id) do update set
       provenance = (firm_facts.provenance || excluded.provenance)
         || jsonb_build_object(
              'client_id',
              coalesce(firm_facts.provenance->'client_id', excluded.provenance->'client_id'),
              'asserted_by_clients',
              case
                when excluded.provenance->>'client_id' is null
                  then ${priorListSql}
                when ${priorListSql} @> jsonb_build_array(excluded.provenance->'client_id')
                  then ${priorListSql}
                else ${priorListSql} || jsonb_build_array(excluded.provenance->'client_id')
              end
            ),
       updated_at = now()
     where firm_facts.firm_id = $2
       and ($9::text is null or (firm_facts.provenance->>'client_id' = $9
            and (firm_facts.provenance->>'entity_client_id' is null or firm_facts.provenance->>'entity_client_id' = $9)))
     returning (xmax = 0) as inserted, status, provenance,
       (select provenance from prior) as prior_provenance`,
    [id, firmId, clean.scope, clean.subject, clean.fact, JSON.stringify(mintProvenance), clean.confidence, model, expectedClientId]
  );
  if (!result.rows.length && expectedClientId !== null) {
    return { id: null, ...clean, inserted: false, status: null, refused: 'fact_owner_conflict' };
  }
  const row = result.rows[0] || {};
  const inserted = Boolean(row.inserted);
  if (inserted) {
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, $5, $6, 'firm_fact.created', 'firm_fact', $3, $4::jsonb)`,
      [
        firmId,
        provenance?.client_id || null,
        id,
        JSON.stringify({ scope: clean.scope, subject: clean.subject, fact: clean.fact, model, provenance: mintProvenance }),
        actorId && actorId !== 'system' ? 'firm' : 'system', actorId
      ]
    );
  } else {
    const assertingClient = provenance?.client_id ? String(provenance.client_id) : null;
    const priorAsserters = asserterList(row.prior_provenance);
    if (assertingClient && !priorAsserters.includes(assertingClient)) {
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, $5, $6, 'firm_fact.reasserted', 'firm_fact', $3, $4::jsonb)`,
        [
          firmId,
          assertingClient,
          id,
          JSON.stringify({
            scope: clean.scope,
            subject: clean.subject,
            fact: clean.fact,
            model,
            provenance: mintProvenance,
            appended_client_id: assertingClient,
            asserted_by_clients: asserterList(row.provenance)
          }),
          actorId && actorId !== 'system' ? 'firm' : 'system', actorId
        ]
      );
    }
  }
  return {
    id,
    ...clean,
    inserted,
    status: row.status || 'active',
    provenance: row.provenance || mintProvenance
  };
};

// The manual "no" — the governance tombstone (status='dismissed', row kept,
// excluded from retrieval by the status='active' readers). G1c closed this
// writer's silent-flip gap: a dismissal that actually flips the row now emits
// `firm_fact.dismissed` IN THE SAME transaction (audit-as-precondition — the
// caller owns the transaction; a failed audit rolls the dismissal back), with
// the acting principal threaded. Every dismiss path — the feed-chat
// forget_fact apply, the settings governance route, the memory-candidates
// dismiss — inherits the receipt from the one writer. An idempotent re-dismiss
// (row already inactive) stays silent, the saveFirmFact re-assert discipline.
export const dismissFirmFact = async ({
  client,
  firmId,
  factId,
  actorId = 'system',
  reason = null,
  source = null,
  expectedClientId = null
} = {}) => {
  if (!client || !firmId || !factId) return false;
  const result = await client.query(
    `update firm_facts set status = 'dismissed', updated_at = now()
      where firm_id = $1 and id = $2 and status = 'active'
        and ($3::text is null or (provenance->>'client_id' = $3
             and (provenance->>'entity_client_id' is null or provenance->>'entity_client_id' = $3)))
      returning id, scope, subject`,
    [firmId, factId, expectedClientId]
  );
  if (!result.rows.length) {
    if (expectedClientId !== null) {
      const inactive = await client.query(
        `select id from firm_facts where firm_id = $1 and id = $2 and status <> 'active'
           and provenance->>'client_id' = $3
           and (provenance->>'entity_client_id' is null or provenance->>'entity_client_id' = $3)`,
        [firmId, factId, expectedClientId]
      );
      if (!inactive.rows.length) {
        const error = new Error('The fact owner changed before candidate dismissal could commit.');
        error.code = 'FIRM_FACT_OWNER_CONFLICT';
        throw error;
      }
    }
    return false;
  }
  const row = result.rows[0];
  await client.query(
    `insert into audit_events (firm_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, $3, 'firm_fact.dismissed', 'firm_fact', $4, $5::jsonb)`,
    [
      firmId,
      actorId === 'system' ? 'system' : 'firm',
      actorId,
      factId,
      JSON.stringify({
        scope: row.scope,
        subject: row.subject,
        reason: reason ? String(reason).slice(0, 300) : null,
        source
      })
    ]
  );
  return true;
};

const sha256Hex = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const erasedIdHash = (factId) => sha256Hex(`firm-fact-erasure|${factId}`);

// "Delete this personal information" — the ERASURE beside the dismiss
// tombstone (G1c / build-spec PR-10; plan §5 G1c records the build-time
// calls). Dismiss KEEPS content as the governance trail of a human "no";
// erase SCRUBS content while keeping a minimal integrity receipt:
//   - the row is scrubbed AND RE-KEYED (status='erased', subject/fact
//     replaced by '[erased]', provenance reduced to hashes + actor +
//     reason) — re-keyed because the deterministic fact id embeds a
//     SUBJECT SLUG that would otherwise survive the scrub;
//   - prior audit_events for the fact get their content-bearing metadata
//     replaced by the content hash and their resource_id re-pointed at the
//     tombstone (the sanctioned erasure exception: actors, actions and
//     timestamps all survive — WHAT is gone, WHO/WHEN is not);
//   - a `firm_fact.erased` integrity receipt records the scrub itself;
//   - saveFirmFact refuses to re-mint the erased content forever via the
//     tombstone's erased_id_hash (restore-after-erasure: a distiller
//     replay or backup re-ingest never resurrects erased content).
// The tombstone carries NO asserter list, so it survives the client-delete
// purge and the orphan sweep ON PURPOSE: the privacy promise is firm-level
// governance and outlives the clean-slate rail. Caller owns the transaction
// (the erase route wraps begin/commit), same contract as dismissFirmFact.
export const eraseFirmFact = async ({
  client,
  firmId,
  factId,
  actorId = 'system',
  reason = null
} = {}) => {
  if (!client || !firmId || !factId) return { erased: false, reason: 'missing_input' };
  const existing = await client.query(
    'select id, scope, subject, fact, status from firm_facts where firm_id = $1 and id = $2 for update',
    [firmId, factId]
  );
  if (!existing.rows.length) return { erased: false, reason: 'not_found' };
  const row = existing.rows[0];
  if (row.status === 'erased') return { erased: false, reason: 'already_erased', tombstone_id: row.id };
  const idHash = erasedIdHash(row.id);
  const contentSha = sha256Hex([row.scope, row.subject, row.fact].join('|'));
  const tombstoneId = `firm-fact-erased-${idHash.slice(0, 16)}`;
  const erasedAt = new Date().toISOString();
  // Scrub the fact's prior audit trail: content-bearing metadata → the hash
  // receipt; resource_id → the tombstone (the original id embeds the subject
  // slug). Action names, actors and timestamps are untouched.
  const scrubbed = await client.query(
    `update audit_events
        set resource_id = $3,
            metadata = jsonb_build_object(
              'content_scrubbed', true,
              'content_sha256', $4::text,
              'scope', $5::text
            )
      where firm_id = $1 and resource_type = 'firm_fact' and resource_id = $2
      returning id`,
    [firmId, row.id, tombstoneId, contentSha, row.scope]
  );
  await client.query(
    `update firm_facts
        set id = $3,
            subject = '[erased]',
            fact = '[erased]',
            confidence = 'low',
            model = null,
            status = 'erased',
            provenance = $4::jsonb,
            updated_at = now()
      where firm_id = $1 and id = $2`,
    [
      firmId,
      row.id,
      tombstoneId,
      JSON.stringify({
        erased_id_hash: idHash,
        content_sha256: contentSha,
        erased_by: actorId,
        erase_reason: reason ? String(reason).slice(0, 300) : null,
        erased_at: erasedAt
      })
    ]
  );
  await client.query(
    `insert into audit_events (firm_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, $3, 'firm_fact.erased', 'firm_fact', $4, $5::jsonb)`,
    [
      firmId,
      actorId === 'system' ? 'system' : 'firm',
      actorId,
      tombstoneId,
      JSON.stringify({
        erased_id_hash: idHash,
        content_sha256: contentSha,
        scope: row.scope,
        audit_rows_scrubbed: scrubbed.rows.length,
        reason: reason ? String(reason).slice(0, 300) : null
      })
    ]
  );
  return { erased: true, tombstone_id: tombstoneId, audit_rows_scrubbed: scrubbed.rows.length };
};

// to_regclass returns null (never throws) for a missing relation, so this is a
// transaction-safe presence check: a pre-migration deploy degrades to a no-op
// instead of aborting the surrounding transaction with 42P01 — load-bearing,
// because retirement runs INSIDE the client-delete transaction.
const firmFactsTablePresent = async (client) => {
  const present = await client.query("select to_regclass('public.firm_facts') as present");
  return Boolean(present.rows[0]?.present);
};

// Purge on client delete, with SOLE-ASSERTER semantics (G−1(b) /
// build-spec PR-2): a fact is hard-deleted ONLY when the deleted client
// was its sole asserting client (including legacy single-client_id
// rows) — ALL statuses, so a prior manual dismiss for that client goes
// too. A fact other ventures also taught SURVIVES: the deleted client
// is stripped from asserted_by_clients and, if it was the first
// asserter, provenance.client_id is re-pointed to the new first — the
// clean-slate rail holds per client without collateral purges. Run
// inside the client-delete transaction so a delete + fresh re-upload is
// a genuine clean slate: a sole-asserter fact's deterministic id is
// freed, so re-teaching mints a new ACTIVE row instead of colliding
// with a dismissed tombstone. (A manual dismiss, where the client still
// exists, KEEPS its row — that path is dismissFirmFact, not this one.)
// The mint history remains in audit_events. Guarded so a pre-migration
// deploy never blocks a client deletion.
export const purgeFirmFactsForDeletedClient = async ({ client, firmId, clientId } = {}) => {
  if (!client || !firmId || !clientId) return { deleted: 0, ids: [], stripped: 0, strippedIds: [] };
  if (!(await firmFactsTablePresent(client))) return { deleted: 0, ids: [], stripped: 0, strippedIds: [] };
  const deleted = await client.query(
    `delete from firm_facts
      where firm_id = $1
        and ${asserterListSql('provenance')} = jsonb_build_array($2::text)
      returning id`,
    [firmId, clientId]
  );
  const stripped = await client.query(
    `update firm_facts
        set provenance = provenance || (
          select jsonb_build_object(
                   'asserted_by_clients', coalesce(jsonb_agg(t.value order by t.ord), '[]'::jsonb),
                   'client_id', (array_agg(t.value order by t.ord))[1]
                 )
            from jsonb_array_elements_text(provenance->'asserted_by_clients')
                 with ordinality as t(value, ord)
           where t.value <> $2
        ),
        updated_at = now()
      where firm_id = $1
        and provenance->'asserted_by_clients' ? $2
        and jsonb_array_length(provenance->'asserted_by_clients') > 1
      returning id`,
    [firmId, clientId]
  );
  return {
    deleted: deleted.rows.length,
    ids: deleted.rows.map((row) => row.id),
    stripped: stripped.rows.length,
    strippedIds: stripped.rows.map((row) => row.id)
  };
};

// Self-healing backstop for facts orphaned BEFORE purge-on-delete shipped (or by
// any path that drops a client without purging), with the same
// SOLE-ASSERTER membership semantics as the purge: a fact is
// hard-deleted — ANY status, so already-dismissed orphans are cleared
// too — only when EVERY asserting client (the asserted_by_clients list,
// or the legacy single client_id) is gone from clients; a fact with a
// mix of live and dead asserters keeps living, with the dead asserters
// stripped and provenance.client_id re-pointed to the first survivor.
// Runs before each fact read so an orphaned fact never reaches the LLM
// context or lingers in the governance panel. Idempotent (the next read
// finds nothing) and best-effort — table-presence guarded so it never
// aborts the read's transaction, and any other error is swallowed so
// the self-heal never breaks the read it rides.
const sweepDeletedClientFacts = async ({ client, firmId } = {}) => {
  if (!client || !firmId) return;
  try {
    if (!(await firmFactsTablePresent(client))) return;
    const listSql = asserterListSql('f.provenance');
    await client.query(
      `delete from firm_facts f
        where f.firm_id = $1
          and ${listSql} <> '[]'::jsonb
          and not exists (
            select 1
              from jsonb_array_elements_text(${listSql}) as v(value)
              join clients c on c.firm_id = f.firm_id and c.id = v.value
          )`,
      [firmId]
    );
    await client.query(
      `update firm_facts f
          set provenance = f.provenance || (
            select jsonb_build_object(
                     'asserted_by_clients', coalesce(jsonb_agg(t.value order by t.ord), '[]'::jsonb),
                     'client_id', (array_agg(t.value order by t.ord))[1]
                   )
              from jsonb_array_elements_text(f.provenance->'asserted_by_clients')
                   with ordinality as t(value, ord)
             where exists (
               select 1 from clients c
                where c.firm_id = f.firm_id and c.id = t.value
             )
          ),
          updated_at = now()
        where f.firm_id = $1
          and f.provenance->'asserted_by_clients' is not null
          and exists (
            select 1 from jsonb_array_elements_text(f.provenance->'asserted_by_clients') as w(value)
             where not exists (
               select 1 from clients c
                where c.firm_id = f.firm_id and c.id = w.value
             )
          )`,
      [firmId]
    );
  } catch {
    // Self-heal is best-effort; never break the read it rides.
  }
};

// Active facts for a set of (scope, subject) pairs, most-specific
// scope first (merchant > client > jurisdiction > firm), bounded so a
// chatty fact base can't blow the token budget.
//
// Entity scoping (G−1(c) / build-spec PR-3): merchant facts retrieve per
// LEGAL ENTITY — a row keyed to an entity (provenance.entity_client_id)
// retrieves only when the caller's `clientId` matches; legacy firm-keyed
// merchant rows (no entity key — all pre-PR-3) keep retrieving for every
// venture and carry `legacy_firm_scope: true` so packets/known_facts show
// the provenance honestly. FAIL-CLOSED default: a caller that passes
// merchant subjects without a `clientId` gets ONLY legacy rows — an
// entity-keyed fact never leaks to an entity-less read. Non-merchant
// scopes are unaffected (naturally keyed already).
//
// FIK-0b coding admission (docs/plan-2026-09-22-fi-jev-decision-knowledge.md
// §2): `codingAdmission: true` is the coding read. A jurisdiction-scope fact is
// firm memory, not a reviewed legal source (migration 030 forbids general
// bookkeeping knowledge here), so no coding engine receives one. A legacy
// firm-keyed merchant fact reaches only an entity on its own asserter list;
// another entity re-teaches it through the entity-keyed path. Both filters run
// in SQL, before the LIMIT, so an excluded row never takes a slot. The
// asserter expression is written out literally (it is asserterListSql's text
// for `provenance`) so the read stays static SQL for the memory-writer scan;
// the PG lifecycle test pins both the list and the lifted legacy client_id.
//
// FIK-0b chat admission (plan §2 / §8.4, unconditional): `chatAdmission: true`
// is the read behind every chat context — the owner portal turn, transaction
// chat, feed chat and firm feed chat — and the transaction-case packet that
// mirrors transaction chat. A jurisdiction-scope row is an unreviewed general
// rule, so it never grounds an answer outside K1's provenance contract. Only
// the jurisdiction exclusion applies; merchant rows keep the G−1(c) behaviour.
// A chat read only proposes (every mutation waits for an explicit apply), so
// this narrows context and needs no flag.
export const CODING_FACT_ADMISSION_FLAG = 'CODING_FACT_ADMISSION';

export const getFirmFactsForSubjects = async ({ client, firmId, subjects = [], limit = MAX_FACTS_PER_CONTEXT, clientId = null, codingAdmission = false, chatAdmission = false } = {}) => {
  const pairs = subjects
    .map(({ scope, value, subject }) => ({
      scope,
      subject: subject || canonicalFactSubject({ scope, value })
    }))
    .filter((pair) => FIRM_FACT_SCOPES.includes(pair.scope) && pair.subject)
    .filter((pair) => !(codingAdmission || chatAdmission) || pair.scope !== 'jurisdiction');
  if (!client || !firmId || !pairs.length) return [];
  // Self-heal first: never feed the LLM context a fact whose minting client
  // is gone (a delete that predated retire-on-delete).
  await sweepDeletedClientFacts({ client, firmId });
  const result = await client.query(
    `select id, scope, subject, fact, confidence, status,
            (scope = 'merchant' and provenance->>'entity_client_id' is null) as legacy_firm_scope
       from firm_facts
      where firm_id = $1 and status = 'active'
        and (scope, subject) in (select unnest($2::text[]), unnest($3::text[]))
        and (scope <> 'merchant'
             or provenance->>'entity_client_id' is null
             or provenance->>'entity_client_id' = $6)
        and (not $7::boolean
             or (scope <> 'jurisdiction'
                 and (scope <> 'merchant'
                      or provenance->>'entity_client_id' is not null
                      or ($6::text is not null and coalesce(provenance->'asserted_by_clients',
                            case when provenance ? 'client_id' then jsonb_build_array(provenance->'client_id')
                                 else '[]'::jsonb end) ? $6::text))))
      order by array_position($4::text[], scope), updated_at desc
      limit $5`,
    [
      firmId,
      pairs.map((pair) => pair.scope),
      pairs.map((pair) => pair.subject),
      FIRM_FACT_SCOPES,
      Math.min(Math.max(Number(limit) || MAX_FACTS_PER_CONTEXT, 1), MAX_FACTS_PER_CONTEXT),
      clientId ? String(clientId) : null,
      Boolean(codingAdmission)
    ]
  ).catch((error) => {
    // Pre-migration deploys: facts degrade to none, never to a dead call.
    if (error?.code === '42P01' || error?.code === '42703') return { rows: [] };
    throw error;
  });
  // The legacy label rides ONLY merchant rows (the honest-provenance
  // packet field); non-merchant rows keep their pre-PR-3 shape.
  return result.rows.map((row) => {
    const { legacy_firm_scope, ...rest } = row;
    return row.scope === 'merchant'
      ? { ...rest, legacy_firm_scope: Boolean(legacy_firm_scope) }
      : rest;
  });
};

// The coding read's subjects for ONE line: its merchant (description and raw
// description), the client (registration number, else name), its
// jurisdiction and the firm. The single-line coder, the correction lane and,
// under CODING_FACT_ADMISSION, every line of a batch round read through this
// one recipe (plan §1.5 / §8.4). The merchant subject leaves out the parsed
// statement's `source_line`: the writers key a merchant fact on the
// counterparty's name, and the raw line's extra text (a reference, a stray
// "Bolt" or "taxi") can re-key the line to another merchant's facts.
export const codingFactSubjects = ({ transaction = {}, clientProfile = {}, firmId } = {}) => [
  { scope: 'merchant', value: `${transaction.description || ''} ${transaction.raw_description || ''}` },
  { scope: 'client', value: clientProfile.uen || clientProfile.companyName || '' },
  { scope: 'jurisdiction', value: clientProfile.jurisdiction || '' },
  { scope: 'firm', value: firmId }
];

// FIK-0b per-line batch read: each line receives exactly the facts the
// single-line coder would read for it, under the same bound and order, so a
// crowded pool can no longer push a line's client or firm facts out of the
// cap, and no line receives another line's merchant facts. Lines with the
// same subjects share one read. A failed read rejects the whole call, so the
// caller holds the round as it does for the pool read.
export const getCodingFactsForTransactions = async ({ client, firmId, clientId, clientProfile = {}, transactions = [], codingAdmission = false } = {}) => {
  const byTransaction = new Map();
  const bySubjects = new Map();
  for (const transaction of transactions) {
    const subjects = codingFactSubjects({ transaction, clientProfile, firmId });
    const key = JSON.stringify(subjects.map((subject) => [subject.scope, canonicalFactSubject(subject)]));
    if (!bySubjects.has(key)) {
      bySubjects.set(key, await getFirmFactsForSubjects({ client, firmId, clientId, codingAdmission, subjects }));
    }
    byTransaction.set(transaction.id, bySubjects.get(key));
  }
  return byTransaction;
};

// Slice H (memory packet, receipt-only): the facts in reach for ONE
// transaction case, resolved the same way the chat surface resolves them
// (api.js transaction-chat route: merchant subject from the line's
// description + raw_description, client subject from UEN falling back to
// the company name, plus firm; jurisdiction is not admitted) — so the receipt's
// facts_available records what the model's known_facts context ACTUALLY
// contained, not a second retrieval recipe drifting from the prompt's.
// Lives here so firmFacts stays the ONE retrieval home. Row-read failures
// degrade to [] subjects → [] facts (the caller's per-source isolation
// decides what that means for the receipt).
export const getFirmFactsForTransactionCase = async ({ client, firmId, clientId, transactionId } = {}) => {
  if (!client || !firmId || !clientId || !transactionId) return null;
  const rows = await client.query(
    `select t.description, t.raw_description,
            c.uen, c.company_name, c.profile
       from transactions t
       join clients c on c.firm_id = t.firm_id and c.id = t.client_id
      where t.firm_id = $1 and t.client_id = $2 and t.id = $3
      limit 1`,
    [firmId, clientId, transactionId]
  );
  if (!rows.rows.length) return null;
  const row = rows.rows[0];
  const profile = row.profile && typeof row.profile === 'object' ? row.profile : {};
  return getFirmFactsForSubjects({
    client,
    firmId,
    // The case's venture is the entity key (G−1(c)): merchant facts
    // resolve per legal entity, legacy rows ride with their honest label.
    clientId,
    // Mirrors the transaction-chat read, so the receipt matches its context.
    chatAdmission: true,
    subjects: [
      { scope: 'merchant', value: `${row.description || ''} ${row.raw_description || ''}` },
      { scope: 'client', value: row.uen || row.company_name || '' },
      { scope: 'jurisdiction', value: profile.jurisdiction || '' },
      { scope: 'firm', value: firmId }
    ]
  });
};

// 'erased' — the scrub-and-rekey privacy tombstone (eraseFirmFact above):
// content gone, integrity receipt kept, never retrieved (readers filter
// status='active'), listed in governance as the record that an erasure ran.
export const FIRM_FACT_STATUSES = ['active', 'dismissed', 'erased'];

const MAX_FACTS_GOVERNANCE = 200;

// Governance read for the Facts panel: the firm's whole memory — both active
// and dismissed facts, carrying provenance + the distiller's model id +
// timestamps — bounded so a chatty fact base can't blow the response. An
// optional status filter narrows to one lifecycle; an UNKNOWN status returns
// nothing rather than silently widening to everything. Soft-fails to [] on
// pre-migration deploys, the same posture as getFirmFactsForSubjects.
export const listFirmFacts = async ({ client, firmId, status = null, limit = MAX_FACTS_GOVERNANCE } = {}) => {
  if (!client || !firmId) return [];
  if (status != null && !FIRM_FACT_STATUSES.includes(status)) return [];
  // Self-heal first: a fact whose minting client is gone shows as retired in
  // the governance panel, not lingering active.
  await sweepDeletedClientFacts({ client, firmId });
  const bounded = Math.min(Math.max(Number(limit) || MAX_FACTS_GOVERNANCE, 1), MAX_FACTS_GOVERNANCE);
  const conditions = ['firm_id = $1'];
  const params = [firmId];
  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  params.push(bounded);
  const result = await client.query(
    `select id, scope, subject, fact, confidence, status, provenance, model, created_at, updated_at
       from firm_facts
      where ${conditions.join(' and ')}
      order by status asc, updated_at desc
      limit $${params.length}`,
    params
  ).catch((error) => {
    // Pre-migration deploys: the panel shows an empty memory, never a dead call.
    if (error?.code === '42P01' || error?.code === '42703') return { rows: [] };
    throw error;
  });
  return result.rows;
};

// ─── The distiller ───────────────────────────────────────────────────────

// The gate is the remember-gate lesson generalized: most correction
// events imply NO durable fact. The distiller runs on the strong tier
// because deciding what the firm should remember forever is a
// judgment call, not bulk filtering.
// 2026-11-10 (owner's decision: Claude only): provider-agnostic — Anthropic
// (claude-opus-5-5) when its key is present, OpenAI (this default) only when
// no Anthropic key is configured; OPENAI_MODEL may pin either family's id.
// Effort `medium`: one event in, usually zero facts out, and every fact is
// refused or staged by deterministic checks after the call (sanitizeFact,
// the jurisdiction refusal, erasure, conflict detection) — never minted.
const DEFAULT_MODEL = 'gpt-5.4';
export const __DEFAULT_MODEL = DEFAULT_MODEL;
const LANE_PROVIDERS = getLane('memory_extraction').providers;
const ANTHROPIC_EFFORT = 'medium';

let dotEnvCache = null;
const readDotEnv = () => {
  if (dotEnvCache) return dotEnvCache;
  const vars = {};
  try {
    const envPath = resolvePath(process.cwd(), '.env');
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const match = line.match(/^(\w+)=(.*)$/);
        if (match) vars[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
      }
    }
  } catch {
    // best-effort
  }
  dotEnvCache = vars;
  return vars;
};

const resolveDistiller = () => resolveTextLaneProvider({
  providers: LANE_PROVIDERS, openAiDefaultModel: DEFAULT_MODEL, dotEnv: readDotEnv()
});

// FIK-0b follow-up (docs/plan-2026-09-22-fi-jev-decision-knowledge.md §8.4): the
// distiller may never propose a jurisdiction-scope fact. Such a fact applies to
// every client in the jurisdiction, so it is general tax/accounting knowledge by
// construction (factIsJurisdictionKnowledge) — it belongs in K1 or the reviewed
// country pack, never in firm memory. The schema offers only the local scopes;
// the stage below refuses one anyway, because the schema is a request, not a
// guarantee (and distillFn is injectable).
const DISTILLER_FACT_SCOPES = FIRM_FACT_SCOPES.filter((scope) => scope !== 'jurisdiction');

const DISTILLER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['facts'],
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['scope', 'subject', 'fact', 'confidence'],
        properties: {
          scope: { type: 'string', enum: DISTILLER_FACT_SCOPES },
          subject: { type: 'string' },
          fact: { type: 'string' },
          confidence: { type: 'string', enum: FIRM_FACT_CONFIDENCES }
        }
      }
    }
  }
};

const DISTILLER_INSTRUCTIONS = `You distill durable LOCAL knowledge for a bookkeeping firm from a single correction event. The event shows what was suggested for a bank line and what actually settled it — a human recode or the client's own reply.

Return facts ONLY when the event reveals something durable and LOCAL — about this specific merchant/counterparty or this client's business — that would change how a competent bookkeeper judges FUTURE lines. Most events imply NO facts: return an empty array by default. A one-off stays a one-off; an amount, a date, or a single transaction's classification is not a fact.

NEVER return general bookkeeping knowledge ("capital injections are equity", "fuel is a vehicle expense") — the models already know it; storing it locally only goes stale.

NEVER return a rule about a country or jurisdiction (a VAT/GST rate or exemption, a deductibility rule, a filing practice, "rent is VAT-exempt in Finland"). Such a rule holds for every business there, so it is general tax or accounting knowledge, not a fact about this business — it is maintained in reviewed, sourced references, never learned from one event.

Each fact is ONE plain-language sentence that names the subject explicitly and stands alone without this event's context. scope=merchant facts are about the counterparty (subject: the merchant/counterparty name); scope=client about the client's own business (subject: the client's registration number, or name if none); scope=firm about how this firm itself works. There is no jurisdiction scope. Confidence reflects how directly the event states the fact — the client's own words rate high; an inference from a recode rates medium at best.`;

// Distill an event into zero-or-more sanitized facts. Pure failure
// posture: any error returns { facts: [], model } — distillation must
// never break the flow it rides (reply recode, drawer save). A provider
// failure also rides back typed (`provider_failure`: no credit, bad key,
// rate limit, refusal, output limit) for the caller's receipt. Both
// providers go through the shared envelope; `model` is the id the RESPONSE
// named (the configured id only when no response arrived).
export const distillFirmFactsFromEvent = async ({ event = {}, fetchFn = fetch } = {}) => {
  const resolved = resolveDistiller();
  if (!resolved.ok) return { facts: [], model: 'not_configured' };
  const input = JSON.stringify(event);
  const execution = { root: { type: 'firm_fact_event', id: String(event?.transaction_id || event?.id || event?.kind || 'event') } };
  const request = resolved.provider === 'anthropic'
    ? anthropicStructuredRequest({
      apiKey: resolved.apiKey, model: resolved.model, system: DISTILLER_INSTRUCTIONS, user: input,
      schema: DISTILLER_SCHEMA, effort: ANTHROPIC_EFFORT, maxTokens: 16000, cacheSystem: true,
      execution, fetchImpl: fetchFn
    })
    : openAiStructuredRequest({
      apiKey: resolved.apiKey, model: resolved.model, instructions: DISTILLER_INSTRUCTIONS, input,
      schemaName: 'firm_fact_distillation', schema: DISTILLER_SCHEMA, store: false, execution, fetchImpl: fetchFn
    });
  try {
    const { result } = await llmCall(request);
    const parsed = result.parsed;
    const facts = (Array.isArray(parsed?.facts) ? parsed.facts : [])
      .map((candidate) => sanitizeFact(candidate))
      .filter(Boolean)
      .slice(0, MAX_FACTS_PER_EVENT);
    return { facts, model: result.model || resolved.model };
  } catch (error) {
    const typed = typedLlmCallFailure(resolved.provider, error);
    return {
      facts: [],
      model: error?.telemetry?.model_source === 'response' ? error.telemetry.model : resolved.model,
      ...(typed ? { provider_failure: typed.receipt() } : {})
    };
  }
};

export const __DISTILLER_INSTRUCTIONS = DISTILLER_INSTRUCTIONS;

// The erasure block, shared with saveFirmFact: content erased through
// eraseFirmFact may never re-enter the plane as a CANDIDATE either — a staged
// candidate is a content-bearing copy (doctrine §4.3 / INV-16).
const blockedByErasure = async ({ client, firmId, clean, entityClientId }) => {
  const id = buildFirmFactId({ firmId, scope: clean.scope, subject: clean.subject, fact: clean.fact, entityClientId });
  const contentSha = sha256Hex([clean.scope, clean.subject, clean.fact].join('|'));
  const erasedBlock = await client.query(
    `select id from firm_facts
      where firm_id = $1 and status = 'erased'
        and (provenance->>'erased_id_hash' = $2
             or provenance->>'content_sha256' = $3)
      limit 1`,
    [firmId, erasedIdHash(id), contentSha]
  );
  return erasedBlock.rows.length > 0;
};

// FIK-0b follow-up: a jurisdiction-scope proposal is dropped, never staged, and
// the drop is receipted — on the return (`out.refused`) and as an audit row
// that names the scope and subject but not the rule text (it never became
// memory, so no content-bearing copy is kept). The receipt is best-effort: a
// failed audit insert must not break the flow the distiller rides, and the
// refusal itself does not depend on it.
const receiptJurisdictionRefusal = async ({ client, firmId, clientId, clean, source, model, provenance }) => {
  try {
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', 'firm_fact_distiller', 'firm_fact.distill_refused', 'firm_fact', null, $3::jsonb)`,
      [firmId, clientId, JSON.stringify({
        reason: 'jurisdiction_knowledge',
        scope: clean.scope,
        subject: clean.subject,
        content_sha256: sha256Hex([clean.scope, clean.subject, clean.fact].join('|')),
        source: source || null,
        model: model || null,
        transaction_id: provenance?.transaction_id || null,
        evidence_request_id: provenance?.evidence_request_id || null
      })]
    );
  } catch {
    // best-effort receipt; the refusal already happened
  }
};

// DMEM-R1 W1 — the distiller's ONE entry point, a candidate STAGE (audit F-02 /
// F-03; doctrine §2.2, INV-01 / INV-02 / INV-03). It replaced
// distillAndSaveFirmFacts, which minted ACTIVE firm_facts from a correction or
// reply and let a post-commit observer stage the candidate already `promoted`.
// Now: resolve the client's MEMORY_CANDIDATES posture first (fail closed — off
// means the strong-model call is not even made); run the distiller; stage one
// `suggested` candidate per fact (`conflicted` when a standing active fact on
// the same subject disagrees — a governance signal, still not a belief). No
// firm_facts write. Soft-fail throughout. Returns the staged candidates
// ({ id, inserted, status, version, scope, subject, fact, confidence }) with
// `posture` and `model` attached for the caller's receipt.
export const distillAndStageFirmFactCandidates = async ({
  client,
  firmId,
  clientId = null,
  event = {},
  provenance = {},
  source = null,
  distillFn = distillFirmFactsFromEvent,
  candidatesModule = null
} = {}) => {
  const out = [];
  out.posture = 'off';
  out.model = null;
  out.refused = [];
  const entityClientId = clientId || provenance?.client_id || null;
  if (!client || !firmId || !entityClientId) return out;
  try {
    // Lazy: memoryCandidates.js imports this module (promote → saveFirmFact), so
    // the staging side is reached without a static cycle.
    const candidates = candidatesModule || await import('./memoryCandidates.js');
    const { posture } = await candidates.resolveMemoryCandidatesPosture({ client, firmId, clientId: entityClientId });
    out.posture = posture;
    if (!candidates.memoryCandidatesProducerMayStage(posture)) return out;
    const { facts, model } = await distillFn({ event });
    out.model = model || null;
    const stageSource = source || provenance?.source || 'distiller';
    for (const fact of facts) {
      const clean = sanitizeFact(fact);
      if (!clean) continue;
      if (factIsJurisdictionKnowledge({ fact_scope: clean.scope })) {
        await receiptJurisdictionRefusal({ client, firmId, clientId: entityClientId, clean, source: stageSource, model, provenance });
        out.refused.push({ scope: clean.scope, subject: clean.subject, reason: 'jurisdiction_knowledge' });
        continue;
      }
      const factEntity = clean.scope === 'merchant' ? String(entityClientId) : null;
      if (await blockedByErasure({ client, firmId, clean, entityClientId: factEntity })) continue;
      const conflicted = await candidates.detectActiveFactConflict({
        client, firmId, clientId: entityClientId, scope: clean.scope, subject: clean.subject, fact: clean.fact
      });
      const staged = await candidates.stageMemoryCandidate({
        client, firmId, clientId: entityClientId, candidateType: 'fact',
        status: conflicted ? 'conflicted' : 'suggested',
        source: stageSource,
        scope: clean.scope, subject: clean.subject, fact: clean.fact, confidence: clean.confidence,
        provenance: { ...(provenance || {}), client_id: entityClientId, distilled: true },
        model: model || null
      });
      if (staged?.id) out.push({ ...staged, ...clean });
    }
    return out;
  } catch {
    return out;
  }
};
