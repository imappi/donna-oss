import { isCodingPolicyError } from './codingPolicy.js';
import {
  DEFAULT_FIRM_ID,
  appendClientPortalChatMessageInDb,
  getClientPortalChatThreadFromDb,
  getClientChatProfileFromDb,
  getClientEvidenceRequestsFromDb,
  getClientPortalChatDocsFromDb,
  getFeedChatRowsFromDb,
  getLedgerPeriodPreviewFromDb,
  withFirmDbClient
} from './firmDb.js';
import { getFirmFactsForSubjects } from './firmFacts.js';
import { buildClientPortalChatContext, compressLedgerSummary } from './clientPortalChat.js';
import { captureRetrievalRequestSnapshot } from './memoryRetrievalShadow.js';
import { buildOwnerTurnMemory } from './ownerMemorySeam.js';
import { buildSelfKnowledgeContext } from './selfKnowledge.js';
import { buildKnowledgeGrounding } from './knowledgeAnswerSeam.js';
import { readClientConfigSnapshot, configSnapshotId } from './clientConfig.js';
import {
  composeKnowledgeAnswerWithModel,
  knowledgeComposeConfigured,
  knowledgeComposeModelId
} from './knowledgeCompose.js';
import { toLocalIsoDay, toUtcIsoDay } from './dates.js';

