// Outbound action store (M0.3, G2/G10 — execution plan A1/A3). Persistence
// for outbound_actions / outbound_action_receipts / outbound_suppression
// (migration 091). Marketing-rail layout: the pipeline owns its modules;
// firmDb.js stays untouched.
//
// Transaction posture: all writers run on the CALLER's client handle and
// never begin/commit (the executor owns its per-action transactions; the
// mint's caller wraps mint+receipt in one transaction).
//
// Receipt bar (G10, 050 template): approved_by / authority / model NOT NULL
// on every receipt — including refusals and cancels. A cancel is a terminal,
// not a silent skip (A3).

import { randomUUID } from 'node:crypto';
import { readInvoiceIssuanceRefusal } from './issuance.js';

import {
  OUTBOUND_ACTION_TYPES, OUTBOUND_ACTION_STATUSES, OUTBOUND_RECEIPT_OUTCOMES,
  OWNER_DIRECTED_ACTION_TYPES
} from './actionGate.js';
import { normalizeChannelValue, listPartyChannels } from './partyStore.js';
import { recordOutboundCorrection } from './earnedAutoLadder.js';
import { fingerprintIssuanceConsequence } from './consequenceFingerprint.js';
import { recordOutboundRoleTransition } from '../roles/roleEvents.js';
import { loadOutboundPack, statutoryTitlesForPack } from './packs.js';
import {
  OUTBOUND_DELIVERY_CONTRACT_VERSION, fingerprintOutboundDeliveryContract,
  resolveOutboundActionLanguage
} from './emailArtifact.js';
import { resolveOwnerReplyTo } from './sendingIdentity.js';

// Anchor types whose consequence is fingerprinted at approval (G13(b)). A
// reminder's consequence IS its anchor's state, which the executor already
// re-checks fresh at send; only the issuance anchors carry a drafted document
// whose business facts can drift underneath an approval.
const FINGERPRINTED_ANCHOR_TYPES = ['issued_invoice', 'issued_quote'];

// Deterministic idempotency key (A3): one action per (type, target, anchor,
// cadence step). The 091 unique index scopes it per (firm, client).
export const buildOutboundIdempotencyKey = ({
  actionType, targetPartyId, anchorType, anchorId, cadenceStep = 0
} = {}) =>
  [actionType, targetPartyId, anchorType, anchorId, `step-${Number(cadenceStep) || 0}`].join(':');

const auditEvent = async (client, {
  firmId, clientId, actorType = 'system', actorId = null,
  action, resourceType, resourceId, metadata = {}
}) => {
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [firmId, clientId, actorType, actorId, action, resourceType, resourceId, JSON.stringify(metadata)]
  );
};

// ── Suppression (checked at mint AND send — A3) ──────────────────────────────

export const isOutboundSuppressed = async (client, { firmId, clientId, channelKind, value }) => {
  const normalized = normalizeChannelValue(channelKind, value);
  if (!normalized) return false;
  const { rows } = await client.query(
    `select 1 from outbound_suppression
      where firm_id = $1 and client_id = $2 and channel_kind = $3 and normalized_value = $4
      limit 1`,
    [firmId, clientId, channelKind, normalized]
  );
  return rows.length > 0;
};

export const addOutboundSuppression = async (client, {
  firmId, clientId, channelKind, value,
  reason = 'manual', source = 'manual', actorType = 'system', actorId = null
}) => {
  const normalized = normalizeChannelValue(channelKind, value);
  if (!normalized) throw new Error('addOutboundSuppression requires a non-empty value');
  const allowed = ['unsubscribed', 'bounced', 'complaint', 'manual'];
  const tag = allowed.includes(reason) ? reason : 'manual';
  const id = randomUUID();
  await client.query(
    `insert into outbound_suppression (id, firm_id, client_id, channel_kind, normalized_value, reason, source)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (firm_id, client_id, channel_kind, normalized_value) do nothing`,
    [id, firmId, clientId, channelKind, normalized, tag, String(source || 'manual')]
  );
  await auditEvent(client, {
    firmId, clientId, actorType, actorId,
    action: 'outbound_suppression.added', resourceType: 'outbound_suppression', resourceId: id,
    metadata: { channel_kind: channelKind, reason: tag, source }
  });
  return { id, normalized, reason: tag };
};

// ── Receipts (append-only; the consequence-diff's home) ──────────────────────

