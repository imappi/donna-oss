// Cross-client merchant signal capture.
//
// PR-A (this module): write the signal events + rollup so the LLM can
// later use it as a prior on categorisation calls. NO consumer wired
// yet — PR-B will plug this into the chat context builder.
//
// Pure helpers (key derivation, denylist, weighting) live here so the
// rule + signal stay in sync with the firmDb merchant-rule writer.
// The DB writer (recordMerchantSignalInDb) is a thin transactional
// wrapper.

import crypto from 'node:crypto';

import { canonicalMerchantPattern } from './transactionIntel.js';

// Signal kinds + their rollup weights. `remember_merchant` — the
// explicit "generalise this" gesture — is the ONLY minting kind since
// §7.6's dated call (Kari, 2026-08-14): an ordinary `apply_category`
// correction contributes NO cross-firm signal (correction ≠ teaching,
// one mint path per consequence). The old weight-1 `apply_category`
// entry is deliberately ABSENT, not zeroed: an unknown kind refuses
// fail-closed at the writer (`invalid_signal_kind`), so a stale caller
// cannot mint. Weights are integers — Postgres `integer` column.
export const SIGNAL_KIND_WEIGHT = Object.freeze({
  remember_merchant: 3
});

// Tokens that normalise to a meaningful pattern under
// canonicalMerchantPattern but represent generic noise that should
// never become a rollup key. ("card" used to be in the canonical
// stop-words but slipped through some bank descriptions.) Kept here
// so the denylist is reviewable in one place and easy to extend.
const GENERIC_KEY_DENYLIST = new Set([
  'card',
  'wire',
  'debit',
  'credit',
  'payment',
  'transfer',
  'sale',
  'purchase',
  'pos',
  'atm',
  'fee',
  'charge',
  'refund',
  'deposit',
  'withdrawal',
  'cash',
  'check',
  'cheque'
]);

const MIN_KEY_LENGTH = 3;

// Derive the rollup key from whatever fields are available. We prefer
// the action's explicit merchant_pattern (set by `remember_merchant`),
// fall back to the transaction's description, then to raw_description.
// All three are folded together so a single canonicalisation pass
// captures whichever has the strongest merchant signal.
export const deriveMerchantKey = ({ action, transaction } = {}) => {
  // Defaults inside the destructure only fire for `undefined`; an
  // explicit `null` would still throw on `.merchant_pattern`. Re-default
  // here so callers can pass either nullish form.
  const a = action || {};
  const t = transaction || {};
  const parts = [a.merchant_pattern, a.contact_name, t.description, t.raw_description]
    .filter((s) => typeof s === 'string' && s.trim())
    .join(' ');
  if (!parts) return '';
  return canonicalMerchantPattern(parts);
};

// Reject keys that would create a poisonous rollup row (matches too
// many unrelated transactions). The check sits AFTER
// canonicalMerchantPattern — we only see normalised forms, never the
// raw string.
export const isMerchantKeyTooGeneric = (key) => {
  if (typeof key !== 'string') return true;
  const trimmed = key.trim();
  if (!trimmed) return true;
  if (trimmed.length < MIN_KEY_LENGTH) return true;
  if (/^\d+$/.test(trimmed)) return true; // numeric-only
  // Single-token denylist hit OR a key that's just denylist words
  // separated by whitespace (e.g. "card payment").
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.every((t) => GENERIC_KEY_DENYLIST.has(t))) return true;
  return false;
};

export const weightForSignalKind = (signalKind) => {
  const weight = SIGNAL_KIND_WEIGHT[signalKind];
  return typeof weight === 'number' && weight > 0 ? weight : 0;
};

// Deterministic event id (G−1(d), build-spec PR-4): the same apply
// replayed — a retry after a crash between the signal commit and the
// chat-action status stamp — must produce the SAME id so the insert's
// `on conflict (id) do nothing` dedupes it. The tuple is the apply's
// full provenance; two different actions on one message differ in
// action_index, two kinds on one action differ in signal_kind.
export const buildMerchantSignalEventId = ({
  firmId,
  clientId,
  transactionId,
  chatMessageId,
  actionIndex,
  signalKind
} = {}) => {
  const basis = [
    String(firmId || ''),
    String(clientId || ''),
    String(transactionId || ''),
    String(chatMessageId || ''),
    typeof actionIndex === 'number' ? String(actionIndex) : '',
    String(signalKind || '')
  ].join('|');
  return `msig-${crypto.createHash('sha256').update(basis).digest('hex').slice(0, 24)}`;
};

// Build the row that goes into merchant_signal_events. Pure — no DB.
// The caller computes merchantKey separately so it can be consistent
// with the rule writer's normalised pattern.
export const buildMerchantSignalEventRow = ({
  firmId,
  clientId,
  transactionId,
  chatMessageId,
  actionIndex,
  action,
  transaction,
  merchantKey,
  jurisdiction,
  signalKind,
  createdAt
}) => {
  if (!firmId || !clientId || !merchantKey || !action) return null;
  const accountName = String(action.account_name || '').trim();
  if (!accountName) return null;
  const weight = weightForSignalKind(signalKind);
  if (!weight) return null;
  const rawMerchant = String(
    action.merchant_pattern
      || transaction?.description
      || transaction?.raw_description
      || ''
  ).slice(0, 240);
  return {
    id: buildMerchantSignalEventId({ firmId, clientId, transactionId, chatMessageId, actionIndex, signalKind }),
    firm_id: firmId,
    client_id: clientId,
    source_transaction_id: transactionId || null,
    source_chat_message_id: chatMessageId || null,
    source_action_index: typeof actionIndex === 'number' ? actionIndex : null,
    merchant_key: merchantKey,
    raw_merchant: rawMerchant,
    account_name: accountName,
    account_code: action.account_code || null,
    tax_treatment: action.tax_treatment || null,
    contact_name: action.contact_name || null,
    jurisdiction: jurisdiction || '',
    signal_kind: signalKind,
    weight,
    created_at: createdAt || new Date().toISOString()
  };
};