export const assembleClientPortalTurn = async ({
  firmId,
  clientId,
  userMessageRow = null,
  ownerPrincipal = null,
  now = new Date(),
  // Operational self-knowledge (selfKnowledge.js): which surface this turn is
  // on (SELF_KNOWLEDGE_SURFACES: 'client_portal' | 'owner_channel' |
  // 'external_chat', the hosted chat hosts via ask_donna) and, for a channel
  // turn, which channel. Only the flag-gated pack reads these; legacy
  // behaviour is untouched when the flag does not act (pack = null).
  surface = 'client_portal',
  channel = null,
  deps = {}
} = {}) => {
  const d = {
    getThread: deps.getThread || getClientPortalChatThreadFromDb,
    getProfile: deps.getProfile || getClientChatProfileFromDb,
    getEvidenceRequests: deps.getEvidenceRequests || getClientEvidenceRequestsFromDb,
    getDocs: deps.getDocs || getClientPortalChatDocsFromDb,
    getFeedRows: deps.getFeedRows || getFeedChatRowsFromDb,
    getLedgerPreview: deps.getLedgerPreview || getLedgerPeriodPreviewFromDb,
    withFirmDbClient: deps.withFirmDbClient || withFirmDbClient,
    getFirmFacts: deps.getFirmFacts || getFirmFactsForSubjects,
    buildOwnerTurnMemory: deps.buildOwnerTurnMemory || buildOwnerTurnMemory,
    buildSelfKnowledge: deps.buildSelfKnowledge || buildSelfKnowledgeContext,
    buildKnowledgeGrounding: deps.buildKnowledgeGrounding || buildKnowledgeGrounding
  };
  const effectiveFirmId = firmId || DEFAULT_FIRM_ID;
  const history = await d.getThread({ firmId, clientId });
  const clientProfile = await d.getProfile({ firmId, clientId }).catch((err) => {
    if (isCodingPolicyError(err)) throw err;
    console.warn('[client-chat] client profile lookup failed', err?.message || err);
    return null;
  });
  // DMEM-R1 W1 (INV-14): a `draft` is a live question on the owner — minted,
  // not yet delivered by a channel — and the owner's own portal turn is the one
  // place it can already be answered, so it is in the owner's context.
  const openAsks = await d.getEvidenceRequests({ firmId, clientId, status: 'draft,open,replied' })
    .then((result) => (Array.isArray(result?.requests) ? result.requests : []))
    .catch((err) => {
      console.warn('[client-chat] evidence requests lookup failed', err?.message || err);
      return [];
    });
  const { rows: docRows, totalCount: docTotal } = await d.getDocs({ firmId, clientId }).catch((err) => {
    console.warn('[client-chat] documents lookup failed', err?.message || err);
    return { rows: [], totalCount: 0 };
  });
  const { rows: feedRows, totalCount: txTotal } = await d.getFeedRows({ firmId, clientId, limit: 200 }).catch((err) => {
    console.warn('[client-chat] transactions lookup failed', err?.message || err);
    return { rows: [], totalCount: 0 };
  });
  const firmFacts = await d.withFirmDbClient((dbClient) => d.getFirmFacts({
    client: dbClient,
    firmId: effectiveFirmId,
    chatAdmission: true, // FIK-0b: no jurisdiction-scope rule grounds an owner answer
    subjects: [
      { scope: 'client', value: clientProfile?.registration_number || clientProfile?.name || '' },
      { scope: 'jurisdiction', value: clientProfile?.jurisdiction || '' }
    ]
  })).catch((err) => {
    console.warn('[client-chat] firm facts lookup failed', err?.message || err);
    return [];
  });
  // The host-local "today" decides which month is current (audit F-11); the
  // month's edges are then bare-day arithmetic in Date.UTC space — UTC on
  // purpose, so the host zone cannot move them again.
  const clock = now instanceof Date ? now : new Date(now);
  const [year, month] = toLocalIsoDay(clock).split('-').map(Number);
  const monthStart = toUtcIsoDay(Date.UTC(year, month - 1, 1));
  const monthEnd = toUtcIsoDay(Date.UTC(year, month, 0));
  const ledgerSummary = await d.getLedgerPreview({ firmId, clientId, periodStart: monthStart, periodEnd: monthEnd })
    .then(compressLedgerSummary)
    .catch((err) => {
      console.warn('[client-chat] ledger summary lookup failed', err?.message || err);
      return null;
    });
  const context = buildClientPortalChatContext({ clientProfile, openAsks, documents: docRows, transactions: feedRows, totalTransactionCount: txTotal, totalDocumentCount: docTotal, ledgerSummary, firmFacts });
  const memoryRetrievalSnapshot = userMessageRow && ownerPrincipal ? captureRetrievalRequestSnapshot({
    firmId: effectiveFirmId,
    clientId,
    sourceMessageId: userMessageRow.id,
    ownerPrincipal,
    firmFacts,
    occurredAt: clock,
    conversationBoundaryMessageId: userMessageRow.id
  }) : null;
  const ownerMemory = memoryRetrievalSnapshot ? await d.withFirmDbClient((memClient) => d.buildOwnerTurnMemory({
    client: memClient,
    firmId: effectiveFirmId,
    clientId,
    baseContext: context,
    history: history.slice(0, -1),
    snapshot: memoryRetrievalSnapshot
  })).catch((err) => {
    console.warn('[client-chat] memory seam failed (fail-safe to legacy)', err?.message || err);
    return null;
  }) : null;
  // Operational self-knowledge pack (flag-gated, SELF_KNOWLEDGE_CONTEXT). null
  // for every un-staged client — the prompt stays byte-identical. Fail-safe to
  // null: a pack failure must never break the owner turn.
  const selfKnowledge = await d.withFirmDbClient((skClient) => d.buildSelfKnowledge({
    client: skClient,
    firmId: effectiveFirmId,
    clientId,
    clientProfile,
    surface,
    channel
  })).catch((err) => {
    console.warn('[client-chat] self-knowledge seam failed (fail-safe to none)', err?.message || err);
    return null;
  });
  // K1 sourced-knowledge grounding (flag-gated, KNOWLEDGE_BASE_RETRIEVAL, born
  // off — §10/§15). null for every un-staged client, so the prompt stays
  // byte-identical; and with an empty corpus every grounded answer is the
  // deterministic outcome 4 (refusal). The per-client config snapshot is read
  // here (corpus spec §7 B4) so the flag is STAGEABLE — a control-plane row,
  // never an env pair; with no row, envFallback () => false keeps it off.
  // `compose` (§7 B3) is injected from HERE, never imported by the seam, so the
  // seam's import set and the boundary allowlist stay untouched; when the model
  // call is unconfigured, compose stays null and only the deterministic
  // outcomes render — with `composedBy` null, because no model answered.
  // Fail-safe to null: a K1 failure must never break the owner turn.
  const questionText = userMessageRow?.content ?? '';
  const composeConfigured = deps.knowledgeCompose !== undefined
    ? deps.knowledgeCompose !== null
    : knowledgeComposeConfigured();
  const knowledgeCompose = deps.knowledgeCompose !== undefined
    ? deps.knowledgeCompose
    : (composeConfigured
      ? (args) => composeKnowledgeAnswerWithModel({ ...args, questionText })
      : null);
  const knowledgeGrounding = userMessageRow ? await d.withFirmDbClient(async (kbClient) => {
    const configSnapshot = await readClientConfigSnapshot(kbClient, { firmId: effectiveFirmId, clientId })
      .catch(() => null);
    return d.buildKnowledgeGrounding({
      client: kbClient,
      clientId,
      clientProfile,
      questionText,
      occurredAt: clock,
      sourceEventId: userMessageRow?.id ?? null,
      openAsks,
      surface,
      configSnapshot,
      configSnapshotId: configSnapshotId({ firmId: effectiveFirmId, clientId, snapshot: configSnapshot }),
      // The ANSWERING model, recorded only when a compose call can actually run
      // (the model id is part of the receipt — never inferred from defaults).
      modelId: composeConfigured ? knowledgeComposeModelId() : null,
      deps: { compose: knowledgeCompose }
    });
  }).catch((err) => {
    console.warn('[client-chat] knowledge grounding seam failed (fail-safe to none)', err?.message || err);
    return null;
  }) : null;
  return {
    context,
    history,
    openAsks,
    validAskIds: openAsks.map((ask) => ask.id).filter(Boolean),
    assistantName: clientProfile?.assistant_name || null,
    ownerMemory,
    memoryRetrievalSnapshot,
    selfKnowledge,
    knowledgeGrounding,
    firmFacts,
    effectiveFirmId
  };
};

export const persistClientPortalTurnMessage = appendClientPortalChatMessageInDb;