export const insertOutboundReceipt = async (client, {
  firmId, clientId, actionId, actionType, targetPartyId = null,
  channel, recipient = null, outcome, reason = null,
  approvedBy, authority, model,
  renderedSubject = null, renderedBody = null, providerMessageId = null,
  checks = [], configSnapshotId = null,
  requestedLanguage = null, actualLanguage = null, languageSource = null,
  languageFallbackBasis = null, correspondenceLocale = null,
  templateName = null, templateCatalogId = null, templateCatalogVersion = null,
  renderedHtml = null, attachmentManifest = [], contentFingerprint = null,
  deliveryContractVersion = null, deliveryContractFingerprint = null
}) => {
  if (!OUTBOUND_RECEIPT_OUTCOMES.includes(outcome)) {
    throw new Error(`insertOutboundReceipt: unknown outcome '${outcome}'`);
  }
  if (!approvedBy || !authority || !model) {
    throw new Error('insertOutboundReceipt: approvedBy, authority and model are mandatory (the marketing bar)');
  }
  const id = randomUUID();
  await client.query(
    `insert into outbound_action_receipts
       (id, firm_id, client_id, action_id, action_type, target_party_id, channel, recipient,
        outcome, reason, approved_by, authority, model, rendered_subject, rendered_body,
        provider_message_id, checks, config_snapshot_id, requested_language, actual_language,
        language_source, language_fallback_basis, correspondence_locale, template_name,
        template_catalog_id, template_catalog_version, rendered_html, attachment_manifest,
        content_fingerprint, delivery_contract_version, delivery_contract_fingerprint)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             $16, $17::jsonb, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27,
             $28::jsonb, $29, $30, $31)`,
    [id, firmId, clientId, actionId, actionType, targetPartyId, channel, recipient,
      outcome, reason, approvedBy, authority, model, renderedSubject, renderedBody,
      providerMessageId, JSON.stringify(checks || []), configSnapshotId,
      requestedLanguage, actualLanguage, languageSource, languageFallbackBasis,
      correspondenceLocale, templateName, templateCatalogId, templateCatalogVersion,
      renderedHtml, JSON.stringify(attachmentManifest || []), contentFingerprint,
      deliveryContractVersion, deliveryContractFingerprint]
  );
  return { id };
};

// ── Mint ─────────────────────────────────────────────────────────────────────
// The caller has already gathered the gate inputs and run
// classifyOutboundAction (the store never re-derives intelligence). Behaviour
// by verdict:
//   - flag_off block        → NOT minted ({ refused: 'flag_off' }) — a dark
//     pipeline mints nothing (the marketing channel-stage-off posture);
//   - any other block       → minted directly as 'cancelled' + a refusal
//     receipt (visible terminal, never a silent skip);
//   - hold_for_approval     → minted at rest on the owner;
//   - auto_execute          → minted 'scheduled' for the sweep.
// Idempotent on (firm, client, idempotency_key): a duplicate mint returns the
// existing row with { deduped: true }.

export const mintOutboundAction = async (client, {
  firmId, clientId, actionType, targetPartyId,
  anchorType, anchorId, packId, template = null, language = null,
  payload = {}, amount = null, currency = null, confidence = null,
  gate, scheduledFor = null, cadenceStep = 0,
  createdBy = 'system', model = null, configSnapshotId = null,
  actorType = 'system', actorId = null
}) => {
  if (!OUTBOUND_ACTION_TYPES.includes(actionType)) {
    throw new Error(`mintOutboundAction: unknown action_type '${actionType}'`);
  }
  if (!targetPartyId || !anchorType || !anchorId || !packId) {
    throw new Error('mintOutboundAction requires targetPartyId, anchorType, anchorId, packId');
  }
  if (!gate || !gate.verdict) {
    throw new Error('mintOutboundAction requires a gate verdict (run classifyOutboundAction first)');
  }
  if (gate.verdict === 'blocked' && gate.reasons?.includes('flag_off')) {
    return { refused: 'flag_off', action: null };
  }

  const status = gate.verdict === 'auto_execute' ? 'scheduled'
    : gate.verdict === 'blocked' ? 'cancelled'
      : 'hold_for_approval';
  const idempotencyKey = buildOutboundIdempotencyKey({
    actionType, targetPartyId, anchorType, anchorId, cadenceStep
  });
  const id = randomUUID();
  // Bearer capability tokens (093, G8/G9): the counterparty's unsubscribe and
  // the owner's approve/decline tap — random per action, resolved by the
  // public outbound routes.
  const inserted = await client.query(
    `insert into outbound_actions
       (id, firm_id, client_id, action_type, target_party_id, anchor_type, anchor_id,
        pack_id, template, language, payload, amount, currency, confidence,
        gate_verdict, gate_basis, status, scheduled_for, cadence_step,
        idempotency_key, cancel_reason, created_by, model, config_snapshot_id,
        approval_token, unsubscribe_token)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14,
             $15, $16::jsonb, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
     on conflict (firm_id, client_id, idempotency_key) do nothing
     returning *`,
    [id, firmId, clientId, actionType, targetPartyId, anchorType, anchorId,
      packId, template, language, JSON.stringify(payload || {}), amount, currency, confidence,
      gate.verdict, JSON.stringify({ mode: gate.mode, stage: gate.stage, flag_key: gate.flagKey, reasons: gate.reasons || [] }),
      status, scheduledFor, Number(cadenceStep) || 0,
      idempotencyKey,
      status === 'cancelled' ? (gate.reasons || []).join(',') : null,
      String(createdBy || 'system'), model, configSnapshotId,
      randomUUID(), randomUUID()]
  );
  if (!inserted.rows[0]) {
    const existing = await client.query(
      `select * from outbound_actions
        where firm_id = $1 and client_id = $2 and idempotency_key = $3`,
      [firmId, clientId, idempotencyKey]
    );
    return { action: existing.rows[0] || null, deduped: true };
  }
  const action = inserted.rows[0];
  await auditEvent(client, {
    firmId, clientId, actorType, actorId,
    action: 'outbound_action.minted', resourceType: 'outbound_action', resourceId: id,
    metadata: {
      action_type: actionType, target_party_id: targetPartyId,
      anchor: `${anchorType}:${anchorId}`, gate_verdict: gate.verdict,
      status, reasons: gate.reasons || [], cadence_step: Number(cadenceStep) || 0
    }
  });
  if (status === 'cancelled') {
    await insertOutboundReceipt(client, {
      firmId, clientId, actionId: id, actionType, targetPartyId,
      channel: 'email', outcome: 'refused', reason: (gate.reasons || []).join(','),
      approvedBy: 'system:gate', authority: 'gate_refusal',
      model: model || 'deterministic:gate',
      checks: (gate.reasons || []).map((r) => ({ check: r, status: 'fail' })),
      configSnapshotId
    });
  }
  // S5 role event (roles/roleEvents.js): a mint that rests on the owner is a
  // role→owner handoff when the action's lane belongs to an actively HIRED
  // role (a hired collections lane at canary mints every send here). Recorded
  // at the writer so every mint funnel emits it; a no-op for Donna-core lanes
  // and un-hired roles; soft on failure (the mint's own receipt stands alone).
  if (status === 'hold_for_approval') {
    await recordOutboundRoleTransition(client, {
      firmId, clientId, action, transition: 'handed_to_owner',
      reasons: gate.reasons || [], actorType, actorId
    });
  }
  return { action, deduped: false };
};

