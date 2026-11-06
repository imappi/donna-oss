// server/donna/db/memory.js — plane M — the merchant-rule mint (`client_rule.merchant_rule_saved`) and its cascade, the client-rule status writer, the review-recode distillation input and the confirmation-bump helpers.
//
// RT-17 (2026-09-02): extracted from server/donna/firmDb.js as a pure move. Every public
// symbol keeps its old import path through firmDb.js, which re-exports it; helpers another
// plane needs are exported here and NOT re-exported by firmDb.js.
//
// DMEM-R1 W1 (2026-09-04, docs/design-donna-memory-remediation.md INV-01 / INV-06 /
// INV-07 / INV-26; audit F-01 / F-05 / F-09 / N-03) — the mint containment, shipped
// for good (it REMOVES write paths):
//   - a MODEL-origin mint (source 'ai_batch' — the batch coder — or 'ai_applied' —
//     an applied AI suggestion's learn) lands status 'proposed', created_by 'ai',
//     with NO cascade. A model may propose a rule; activation is a separate
//     governed transition (updateClientRuleStatusInDb proposed → active, receipted).
//     On conflict with an existing row it never changes that row's status or
//     created_by — a proposal cannot re-activate a retired rule or take over a
//     human one.
//   - a HUMAN mint (every other source) activates AND, in the same transaction,
//     retires every OTHER active rule on the same (client, pattern) with a
//     `client_rule.retired` receipt naming the successor — one logical slot, one
//     current projection, so the deterministic consumer can never let input
//     order pick the stale mapping (N-03).
//   - the cascade is bounded to lines dated on/after the rule's effective start:
//     the caller's explicit `effective_from` (ISO day) or, absent, the mint day.
//     History the firm already coded stays as the firm coded it (the F-09
//     stopgap; W2 owns the interval columns). The receipt records the bound.
//   - loadActiveClientRulesForAuthority is the ONE read boundary for the
//     deterministic consumers: with MEMORY_LEGACY_AI_RULE_DEMOTION acting for the
//     client, legacy created_by='ai' ACTIVE rules are demoted to suggestion-only
//     (they reach the coder as labelled hints, never the matcher).

import { canonicalMerchantPattern, clusterContactLabel, normalizeIntelText } from '../transactionIntel.js';
import { enrichCodingWithXeroAccount } from '../xeroAccountMatcher.js';
import { toIsoDay } from '../dates.js';
import { MEMORY_LEGACY_AI_RULE_DEMOTION_FLAG, clientFlagActs, readClientConfigSnapshot } from '../clientConfig.js';

import { withFirmDbClient } from './pool.js';
import { shortHash, slugifyRulePart } from './shared.js';
import { DEFAULT_FIRM_ID, getClientJurisdictionForEnrichment } from './clients.js';
import { amountForPayload, directionForPayload, rowToTransactionPayload } from './transactions.js';
import { isIntercompanyAccount } from './coding.js';
import { getXeroAccountsForClient } from './xero.js';
import { getFirmSnapshotFromDb } from './snapshot.js';

// Client-rule id derivation. Shared with PR 4's document-line "make a
// rule" path so a learn-from-transaction and a learn-from-document for
// the same (client, vendor pattern, account_code) collapse onto the
// same row via `on conflict (id) do update`. Keep this stable — changing
// the shape orphans every previously-learned rule.
export const buildClientRuleId = ({ clientId, normalizedPattern, accountCode } = {}) =>
  [
    'client-rule',
    slugifyRulePart(clientId),
    slugifyRulePart(normalizedPattern),
    slugifyRulePart(accountCode),
    shortHash(`${clientId}|${normalizedPattern}|${accountCode}`)
  ].join('-').slice(0, 140);

const merchantNameFromTransactionPayload = (payload = {}) => {
  const contact = String(payload.contact || '').trim();
  const usableContact = contact && !/^(customer|client|unknown|merchant)$/i.test(contact) ? contact : '';
  const candidate = usableContact || String(payload.description || '').split(/[|,]/)[0] || payload.merchant_pattern || '';
  return String(candidate).trim().slice(0, 120);
};