// Transactional DB writer. Inserts the event row, its audit row, and
// the rollup upsert. Caller passes the pg `client` so this composes
// with the outer apply-route transaction (rule write + signal write
// must commit or roll back as a unit) — BOTH call sites now run it
// inside an explicit transaction, which is what makes the audit row
// a genuine precondition for the mint (no record, no event).
//
// Returns:
//   { written: true,  event_id, rollup_weight }      success
//   { written: false, skipped_reason: 'too_generic' | 'missing_input'
//                     | 'invalid_signal_kind' }       nothing to record
//   { written: false, skipped_reason: 'duplicate_replay', event_id }
//     — the deterministic id already exists (G−1(d)): a replayed apply
//     dedupes the EVENT and, critically, never re-increments the
//     ROLLUP (the event insert's rowCount gates it). No audit row on a
//     replay either — the first write audited the mint; a replay mints
//     nothing.
//
// "skipped" is not an error — the apply route should still flip the
// chat action to `applied` and return 201; we just didn't accumulate
// cross-client knowledge from this particular event.
export const recordMerchantSignalInDb = async ({
  client,
  firmId,
  clientId,
  transactionId,
  chatMessageId,
  actionIndex,
  action,
  transaction,
  signalKind,
  jurisdiction = '',
  actorId = 'system'
} = {}) => {
  if (!client || !firmId || !clientId || !action) {
    return { written: false, skipped_reason: 'missing_input' };
  }
  if (!weightForSignalKind(signalKind)) {
    return { written: false, skipped_reason: 'invalid_signal_kind' };
  }
  const merchantKey = deriveMerchantKey({ action, transaction });
  if (isMerchantKeyTooGeneric(merchantKey)) {
    return { written: false, skipped_reason: 'too_generic' };
  }
  const row = buildMerchantSignalEventRow({
    firmId,
    clientId,
    transactionId,
    chatMessageId,
    actionIndex,
    action,
    transaction,
    merchantKey,
    jurisdiction,
    signalKind
  });
  if (!row) {
    return { written: false, skipped_reason: 'missing_input' };
  }

  const eventInsert = await client.query(
    `insert into merchant_signal_events
       (id, firm_id, client_id, source_transaction_id, source_chat_message_id,
        source_action_index, merchant_key, raw_merchant, account_name,
        account_code, tax_treatment, contact_name, jurisdiction, signal_kind,
        weight, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::timestamptz)
     on conflict (id) do nothing`,
    [
      row.id,
      row.firm_id,
      row.client_id,
      row.source_transaction_id,
      row.source_chat_message_id,
      row.source_action_index,
      row.merchant_key,
      row.raw_merchant,
      row.account_name,
      row.account_code,
      row.tax_treatment,
      row.contact_name,
      row.jurisdiction,
      row.signal_kind,
      row.weight,
      row.created_at
    ]
  );
  // The replay guard (G−1(d)): a deduped event must not re-increment the
  // rollup — with `do nothing` alone a replayed apply would dedupe the
  // EVENT yet still double-count the ROLLUP. rowCount is the gate.
  if (eventInsert.rowCount !== 1) {
    return { written: false, skipped_reason: 'duplicate_replay', event_id: row.id };
  }

  // Audit-as-precondition for the MINT: same client, same transaction as
  // the event insert — if this row cannot be recorded, the signal (and at
  // the remember_merchant site the whole rule+signal transaction) rolls
  // back. Real actor on the row (pod-safety #1), never a silent write.
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'firm', $3, 'merchant_signal.recorded', 'merchant_signal_event', $4, $5::jsonb)`,
    [
      row.firm_id,
      row.client_id,
      actorId || 'system',
      row.id,
      JSON.stringify({
        merchant_key: row.merchant_key,
        account_name: row.account_name,
        signal_kind: row.signal_kind,
        weight: row.weight,
        jurisdiction: row.jurisdiction,
        source_transaction_id: row.source_transaction_id,
        source_chat_message_id: row.source_chat_message_id,
        source_action_index: row.source_action_index
      })
    ]
  );

  const rollup = await client.query(
    `insert into merchant_signal_rollup
       (merchant_key, account_name, jurisdiction, occurrence_weight,
        occurrence_count, last_seen_at)
     values ($1, $2, $3, $4, 1, now())
     on conflict (merchant_key, account_name, jurisdiction) do update set
       occurrence_weight = merchant_signal_rollup.occurrence_weight + excluded.occurrence_weight,
       occurrence_count = merchant_signal_rollup.occurrence_count + 1,
       last_seen_at = now()
     returning occurrence_weight`,
    [row.merchant_key, row.account_name, row.jurisdiction, row.weight]
  );

  return {
    written: true,
    event_id: row.id,
    rollup_weight: rollup.rows[0]?.occurrence_weight ?? null
  };
};