// ── Lifecycle writers ────────────────────────────────────────────────────────

// A next-period refusal is owner responsibility, not an editable invoice or
// sendable draft. Every approval surface and held-draft editor uses this writer.
const assertInvoiceAdmission = async (client, { firmId, clientId, actionId }) => {
  const row = (await client.query(
    'select * from outbound_actions where id = $1 and firm_id = $2 and client_id = $3 for update',
    [actionId, firmId, clientId]
  )).rows[0];
  if (row?.payload?.recurrence_refusal) {
    const error = new Error('This recurrence could not create an invoice. Stop the blocked recurrence; it cannot be approved or edited.');
    error.code = 'OUTBOUND_INVOICE_RECURRENCE_BLOCKED';
    error.statusCode = 409;
    throw error;
  }
  const refusal = row && await readInvoiceIssuanceRefusal(client, { firmId, clientId, action: row });
  if (refusal) {
    const error = new Error('This invoice cannot be sent with its current seller and tax facts. Choose “Don’t send” to close it.');
    error.code = 'OUTBOUND_INVOICE_INVALID';
    error.reason = refusal;
    error.statusCode = 409;
    throw error;
  }
};

// Owner approval: hold_for_approval → approved. Requires a non-system
// principal — approval IS the authority the receipt will cite.
//
// G13(b): the approved CONSEQUENCE is fingerprinted here, in the writer, not at
// the approval surfaces — same reasoning as editHeldOutboundActionDraft's D1
// recorder. A surface that forgot to pass a fingerprint would leave the column
// NULL, and a NULL reads as "nothing to compare", which is silently no
// protection at all. Computing it at the writer means every approval, from
// every surface, is comparable at send.
//
// Only issuance anchors carry one: a dunning reminder's consequence is the
// anchor's own state, which the executor already re-checks. `null` stays null
// and the send-time check is a no-op — byte-identical to before for them.
export const approveOutboundAction = async (client, {
  firmId, clientId, actionId, actorType, actorId = null
}) => {
  if (!actorType || actorType === 'system') {
    throw new Error('approveOutboundAction requires a non-system acting principal');
  }
  await assertInvoiceAdmission(client, { firmId, clientId, actionId });
  const fingerprint = await approvedConsequenceFingerprintFor(client, {
    firmId, clientId, actionId
  });
  const deliveryContract = await approvedDeliveryContractFor(client, {
    firmId, clientId, actionId
  });
  if (deliveryContract?.refused) {
    const error = new Error(deliveryContract.reason);
    error.code = deliveryContract.reason === 'requested_language_unavailable'
      ? 'OUTBOUND_REQUESTED_LANGUAGE_UNAVAILABLE'
      : 'OUTBOUND_DELIVERY_CONTRACT_UNAVAILABLE';
    error.statusCode = 409;
    error.detail = deliveryContract.resolution;
    throw error;
  }
  const { rows } = await client.query(
    `update outbound_actions
        set status = 'approved', approved_by_actor_type = $4, approved_by_actor_id = $5,
            approved_at = now(), scheduled_for = coalesce(scheduled_for, now()),
            approved_consequence_fingerprint = $6,
            approved_delivery_contract_version = $7,
            approved_delivery_contract_fingerprint = $8, updated_at = now()
      where id = $1 and firm_id = $2 and client_id = $3 and status = 'hold_for_approval'
      returning *`,
    [actionId, firmId, clientId, actorType, actorId, fingerprint,
      deliveryContract?.version || null, deliveryContract?.fingerprint || null]
  );
  if (!rows[0]) return null;
  await auditEvent(client, {
    firmId, clientId, actorType, actorId,
    action: 'outbound_action.approved', resourceType: 'outbound_action', resourceId: actionId,
    metadata: {
      action_type: rows[0].action_type,
      approved_consequence_fingerprint: fingerprint,
      approved_delivery_contract_version: deliveryContract?.version || null,
      approved_delivery_contract_fingerprint: deliveryContract?.fingerprint || null
    }
  });
  // S5 role event: the owner decided — the held item leaves their queue and
  // the role's lane resumes (the sweep sends it). At the writer so both
  // approval surfaces (workspace + digest link) emit it; soft on failure.
  await recordOutboundRoleTransition(client, {
    firmId, clientId, action: rows[0], transition: 'resumed_from_owner',
    outcome: 'approved', actorType, actorId
  });
  return rows[0];
};