const autoExplainLimitForRule = (payload = {}) => {
  const explicit = Number(payload.merchant_rule_auto_explain_limit);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const account = normalizeIntelText(payload.account_name || payload.account_label || payload.xero_account_name || payload.merchant_rule_account || payload.account_code || payload.proposed_account || '');
  const suggestion = payload.ai_suggestion || {};
  const suggestionSaysNoEvidence = suggestion.evidence_required === false;
  if (/meal|entertainment|travel|transport/.test(account)) return suggestionSaysNoEvidence ? 100 : 25;
  if (/software|subscription|bank fees|fees/.test(account)) return suggestionSaysNoEvidence ? 250 : 25;
  return suggestionSaysNoEvidence ? 100 : 25;
};

// Model-origin sources: the batch coder's mint and an applied AI suggestion's
// learn. Anything else is a human teaching (the drawer, the review accept, the
// chat verbs) and activates.
export const MODEL_ORIGIN_RULE_SOURCES = Object.freeze(['ai_batch', 'ai_applied']);
export const isModelOriginRuleSource = (source) => MODEL_ORIGIN_RULE_SOURCES.includes(String(source || ''));

// A calendar day through the ONE normalizer (dates.js toIsoDay — local getters
// for a Date, the leading day for an ISO string; RT-15's date discipline), then
// validated: anything that is not a YYYY-MM-DD day is refused (null).
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isoDay = (value) => {
  if (value == null || value === '') return null;
  const day = toIsoDay(value);
  if (!ISO_DAY_RE.test(day)) return null;
  return Number.isNaN(new Date(`${day}T00:00:00Z`).getTime()) ? null : day;
};

// The cascade bound (INV-07: business-effective time is not record time). The
// caller's explicit `effective_from` wins; absent, the mint DAY (the host's
// calendar day, the same convention every date column reads back under) —
// never the whole history. `bound` names which one applied so the receipt can
// say so.
export const resolveRuleEffectiveFrom = ({ payload = {}, now = new Date() } = {}) => {
  const explicit = isoDay(payload?.effective_from);
  if (explicit) return { effectiveFrom: explicit, bound: 'explicit' };
  return { effectiveFrom: isoDay(now) || isoDay(new Date()), bound: 'mint_date' };
};