// Stamp the complete language/template/recipient contract at approval. This
// is deliberately separate from the established issuance consequence hash:
// old consequence rows keep their exact v1 interpretation while this
// independently versioned contract can evolve without laundering drift.
// Unlike the historical consequence observer, this new contract is required
// for every new approval: inability to compute it refuses rather than minting
// another unguarded approval. Unsupported requested language is the named
// owner-fixable refusal.
const approvedDeliveryContractFor = async (client, { firmId, clientId, actionId }) => {
  try {
    const action = await client.query(
      `select action_type, anchor_type, anchor_id, target_party_id,
              pack_id, template, language
         from outbound_actions
        where id = $1 and firm_id = $2 and client_id = $3`,
      [actionId, firmId, clientId]
    ).then((r) => r.rows[0] || null);
    if (!action) return null;
    if (!action.pack_id || !action.template) {
      return { refused: true, reason: 'delivery_contract_incomplete', resolution: null };
    }

    const pack = loadOutboundPack(action.pack_id);
    const ownerDirected = OWNER_DIRECTED_ACTION_TYPES.includes(action.action_type);
    const party = ownerDirected ? null : await client.query(
      `select preferred_language, fallback_language
         from client_parties
        where id = $1 and firm_id = $2 and client_id = $3`,
      [action.target_party_id, firmId, clientId]
    ).then((r) => r.rows[0] || null);
    const resolution = resolveOutboundActionLanguage({
      pack,
      actionLanguage: action.language,
      preferredLanguage: party?.preferred_language,
      fallbackLanguage: party?.fallback_language,
      ownerDirected
    });
    if (!resolution.ok) {
      return { refused: true, reason: resolution.reason, resolution };
    }

    let recipient = null;
    if (ownerDirected) {
      const profile = await client.query(
        'select profile from clients where firm_id = $1 and id = $2',
        [firmId, clientId]
      ).then((r) => r.rows[0]?.profile || null);
      recipient = resolveOwnerReplyTo(profile);
    } else {
      const channels = await listPartyChannels(client, {
        firmId, clientId, partyId: action.target_party_id, activeOnly: true
      });
      const emails = channels.filter((channel) => channel.channel_kind === 'email');
      recipient = (emails.find((channel) => channel.is_primary) || emails[0])?.normalized_value || null;
    }

    let statutoryTitle = null;
    let statutoryTitleLimb = null;
    if (action.action_type === 'issue_invoice') {
      const anchor = await client.query(
        `select draft from issued_invoices
          where firm_id = $1 and client_id = $2 and id = $3`,
        [firmId, clientId, action.anchor_id]
      ).then((r) => r.rows[0] || null);
      const registered = anchor?.draft?.invoice?.seller?.taxRegistered;
      const titles = statutoryTitlesForPack(pack, resolution.actualLanguage);
      if (titles && typeof registered !== 'boolean') {
        return {
          refused: true,
          reason: 'delivery_contract_incomplete',
          resolution: { detail: 'invoice tax-registration limb is unavailable' }
        };
      }
      statutoryTitle = titles
        ? (registered ? titles.whenTaxRegistered : titles.otherwise)
        : null;
      statutoryTitleLimb = titles
        ? (registered ? 'tax_registered' : 'otherwise')
        : null;
    }

    return {
      version: OUTBOUND_DELIVERY_CONTRACT_VERSION,
      resolution,
      fingerprint: fingerprintOutboundDeliveryContract({
        recipient,
        packId: pack.pack.id,
        packVersion: pack.pack.version,
        templateName: action.template,
        requestedLanguage: resolution.requestedLanguage,
        actualLanguage: resolution.actualLanguage,
        languageSource: resolution.languageSource,
        fallbackBasis: resolution.fallbackBasis,
        correspondenceLocale: resolution.locale,
        direction: resolution.direction,
        statutoryTitle,
        statutoryTitleLimb
      })
    };
  } catch (error) {
    return {
      refused: true,
      reason: 'delivery_contract_unavailable',
      resolution: { detail: String(error?.message || error) }
    };
  }
};

// Read the action, its issuance anchor, and the recipient the party store would
// resolve right now, and fingerprint that. Soft: a structural failure here
// leaves the fingerprint NULL rather than blocking the owner's approval — the
// send-time check treats NULL as "not fingerprinted" and proceeds exactly as it
// did before this column existed. An approval must never fail because a guard
// could not be computed.
const approvedConsequenceFingerprintFor = async (client, { firmId, clientId, actionId }) => {
  try {
    const { rows } = await client.query(
      `select action_type, anchor_type, anchor_id, target_party_id
         from outbound_actions
        where id = $1 and firm_id = $2 and client_id = $3`,
      [actionId, firmId, clientId]
    );
    const action = rows[0];
    if (!action || !FINGERPRINTED_ANCHOR_TYPES.includes(action.anchor_type)) return null;

    const table = action.anchor_type === 'issued_invoice' ? 'issued_invoices' : 'issued_quotes';
    const anchor = await client.query(
      `select draft from ${table} where firm_id = $1 and client_id = $2 and id = $3`,
      [firmId, clientId, action.anchor_id]
    ).then((r) => r.rows[0] || null);
    if (!anchor) return null;

    const channels = await listPartyChannels(client, {
      firmId, clientId, partyId: action.target_party_id, activeOnly: true
    });
    const emails = channels.filter((c) => c.channel_kind === 'email');
    const recipient = (emails.find((c) => c.is_primary) || emails[0])?.normalized_value || null;

    return fingerprintIssuanceConsequence({ recipient, anchorRow: anchor });
  } catch {
    return null;
  }
};

// Owner EDIT of a held draft (G15/D12 — the workspace Actions tab's edit
// verb). Bounded on purpose: only OWNER-SIDE free text is editable —
// anchor-derived facts (amounts, dates, invoice/quote numbers, lines,
// reference numbers) and derived values (days_overdue, unsubscribe_url) are
// the pipeline's truth and must never be shaded by an edit; the recipient
// stays the party store's call (the executor ignores payload overrides for
// it). Lives at the WRITER so the D1 recorder cannot be skipped by any
// surface: an owner edit IS a counted correction ('edited_held_draft', the
// reserved kind in earnedAutoLadder.js's header) — the draft Donna proposed
// needed fixing, so the clean streak resets.
export const EDITABLE_DRAFT_RENDER_KEYS = Object.freeze([
  'payment_instructions', 'owner_business_name'
]);

export const editHeldOutboundActionDraft = async (client, {
  firmId, clientId, actionId, renderValues = {}, actorType, actorId = null
}) => {
  if (!actorType || actorType === 'system') {
    throw new Error('editHeldOutboundActionDraft requires a non-system acting principal');
  }
  await assertInvoiceAdmission(client, { firmId, clientId, actionId });
  const entries = Object.entries(renderValues || {});
  if (!entries.length) {
    const error = new Error('editHeldOutboundActionDraft: no render values to edit');
    error.code = 'OUTBOUND_EDIT_EMPTY';
    throw error;
  }
  const unknown = entries.filter(([key]) => !EDITABLE_DRAFT_RENDER_KEYS.includes(key));
  if (unknown.length) {
    // Fail-closed: an edit surface must never widen the editable set from
    // the client side — anchor facts are not the owner's to restate.
    const error = new Error(
      `editHeldOutboundActionDraft: keys not editable: ${unknown.map(([k]) => k).join(', ')}`);
    error.code = 'OUTBOUND_EDIT_KEY_FORBIDDEN';
    throw error;
  }
  const patch = {};
  for (const [key, value] of entries) patch[key] = String(value ?? '').trim();

  const { rows } = await client.query(
    `update outbound_actions
        set payload = jsonb_set(
              coalesce(payload, '{}'::jsonb), '{render_values}',
              coalesce(payload->'render_values', '{}'::jsonb) || $4::jsonb),
            updated_at = now()
      where id = $1 and firm_id = $2 and client_id = $3 and status = 'hold_for_approval'
      returning *`,
    [actionId, firmId, clientId, JSON.stringify(patch)]
  );
  if (!rows[0]) return null;
  const action = rows[0];
  await recordOutboundCorrection(client, {
    firmId, clientId, actionType: action.action_type,
    kind: 'edited_held_draft',
    refType: 'outbound_action', refId: actionId,
    actorType, actorId
  });
  await auditEvent(client, {
    firmId, clientId, actorType, actorId,
    action: 'outbound_action.draft_edited', resourceType: 'outbound_action', resourceId: actionId,
    metadata: { action_type: action.action_type, edited_keys: Object.keys(patch) }
  });
  return action;
};