const applyMerchantRuleCascade = async ({
  client,
  firmId,
  clientId,
  ruleId,
  normalizedPattern,
  accountCode,
  rulePayload,
  autoExplainLimit,
  effectiveFrom = null
}) => {
  if (!clientId || !normalizedPattern || !accountCode) return { matched: 0, closed: 0, effective_from: effectiveFrom };

  const xeroAccounts = await getXeroAccountsForClient({ client, firmId, clientId });
  const jurisdiction = await getClientJurisdictionForEnrichment({ client, firmId, clientId });
  // W1 (F-09 stopgap): only lines dated on/after the rule's effective start are
  // candidates. A line with no date cannot be placed on the business axis and
  // is left alone (a null applicability field is not a wildcard).
  const transactionsResult = await client.query(
    `select * from transactions
      where firm_id = $1 and client_id = $2
        and transaction_date is not null
        and transaction_date >= $3::date`,
    [firmId, clientId, effectiveFrom]
  );
  const matching = transactionsResult.rows
    .map(rowToTransactionPayload)
    .filter((transaction) => {
      const txSource = `${transaction.description || ''} ${transaction.raw_description || ''} ${transaction.contact || ''} ${transaction.source_line || ''}`;
      const txText = normalizeIntelText(txSource);
      const txPattern = canonicalMerchantPattern(txSource);
      return txPattern === normalizedPattern || txText.includes(normalizedPattern);
    });

  let closed = 0;
  for (const transaction of matching) {
    const intercompanyRule = isIntercompanyAccount(accountCode);
    const autoExplained = intercompanyRule || (directionForPayload(transaction) === 'money_out' && amountForPayload(transaction) <= autoExplainLimit);
    const supportNote = autoExplained
      ? rulePayload.support_note || `Matched client rule: ${rulePayload.label}.`
      : transaction.support_note || '';
    const payloadPatch = enrichCodingWithXeroAccount({
      coding: {
        proposed_account: accountCode,
        account_code: accountCode,
        contact: rulePayload.contact || transaction.contact || rulePayload.merchant_name || '',
        tax_treatment: rulePayload.tax_treatment || transaction.tax_treatment || '',
        matched_client_rule_id: ruleId,
        matched_client_rule_label: rulePayload.label,
        support_status: autoExplained ? 'rule_explained' : transaction.support_status || '',
        support_note: supportNote || undefined,
        reconciliation_status: autoExplained ? 'explained' : transaction.reconciliation_status || undefined
      },
      transaction,
      xeroAccounts,
      jurisdiction
    });
    await client.query(
      `update transactions
       set account_code = $3,
           reconciliation_status = case when $4 then 'explained' else reconciliation_status end,
           status = case when $4 and status = 'needs_review' then 'ready' else status end,
           payload = payload || $5::jsonb,
           updated_at = now()
       where firm_id = $1 and id = $2`,
      [firmId, transaction.id, payloadPatch.account_code || accountCode, autoExplained, JSON.stringify(payloadPatch)]
    );
    if (autoExplained) {
      const closeResult = await client.query(
        `update transaction_review_queue
         set status = 'resolved',
             payload = payload || $4::jsonb,
             updated_at = now()
         where firm_id = $1
           and client_id = $2
           and status = 'open'
           and (
             item_id = $3
             or payload->>'transaction_id' = $3
           )`,
        [
          firmId,
          clientId,
          transaction.id,
          JSON.stringify({
            closed_by: 'client_rule',
            matched_client_rule_id: ruleId,
            matched_client_rule_label: rulePayload.label
          })
        ]
      );
      closed += closeResult.rowCount || 0;
    } else {
      await client.query(
        `update transaction_review_queue
         set payload = payload || $4::jsonb,
             updated_at = now()
         where firm_id = $1
           and client_id = $2
           and status = 'open'
           and (
             item_id = $3
             or payload->>'transaction_id' = $3
           )`,
        [
          firmId,
          clientId,
          transaction.id,
          JSON.stringify({
            matched_client_rule_id: ruleId,
            matched_client_rule_label: rulePayload.label,
            proposed_account: accountCode
          })
        ]
      );
    }
  }

  return { matched: matching.length, closed, effective_from: effectiveFrom };
};

// W1 (F-05 / N-03, INV-06): a human mint supersedes every OTHER active rule on
// the same (client, pattern) in the same transaction, each retirement receipted
// with the successor. Returns the retired ids. Runs BEFORE the upsert so the
// slot holds exactly one current rule when the mint commits.
const retireSupersededRulesOnPattern = async ({ client, firmId, clientId, normalizedPattern, successorRuleId, actorId, source }) => {
  const retired = await client.query(
    `update client_rules
        set status = 'retired',
            payload = payload || $5::jsonb,
            updated_at = now()
      where firm_id = $1 and client_id = $2 and pattern_text = $3 and status = 'active' and id <> $4
      returning id, account_code, created_by`,
    [firmId, clientId, normalizedPattern, successorRuleId, JSON.stringify({ retired_reason: 'superseded_by_correction', superseded_by_rule_id: successorRuleId })]
  );
  for (const row of retired.rows) {
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, 'firm', $3, 'client_rule.retired', 'client_rule', $4, $5::jsonb)`,
      [
        firmId,
        clientId,
        actorId || 'system',
        row.id,
        JSON.stringify({
          rule_id: row.id,
          prior_status: 'active',
          next_status: 'retired',
          decided_by: actorId || source,
          retired_reason: 'superseded_by_correction',
          superseded_by_rule_id: successorRuleId,
          merchant_pattern: normalizedPattern,
          prior_account_code: row.account_code,
          prior_created_by: row.created_by
        })
      ]
    );
  }
  return retired.rows.map((row) => row.id);
};

export const saveMerchantRuleForPayload = async ({
  client,
  firmId,
  clientId,
  transactionId,
  payload,
  supportNote = '',
  source = 'transaction_drawer',
  actorId = null
}) => {
  if (!clientId || !payload) return null;
  const merchantPattern = merchantNameFromTransactionPayload(payload);
  const normalizedPattern = canonicalMerchantPattern(`${payload.merchant_pattern || ''} ${merchantPattern} ${payload.description || ''} ${payload.raw_description || ''} ${payload.source_line || ''}`);
  const accountCode = payload.merchant_rule_account || payload.account_code || payload.proposed_account || null;
  if (!normalizedPattern || !accountCode) return null;

  const autoExplainLimit = autoExplainLimitForRule(payload);
  const ruleId = buildClientRuleId({ clientId, normalizedPattern, accountCode });
  const rulePayload = {
    source,
    source_transaction_id: transactionId,
    merchant_name: merchantPattern,
    merchant_pattern: normalizedPattern,
    account_code: accountCode,
    proposed_account: accountCode,
    account_name: payload.account_name || null,
    account_label: payload.account_label || null,
    xero_account_id: payload.xero_account_id || null,
    xero_account_code: payload.xero_account_code || null,
    xero_account_name: payload.xero_account_name || payload.account_name || null,
    xero_tax_type: payload.xero_tax_type || null,
    // D2: for a KNOWN multi-payee cluster pattern (taxis, ride-hail), the rule's
    // canonical contact is a generic cluster label ("Taxi") so it never stamps
    // the whole cluster with the first member's specific payee. A single-supplier
    // pattern returns '' from clusterContactLabel and keeps its specific name.
    contact: clusterContactLabel(normalizedPattern) || payload.contact || merchantPattern,
    tax_treatment: payload.tax_treatment || null,
    support_note: supportNote || payload.support_note || null,
    auto_explain_limit: autoExplainLimit,
    confidence: isModelOriginRuleSource(source) ? 0.86 : 0.92,
    label: `${merchantPattern} -> ${accountCode}`
  };
  const modelOrigin = isModelOriginRuleSource(source);
  const { effectiveFrom, bound: effectiveBound } = resolveRuleEffectiveFrom({ payload });
  rulePayload.effective_from = effectiveFrom;
  rulePayload.effective_from_basis = effectiveBound;

  // A human teaching supersedes the slot's other current rules first (F-05).
  const retiredRuleIds = modelOrigin
    ? []
    : await retireSupersededRulesOnPattern({ client, firmId, clientId, normalizedPattern, successorRuleId: ruleId, actorId, source });

  // A model-origin mint INSERTS a proposal; on conflict it refreshes the payload
  // and nothing else (status and created_by are the existing row's — a proposal
  // re-activates nothing and takes over nothing). A human mint activates.
  const upsert = modelOrigin
    ? await client.query(
      `insert into client_rules (
         id, firm_id, client_id, rule_type, pattern_text, category_override,
         account_code, reconciliation_behavior, notes, created_by, status, payload
       )
       values ($1, $2, $3, 'merchant_category', $4, null, $5, 'low_materiality_auto_explain', $6, 'ai', 'proposed', $7::jsonb)
       on conflict (id) do update set
         payload = client_rules.payload || excluded.payload,
         updated_at = now()
       returning (xmax = 0) as inserted, status, created_by`,
      [
        ruleId,
        firmId,
        clientId,
        normalizedPattern,
        accountCode,
        supportNote || `Use ${accountCode} for ${merchantPattern}.`,
        JSON.stringify(rulePayload)
      ]
    )
    : await client.query(
      `insert into client_rules (
         id, firm_id, client_id, rule_type, pattern_text, category_override,
         account_code, reconciliation_behavior, notes, created_by, status, payload
       )
       values ($1, $2, $3, 'merchant_category', $4, null, $5, 'low_materiality_auto_explain', $6, 'human', 'active', $7::jsonb)
       on conflict (id) do update set
         pattern_text = excluded.pattern_text,
         account_code = excluded.account_code,
         reconciliation_behavior = excluded.reconciliation_behavior,
         notes = excluded.notes,
         created_by = excluded.created_by,
         status = 'active',
         payload = client_rules.payload || excluded.payload,
         updated_at = now()
       returning (xmax = 0) as inserted, status, created_by`,
      [
        ruleId,
        firmId,
        clientId,
        normalizedPattern,
        accountCode,
        supportNote || `Use ${accountCode} for ${merchantPattern}.`,
        JSON.stringify(rulePayload)
      ]
    );
  const status = upsert.rows[0]?.status || (modelOrigin ? 'proposed' : 'active');
  // Only an ACTIVE rule may touch the book. A proposal cascades nothing (INV-01);
  // a model re-mint that landed on an existing active human rule cascades nothing
  // either — that rule's own activation already did.
  const cascadeResult = status === 'active' && !modelOrigin
    ? await applyMerchantRuleCascade({
      client,
      firmId,
      clientId,
      ruleId,
      normalizedPattern,
      accountCode,
      rulePayload,
      autoExplainLimit,
      effectiveFrom
    })
    : null;
  // The mint's own audit row, on the SAME client/transaction as the rule write —
  // audit-as-precondition (no record, no execution): if this insert fails, the
  // caller's transaction rolls the mint back with it. Closes the CLAUDE.md
  // "merchant-rule mint emits NO audit row" gap at the writer, so every call
  // site (both chat verbs, the drawer/review accept, the auto-apply cascade)
  // is covered — not just the chat routes.
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'firm', $3, 'client_rule.merchant_rule_saved', 'client_rule', $4, $5::jsonb)`,
    [
      firmId,
      clientId,
      actorId || 'system',
      ruleId,
      JSON.stringify({
        source,
        merchant_pattern: normalizedPattern,
        account_code: accountCode,
        source_transaction_id: transactionId || null,
        inserted: Boolean(upsert.rows[0]?.inserted),
        status,
        created_by: upsert.rows[0]?.created_by || (modelOrigin ? 'ai' : 'human'),
        effective_from: effectiveFrom,
        effective_from_basis: effectiveBound,
        cascade_matched: cascadeResult?.matched ?? null,
        retired_rule_ids: retiredRuleIds
      })
    ]
  );
  // `inserted` (G2 PR-14): did THIS call bring the rule into being, or did the
  // deterministic-id upsert land on one that already existed? The reverse leg needs
  // the answer — retiring a rule this apply merely re-taught would destroy memory the
  // reversed action never created. Already computed for the audit row above; now
  // returned so the capture can record it honestly.
  return {
    ruleId,
    rulePayload,
    cascadeResult,
    inserted: Boolean(upsert.rows[0]?.inserted),
    status,
    effectiveFrom,
    retiredRuleIds
  };
};