// Owner "this was wrong" on an EXECUTED send (the reply_if_wrong D1 recorder
// — v1 IS the workspace verb on the sent-FYI rows; email-reply ingestion is
// the named v2 follow-up). The send HAPPENED, so there is no state change and
// no cancel — this is a correction record, nothing else. Lives at the WRITER
// so no surface can skip the recorder. Idempotent at the writer: the payload
// marker is stamped in the same UPDATE whose WHERE guard requires it absent,
// so a second click matches zero rows and records NO second correction.
export const markExecutedOutboundActionWrong = async (client, {
  firmId, clientId, actionId, actorType, actorId = null, channel = null
}) => {
  if (!actorType || actorType === 'system') {
    throw new Error('markExecutedOutboundActionWrong requires a non-system acting principal');
  }
  const { rows } = await client.query(
    `update outbound_actions
        set payload = jsonb_set(
              coalesce(payload, '{}'::jsonb), '{owner_marked_wrong_at}', to_jsonb(now())),
            updated_at = now()
      where id = $1 and firm_id = $2 and client_id = $3
        and status = 'executed'
        and (payload->>'owner_marked_wrong_at') is null
      returning *`,
    [actionId, firmId, clientId]
  );
  if (!rows[0]) return null;
  const action = rows[0];
  await recordOutboundCorrection(client, {
    firmId, clientId, actionType: action.action_type,
    kind: 'reply_if_wrong',
    refType: 'outbound_action', refId: actionId,
    actorType, actorId
  });
  await auditEvent(client, {
    firmId, clientId, actorType, actorId,
    action: 'outbound_action.marked_wrong', resourceType: 'outbound_action', resourceId: actionId,
    // channel: which surface carried the owner's "wrong" — absent for the
    // v1 workspace click, 'email_reply' for the v2 ingestion sweep.
    metadata: { action_type: action.action_type, ...(channel ? { channel } : {}) }
  });
  return action;
};

// post_send_reversal — the LAST reserved D1 kind, landed with the AR-post
// slice. The owner reverses an executed issue_invoice send's AR JOURNAL (the
// books entry, not the send — the email went; this is bookkeeping error
// correction, distinct from a credit note toward the customer). Workspace
// verb ONLY: the email-reply ingestion channel NEVER triggers a ledger
// reversal (an LLM-classified reply must not move the books). Guards:
//   - non-system principal mandatory (an owner verb, like mark-wrong);
//   - only an EXECUTED issue_invoice whose payload carries the stamped
//     ar_journal_id (a skipped leg has nothing to reverse) and no prior
//     ar_post_reversed_at marker — the idempotency lives in the UPDATE's
//     WHERE (the mark-wrong pattern: a second click matches zero rows);
//   - the books motion routes THROUGH firmDb's
//     __reverseOutboundArJournalWithClient (the existing correction-journal
//     machinery — reversal_of linkage, locked-period one-way-door); its
//     refusal throws OUT of this writer so the caller's rollback un-stamps
//     the marker — the verb is atomic, never marker-without-reversal;
//   - recordOutboundCorrection(kind='post_send_reversal') INSIDE the writer
//     (the D1 ladder contract — no surface can skip the recorder).
export const reverseExecutedOutboundArPost = async (client, {
  firmId, clientId, actionId, actorType, actorId = null,
  reason = 'owner_post_send_reversal', impls = null
}) => {
  if (!actorType || actorType === 'system') {
    throw new Error('reverseExecutedOutboundArPost requires a non-system acting principal');
  }
  const { rows } = await client.query(
    `update outbound_actions
        set payload = jsonb_set(
              coalesce(payload, '{}'::jsonb), '{ar_post_reversed_at}', to_jsonb(now())),
            updated_at = now()
      where id = $1 and firm_id = $2 and client_id = $3
        and status = 'executed' and action_type = 'issue_invoice'
        and (payload->>'ar_journal_id') is not null
        and (payload->>'ar_post_reversed_at') is null
      returning *`,
    [actionId, firmId, clientId]
  );
  if (!rows[0]) return null;
  const action = rows[0];
  const reverseImpl = impls?.reverseArJournal
    || (await import('../firmDb.js')).__reverseOutboundArJournalWithClient;
  const reversal = await reverseImpl({
    client, firmId, clientId,
    arJournalId: action.payload.ar_journal_id,
    reason, actorId: actorId || 'owner'
  });
  await client.query(
    `update outbound_actions
        set payload = jsonb_set(payload, '{ar_reversal_journal_id}', to_jsonb($4::text)),
            updated_at = now()
      where id = $1 and firm_id = $2 and client_id = $3`,
    [actionId, firmId, clientId, String(reversal.reversal_journal_id)]
  );
  await recordOutboundCorrection(client, {
    firmId, clientId, actionType: action.action_type,
    kind: 'post_send_reversal',
    refType: 'outbound_action', refId: actionId,
    actorType, actorId
  });
  await auditEvent(client, {
    firmId, clientId, actorType, actorId,
    action: 'outbound_action.ar_post_reversed', resourceType: 'outbound_action', resourceId: actionId,
    metadata: {
      action_type: action.action_type,
      ar_journal_id: action.payload.ar_journal_id,
      reversal_journal_id: reversal.reversal_journal_id
    }
  });
  return { action, reversal };
};