// W1 (S09/L2, audit F-01): the ONE read boundary for the deterministic rule
// consumers (the intel refresh, the single and batch coders). Returns the
// client's ACTIVE rules split into `authoritative` (what clientRuleMatchFor may
// apply) and `demoted` — the legacy created_by='ai' active rows when
// MEMORY_LEGACY_AI_RULE_DEMOTION acts for the client. A demoted rule reaches the
// coder as a labelled SUGGESTION (`reconciliation_behavior: 'suggestion_only'`,
// the note says it is an ungoverned model-minted mapping), never the matcher:
// a rule match proposes, it no longer auto-explains. Born on the plane
// (envFallback false): without a row the split is empty and every caller is
// byte-identical to before.
export const loadActiveClientRulesForAuthority = async ({ client, firmId, clientId, limit = null, env = process.env } = {}) => {
  if (!client || !firmId || !clientId) return { rules: [], authoritative: [], demoted: [], demotionActs: false };
  const limitSql = Number.isFinite(Number(limit)) && Number(limit) > 0 ? ` limit ${Math.floor(Number(limit))}` : '';
  const result = await client.query(
    `select * from client_rules where firm_id = $1 and client_id = $2 and status = $3 order by updated_at desc${limitSql}`,
    [firmId, clientId, 'active']
  );
  const rules = result.rows || [];
  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId }).catch(() => ({}));
  const demotionActs = clientFlagActs({ flagKey: MEMORY_LEGACY_AI_RULE_DEMOTION_FLAG, snapshot, envFallback: () => false, env });
  if (!demotionActs) return { rules, authoritative: rules, demoted: [], demotionActs };
  const authoritative = [];
  const demoted = [];
  for (const rule of rules) {
    if (String(rule.created_by || '') === 'ai') demoted.push(rule);
    else authoritative.push(rule);
  }
  return { rules, authoritative, demoted, demotionActs };
};

// The labelled hint shape a demoted rule takes in the coder's prompt packet:
// the same fields transactionLlm renders for a rule, with the authority class
// stated in the row itself (doctrine §2.5 — labels survive into the packet).
export const demotedRuleAsSuggestion = (rule = {}) => ({
  ...rule,
  reconciliation_behavior: 'suggestion_only',
  notes: `Legacy model-proposed mapping (created by the model, not yet confirmed by a human) — a hint, not a rule: ${rule.notes || rule.payload?.support_note || ''}`.trim()
});

// Reconciliation PR 5 — firm-side decision endpoint for proposed
// learned rules. Base transitions: `proposed → active` (Commit) and
// `proposed → retired` (Discard). Calling this with any other prior
// status returns 409 so the FE can surface a clear error.
//
// G1c (godmode build-spec PR-10) — the "later PR" the original comment
// named: `active → retired` is now a transition of this SAME writer
// (INV-1 — one home for rule-status transitions, never a second path),
// behind the explicit `allowActiveRetire` opt-in so every existing
// caller is byte-identical. It is the feed-chat `retire_rule` verb's
// route: an operator retiring a LIVE rule so it stops matching future
// lines. The retire leg emits its own distinct audit action
// (`client_rule.retired`, actor threaded) — the proposed-decision leg
// keeps `client_rule.firm_decided` unchanged.
//
// `dbClient` optional override is for tests; production callers omit
// it and the pool client is borrowed via withFirmDbClient.
export const updateClientRuleStatusInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  ruleId,
  nextStatus,
  decidedBy = 'firm',
  allowActiveRetire = false,
  actorId = null,
  dbClient = null
} = {}) => {
  if (!ruleId) {
    const error = new Error('Client rule id is required.');
    error.statusCode = 400;
    throw error;
  }
  const allowed = ['active', 'retired'];
  if (!allowed.includes(String(nextStatus))) {
    const error = new Error('Valid client rule status is required.');
    error.statusCode = 400;
    throw error;
  }

  const run = async (client) => {
    await client.query('begin');
    try {
      const existing = await client.query(
        'select * from client_rules where firm_id = $1 and id = $2',
        [firmId, ruleId]
      );
      if (!existing.rows.length) {
        const error = new Error('Client rule not found.');
        error.statusCode = 404;
        throw error;
      }
      const rule = existing.rows[0];
      const priorStatus = rule.status;
      const activeRetire = allowActiveRetire && nextStatus === 'retired' && priorStatus === 'active';
      if (priorStatus !== 'proposed' && !activeRetire) {
        const error = new Error(
          allowActiveRetire && nextStatus === 'retired'
            ? `Only active or proposed rules can be retired (current status: ${priorStatus}).`
            : `Only proposed rules can be promoted via this endpoint (current status: ${priorStatus}).`
        );
        error.statusCode = 409;
        throw error;
      }

      // W1 (INV-06): activating a proposed rule is a governed transition INTO
      // the (client, pattern) slot, so the slot's other current rules retire in
      // the same transaction, receipted — the same supersession a human mint
      // performs. The proposed-decision receipt below stays byte-identical.
      const retiredRuleIds = nextStatus === 'active' && rule.pattern_text
        ? await retireSupersededRulesOnPattern({
          client, firmId, clientId: rule.client_id, normalizedPattern: rule.pattern_text,
          successorRuleId: ruleId, actorId, source: decidedBy
        })
        : [];

      await client.query(
        `update client_rules
            set status = $3, updated_at = now()
          where firm_id = $1 and id = $2`,
        [firmId, ruleId, nextStatus]
      );

      // The retire leg (active → retired) carries its own distinct audit
      // action with the acting principal; the proposed-decision leg stays
      // byte-identical (its literal action name is pinned in ruleLearner.test.js).
      if (activeRetire) {
        await client.query(
          `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
           values ($1, $2, 'firm', $3, 'client_rule.retired', 'client_rule', $4, $5::jsonb)`,
          [
            firmId,
            rule.client_id,
            actorId || decidedBy,
            ruleId,
            JSON.stringify({
              rule_id: ruleId,
              prior_status: priorStatus,
              next_status: nextStatus,
              decided_by: decidedBy
            })
          ]
        );
      } else {
        await client.query(
          `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
           values ($1, $2, 'firm', 'client_rule.firm_decided', 'client_rule', $3, $4::jsonb)`,
          [
            firmId,
            rule.client_id,
            ruleId,
            JSON.stringify({
              rule_id: ruleId,
              prior_status: priorStatus,
              next_status: nextStatus,
              decided_by: decidedBy
            })
          ]
        );
      }

      await client.query('commit');
      return { rule_id: ruleId, prior_status: priorStatus, next_status: nextStatus, retired_rule_ids: retiredRuleIds };
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  };

  if (dbClient) {
    const summary = await run(dbClient);
    return { ...summary, snapshot: null };
  }
  const summary = await withFirmDbClient(run);
  const snapshot = await getFirmSnapshotFromDb({ firmId });
  return { ...summary, snapshot };
};

// Layer-2 drawer-recode gate: distill only when a HUMAN-applied coding
// DISAGREES with the persisted verdict. A confirmation carries no
// correction signal (the model was right — nothing local to learn), a
// Suspense park says "I don't know" rather than knowledge, and a line
// with no prior verdict has no disagreement to learn from (the
// reply-recode hook owns the reply-rich path; merchant rules own
// recurring-pattern memory). Name-level comparison across the alias
// keys both FE patch builders emit — buildAcceptedPatch sends
// account_name/category/account_label, the legacy view sends
// proposed_account/account_code.
export const __shouldDistillReviewRecode = ({ reviewState, codingPatch = {}, priorVerdict = null } = {}) => {
  if (!['accepted', 'resolved'].includes(String(reviewState || ''))) return false;
  const humanValues = ['account_name', 'category', 'account_label', 'account_code', 'proposed_account']
    .map((key) => normalizeIntelText(codingPatch[key] || ''))
    .filter(Boolean);
  if (!humanValues.length) return false;
  if (humanValues.includes('suspense')) return false;
  const verdictValues = ['proposed_account', 'account_code', 'account_name', 'account_label']
    .map((key) => normalizeIntelText(priorVerdict?.[key] || ''))
    .filter(Boolean);
  if (!verdictValues.length) return false;
  return !humanValues.some((value) => verdictValues.includes(value));
};

// Distiller event for a drawer recode — the drawer twin of the
// reply-recode event above. Client identity rides as registration
// number + name (never the clients.id row id — facts must survive
// recreates); the prior verdict is labeled as the model's own
// unconfirmed suggestion, same provenance framing the reply path uses.
export const __buildReviewRecodeDistillation = ({
  item = {},
  codingPatch = {},
  reviewState = '',
  reviewerNote = '',
  transactionRow = {},
  clientRow = {}
} = {}) => {
  const txPayload = transactionRow.payload || {};
  const priorVerdict = txPayload.ai_suggestion && typeof txPayload.ai_suggestion === 'object'
    ? txPayload.ai_suggestion
    : null;
  const profile = clientRow.profile || {};
  return {
    event: {
      kind: 'drawer_recode',
      client: {
        name: profile.companyName || clientRow.company_name || '',
        registration_number: profile.uen || clientRow.uen || '',
        jurisdiction: profile.jurisdiction || clientRow.jurisdiction || ''
      },
      transaction: {
        description: transactionRow.description || '',
        money_in: Number(transactionRow.money_in || 0),
        money_out: Number(transactionRow.money_out || 0),
        currency: txPayload.account_currency || transactionRow.currency || '',
        contact: txPayload.contact || ''
      },
      prior_verdict: priorVerdict
        ? {
            proposed_account: priorVerdict.proposed_account || '',
            confidence: priorVerdict.confidence || '',
            reasoning: priorVerdict.reasoning || '',
            provenance: 'machine_suggestion_unconfirmed'
          }
        : null,
      human_coding: {
        account: codingPatch.account_name || codingPatch.category || codingPatch.account_label || codingPatch.account_code || '',
        account_code: codingPatch.account_code || null,
        tax_treatment: codingPatch.tax_treatment || codingPatch.xero_tax_type || null,
        reviewer_note: reviewerNote || null,
        review_state: reviewState
      }
    },
    provenance: {
      source: 'drawer_recode',
      client_id: item.client_id || null,
      transaction_id: item.payload?.transaction_id || item.item_id || null,
      review_item_id: item.id || null
    }
  };
};

// `returnSnapshot: false` skips the (heavy, ~28-query) firm snapshot
// rebuild and returns null — for batch callers (feed-chat mass apply)
// that loop this writer per row and fetch ONE snapshot at the end.
// Pod-safety #2 (before_state + reverse): the compact before/after of exactly
// the fields THIS writer mutates — review-item status/review_state, every
// codingPatch key it overwrites on the item payload, and (when the transaction
// row was pre-read) the transaction's account_code / category /
// reconciliation_status. `after.transaction` mirrors the SQL's own
// coalesce/case semantics so the recorded after IS what the update wrote.
// A confirm of an LLM-suggested categorization bumps the matched rule's
// confirmation count; the 2nd confirm promotes its confidence to
// auto-apply strength (0.9). Pure; exported for tests — the write site in
// updateTransactionReviewItemInDb audits the bump with these values.
export const __ruleConfirmationBumpPatch = (rulePayload = {}) => {
  const confirmationCount = Number(rulePayload.confirmation_count || 0) + 1;
  return {
    confirmation_count: confirmationCount,
    confidence: confirmationCount >= 2 ? 0.9 : 0.7
  };
};

// G2 idempotency sweep (build-spec-g2 PR-13): one review item drives at most
// ONE confirmation bump. The bump write stamps last_confirmed_review_item_id;
// a crash-window replay of the same apply (crash between writer commit and
// the spine's applied stamp, then re-apply) — and the sibling artifact, a
// later note/update re-deriving the accepted state on the SAME item — sees
// its own id already recorded and skips, so a single human confirm can never
// phantom-promote a rule to auto-apply strength (0.9 arrives at count 2). A
// DIFFERENT review item confirming the same rule still bumps: that is the
// real second signal the promotion threshold means. Trade-off recorded: a
// genuine re-confirm through the SAME reopened item no longer re-bumps — one
// line is one piece of evidence. Pure; exported for tests.
export const __shouldBumpRuleConfirmation = (rulePayload = {}, reviewItemId = '') =>
  Boolean(reviewItemId) &&
  String(rulePayload.last_confirmed_review_item_id || '') !== String(reviewItemId);