// Cancel from any pre-execution state; terminal, receipted. The CTE captures
// the PRE-cancel status so the D1 correction recorder can tell a declined
// held draft from a pre-send pullback.
export const cancelOutboundAction = async (client, {
  firmId, clientId, actionId, reason, actorType = 'system', actorId = null,
  approvedBy = null, authority = null, checks = []
}) => {
  const { rows } = await client.query(
    `with prior as (
       select status from outbound_actions
        where id = $1 and firm_id = $2 and client_id = $3
     )
     update outbound_actions
        set status = 'cancelled', cancel_reason = $4, updated_at = now()
      where id = $1 and firm_id = $2 and client_id = $3
        and status in ('scheduled', 'hold_for_approval', 'approved')
      returning *, (select status from prior) as prior_status`,
    [actionId, firmId, clientId, String(reason || 'unspecified')]
  );
  if (!rows[0]) return null;
  const action = rows[0];
  // D1 counted set: an OWNER (non-system) cancel is a correction — a decline
  // of a held draft, or a pullback of a scheduled/approved send. System
  // cancels (send-time interlocks, settled anchors) are not corrections.
  if (actorType && actorType !== 'system') {
    await recordOutboundCorrection(client, {
      firmId, clientId, actionType: action.action_type,
      kind: action.prior_status === 'hold_for_approval' ? 'declined_held_draft' : 'cancelled_pre_send',
      refType: 'outbound_action', refId: actionId,
      actorType, actorId
    });
  }
  await insertOutboundReceipt(client, {
    firmId, clientId, actionId, actionType: action.action_type,
    targetPartyId: action.target_party_id, channel: 'email',
    outcome: 'cancelled', reason: String(reason || 'unspecified'),
    approvedBy: approvedBy || `${actorType}:${actorId || 'system'}`,
    authority: authority || 'cancel',
    model: action.model || 'deterministic:gate',
    checks, configSnapshotId: action.config_snapshot_id
  });
  await auditEvent(client, {
    firmId, clientId, actorType, actorId,
    action: 'outbound_action.cancelled', resourceType: 'outbound_action', resourceId: actionId,
    metadata: { reason: String(reason || 'unspecified'), action_type: action.action_type }
  });
  // S5 role event: a cancel of a HELD row is the item leaving the owner's
  // queue — declined by the owner, or withdrawn by Donna (settled anchor).
  // A pre-hold cancel (scheduled/approved) never rested on the owner, so no
  // handoff event exists to close.
  if (action.prior_status === 'hold_for_approval') {
    await recordOutboundRoleTransition(client, {
      firmId, clientId, action, transition: 'resumed_from_owner',
      outcome: actorType && actorType !== 'system' ? 'declined' : 'withdrawn',
      reasons: [String(reason || 'unspecified')],
      actorType, actorId
    });
  }
  return action;
};

// ── Executor support ─────────────────────────────────────────────────────────

// Plain read of due work (the sweep's scan; shadow mode reads, act mode
// claims per-row inside the executor's transaction).
export const listDueOutboundActions = async (client, {
  firmId, clientId, now = new Date().toISOString(), limit = 25
}) => {
  const bounded = Math.min(Math.max(Number(limit) || 25, 1), 200);
  const { rows } = await client.query(
    `select * from outbound_actions
      where firm_id = $1 and client_id = $2
        and status in ('scheduled', 'approved')
        and coalesce(scheduled_for, created_at) <= $3::timestamptz
      order by coalesce(scheduled_for, created_at) asc
      limit $4`,
    [firmId, clientId, now, bounded]
  );
  return rows;
};

// Claim ONE row for execution (caller is inside a transaction): re-checks the
// claimable state under FOR UPDATE SKIP LOCKED, flips the executing lease.
export const claimOutboundActionForExecution = async (client, {
  firmId, clientId, actionId, now = new Date().toISOString()
}) => {
  const { rows } = await client.query(
    `select * from outbound_actions
      where id = $1 and firm_id = $2 and client_id = $3
        and status in ('scheduled', 'approved')
        and coalesce(scheduled_for, created_at) <= $4::timestamptz
      for update skip locked`,
    [actionId, firmId, clientId, now]
  );
  if (!rows[0]) return null;
  await client.query(
    `update outbound_actions set status = 'executing', claimed_at = now(), updated_at = now()
      where id = $1`,
    [actionId]
  );
  return rows[0];
};

// Move a claimed row sideways without sending (fresh interlock verdicts at
// send time): back to the owner, or to a receipted terminal cancel.
export const holdClaimedOutboundAction = async (client, {
  firmId, clientId, actionId, reasons = []
}) => {
  const { rows } = await client.query(
    `update outbound_actions
        set status = 'hold_for_approval', claimed_at = null,
            gate_basis = gate_basis || $4::jsonb, updated_at = now()
      where id = $1 and firm_id = $2 and client_id = $3 and status = 'executing'
      returning *`,
    [actionId, firmId, clientId, JSON.stringify({ held_at_send: reasons })]
  );
  if (!rows[0]) return null;
  await auditEvent(client, {
    firmId, clientId,
    action: 'outbound_action.held_at_send', resourceType: 'outbound_action', resourceId: actionId,
    metadata: { reasons }
  });
  // S5 role event: a send-time hold rests the item back on the owner — the
  // role→owner handoff, recorded at the writer so every interlock (authority,
  // stale consequence, role leash) emits it. Soft; hired lanes only.
  await recordOutboundRoleTransition(client, {
    firmId, clientId, action: rows[0], transition: 'handed_to_owner', reasons
  });
  return rows[0];
};

export const cancelClaimedOutboundAction = async (client, {
  firmId, clientId, actionId, reason, approvedBy, authority, model, checks = []
}) => {
  const { rows } = await client.query(
    `update outbound_actions
        set status = 'cancelled', cancel_reason = $4, claimed_at = null, updated_at = now()
      where id = $1 and firm_id = $2 and client_id = $3 and status = 'executing'
      returning *`,
    [actionId, firmId, clientId, String(reason || 'unspecified')]
  );
  if (!rows[0]) return null;
  const action = rows[0];
  await insertOutboundReceipt(client, {
    firmId, clientId, actionId, actionType: action.action_type,
    targetPartyId: action.target_party_id, channel: 'email',
    outcome: 'cancelled', reason: String(reason || 'unspecified'),
    approvedBy, authority, model: model || action.model || 'deterministic:gate',
    checks, configSnapshotId: action.config_snapshot_id
  });
  await auditEvent(client, {
    firmId, clientId,
    action: 'outbound_action.cancelled', resourceType: 'outbound_action', resourceId: actionId,
    metadata: { reason: String(reason || 'unspecified'), at: 'send_time' }
  });
  return action;
};

// The sent-flip and its receipt commit together (caller's transaction): no
// receipt, no 'executed' — the finalizeSend pattern.
export const finalizeOutboundSend = async (client, {
  firmId, clientId, actionId, receipt, payloadPatch = null
}) => {
  // payloadPatch: additive jsonb merge stamped WITH the executed flip (e.g.
  // the AR leg's journal id, so owner surfaces read it off the action row
  // without a join). '{}' when absent — a no-op merge, existing callers
  // byte-identical.
  const { rows } = await client.query(
    `update outbound_actions
        set status = 'executed', send_error = null, claimed_at = null,
            payload = coalesce(payload, '{}'::jsonb) || $4::jsonb, updated_at = now()
      where id = $1 and firm_id = $2 and client_id = $3 and status = 'executing'
      returning *`,
    [actionId, firmId, clientId, JSON.stringify(payloadPatch || {})]
  );
  if (!rows[0]) return null;
  const action = rows[0];
  const { id: receiptId } = await insertOutboundReceipt(client, {
    firmId, clientId, actionId, actionType: action.action_type,
    targetPartyId: action.target_party_id, outcome: 'sent',
    configSnapshotId: action.config_snapshot_id, ...receipt
  });
  await auditEvent(client, {
    firmId, clientId,
    action: 'outbound_action.executed', resourceType: 'outbound_action', resourceId: actionId,
    metadata: {
      action_type: action.action_type, receipt_id: receiptId,
      provider_message_id: receipt.providerMessageId || null
    }
  });
  return { action, receiptId };
};

export const markOutboundActionFailed = async (client, {
  firmId, clientId, actionId, error, receipt
}) => {
  const { rows } = await client.query(
    `update outbound_actions
        set status = 'failed', send_error = $4, claimed_at = null, updated_at = now()
      where id = $1 and firm_id = $2 and client_id = $3 and status = 'executing'
      returning *`,
    [actionId, firmId, clientId, String(error || 'send failed').slice(0, 500)]
  );
  if (!rows[0]) return null;
  const action = rows[0];
  await insertOutboundReceipt(client, {
    firmId, clientId, actionId, actionType: action.action_type,
    targetPartyId: action.target_party_id, outcome: 'failed',
    reason: String(error || 'send failed').slice(0, 500),
    configSnapshotId: action.config_snapshot_id, ...receipt
  });
  await auditEvent(client, {
    firmId, clientId,
    action: 'outbound_action.failed', resourceType: 'outbound_action', resourceId: actionId,
    metadata: { action_type: action.action_type, error: String(error || 'send failed').slice(0, 500) }
  });
  return action;
};

// Stale executing leases (a crash between claim and finalize). Surfaced,
// never auto-retried — a possibly-sent send must not be re-sent. M1's digest
// renders these as a MUST-REVIEW row.
export const listStaleExecutingActions = async (client, {
  firmId, clientId, olderThanMinutes = 15, limit = 50
}) => {
  const { rows } = await client.query(
    `select * from outbound_actions
      where firm_id = $1 and client_id = $2 and status = 'executing'
        and claimed_at < now() - ($3 || ' minutes')::interval
      order by claimed_at asc
      limit $4`,
    [firmId, clientId, String(Number(olderThanMinutes) || 15), Math.min(Math.max(Number(limit) || 50, 1), 200)]
  );
  return rows;
};

export { OUTBOUND_ACTION_STATUSES };
