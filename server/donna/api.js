import { handlePhysicalReconciliationRequest } from './inventory/physicalReconciliationApi.js';
import { handleCaptureAccessRequest, CAPTURE_API_PATH } from './inventory/captureAccessApi.js';
import { readJevCase } from './jevPreview.js';
import { completeOwnerCompanySetup } from './ownerCompanySetup.js';
import { resolveFirmIntakeIdentity } from './clientIntakeIdentity.js';
import { readNativeProcessingSelectionWithClient } from './hostedFirmIntake.js';
import { buildFirmReadFailureDiagnostic } from './firmReadFailureDiagnostics.js';
import { readFirmDbPoolCounts } from './db/pool.js';
import { resolveDeploymentReceipt } from './runtimeHostIdentity.js';
import { captureFiChatCodingEvidence, assertChatCodingEvidence } from './db/codingEvidence.js';
import { readFinnishProfileIntakeWithClient } from './clientLifecycleRegistry.js';
import { handleFinnishPilotOperator } from './hostedPilotOperator.js';
import { reviewCloudPilotOperations,enableCloudPilotProcessing,runCloudPilotDependencyProbes } from './cloudPilotOperations.js';
import { reviewInternalPilotSendRelease,releaseInternalPilotSendContainment,authorizePilotSendRelease } from './internalPilotSendRelease.js';
import { readInternalPilotSendRestrictionWithClient } from './internalPilotAccess.js';
import { createCloudPilotUpload, lockUploadClientInFirm } from './cloudEvidenceIntake.js';
import { requireClientInFirm } from './db/clients.js';
import { actAeOpeningFromDb, readAeOpeningFromDb } from './ae/openingBalanceDb.js';
import { resolveSellerJurisdiction } from './ownerInvoiceSellerContext.js';
import { Buffer } from 'node:buffer';
import { validateCodingPolicyForChatActionInDb, captureNativeChatCodingContextWithClient, revalidateNativeChatCodingContextWithClient } from './db/coding.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { isCodingPolicyError } from './codingPolicy.js';
import { extractBizfilePdfTextFromBase64 } from './bizfilePdf.js';
import { extractClientIntakeDraft } from './clientIntakeDraft.js';
import { ACCOUNTING_IMPORT_LIMITS, inspectAccountingImport } from './accountingImport.js';
import { resolveRequestFirmId, resolveAuthenticatedMemberFirm } from './requestFirm.js';
import { getSingaporeGstDraftArtifactFromDb, singaporeGstDraftFilename } from './statutoryRegistry.js';
import { selfProvisionFirmWorkspace } from './firmSelfProvision.js';
import { toIsoDay } from './dates.js';
import { getProviderFailuresFromDb } from './providerFailureReadModel.js';
import {
  buildEvidenceStorageKey,
  createEvidenceSignedUploadUrl,
  createEvidenceSignedUrl,
  assertEvidenceDownloadReference,
  deleteEvidenceObjects,
  isLocalEvidenceStorage,
  LOCAL_EVIDENCE_PATH,
  listEvidenceObjects,
  loadLocalEvidenceObject,
  verifyLocalEvidenceAccess
} from './evidenceStorage.js';
import {
  checkEntityReadinessAdmissionWithClient,
  readRetainedProcessingScopeInDb,
  EntityReadinessAdmissionError
} from './runtimeReadinessAdmission.js';
import {
  fetchDistinctStorageBucketsInDb,
  fetchDrainablePendingRowsInDb,
  fetchOutboxPendingRowsInDb,
  fetchReferencedStorageKeysInDb,
  failStuckProcessingRowsInDb,
  getDocumentForParseInDb,
  getDocumentLinesForFirmInDb,
  getParseStatusForDocumentsInDb,
  logStorageOrphanCleanedInDb,
  markParseEventSentInDb,
  markParseFailedInDb,
  registerDocumentInDb,
  resolveDuplicateInDb,
  retryParseRunsInDb,
  runReconciliationForBankStatementInDb,
  selectStorageOrphans
} from './parseDocumentsDb.js';
import { patchDocumentLineInDb } from './documentLinePatch.js';
import { runCodingAutoPostForTransaction, sweepCodingAutoPost } from './codingAutoPost.js';
import { runCodingConvergenceInDb } from './codingConvergence.js';
import { listRuntimePolicyIncidents, claimRuntimePolicyIncident } from './runtimePolicyIncidentDb.js';
import { retryRuntimePolicyIncidentInDb } from './runtimePolicyRepairs.js';
// RT-16 — the ONE coding state projected to the legacy label the routes speak.
import { legacyReviewStateFor } from './codingState.js';
import { buildFinancialReportCsv, buildFinancialReportPdf, financialReportFilename } from './financialReportExport.js';
import {
  ALLOWED_CORRECTION_FIELDS,
  getDocumentCorrectionsFromDb,
  recordDocumentCorrectionInDb
} from './documentCorrections.js';
import { runParseInline, sendParseDocumentEvent } from './inngest/parseDocument.js';
import {
  PARSE_DOCUMENT_MAX_ATTEMPTS_DEFAULT,
  parseDocumentMaxAttempts,
  requestParseRun
} from './desktop/parseDocumentJob.js';
import { categorizeError, withRetryOwner, parseRetriesExhaustedEnvelope } from './inngest/parseErrors.js';
import { prepareGbVatReturnFromDb, getGbStatutoryReportFromDb, buildGbLtdCloseRefusalEnvelope } from './statutoryRegistry.js';
import { ownerVatReturnFromDb } from './ownerVatReturnSurface.js';
import { isInngestConfigured } from './inngest/client.js';
import { REVERSE_ACTION_TYPE } from './operatorCapability.js';
import {
  assertFirmAccess,
  assertActionCapability,
  reverseAppliesInDb,
  assertFirmScopeAllowed,
  deleteClientInDb,
  getClientAccountingSystemFromDb,
  startHmrcConnectionInDb,
  completeHmrcConnectionInDb,
  updateClientProfileInDb,
  registerFiscalPeriodFromDb,
  listFiscalPeriodsFromDb,
  updateFirmLoopSettingsInDb,
  queryFirmDb,
  acceptClientEvidenceRequestInDb,
  batchSuggestTransactionCodingInDb,
  createClientEvidenceRequestInDb,
  getAssignmentRoleForPrincipal,
  cancelClientEvidenceRequestInDb,
  amendClientEvidenceRequestInDb,
  resendClientEvidenceRequestInDb,
  getOpenClientEvidenceRequestsForChatFromDb,
  createClientInDb,
  resolveDesktopClientCreationPrincipal,
  draftClientAskBatchInDb,
  getAskBatchDraftsForFirmFromDb,
  getClientAskBatchesFromDb,
  sendClientAskBatchInDb,
  createCloseArchiveInDb,
  filterFirmSnapshotForAccess,
  getAuthorizedFirmSnapshotFromDb,
  getCloseArchivePreviewFromDb,
  getCloseArchiveExportFromDb,
  getCloseDiagnosticsFromDb,
  getCloseExceptionsFromDb,
  getClientAccountOptionsFromDb,
  getClientChatProfileFromDb,
  getClientEvidenceRequestsFromDb,
  getFeedChatAgreementDocsFromDb,
  getFeedChatPipelineDocsFromDb,
  getFeedChatRowsFromDb,
  getFinancialReportFromDb,
  getLatestPostedLedgerPeriodFromDb,
  getFinlandIssuedInvoicesFromDb,
  getFinlandQuotesFromDb,
  getProcountorExportPackageFromDb,
  getFirmSnapshotFromDb,
  listFirmIdsInDb,
  getLedgerAuditTrailFromDb,
  getLedgerPeriodPreviewFromDb,
  isFirmDatabaseConfigured,
  isSeedFallbackAllowed,
  lockClosePeriodInDb,
  postLedgerAdjustmentInDb,
  postLedgerPeriodInDb,
  postLedgerTransactionInDb,
  refreshTransactionIntelInDb,
  runCloseChecksInDb,
  rejectClientEvidenceRequestInDb,
  recordDocumentSignedUrlCreatedInDb,
  recordEvidenceTopicTurnInDb,
  resolveClientEvidenceRequestInDb,
  __normalizeAnswerSource,
  suggestTransactionCodingInDb,
  completeXeroConnectionInDb,
  completeQboConnectionInDb,
  completeProcountorConnectionInDb,
  connectProcountorWithApiKeyInDb,
  disconnectQboConnectionInDb,
  disconnectProcountorConnectionInDb,
  disconnectXeroConnectionInDb,
  createManualReconciliationMatchInDb,
  appendClientPortalChatMessageInDb,
  appendDocumentChatMessageInDb,
  redactChatCommentInDb,
  appendFirmChatMessageInDb,
  appendTransactionChatMessageInDb,
  getClientPortalChatDocsFromDb,
  getFirmChatMessageFromDb,
  getFirmChatThreadFromDb,
  updateFirmChatActionStatusInDb,
  getClientPortalChatThreadFromDb,
  getDocumentChatMessageFromDb,
  getDocumentChatThreadFromDb,
  getTransactionChatMessageFromDb,
  getTransactionChatThreadFromDb,
  getTransactionChatUnreadSummaryFromDb,
  updateDocumentChatActionStatusInDb,
  updateTransactionChatActionStatusInDb,
  mintWhatsAppBindTokenInDb,
  redeemWhatsAppBindTokenInDb,
  revokeWhatsAppBindingInDb,
  getActiveWhatsAppBindingForClientInDb,
  getActiveWhatsAppBindingsByPhoneHashInDb,
  getActiveSmsBindingsByPhoneHashInDb,
  getActiveTelegramBindingsByPhoneHashInDb,
  getActiveTelegramBindingForClientInDb,
  recordMessageDeliveryLedgerInDb,
  deleteDocumentInDb,
  getDocumentClientIdInDb,
  updateDocumentInDb,
  updateClientRuleStatusInDb,
  updateReconciliationMatchInDb,
  DECIDED_TRANSACTION_REVIEW_STATES,
  ensureTransactionReviewItemInDb,
  updateTransactionReviewItemInDb,
  updateTransactionInDb,
  withFirmDbClient,
  listFirmChatVentureUniverseInDb,
  countRecentFirmChatUserMessagesInDb,
  saveMerchantRuleForPayload,
  getFirmPrincipalForAuth,
  deliverEvidenceAsksOnAllChannels,
  DEFAULT_FIRM_ID,
  resolveClientCreateFirmIdInDb,
  adoptResolvedDefaultFirmId,
  findLedgerAccountByNameOrAlias
} from './firmDb.js';
import {
  getFinlandAnnualReturnFromDb,
  getFinlandAlvReturnFromDb,
  getGbLtdMonthlyCloseFromDb,
  getFinlandAlvThresholdWatchFromDb,
  getAlvReturnForPeriodInDb,
  getSuomifiMandateStatusInDb,
  recordSuomifiMandateInDb,
  revokeSuomifiMandateInDb,
  getFinlandScopeDriftFromDb,
  getFinlandOyOnboardingStateFromDb,
  getFinlandYelStatusFromDb,
  getFinlandEnnakkoveroStatusFromDb,
  getFinlandPrepaymentRegisterFromDb,
  getFinlandCutoverPackFromDb,
  recordPrepaymentRegisterCheckInDb,
  startFinlandAlvReturnFilingInDb
} from './statutoryRegistry.js';
import { buildModelLaneReceipt } from './desktop/capabilityReceipt.js';
import { isDesktopHostEnv, seedDesktopFirmMetadataWithClient } from './desktop/hostPlaneSeed.js';
import { mintFirstRunFirm, normalizeFirstRunInput } from './desktop/firstRunFirmMint.js';
import { runtimeLivenessProbe } from './desktop/runtimeLiveness.js';
import { runCanonicalRoleResolutionForClient, runCanonicalRoleResolutionSweep } from './canonicalRoleResolutionDb.js';
import { assessEvidenceTopicTurn, buildEvidenceTopicState } from './channels/inboundCore.js';
import { resolveStructuredOwnerReplyAdapter, supportsStructuredOwnerReply } from './statutoryRegistry.js';
import { runEvidenceTopicReminderSweep } from './channels/evidenceTopicReminders.js';
import { recordConvergenceMetricsSnapshot, computeAskClockMetrics } from './convergenceMetricSnapshots.js';
import { addToWaitlist } from './marketingWaitlistDb.js';
import { recordUserFeedbackInDb } from './userFeedback.js';
import { putLocalEvidenceForToken } from './localEvidencePut.js';
import { handleMarketingAdminApi, handleMarketingInboundWebhook, handleMarketingUnsubscribe } from './marketing/marketingRoutes.js';
import { handleMcpApiRequest } from './mcp/mcpApi.js';
import { handleMcpRemoteRequest, isMcpRemotePath } from './mcp/mcpRemoteAdapter.js';
import { listEntityExposure, setEntityExposure } from './mcp/mcpConsent.js';
import {
  listFirmSeats,
  inviteSeatInDb,
  updateSeatInDb,
  setSeatEntitiesInDb,
  sendSeatInviteEmail,
  recordSeatInviteEmailOutcome,
  resendSeatInviteEmail,
  assertExternalChaseReleaseAllowed,
  assertSeatExportAllowed
} from './seatsDb.js';
import {
  getClientOwnerAccessInDb,
  inviteClientOwnerInDb,
  resendClientOwnerInviteInDb,
  revokeClientOwnerInviteInDb,
  removeClientOwnerAccessInDb,
  recordClientOwnerInviteEmailOutcomeInDb,
  sendClientOwnerInviteEmail,
  acceptClientOwnerInviteInDb,
  principalIsFirmInvitedOwnerInDb,
  readFirmNameInDb
} from './clientOwnerInvitesDb.js';
import {
  handleOutboundUnsubscribe, handleOutboundApproval, handleOutboundPayLinkWebhook,
  handleOutboundReplyWebhook
} from './outbound/outboundRoutes.js';
import {
  readOwnerActionsSurface, decideOwnerAction, editOwnerHeldDraft, actOnOwnerReceivableCase,
  markOwnerAutoSentWrong, reverseOwnerAutoSentPost, setOwnerActionPartyLanguage
} from './outbound/ownerActionsSurface.js';
import { runStatutoryObligationSweep } from './outbound/statutoryObligations.js';
import { getClientBillingContext, assertClientEntitled } from './clientSubscriptionDb.js';
import { sendWhatsAppText } from './channels/whatsapp.js';
import { sendSmsText } from './channels/sms.js';
import { sendTelegramText, telegramEnvAllowsClient } from './channels/telegram.js';
import { processWhatsAppInboundMessage, handleWhatsAppComplianceCommand } from './channels/whatsappInbound.js';
import { ownerChannelAllowsClient, prefetchOwnerChannelGateContext } from './channels/ownerChannelConfig.js';
import { whatsappEnvAllowsClient } from './channels/whatsappWebhookCore.js';
import { processSmsInboundMessage, handleSmsComplianceCommand, SMS_INBOUND_COPY } from './channels/smsInbound.js';
import { processTelegramInboundMessage, handleTelegramComplianceCommand, TELEGRAM_INBOUND_COPY } from './channels/telegramInbound.js';
import { runOwnerMediaTerminalSummarySweep } from './channels/ownerMediaParseSummary.js';
import {
  extractBindingToken,
  hashPhoneE164,
  hashWhatsAppToken,
  verifyMetaWebhookSignature,
  whatsappJson
} from './channels/whatsappWebhookCore.js';
import { parseTwilioForm, smsJson, twilioRequestUrl, verifyTwilioWebhookSignature } from './channels/smsWebhookCore.js';
import { telegramJson, verifyTelegramWebhookSecret, extractTelegramStartToken, isBareTelegramStart, telegramChatKey, telegramInboundMessageId, telegramSenderVerdict } from './channels/telegramWebhookCore.js';
import { selfProvisionClientWorkspace } from './selfProvisionDb.js';
import { provisionEntityReadiness } from './runtimeReadiness.js';
import { renewCloudHostReadinessIfDue, withCloudReadinessClient } from './cloudRuntimeReadiness.js';
import {
  isSelfServeProvisioningEnabled,
  provisionClientWorkspaceForAuth
} from './selfServeProvisioning.js';
import {
  isAuthEmailHookEnabled,
  verifyHookSignature,
  handleAuthEmailHookPayload
} from './email/authEmailHook.js';
import {
  isBillingEnabled,
  isWebhookConfigured,
  createBillingPortalSession,
  constructWebhookEvent,
  applyWebhookEvent
} from './stripeBilling.js';
import { getAccountingSystemAdapter } from './accountingSystems/index.js';
import { resolveOAuthCallbackOrigin, buildOAuthCallbackUrl } from './oauthCallbackOrigin.js';
import { verifyProcountorState } from './procountorClient.js';
import { dismissFirmFact, eraseFirmFact, getFirmFactsForSubjects, getFirmFactsForTransactionCase, listFirmFacts } from './firmFacts.js';
import { computeModelLaneReport } from './modelLaneReport.js';
import { decideJevReconciliation, jevDecisionPreview } from './jevRuntimeDecision.js';
import { setLaneDecidingPolicy, clearLaneDecidingPolicy } from './modelLanePolicy.js';
import { memoryPacketObserves } from './memoryPacket.js';
import {
  playbookRetrievalActs,
  playbookRetrievalObserves,
  selectPlaybooksForCase,
  renderPlaybooksForPrompt,
  playbookIdsFromMessagePayload
} from './bookkeepingPlaybooks.js';
import { recordMerchantSignalInDb } from './merchantSignals.js';
import { getFirmSeedSnapshot } from './firmSeeds.js';
import { buildFirmFeed } from './firmFeed.js';
import {
  buildDocumentChatContext,
  bindDocumentChatCorrectionTarget,
  DOCUMENT_CHAT_APPLIABLE_ACTION_TYPES,
  evaluateMarkImmaterialPreflight,
  generateDocumentChatReply,
  newMessageId
} from './documentChat.js';
import { getDispositionMaterialityPolicy } from './dispositionMateriality.js';
import {
  buildTransactionChatContext,
  compactMerchantKey,
  fetchActiveTransactionMatch,
  fetchTransactionChatCandidateDocuments,
  fetchTransactionChatCollisionGroup,
  TRANSACTION_CHAT_ALL_APPLIABLE_ACTION_TYPES,
  generateTransactionChatReply,
  newTransactionChatMessageId,
  buildApplyCategoryCodingPatch
} from './transactionChat.js';
import {
  validateCorrectionFieldsForApply,
  buildCorrectionTeachingReceipt
} from './correctionTeaching.js';
import {
  buildFeedChatContext,
  buildFirmFactsAvailableByClient,
  buildFirmFeedChatContext,
  FEED_CHAT_ALL_APPLIABLE_ACTION_TYPES,
  FEED_CHAT_MAX_PIPELINE_STATES,
  FEED_CHAT_MAX_SELECTED_DOCUMENTS,
  FEED_CHAT_TRANSACTION_ID,
  FIRM_FEED_CHAT_THREAD,
  generateFeedChatReply,
  generateFirmFeedChatReply,
  MAX_FIRM_CHAT_CLIENTS,
  MAX_FIRM_FEED_ROWS_PER_CLIENT,
  newFeedChatMessageId,
  roleChatThreadId,
  selectFirmApplyFacts
} from './feedChat.js';
import { applyFeedChatAction } from './feedChatApply.js';
import { hydrateFinancialReportActions } from './financialReportChat.js';
// S3 (specialist-roles doc §5): the roster read + the four employment writers.
// The routes below add auth + transport ONLY — hire/end/approve/revoke all
// land on roleEmployment.js's writers (INV-S1: no forked writers), each in one
// caller-owned transaction, actor_type 'owner' with the real principal id.
import { benchUiMode, listSpecialistAssignments, listRoleAuthorityGrants, readRoleRoster } from './roles/roleRoster.js';
import {
  hireRole, endRoleAssignment, approveRoleGrant, revokeRoleGrant,
  readActiveSpecialistAssignment, grantableActionsForRole
} from './roles/roleEmployment.js';
import { AI_PROFILES, findRoleDefinition } from './roles/roleRegistry.js';
import {
  CLIENT_PORTAL_CHAT_APPLIABLE_ACTION_TYPES,
  findClientPortalReportRequest,
  generateClientPortalChatReply,
  generateClientPortalReportNarration,
  newClientPortalChatMessageId,
  projectClientChatThreadForOwner
} from './clientPortalChat.js';
import { onOwnerMessagePersisted } from './intentCompilerShadow.js';
import { listOwnerIntentProposalCards, withdrawOwnerIntentProposalCard } from './proposalStore.js';
import { attemptOwnerIntentProposalAccept, prepareOwnerIntentProposalPreflight } from './ownerIntentRuntime.js';
import { ownerActorAttribution } from './ownerActorAttribution.js';
import { onOwnerTurnMemoryShadow } from './memoryRetrievalShadow.js';
import { controlledMemoryUnavailableText } from './ownerMemorySeam.js';
import { assembleClientPortalTurn } from './clientPortalTurn.js';
import { applyClientChatAction } from './clientChatApply.js';
import { buildFeedEventsFromDb } from './feedEvents.js';
import { attemptLedgerReclass } from './ledgerReclass.js';
import { gateChatApplyAction, executeChatApplyAction, auditChatApplyEvent, chatApplyActorId } from './chatApplySpine.js';
import {
  validateMentionSubmission,
  validateDirectAgentChatRef,
  filterMentionRoster
} from './mentions/mentionResolution.js';
import { buildMentionRosterForClient } from './mentions/mentionRosterDb.js';
import { buildCommentPayload, buildThreadResolutionPayload } from './mentions/commentEvents.js';
import { projectChatMessageForViewer, projectChatMessagesForViewer } from './chatViewerProjection.js';
import { buildMentionNotificationRows, buildNotificationPayload, buildMentionDigest } from './mentions/notificationEvents.js';
import { listMentionNotifications, countUnreadMentionNotifications, markMentionNotificationsRead, listOpenSeatAsksForPrincipal } from './mentions/notificationsDb.js';
import { decideSeatAuthority } from './seatAuthority.js';
import { resolveCapabilityClass } from './operatorCapability.js';
import { decideInstructedAgentAction, agentEffectiveCapabilityClass } from './roles/roleAuthority.js';
import { AGENT_ASK_LOOP_KEY, AGENT_ANSWER_ACTION_TYPE, drainAgentAskAnswers } from './agentAskAnswerConsumer.js';
import {
  onAgentAskCreatedRequestAnswer,
  onReconcileCompleteRequestAskDraft
} from './loopsShadowProducers.js';
import { toLocalIsoDay } from './dates.js';

// /assign eligibility (mentions slice 4): the artifact's materiality, minor
// units, resolved from the artifact row itself — a transaction's largest
// money leg, a document's total. Null when unresolvable, which for a BOUNDED
// assignee role fail-closes upward in decideSeatAuthority (amount_unresolved
// routes, never slips through), the same law the seat apply lane runs.
const resolveMentionArtifactAmountMinor = async ({ firmId, clientId, surface, threadId }) => {
  try {
    if (surface === 'document_chat') {
      const r = await queryFirmDb(
        'select total_amount from documents where firm_id = $1 and client_id = $2 and id = $3 limit 1',
        [firmId, clientId, threadId]
      );
      const amount = Number(r.rows?.[0]?.total_amount);
      return Number.isFinite(amount) && amount !== 0 ? Math.round(Math.abs(amount) * 100) : null;
    }
    const r = await queryFirmDb(
      'select money_in, money_out from transactions where firm_id = $1 and client_id = $2 and id = $3 limit 1',
      [firmId, clientId, threadId]
    );
    const row = r.rows?.[0];
    if (!row) return null;
    const amount = Math.max(Math.abs(Number(row.money_in) || 0), Math.abs(Number(row.money_out) || 0));
    return amount > 0 ? Math.round(amount * 100) : null;
  } catch {
    return null;
  }
};

// @Donna is a structured address on the artifact's EXISTING synchronous
// Donna chat turn. It is not a comment-only FYI and it does not fork a second
// chat engine. Resolve the client-supplied ref against the same eligible roster
// as /chat-comments; raw text is never parsed for actor identity (D6).
const resolveDirectDonnaChatRef = async ({ firmId, clientId, ref }) => {
  if (!ref) return null;
  const roster = await buildMentionRosterForClient({
    firmId: firmId || DEFAULT_FIRM_ID,
    clientId
  });
  const submission = validateDirectAgentChatRef({ ref, roster });
  if (!submission.ok) {
    const error = new Error('The addressed agent did not resolve to Donna for this artifact.');
    error.statusCode = 400;
    error.code = submission.refusals[0]?.reason || 'direct_agent_not_resolved';
    error.refusals = submission.refusals;
    throw error;
  }
  return submission.resolved[0];
};
import {
  onFeedChatActionApplied,
  onTransactionChatActionApplied,
  onDocumentChatActionApplied,
  shadowRiskContextObserves
} from './feedChatProposalShadow.js';
// Slice F per-client gate: the config-plane snapshot read that decides, per client, whether the
// shadow capture enriches with riskContext (consulted via shadowRiskContextObserves below).
import { readClientConfigSnapshot, clientFlagActs } from './clientConfig.js';
// The goal-first loop's MASTER switch. `isLoopsShadowEnabled` (loopsShadowProducers.js,
// no longer imported here — DMEM-R1 W1 re-pointed the last two raw reads in this
// file, the /memory-candidates routes, onto the MEMORY_CANDIDATES plane key) reads
// the legacy LOOPS_SHADOW env ONLY; `isLoopSystemEnabled` resolves the tier ladder
// (LOOPS_TIER || LOOPS_SHADOW) that loopExecutionGate.js documents as "the
// drain-level master switch — replaces isLoopsShadowEnabled() at the drain
// entry", and is what every loop WORKER already gates on internally
// (loopInboxWorker.js, loopOutboxDispatcher.js, reconciliationEvalConsumer.js).
// The route-level gates below had never been migrated, so an operator who set
// LOOPS_TIER (the desktop appliance does — hostRuntimeDefaults.js ships
// LOOPS_TIER=canary) got a cron entry that skipped before the worker it gates
// ever ran. Back-compat is exact for the cloud, whose env sets LOOPS_SHADOW and
// no LOOPS_TIER: both predicates return true. It is strictly MORE correct at the
// edge — an explicit LOOPS_TIER=off now darkens these too, where the raw-env
// predicate would have let them run.
import { isLoopSystemEnabled, decideLoopExecution, readFirmExecutionContext } from './loopExecutionGate.js';
import { drainLoopInbox } from './loopInboxWorker.js';
import { dispatchLoopOutbox } from './loopOutboxDispatcher.js';
import { drainReconciliationEvalRequests } from './reconciliationEvalConsumer.js';
import { drainAskDraftRequests } from './askAutoDraftConsumer.js';
import { drainAutoSendAskBatches } from './askAutoSendProducer.js';
import { getModel as getReconciliationMatcherModel } from './reconciliationLlmCore.js';
import { computeDelegatedAuthorityMetrics } from './reconciliationDelegatedAuthorityMetrics.js';
import { listCloseBlockersForClient, loopsTablesPresent } from './caseManager.js';
import { attachGoalSummaries, listResolvedGoalsForClient } from './loopGoalSummary.js';
import {
  listMemoryCandidatesWithConflicts,
  memoryCandidatesTablePresent,
  memoryCandidatesGovernanceMayAct,
  promoteMemoryCandidate,
  dismissMemoryCandidate,
  resolveMemoryCandidatesPosture
} from './memoryCandidates.js';
import { knownPrincipalsForClientProfile } from './transactionLlm.js';
import { getOperatorCaseSnapshot, pipelineStateFromDoc } from './operatorCaseSnapshot.js';
import { logStorageCleanupAuthorizedInDb, logStorageCleanupRefusedInDb } from './storageCleanupReceipts.js';
// Slice G (G→F seam): the per-scope authority ceiling is the case snapshot's materiality
// threshold. loadActiveGrantsForClient reads the client's active grants (the store, DB +
// pre-migration soft-fail); materialityThresholdFromGrants picks the most-conservative
// ceiling (the pure leaf). Threaded into the shadow snapshot loaders' riskContext so the
// `materiality_band` flag resolves instead of staying `unknown`. Shadow-only by inheritance.
import { loadActiveGrantsForClient } from './reconciliationAuthorityGrants.js';
import { materialityThresholdFromGrants, matchVerdictFromAuthorization } from './authorityEnvelope.js';
// Slice G consumer: the focus transaction's PERSISTED reconciliation-match authorization →
// rendered into the shadow receipt's `matchVerdict` (preflight's `match_reconciles` check) so the
// receipt RENDERS the persisted reconciliation verdict instead of leaving matchVerdict null.
import { loadMatchAuthorizationForTransaction } from './reconciliationMatchAuthorization.js';
// Slice F flag source: the client's already-coded accounts → the snapshot's
// `knownAccountKeys` riskContext input, so `first_use_account` resolves instead of `unknown`.
import { loadKnownAccountKeysForClient } from './clientAccountHistory.js';
// Slice F flag source: the focus transaction's duplicate-candidate ids → the snapshot's
// `duplicateCandidateIds` riskContext input, so `duplicate_risk` resolves instead of `unknown`.
import { loadDuplicateCandidateIdsForTransaction } from './transactionDuplicateCandidates.js';
// The parse-cron failure rule (one owner; the desktop manifest reads it too).
import { parseCronSummaryFailures } from './parseCronSummaryFailures.js';
export { parseCronSummaryFailures };
// Parse-cron task allowlist. Exported so regression tests can pin the
// supported set — a stale vercel.json schedule pointing at a removed
// task would otherwise fail silently in production (cron call returns
// 400 CRON_TASK_UNSUPPORTED, no work happens, no alarms).
export const SUPPORTED_CRON_TASKS = new Set([
  'outbox',
  'stuck',
  'storage_orphans',
  'drain',
  'reconcile',
  'coding_auto_post',
  'coding_convergence',
  'diagnostics',
  'loops_inbox',
  'loops_recon_eval',
  'convergence_snapshot',
  'statutory_watches',
  // The HOURLY cadence of the same jurisdiction-neutral sweep (RT-19): only
  // bindings that declare `hourly: true` run on it — today the AE VAT
  // registration-status ask, cheap by construction — so a client born after
  // the 04:15 tick is asked within the hour, not tomorrow.
  'statutory_watches_hourly',
  'evidence_topic_reminders',
  'canonical_role_resolution',
  // DEPRECATED alias for 'statutory_watches' (country-pack contract gap 3):
  // the daily statutory sweep is jurisdiction-neutral now, so no cron task
  // carries a country name. Kept only so an invocation in flight across the
  // deploy that renames the vercel.json schedule does not 400. Delete it, the
  // dispatch branch in this file, and its regression test once the renamed
  // schedule is live in production.
  'finland_watches',
  'all'
]);
// Slice F→G seam: the Slice-C shadow snapshot loader, now WITH the resolved riskContext —
// the Slice-G materiality threshold (per-scope authority ceiling) so `materiality_band`
// resolves, the client's already-coded accounts (`knownAccountKeys`) so `first_use_account`
// resolves, and the focus transaction's duplicate-candidate ids (`duplicateCandidateIds`) so
// `duplicate_risk` resolves — all threaded into getOperatorCaseSnapshot. Invoked ONLY inside
// the shadow hook's LOOPS_SHADOW gate, so the three reads add no latency when shadow is off,
// and share ONE db connection. Best-effort and per-source isolated: a read failure leaves only
// that input absent and the snapshot keeps the honest `unknown` for the dependent flag (never
// throws into the hook). A genuine EMPTY result is a real signal (empty history → every account
// flags first-use; no duplicate candidate → clear), distinct from a read failure (→ unknown).
const loadShadowCaseSnapshotWithRiskContext = async ({ firmId, clientId, transactionId }) => {
  let materialityThreshold = null;
  let knownAccountKeys = null;
  let duplicateCandidateIds = null;
  let matchAuthorization = null;
  let memoryFacts = null;
  try {
    // Five flag/verdict/memory sources resolved over ONE shared connection. Each is isolated in
    // its own try so one source's failure leaves only its dependent signal honestly absent — it
    // never drops the others. The connection itself is the only all-or-nothing boundary.
    await withFirmDbClient(async (c) => {
      // Slice F/H — per-client config-stage gates, resolved from ONE config snapshot read on this
      // same connection. Two INDEPENDENT observe-only flags: LOOPS_SHADOW_RISK_CONTEXT gates the
      // four riskContext reads (Slice F), MEMORY_PACKET_RECEIPTS gates the facts read (Slice H) —
      // staging one off must never disable the other. No DB row ⇒ observe (both env fallbacks are
      // true) ⇒ byte-identical to the pre-gate path. A config-read failure falls through to
      // enrich (best-effort, never loses the enrichment).
      let observeRiskContext = true;
      let observeMemoryPacket = true;
      try {
        const configSnapshot = await readClientConfigSnapshot(c, { firmId, clientId });
        observeRiskContext = shadowRiskContextObserves({ snapshot: configSnapshot });
        observeMemoryPacket = memoryPacketObserves({ snapshot: configSnapshot });
      } catch { /* config read failed → default to enrich (byte-identical, best-effort) */ }
      if (observeRiskContext) {
        try {
          materialityThreshold = materialityThresholdFromGrants(
            await loadActiveGrantsForClient({ client: c, firmId, clientId })
          );
        } catch { /* materiality_band stays unknown */ }
        try {
          // [] = genuine empty history (a signal), not unknown
          knownAccountKeys = await loadKnownAccountKeysForClient({ client: c, firmId, clientId, excludeTransactionId: transactionId });
        } catch { /* first_use_account stays unknown */ }
        try {
          // [] = a query that ran and found no candidate (a real "no duplicate" signal); the read
          // returns null — not [] — when it could not answer, so a soft-fail stays unknown.
          duplicateCandidateIds = await loadDuplicateCandidateIdsForTransaction({ client: c, firmId, clientId, transactionId });
        } catch { /* duplicate_risk stays unknown */ }
        try {
          // Slice G: the persisted reconciliation-match authorization receipt (null when no match,
          // no authorization, or soft-fail → no match check is emitted). RENDERED, never re-checked.
          matchAuthorization = await loadMatchAuthorizationForTransaction({ client: c, firmId, clientId, transactionId });
        } catch { /* matchVerdict stays absent → no match_reconciles check */ }
      }
      if (observeMemoryPacket) {
        try {
          // Slice H: the facts in reach for this case — the SAME retrieval recipe the chat
          // prompt's known_facts context used (firmFacts.getFirmFactsForTransactionCase), so the
          // receipt records what the model could actually see. null = could not answer (row
          // missing / soft-fail) → receipt fields stay bare []; [] = genuinely no facts known.
          memoryFacts = await getFirmFactsForTransactionCase({ client: c, firmId, clientId, transactionId });
        } catch { /* memory packet stays absent → facts_available/used/conflicted stay [] */ }
      }
    });
  } catch { /* best-effort — absent inputs → the dependent flags stay honestly unknown */ }
  const riskContext = {};
  if (materialityThreshold != null) riskContext.materialityThreshold = materialityThreshold;
  if (Array.isArray(knownAccountKeys)) riskContext.knownAccountKeys = knownAccountKeys;
  if (Array.isArray(duplicateCandidateIds)) riskContext.duplicateCandidateIds = duplicateCandidateIds;
  const snapshot = await getOperatorCaseSnapshot({
    firmId,
    clientId,
    focus: { type: 'transaction', id: transactionId },
    include: ['convergence', 'risk_flags'],
    riskContext
  });
  // Slice G: attach the RENDERED match verdict alongside the snapshot (namespaced, additive) so
  // resolveSnapshotSignal threads it into the shadow receipt without a per-call-site edit.
  // matchVerdictFromAuthorization is the one render path (it delegates to
  // renderAuthorityEnvelopeFromAuthorization), carrying reconciles/reason + the echoed
  // authority_source/band; preflight's match_reconciles check renders it. null when nothing is
  // persisted (no match / no authorization / soft-fail) → no match check, exactly as before.
  return {
    ...snapshot,
    match_verdict: matchVerdictFromAuthorization(matchAuthorization),
    // Slice H: the retrieved fact rows ride the snapshot (namespaced, additive) so
    // resolveSnapshotSignal threads them into the shadow receipt's memory packet
    // without a per-call-site edit — the same seam match_verdict uses.
    memory_facts: memoryFacts
  };
};

const MAX_REQUEST_BYTES = 1024 * 1024;
const DOCUMENT_EXTRACTION_REQUEST_BYTES = 15 * 1024 * 1024;

const readJsonBody = async (req, { maxBytes = MAX_REQUEST_BYTES } = {}) => {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    if (totalBytes > maxBytes) {
      const error = new Error('Request body too large.');
      error.statusCode = 413;
      error.code = 'REQUEST_BODY_TOO_LARGE';
      error.details = { max_request_bytes: maxBytes };
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
};

// Raw-bytes sibling of readJsonBody, for the local evidence PUT (the SPA
// uploads the file body verbatim, exactly as it does to a Supabase signed
// URL). Same cap discipline, no string round-trip.
const readRawBodyBytes = async (req, { maxBytes = MAX_REQUEST_BYTES } = {}) => {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.length;
    if (totalBytes > maxBytes) {
      const error = new Error('Request body too large.');
      error.statusCode = 413;
      error.code = 'REQUEST_BODY_TOO_LARGE';
      error.details = { max_request_bytes: maxBytes };
      throw error;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
};

// Read .env from disk — Vite plugin context may not expose
// process.env values reliably, so we always read from disk as fallback.
let _dotEnvCache = null;
const readDotEnv = () => {
  if (_dotEnvCache) return _dotEnvCache;
  const vars = {};
  try {
    const envPath = resolvePath(process.cwd(), '.env');
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
        const m = line.match(/^(\w+)=(.*)$/);
        if (m) vars[m[1]] = m[2].trim();
      }
    }
  } catch { /* best-effort */ }
  _dotEnvCache = vars;
  return vars;
};

const getDonnaAccessToken = () => {
  const dotEnv = readDotEnv();
  return process.env.DONNA_ACCESS_TOKEN || dotEnv.DONNA_ACCESS_TOKEN || '';
};

const getSupabaseAuthConfig = () => {
  const dotEnv = readDotEnv();
  return {
    url: process.env.SUPABASE_URL || dotEnv.SUPABASE_URL || '',
    publishableKey:
      process.env.SUPABASE_PUBLISHABLE_KEY ||
      process.env.SUPABASE_ANON_KEY ||
      dotEnv.SUPABASE_PUBLISHABLE_KEY ||
      dotEnv.SUPABASE_ANON_KEY ||
      '',
    allowedEmails: new Set(
      (process.env.DONNA_AUTH_ALLOWED_EMAILS || dotEnv.DONNA_AUTH_ALLOWED_EMAILS || '')
        .split(',')
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean)
    )
  };
};

const getSubmittedAccessToken = (req) => {
  const headerToken = req.headers['x-donna-access-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) return headerToken.trim();

  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) return match[1].trim();
  }

  return '';
};

const tokensMatch = (expected, submitted) => {
  if (!expected || !submitted) return false;
  const expectedBuffer = Buffer.from(expected);
  const submittedBuffer = Buffer.from(submitted);
  return expectedBuffer.length === submittedBuffer.length && timingSafeEqual(expectedBuffer, submittedBuffer);
};

const isProtectedDonnaPath = (pathname) =>
  [
    '/api/donna/firms',
    '/api/donna/bizfile',
    // Billing status/checkout/portal require the firm/portal token so
    // assertFirmAccess can scope them. The signature-verified webhook
    // (/api/donna/billing/webhook) is dispatched before this gate and is
    // intentionally not covered here.
    '/api/donna/billing',
    // Marketing ADMIN (drafts/sends) is staff-only lead data; the public
    // unsubscribe lives at /api/donna/marketing/unsubscribe, outside this
    // prefix on purpose — an unsubscribe must never require auth.
    '/api/donna/marketing/admin',
    // The MCP read surface serves an external model; it additionally
    // REQUIRES req.donnaAuth inside its handler (no token configured ⇒
    // refuse, unlike the fail-open default of this gate).
    '/api/donna/mcp'
  ].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

// OAuth providers redirect the operator's browser back to these callback
// paths with no Donna access token — the request carries an HMAC-signed
// `state` instead, which the handler verifies (verifyXeroState /
// verifyQboState / verifyProcountorState). All are exempted from the
// access-token gate; the signed state is the control. Keep this in lockstep
// with the /<system>/callback route handlers below — a callback missing here
// is rejected with AUTH_REQUIRED before it can process the provider's code
// (the Procountor callback hit exactly that until it was added).
export const isSignedDonnaCallbackPath = (pathname) =>
  pathname === '/api/donna/firms/xero/callback' ||
  pathname === '/api/donna/firms/qbo/callback' ||
  pathname === '/api/donna/firms/procountor/callback' ||
  pathname === '/api/donna/firms/hmrc/callback';

// The host-class fence (RT-14, audit F-19, decision D5). These routes exist
// for the CLOUD deployment only — they serve Kari's funnel, the hosted
// billing, Supabase's auth-email hook and self-serve provisioning, the
// public outbound webhooks a third party (Stripe, Resend) calls back, and
// the OAuth redirect targets an accounting provider sends the operator's
// browser to. None of them has a caller on the appliance: no public URL
// reaches a Unix socket, no Stripe account bills a desktop book, no
// Supabase session provisions it. Until RT-14 they were mounted and served
// there anyway (F-19). On the desktop host `handleDonnaApiRequest` answers
// them 404 CLOUD_ONLY_ROUTE before any webhook or auth gate runs; the
// cloud build is untouched (every handler stays mounted, built and tested).
// The desktop manifest applies the same fence to scheduled work
// (handlerManifest.js: no marketing functions, no Inngest outbox, no drain,
// no ledger mirror sweeps on a 'none' book).
//
// Deliberately NOT fenced: the owner-channel webhooks (Telegram/WhatsApp/SMS
// are the owner's intake, wired per client), the HMRC connect/callback pair
// (the UK filing lane the appliance ships), /evidence-local (the appliance's
// own blob route), and every /firms route that is not named here.
export const CLOUD_ONLY_DONNA_PATH_PREFIXES = Object.freeze([
  '/api/donna/marketing',
  '/api/donna/billing',
  // The hosted MCP endpoint (ChatGPT app / Claude remote connector) and its
  // anonymous demo + OAuth metadata: a chat host reaches a public HTTPS URL,
  // never the appliance's Unix socket, and its auth ends in a Supabase
  // session the appliance does not have. The LOCAL MCP route the MCPB shim
  // calls (/api/donna/mcp/v1/*) stays mounted on both hosts.
  '/api/donna/mcp/remote',
  '/api/donna/mcp/demo',
  '/api/donna/mcp/oauth-protected-resource'
]);
export const CLOUD_ONLY_DONNA_PATHS = Object.freeze([
  '/api/donna/waitlist',
  '/api/donna/auth-email-hook',
  '/api/donna/outbound/unsubscribe',
  '/api/donna/outbound/approval',
  '/api/donna/outbound/paylink-webhook',
  '/api/donna/outbound/reply-webhook',
  '/api/donna/firms/self-provision',
  '/api/donna/firms/provision-workspace',
  '/api/donna/firms/xero/callback',
  '/api/donna/firms/qbo/callback',
  '/api/donna/firms/procountor/callback'
]);
export const isCloudOnlyDonnaPath = (pathname) =>
  CLOUD_ONLY_DONNA_PATHS.includes(pathname)
  || CLOUD_ONLY_DONNA_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

// /firms/health is the deploy-vintage receipt (database_configured +
// commit_sha + vercel_env + the deployment's source coordinates (deployment
// id/url, git provider, repo, branch — resolveDeploymentReceipt) + one
// model-lane presence boolean per provider — no firm data, no key values) and
// is deliberately public: "what is actually deployed, and from where" must be
// readable without any secret. Keep this in lockstep with
// the /health route handler — if that route ever returns more than the
// receipt fields, this exemption must be revisited first.
export const isPublicDonnaHealthPath = (pathname) =>
  pathname === '/api/donna/firms/health';

// Vercel cron invocations hit /parse-cron with
// `Authorization: Bearer $CRON_SECRET` (where CRON_SECRET is the env
// var Vercel itself auto-supplies when at least one cron is
// configured). That bearer is neither a DONNA_ACCESS_TOKEN nor a
// Supabase JWT, so the regular auth gate would 401 the cron before
// our handler-level CRON_SECRET check could ever run. We add a
// scoped exception: CRON_SECRET only unlocks the parse-cron path,
// not the rest of the firm API.
const isParseCronPath = (pathname) => pathname === '/api/donna/firms/documents/parse-cron';

const validateSupabaseBearerToken = async (token) => {
  const config = getSupabaseAuthConfig();
  if (!token || !config.url || !config.publishableKey) return null;

  const response = await fetch(`${config.url}/auth/v1/user`, {
    headers: {
      apikey: config.publishableKey,
      Authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) return false;

  const user = await response.json().catch(() => null);
  const email = String(user?.email || '').trim().toLowerCase();
  if (!email) return null;

  // The allowlist no longer HARD-rejects a non-listed email here, or self-serve
  // signup would be impossible (every new owner's email is, by definition, not
  // on a staff allowlist). Instead we tag whether the email is staff. `staff` =
  // true when no allowlist is configured (open) OR the email is on it. A
  // non-staff user is a self-serve owner: requireDonnaAccess lets them onto the
  // OWNER surface only (self-provision + their own client via assertFirmAccess),
  // while the allowlist still gates firm-member/console access.
  return {
    type: 'supabase_user',
    userId: String(user?.id || ''),
    email,
    // GoTrue's own confirmation stamp. Read by the owner-invite acceptance,
    // which binds a principal by email and so needs the email proven.
    emailVerified: Boolean(user?.email_confirmed_at || user?.confirmed_at),
    staff: config.allowedEmails.size === 0 || config.allowedEmails.has(email)
  };
};

// The ONE bearer-resolution chain for the firm API: access token → (parse-cron
// only) cron secret → Supabase session. Returns the auth object a handler may
// trust, or null. requireDonnaAccess turns null into the 401 below; the hosted
// MCP adapter (mcpRemoteAdapter.js) calls this directly so its 401 can carry
// the RFC 9728 challenge a chat host needs — the DECISION is still made here
// and in the funnel, never in the adapter.
export const resolveSubmittedDonnaAuth = async (req, { pathname = '' } = {}) => {
  const expectedToken = getDonnaAccessToken();
  const submittedToken = getSubmittedAccessToken(req);
  if (tokensMatch(expectedToken, submittedToken)) {
    return { type: 'access_token' };
  }

  // Scoped cron-secret bypass: only the /parse-cron path accepts the
  // Vercel-issued CRON_SECRET bearer. Without this branch, every
  // scheduled cron call would 401 here before reaching the handler's
  // own CRON_SECRET check — which is exactly the bug that left
  // outbox/stuck/drain crons unable to fire in production.
  if (isParseCronPath(pathname)) {
    const cronSecret = String(process.env.CRON_SECRET || '').trim();
    if (cronSecret && tokensMatch(cronSecret, submittedToken)) {
      return { type: 'cron_secret' };
    }
  }

  const supabaseAuth = await validateSupabaseBearerToken(submittedToken);
  if (supabaseAuth) {
    // Staff (allowlisted, or no allowlist configured) authenticate as before —
    // full access, still scoped downstream by assertFirmAccess.
    if (supabaseAuth.staff) {
      const membership = isFirmDatabaseConfigured()
        ? await resolveAuthenticatedMemberFirm({ auth: supabaseAuth })
        : { firmId: null, ambiguous: false };
      if (membership.ambiguous) return null;
      return membership.firmId ? { ...supabaseAuth, firmId: membership.firmId } : supabaseAuth;
    }
    // Non-staff = a self-serve business owner not on the firm allowlist. The
    // allowlist still gates firm-member/console access; an owner is authorized
    // by their client-scoped collaborator row (assertFirmAccess), not the
    // allowlist. Let them authenticate onto the OWNER surface only:
    //   - /self-provision: the bootstrap call, before any membership exists.
    //   - any path once they ALREADY resolve to a CLIENT-SCOPED principal
    //     (their own collaborator row); assertFirmAccess then restricts them to
    //     their own client(s).
    //   - (2026-09-16) any path once they hold an active firm_members row: a
    //     self-provisioned firm's administrator is admitted into exactly that
    //     firm — database membership is the authority, the allowlist is not a
    //     second gate in front of it.
    if (pathname === '/api/donna/firms/self-provision') return supabaseAuth;
    //   - /owner-invites/accept: a firm-invited owner has no principal until
    //     the invite binds one; the route itself requires the verified email
    //     to match the invite (clientOwnerInvitesDb.js). Grants nothing else.
    if (pathname === '/api/donna/firms/owner-invites/accept') return supabaseAuth;
    // A DATABASE membership is authority in its own right (a self-provisioned
    // firm's administrator is never on a staff allowlist): admit the member
    // into exactly their firm. Ambiguous memberships still refuse.
    const membership = isFirmDatabaseConfigured()
      ? await resolveAuthenticatedMemberFirm({ auth: supabaseAuth })
      : { firmId: null, ambiguous: false };
    if (membership.ambiguous) return null;
    if (membership.firmId) return { ...supabaseAuth, firmId: membership.firmId };
    const principal = await getFirmPrincipalForAuth({ auth: supabaseAuth });
    if (principal && !principal.unrestricted) return supabaseAuth;
    // Otherwise null: a non-staff caller with no owned workspace has no
    // business on the firm API. The identity IS verified, though — record
    // that so requireDonnaAccess can answer "no workspace yet" (403,
    // FIRM_ACCESS_DENIED) instead of "bad credentials" (401): a signup that
    // reloads before finishing setup must keep its valid session and be
    // offered setup, never told its session expired. Ambiguous memberships
    // above deliberately stay a bare null.
    req.donnaVerifiedIdentity = supabaseAuth;
  }
  return null;
};

const requireDonnaAccess = async (req, res, requestUrl) => {
  const expectedToken = getDonnaAccessToken();
  if (isSignedDonnaCallbackPath(requestUrl.pathname)) return true;
  if (isPublicDonnaHealthPath(requestUrl.pathname)) return true;
  if (!expectedToken || !isProtectedDonnaPath(requestUrl.pathname)) return true;

  const auth = await resolveSubmittedDonnaAuth(req, { pathname: requestUrl.pathname });
  if (auth) {
    req.donnaAuth = auth;
    return true;
  }
  if (req.donnaVerifiedIdentity) {
    // Verified identity, no workspace: the same answer a member-less staff
    // identity gets from assertFirmAccess, so every client treats both as
    // "set up a workspace", not as a dead session. Grants nothing.
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ code: 'FIRM_ACCESS_DENIED', reason: 'workspace_required', error: 'This sign-in is verified but has no workspace yet.' }));
    return false;
  }

  res.statusCode = 401;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('WWW-Authenticate', 'Bearer realm="Donna firm data"');
  res.end(JSON.stringify({ code: 'AUTH_REQUIRED', error: 'Access token required.' }));
  return false;
};

const donnaBizfileApiHandler = async (req, res) => {
  try {
    const requestUrl = new URL(req.url || '/', 'http://localhost');

    if (requestUrl.pathname === '/extract' && req.method === 'POST') {
      const body = await readJsonBody(req, { maxBytes: DOCUMENT_EXTRACTION_REQUEST_BYTES });
      const base64 = String(body?.data_base64 || '').trim();
      const filename = String(body?.filename || 'Bizfile PDF').trim();

      if (!base64) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Missing PDF data.' }));
        return;
      }

      const text = extractBizfilePdfTextFromBase64(base64);
      if (!text || text.length < 20) {
        res.statusCode = 422;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'No readable Bizfile text was found in this PDF.' }));
        return;
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          filename,
          text,
          text_length: text.length,
          line_count: text.split('\n').filter(Boolean).length
        })
      );
      return;
    }

    // "Drop anything" venture intake: one strong-LLM call turns any
    // identity-bearing document (registry extract from any jurisdiction,
    // bank statement, tax notice, invoice, …) or pasted text into a
    // draft client profile. Lives under the /bizfile prefix because the
    // prefix is already access-gated and routed in dev + prod; the
    // route name is the generic one.
    if (requestUrl.pathname === '/intake-draft' && req.method === 'POST') {
      const body = await readJsonBody(req, { maxBytes: DOCUMENT_EXTRACTION_REQUEST_BYTES });
      let processingReview = { available: false };
      if (isFirmDatabaseConfigured()) {
        const firmId = await resolveClientCreateFirmIdInDb({ requestedFirmId: body?.firm_id || null });
        await assertFirmAccess({ firmId, auth: req.donnaAuth, requireMember: true });
        const selection = await withFirmDbClient(client => readNativeProcessingSelectionWithClient(client, { firmId }));
        processingReview = { available: selection.available,
          ...(selection.available ? { selection_id: selection.selection_id } : {}) };
      }
      const base64 = String(body?.data_base64 || '').trim();
      const pastedText = String(body?.text || '').trim();
      const filename = String(body?.filename || '').trim();
      const mimeType = String(body?.mime_type || body?.mimeType || '').trim();

      if (!base64 && !pastedText) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Provide a document (data_base64) or pasted text.' }));
        return;
      }

      const result = await extractClientIntakeDraft({
        base64,
        filename,
        mimeType,
        text: pastedText
      });

      if (result.kind !== 'ok') {
        res.statusCode = result.code === 'DOCUMENT_IDENTIFIES_NO_BUSINESS' ? 422 : 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          error: result.code === 'DOCUMENT_IDENTIFIES_NO_BUSINESS'
            ? 'Donna read the document but could not find a business to onboard in it.'
            : 'Donna could not read this document right now.',
          code: result.code,
          reason: result.reason
        }));
        return;
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ filename: filename || null, draft: result.draft, processing_review: processingReview }));
      return;
    }

    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
  } catch (error) {
    res.statusCode = error?.statusCode || 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: error.message || 'Server error while extracting Bizfile PDF.',
      code: error?.code || null,
      details: error?.details || null
    }));
  }
};

const getFirmItemClientId = (items = [], id) => {
  const item = items.find((candidate) => candidate?.id === id);
  return item?.client_id || item?.clientId || null;
};

// Document-route authorization that runs BEFORE any firm snapshot (F-10): a
// one-row client lookup, then assertFirmAccess. "Missing" and "not yours" are
// the same answer (null → the caller's uniform 404), so the route is no
// existence oracle and a foreign probe never reaches the snapshot's
// convergence-mark settle. Only the 403 access refusal is folded; every other
// failure (scope guard, DB) still propagates.
const assertDocumentRouteAccess = async ({ firmId, documentId, auth, requireMember = false } = {}) => {
  const clientId = await getDocumentClientIdInDb({ firmId, documentId });
  const refuse = (error) => {
    if (error?.statusCode === 403) return null;
    throw error;
  };
  const access = await assertFirmAccess({ firmId, auth, clientIds: collectClientIds(clientId) }).catch(refuse);
  if (!access || !clientId) return null;
  if (requireMember) await assertFirmAccess({ firmId, auth, requireMember: true, clientIds: collectClientIds(clientId) });
  return access;
};

const sendDocumentNotFound = (res) => {
  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'Document was not found.', code: 'DOCUMENT_NOT_FOUND' }));
};

const collectClientIds = (...sources) => {
  const ids = new Set();
  sources.flat().forEach((item) => {
    const clientId = typeof item === 'string' ? item : item?.client_id || item?.clientId;
    if (clientId) ids.add(clientId);
  });
  return Array.from(ids);
};

// The actor recorded on a `document.signed_url.created` audit. Minting a
// signed evidence URL hands out a bearer capability to a source PDF, so
// every path that mints one attributes it the same way — this is the one
// expression both the download route and the case-snapshot routes use.
const signedUrlActorFromAccess = (access) =>
  access?.principal?.email ||
  access?.principal?.userId ||
  access?.principal?.principalId ||
  'system';

const safeFirmReturnTo = (value, fallback = '/firms?tab=accounting') => {
  const text = String(value || '').trim();
  if (!text || !text.startsWith('/') || text.startsWith('//') || text.startsWith('/api/')) return fallback;
  return text;
};

// ── The parse-cron task runner (RT-14) ────────────────────────────────────
//
// ONE runner for the parse-cron task family, called from two places:
//   - the cloud: the /documents/parse-cron route below, driven by
//     vercel.json's `crons:` (Vercel's cron runner) or an operator curl;
//   - the appliance: the desktop handler manifest (desktop/handlerManifest.js
//     DESKTOP_PARSE_CRON_SCHEDULE) calls it IN-PROCESS through the durable
//     step shim — no HTTP self-call, no access token, no Vercel budget.
// The task vocabulary is SUPPORTED_CRON_TASKS (validated by the caller and
// here). `clientId` is the operator-scoped argument the `reconcile` and
// `coding_auto_post` tasks take; `authorizedAs` is the diagnostics receipt of
// who asked. Returns the summary object the route serialises.
export const runParseCronTask = async ({ task = 'all', clientId = null, authorizedAs = 'unknown' } = {}) => {
  if (!SUPPORTED_CRON_TASKS.has(task)) {
    const error = new Error(`Unsupported parse-cron task: ${task}`);
    error.code = 'CRON_TASK_UNSUPPORTED';
    throw error;
  }
  if (!isFirmDatabaseConfigured()) {
    return { skipped: true, reason: 'firm_db_not_configured' };
  }
  const summary = {};

  if (task === 'outbox' || task === 'all') {
    if (!isInngestConfigured()) {
      // RT-14b: on a host without Inngest (the appliance) the outbox is the
      // register route's promise kept. "The outbox sweeper picks this up" was
      // true only in the cloud; with the drain gone (RT-14) a row whose
      // register-time enqueue failed rested `pending` on nobody until a manual
      // retry — the two-terminal violation. Same selection as the cloud
      // (pending, no job-exists receipt, past the 30-second settle window);
      // the transport is the producer fork (requestParseRun → a
      // `parse-document` local job, dedupe_key = parse_run_id), so a run whose
      // job DOES exist (the stamp failed, not the enqueue) dedupes and only
      // gets its receipt. Every row touched is named in the summary — never a
      // silent net. Scheduled every minute from DESKTOP_PARSE_CRON_SCHEDULE.
      const pending = await fetchOutboxPendingRowsInDb({ limit: 100 });
      const requeued = [];
      const alreadyQueued = [];
      const failed = [];
      let withoutRunId = 0;
      for (const row of pending) {
        if (!row.parse_run_id) {
          withoutRunId += 1;
          continue;
        }
        const receipt = {
          document_id: row.id,
          client_id: row.client_id,
          parse_run_id: row.parse_run_id,
          parse_enqueued_at: row.parse_enqueued_at,
          reason: 'no_job_receipt'
        };
        try {
          const result = await requestParseRun({
            firmId: row.firm_id,
            documentId: row.id,
            parseRunId: row.parse_run_id,
            clientId: row.client_id,
            documentType: row.document_type
          });
          await markParseEventSentInDb({
            firmId: row.firm_id,
            documentId: row.id,
            parseRunId: row.parse_run_id
          });
          if (result.deduped) {
            alreadyQueued.push(receipt);
          } else {
            requeued.push({ ...receipt, job_id: result.job_id });
            console.warn('[parse-cron outbox] requeued a parse run whose register-time enqueue left no job', {
              document_id: row.id,
              firm_id: row.firm_id,
              client_id: row.client_id,
              parse_run_id: row.parse_run_id,
              job_id: result.job_id
            });
          }
        } catch (enqueueErr) {
          failed.push({ ...receipt, error: enqueueErr?.message || String(enqueueErr) });
          // The next minute retries; a persistent failure here is the queue
          // table itself refusing writes — worth an operator's eyes.
          console.error('[parse-cron outbox] local-job requeue failed', {
            document_id: row.id,
            firm_id: row.firm_id,
            client_id: row.client_id,
            parse_run_id: row.parse_run_id,
            error: enqueueErr?.message || String(enqueueErr)
          });
        }
      }
      summary.outbox = {
        transport: 'local_job',
        picked: pending.length,
        requeued,
        already_queued: alreadyQueued,
        failed,
        without_run_id: withoutRunId
      };
    } else {
      const pending = await fetchOutboxPendingRowsInDb({ limit: 100 });
      let resent = 0;
      let failed = 0;
      for (const row of pending) {
        if (!row.parse_run_id) continue;
        try {
          await sendParseDocumentEvent({
            firmId: row.firm_id,
            documentId: row.id,
            parseRunId: row.parse_run_id,
            clientId: row.client_id,
            documentType: row.document_type
          });
          await markParseEventSentInDb({
            firmId: row.firm_id,
            documentId: row.id,
            parseRunId: row.parse_run_id
          });
          resent += 1;
        } catch (sendErr) {
          failed += 1;
          // Per-row context so an on-call operator can find the
          // stuck row without grepping the DB. Inngest dedupes by
          // event id, so re-sends are safe — but a persistent
          // failure here points at a real outage worth diagnosing.
          console.error('[parse-cron outbox] resend failed', {
            document_id: row.id,
            firm_id: row.firm_id,
            client_id: row.client_id,
            parse_run_id: row.parse_run_id,
            error: sendErr?.message || String(sendErr)
          });
        }
      }
      summary.outbox = { picked: pending.length, resent, failed };
    }
  }

  if (task === 'stuck' || task === 'all') {
    const stuck = await failStuckProcessingRowsInDb({ thresholdSeconds: 300 });
    summary.stuck = stuck;
    // F-2: the flip above (and the worker's own hard-fail path) leaves an
    // owner-initiated Telegram doc terminal WITHOUT any post-parse leg to
    // speak for it — sweep those into the owner-media summary pipeline so
    // a failed photo parse is never chat-silent. Runs on the same tick
    // that minted the STUCK flip; gates + exactly-once claim live inside
    // the sweep. No-throw by contract, belt here anyway.
    summary.owner_media_terminal_summaries = await runOwnerMediaTerminalSummarySweep({ firmId: DEFAULT_FIRM_ID })
      .catch((error) => ({ swept: 0, sent: 0, skipped: {}, error: error?.message || String(error) }));
  }

  // Inline drain. Picks pending rows past the threshold and runs
  // the worker function directly — bypasses Inngest entirely so
  // a deploy that has no INNGEST_EVENT_KEY (or where Inngest's
  // webhook can't deliver back) still makes forward progress.
  // Per-row hard cap is small because each bank-statement OCR
  // can eat 30-60s and the cron function budget is 5min total;
  // we also break on a soft time budget so we never trip Vercel.
  // parse_run_id gating in claimParseRunInDb keeps drain and any
  // late Inngest delivery from double-processing.
  if (task === 'drain' || task === 'all') {
    // 12, up from 5 (Kari, 2026-08-06): with small-docs-first ordering a
    // tick can clear a whole receipt batch (~12 × 15s) inside the deadline
    // instead of leaving the tail for later ticks; the DEADLINE below is
    // the real budget guard either way, so a tick that lands on statements
    // still stops in time.
    const DRAIN_PER_RUN_LIMIT = 12;
    const DRAIN_DEADLINE_MS = 4 * 60 * 1000; // leave 1min headroom under Vercel's 5m
    const startedAt = Date.now();
    // 120s threshold: with Inngest wired, drain is genuinely the
    // FALLBACK — a healthy Inngest delivery claims a fresh row well
    // inside two minutes, so drain only ever sees rows Inngest
    // dropped (unconfigured, outage, webhook drift). At the old 5s
    // the per-minute drain raced Inngest for every fresh upload —
    // claim-gating made the race safe, just noisy. Cost when Inngest
    // is NOT configured: uploads wait up to ~2min for the drain tick
    // (acceptable for a degraded fallback mode).
    // With Inngest wired, drain is the FALLBACK and the 120s threshold
    // keeps it from racing a healthy event delivery (comment above).
    // RT-14: this task is CLOUD-ONLY. On the appliance the per-document
    // parse is a `parse-document` local job (RT-08) and the drain has no
    // desktop manifest entry any more (handlerManifest.js
    // CLOUD_ONLY_PARSE_CRON_TASKS) — the one-release backstop that
    // partitioned pending rows by their local job is deleted with it.
    // The 12-row cap and the 4-minute deadline above are Vercel's
    // function budget, which is the only host this task still runs on.
    // Env knob is a tuning override, never a behavior gate.
    const drainThresholdSeconds = Number(process.env.PARSE_DRAIN_THRESHOLD_SECONDS ?? 120);
    const fetched = await fetchDrainablePendingRowsInDb({
      limit: DRAIN_PER_RUN_LIMIT,
      thresholdSeconds: drainThresholdSeconds
    });
    // RT-02 (audit F-02 containment, F-07): the tick loop is
    // `runParseDrainTick` (bottom of this file) so its decisions are
    // testable without HTTP. It never marks a released row failed while
    // automatic attempts remain, rests a spent budget terminal with an
    // honest message, counts admission refusals by name, and skips rows
    // whose readiness hold is still fresh.
    summary.drain = await runParseDrainTick({
      drainable: fetched,
      runParse: (row) => runParseInline({
        firmId: row.firm_id,
        documentId: row.id,
        parseRunId: row.parse_run_id
      }),
      markParseFailed: markParseFailedInDb,
      deadlineMs: DRAIN_DEADLINE_MS,
      startedAt,
      log: console
    });
  }

  if (task === 'reconcile' || task === 'all') {
    const reconcileClientId = clientId || '';
    if (reconcileClientId) {
      try {
        const result = await runReconciliationForBankStatementInDb({
          firmId: DEFAULT_FIRM_ID,
          clientId: reconcileClientId
        });
        summary.reconcile = result;
      } catch (reconcileErr) {
        summary.reconcile = { error: reconcileErr?.message || 'reconcile_failed' };
      }
    } else {
      summary.reconcile = { skipped: true, reason: 'client_id query param required' };
    }
  }

  // Coding auto-post — drive confident strong-coder codings that would
  // otherwise rest at review_state='suggested' (firm limbo, a two-terminal
  // violation) to a terminal: confident + no-evidence + P&L coding →
  // auto_reconciled (applied via the review writer); evidence_required →
  // on_owner (an owner evidence ask). Fail-closed behind the CODING_AUTO_POST
  // canary — inert (every line stays 'suggested') until a client is
  // allowlisted. Deliberately NOT part of `all`: explicit ?task=coding_auto_post
  // (like reconcile), scoped to one client_id.
  if (task === 'coding_auto_post') {
    const codingClientId = clientId || '';
    if (codingClientId) {
      try {
        summary.coding_auto_post = await sweepCodingAutoPost({
          firmId: DEFAULT_FIRM_ID,
          clientId: codingClientId
        });
      } catch (codingErr) {
        summary.coding_auto_post = { error: codingErr?.message || 'coding_auto_post_failed' };
      }
    } else {
      summary.coding_auto_post = { skipped: true, reason: 'client_id query param required' };
    }
  }

  // Coding convergence — the scheduled re-drive for the batch-coder leg
  // (codingConvergence.js). The inline post-parse coder call is fire-once
  // and dies with the invocation's 300s budget (the 2026-07-03 August-
  // Honeybee incident: 20 lines rested uncoded with no terminal writer
  // pending). Each tick re-runs the coder for clients with codable lines
  // the strong model has never seen, then runs the CODING_AUTO_POST-
  // canaried sweep — bounded, incremental, self-healing across ticks.
  // Deliberately NOT part of `all` (mirrors loops_inbox / coding_auto_post).
  if (task === 'coding_convergence') {
    try {
      const firmIds = await listFirmIdsInDb();
      const results = [];
      for (const firmId of firmIds) {
        try { results.push({firm_id:firmId,result:await runCodingConvergenceInDb({firmId})}); }
        catch (error) { results.push({firm_id:firmId,error:error?.message || 'coding_convergence_failed'}); }
      }
      summary.coding_convergence = { ...(results.length === 1 ? results[0].result : {}), firms: results,
        errors: results.reduce((sum, item) => sum + (item.error ? 1 : Number(item.result?.errors || 0)), 0) };
    } catch (convergenceErr) {
      summary.coding_convergence = { error: convergenceErr?.message || 'coding_convergence_failed' };
    }
  }

  // Statutory obligations — the daily jurisdiction-neutral sweep
  // (country-pack contract gap 3 / kernel-audit G12). Replaces the
  // country-named `finland_watches` task: WHICH obligations exist is now
  // pack data (packs/<cc> obligations.items[]) bound by name in
  // outbound/statutoryObligations.js, so the UK's duties are a pack entry
  // plus a binding — never a `uk_watches` cron sibling.
  //
  // Behaviourally identical for Finland: the same two drains, in the same
  // order, each still a strict no-op while its own flag is dark. What
  // changed is that an unbuilt duty and an UNSURVEYED market now ride out
  // in the summary instead of being invisible.
  //
  // Deliberately NOT part of `all` (unchanged): it sweeps config-plane
  // candidates and is a no-op while every watch flag is dark.
  //
  // 'finland_watches' is a DEPRECATED alias kept only so a cron
  // invocation in flight across the deploy that renames the schedule does
  // not 400. Delete it — from here, SUPPORTED_CRON_TASKS and the
  // regression test — once the renamed schedule is live in production.
  if (task === 'statutory_watches' || task === 'finland_watches') {
    try {
      summary.statutory_watches = await runStatutoryObligationSweep();
    } catch (statutoryWatchErr) {
      summary.statutory_watches = { error: statutoryWatchErr?.message || 'statutory_watches_failed' };
    }
  }

  // The hourly cadence of the same sweep — dispatches ONLY the bindings
  // that declared themselves hourly (statutoryObligations.js); every
  // other duty keeps its daily tick. Deliberately NOT part of `all`.
  if (task === 'statutory_watches_hourly') {
    try {
      summary.statutory_watches_hourly = await runStatutoryObligationSweep({ cadence: 'hourly' });
    } catch (statutoryWatchErr) {
      summary.statutory_watches_hourly = { error: statutoryWatchErr?.message || 'statutory_watches_hourly_failed' };
    }
  }

  // Evidence-topic reminder sweep (audit §10 "wire existing": the sweep had
  // only a manual script caller). Deliberately NOT part of `all` — it has
  // its own daily schedule. Safe by construction: every candidate is HELD
  // unless the EVIDENCE_TOPIC_REMINDERS flag ACTS for that client on the
  // config plane AND an active channel binding exists, so this cron is a
  // no-op until a client is staged.
  if (task === 'evidence_topic_reminders') {
    try {
      summary.evidence_topic_reminders = await runEvidenceTopicReminderSweep({});
    } catch (reminderSweepErr) {
      summary.evidence_topic_reminders = { error: reminderSweepErr?.message || 'evidence_topic_reminders_failed' };
    }
  }

  // Canonical-role resolution sweep — the caller for Donna-ledger ('none')
  // clients whose chart grows at posting time (verdict-account mints) with
  // no sync event to trigger the sync-route run. Deliberately NOT part of
  // `all` — it has its own daily schedule. Safe by construction: each
  // client's run self-gates on the CANONICAL_ROLE_RESOLUTION config-plane
  // flag (flag_dark receipt, no model call), so this cron is a no-op until
  // a client is staged.
  if (task === 'canonical_role_resolution') {
    try {
      summary.canonical_role_resolution = await runCanonicalRoleResolutionSweep({});
    } catch (roleSweepErr) {
      summary.canonical_role_resolution = { error: roleSweepErr?.message || 'canonical_role_resolution_failed' };
    }
  }

  // Donna Loops — drain the at-least-once event inbox, then dispatch the outbox
  // (Phase 3 inbox + Step 7 dispatcher). Deliberately NOT part of `all`: it
  // requires an explicit `?task=loops_inbox` so it is driven by hand during dev
  // validation, and is a no-op until LOOPS_SHADOW is on. The drain moves WORKFLOW
  // state only (no LLM, no external calls, no accounting writes); the dispatcher
  // then fans the resulting outbox rows out under the per-firm/case gate (it is
  // INERT until a firm graduates past shadow — back-compat is exact).
  if (task === 'loops_inbox') {
    if (!isLoopSystemEnabled()) {
      summary.loops_inbox = { skipped: true, reason: 'loops_shadow_off' };
    } else {
      try {
        summary.loops_inbox = await withFirmDbClient((client) =>
          drainLoopInbox({ client, workerId: 'parse-cron' })
        );
      } catch (loopsErr) {
        summary.loops_inbox = { error: loopsErr?.message || 'loops_inbox_failed' };
      }
      try {
        summary.loops_outbox = await withFirmDbClient((client) =>
          dispatchLoopOutbox({ client })
        );
      } catch (loopsErr) {
        summary.loops_outbox = { error: loopsErr?.message || 'loops_outbox_failed' };
      }
      // PR 1b — drain the reconciliation fresh-evaluation requests the wake just
      // produced (Trap-2 close). This is the ONE token-spending loop stage: it
      // re-runs the strong matcher for each requested bank line (with the client's
      // answer as context) OUTSIDE any txn, persists the fresh verdict, and emits
      // the completion that re-wakes the case. Runs AFTER the dispatch so a
      // case.resolved → dependency.resolved cascade in this same pass can produce
      // the request the consumer then drains. Inert at shadow (the consumer's
      // action is canary+), so this is byte-identical to no consumer until a firm
      // graduates — the careful-canary discipline.
      try {
        summary.loops_recon_eval = await withFirmDbClient((client) =>
          drainReconciliationEvalRequests({ client })
        );
      } catch (loopsErr) {
        summary.loops_recon_eval = { error: loopsErr?.message || 'loops_recon_eval_failed' };
      }
      // Slice 3 — drain the auto-DRAFT requests the post-reconcile seam produced:
      // run the strong-LLM ask pipeline (OUTSIDE any txn) to (re)draft each canary+
      // firm's client ask-batch. Runs BEFORE the auto-send drain so a draft produced
      // this tick can be sent the same tick. Inert at shadow (proposal_creation is
      // canary+); the draft pipeline supersedes, so it is idempotent on re-run.
      try {
        summary.loops_ask_draft = await withFirmDbClient((client) =>
          drainAskDraftRequests({ client })
        );
      } catch (loopsErr) {
        summary.loops_ask_draft = { error: loopsErr?.message || 'loops_ask_draft_failed' };
      }
      // Mentions slice 4 — drain the agent-ask ANSWER requests (@agent
      // asks): the strong model answers the colleague's question on the
      // artifact (OUTSIDE any txn) or escalates to the instructing seat;
      // a dead-lettered request escalates on the bound. Inert at shadow
      // (proposal_creation is canary+), and the mint route refuses below
      // canary, so this drains nothing there by construction.
      try {
        summary.loops_agent_answers = await withFirmDbClient((client) =>
          drainAgentAskAnswers({ client })
        );
      } catch (loopsErr) {
        summary.loops_agent_answers = { error: loopsErr?.message || 'loops_agent_answers_failed' };
      }
      // Slice 2 — auto-send the firm's current ask-batch drafts. Delivering a
      // drafted question is `client_visible_message`, a V1-forbidden action: this
      // sends ONLY for firms at canary+ that have turned the `auto_send_client_asks`
      // toggle on (the Slice-1 human authorization). It RE-GATES per firm right
      // before each send, so a suspension landing between draft and tick stops it.
      // Inert otherwise — a firm without the toggle drafts (Slice 3) but never
      // auto-sends, the careful-canary discipline. Idempotent: a tick with no live
      // draft is a no-op.
      try {
        summary.loops_auto_send = await withFirmDbClient((client) =>
          drainAutoSendAskBatches({
            client,
            requestRedraftFn: onReconcileCompleteRequestAskDraft
          })
        );
      } catch (loopsErr) {
        summary.loops_auto_send = { error: loopsErr?.message || 'loops_auto_send_failed' };
      }
    }
  }

  // Donna Loops — the reconciliation fresh-evaluation consumer on its own (PR 1b).
  // Same gate; lets the scoped re-match drain be driven without re-running inbox +
  // dispatch (e.g. to clear a backlog after a deploy).
  if (task === 'loops_recon_eval') {
    if (!isLoopSystemEnabled()) {
      summary.loops_recon_eval = { skipped: true, reason: 'loops_shadow_off' };
    } else {
      try {
        summary.loops_recon_eval = await withFirmDbClient((client) =>
          drainReconciliationEvalRequests({ client })
        );
      } catch (loopsErr) {
        summary.loops_recon_eval = { error: loopsErr?.message || 'loops_recon_eval_failed' };
      }
    }
  }

  // Slice J — daily convergence-metrics SAMPLER. Persists each client's
  // already-computed convergenceMetrics (the two-terminal-states split +
  // hanging_by_reason + prompts_per_100 + authority_misses) as a
  // one-row-per-client-per-day series so the ESCALATION RATE TRENDS over
  // time (CLAUDE.md GOAL — "the ONE metric ... and its trend"). Read-only
  // over the reconcile feed: it RECORDS the persisted per-row verdicts the
  // snapshot already aggregated, never re-deriving convergence. Last reading
  // of the day wins (upsert). Per-firm so a snapshot failure on one book
  // leaves the others sampled.
  if (task === 'convergence_snapshot') {
    const firmIds = await listFirmIdsInDb();
    const perFirm = [];
    for (const fid of firmIds) {
      try {
        const snap = await getFirmSnapshotFromDb({ firmId: fid });
        const byClient = snap?.convergenceMetrics?.by_client || {};
        // Q5 — the ask-clock half of the sample (asks_sent_7d + open-ask
        // age percentiles), merged into the same 049 blob. Kept in
        // lock-step with the daily cron (inngest/convergenceClocks.js)
        // so a manual run and the cron write the same row shape.
        const recorded = await withFirmDbClient(async (client) => {
          const askClocksByClient = {};
          for (const cid of Object.keys(byClient)) {
            if (!cid || cid === '__unknown__') continue;
            const clocks = await computeAskClockMetrics({ client, firmId: fid, clientId: cid });
            if (clocks) askClocksByClient[cid] = clocks;
          }
          return recordConvergenceMetricsSnapshot({ client, firmId: fid, byClient, askClocksByClient });
        });
        perFirm.push({ firm_id: fid, clients: Object.keys(byClient).length, ...recorded });
      } catch (snapErr) {
        console.error('[parse-cron convergence_snapshot] firm failed', {
          firm_id: fid,
          error: snapErr?.message || String(snapErr)
        });
        perFirm.push({ firm_id: fid, error: snapErr?.message || 'convergence_snapshot_failed' });
      }
    }
    summary.convergence_snapshot = { firms: perFirm };
  }

  // PR 4 — daily Supabase Storage orphan cleanup. Storage objects
  // that have no backing documents row > 1h old (either pre-register
  // failure that the same-session retry didn't catch, or a cancelled
  // duplicate placeholder whose row was deleted) get hard-deleted.
  // Hard delete is the right default — by definition these are
  // unreferenced files, Supabase Storage has its own versioning if
  // recovery is ever needed, and we log a rich audit trail
  // (bucket + key + size) for every deletion.
  if (task === 'storage_orphans') {
    const buckets = await fetchDistinctStorageBucketsInDb();
    const PER_RUN_LIMIT = 1000;
    let totalDeleted = 0;
    let totalScanned = 0;
    const perBucket = [];
    for (const bucket of buckets) {
      if (totalDeleted >= PER_RUN_LIMIT) break;
      const referencedKeys = await fetchReferencedStorageKeysInDb({ bucket });
      let objects = [];
      try {
        objects = await listEvidenceObjects({
          bucket,
          prefix: '',
          maxItems: 5000
        });
      } catch (listErr) {
        perBucket.push({ bucket, error: listErr?.message || 'list_failed' });
        continue;
      }
      totalScanned += objects.length;
      const orphans = selectStorageOrphans({
        objects,
        referencedKeys,
        minAgeMs: 60 * 60 * 1000,
        limit: PER_RUN_LIMIT - totalDeleted
      });
      if (!orphans.length) {
        perBucket.push({ bucket, scanned: objects.length, deleted: 0, refused: 0 });
        continue;
      }
      // DMEM-R1 W1 (doctrine INV-15; audit F-12 cleanup leg, S11/L1 + L3):
      // trusted identity is resolved BEFORE a destructive target is acted on,
      // and nothing is deleted unaudited. Path layout is firmId/clientId/…
      // (buildEvidenceStorageKey) — decode it, VALIDATE the prefix against the
      // firms and clients on this book, and then, per object:
      //   1. a prefix that is not a firm on this book is REFUSED — the object
      //      is kept, the refusal receipted (on the book's sole firm when there
      //      is exactly one; always in the run summary) and named in the log;
      //   2. a known firm's orphan gets its `storage.cleanup_authorized` receipt
      //      BEFORE the delete — an audit-insert failure keeps the object
      //      (fail closed), never a delete with no trail;
      //   3. the delete runs one key at a time so every `storage.orphan_cleaned`
      //      receipt names exactly one object that is actually gone; a delete
      //      error leaves the authorized receipt as the record of the attempt.
      const decoded = orphans.map((orphan) => {
        const parts = String(orphan.key).split('/');
        return { orphan, firmIdFromKey: parts[0] || null, clientIdFromKey: parts[1] || null };
      });
      const firmPrefixes = [...new Set(decoded.map((entry) => entry.firmIdFromKey).filter(Boolean))];
      const knownFirmIds = new Set(firmPrefixes.length
        ? (await queryFirmDb('select id from firms where id = any($1::text[])', [firmPrefixes])).rows.map((row) => row.id)
        : []);
      const clientCandidates = decoded.filter((entry) => knownFirmIds.has(entry.firmIdFromKey) && entry.clientIdFromKey);
      const knownClientKeys = new Set(clientCandidates.length
        ? (await queryFirmDb(
            'select firm_id, id from clients where firm_id = any($1::text[]) and id = any($2::text[])',
            [
              [...new Set(clientCandidates.map((entry) => entry.firmIdFromKey))],
              [...new Set(clientCandidates.map((entry) => entry.clientIdFromKey))]
            ]
          )).rows.map((row) => `${row.firm_id}/${row.id}`)
        : []);
      const bookFirms = (await queryFirmDb('select id from firms order by created_at asc, id asc limit 2')).rows.map((row) => row.id);
      const soleFirmId = bookFirms.length === 1 ? bookFirms[0] : null;
      let bucketDeleted = 0;
      let bucketRefused = 0;
      let bucketAuditFailed = 0;
      let bucketDeleteErrors = 0;
      const refusedKeys = [];
      for (const { orphan, firmIdFromKey, clientIdFromKey } of decoded) {
        if (!knownFirmIds.has(firmIdFromKey)) {
          bucketRefused += 1;
          refusedKeys.push({ bucket, key: orphan.key, firm_prefix: firmIdFromKey });
          console.warn('[parse-cron storage_orphans] orphan key prefix is not a firm on this book; REFUSED — object kept', {
            bucket,
            key: orphan.key,
            size: orphan.size,
            age_ms: orphan.age_ms,
            firm_prefix: firmIdFromKey
          });
          if (soleFirmId) {
            try {
              await logStorageCleanupRefusedInDb({ firmId: soleFirmId, bucket, key: orphan.key, size: orphan.size, ageMs: orphan.age_ms, firmPrefix: firmIdFromKey });
            } catch (auditErr) {
              console.error('[parse-cron storage_orphans] refusal receipt failed (object kept)', { bucket, key: orphan.key, error: auditErr?.message || String(auditErr) });
            }
          }
          continue;
        }
        const clientId = knownClientKeys.has(`${firmIdFromKey}/${clientIdFromKey}`) ? clientIdFromKey : null;
        try {
          await logStorageCleanupAuthorizedInDb({ firmId: firmIdFromKey, clientId, bucket, key: orphan.key, size: orphan.size, ageMs: orphan.age_ms, authorizedAs });
        } catch (auditErr) {
          // Fail closed: no receipt, no delete.
          bucketAuditFailed += 1;
          console.error('[parse-cron storage_orphans] pre-delete audit failed; object kept', { bucket, key: orphan.key, error: auditErr?.message || String(auditErr) });
          continue;
        }
        const deleteResult = await deleteEvidenceObjects({ bucket, keys: [orphan.key] });
        if (!deleteResult?.deleted) {
          bucketDeleteErrors += 1;
          continue;
        }
        bucketDeleted += 1;
        try {
          await logStorageOrphanCleanedInDb({
            bucket,
            key: orphan.key,
            size: orphan.size,
            ageMs: orphan.age_ms,
            firmId: firmIdFromKey,
            clientId
          });
        } catch (auditErr) {
          // The object is gone and its pre-delete authorization receipt stands;
          // the cleaned receipt is what failed — say so, never swallow it.
          bucketAuditFailed += 1;
          console.error('[parse-cron storage_orphans] post-delete audit failed (authorization receipt stands)', {
            bucket,
            key: orphan.key,
            error: auditErr?.message || String(auditErr)
          });
        }
      }
      totalDeleted += bucketDeleted;
      perBucket.push({
        bucket,
        scanned: objects.length,
        deleted: bucketDeleted,
        refused: bucketRefused,
        refused_keys: refusedKeys,
        audit_failures: bucketAuditFailed,
        delete_errors: bucketDeleteErrors
      });
    }
    summary.storage_orphans = {
      buckets: perBucket,
      scanned_total: totalScanned,
      deleted_total: totalDeleted,
      refused_total: perBucket.reduce((sum, row) => sum + (row.refused || 0), 0)
    };
  }

  // Read-only diagnostics. Returns enough state to answer "why
  // are docs stuck in Queued?" in one call without dashboard
  // access. Booleans only for env presence — never the secret
  // value itself.
  if (task === 'diagnostics') {
    const hasEnv = (name) => Boolean(String(process.env[name] || '').trim());
    // `duplicate_pending` was missing from the original counts
    // filter — those rows have parse_enqueued_at=null, so they
    // never showed up here. A file sitting in duplicate_pending
    // is the canonical "looks stuck but isn't really" state
    // (waiting on the 3-way resolver), and "this diagnostic
    // says zero documents" was actively misleading.
    // `completed` is included for the 24h denominator so an
    // operator can see "200 completed, 0 pending" and conclude
    // the pipeline is healthy.
    const counts = await queryFirmDb(
      `select parse_status,
              count(*)::int as count,
              min(parse_enqueued_at) as oldest_enqueued_at
       from documents
       where parse_status in ('pending', 'processing', 'failed', 'duplicate_pending', 'completed', 'skipped')
         and (parse_enqueued_at > now() - interval '24 hours'
              or (parse_enqueued_at is null and created_at > now() - interval '24 hours'))
       group by parse_status`
    ).catch((err) => ({ rows: [], error: err?.message || String(err) }));
    // Most recent 10 documents regardless of status, with
    // filename + duplicate flags + which client they belong to.
    // Lets an operator answer "what state is the file I just
    // uploaded actually in?" without DB access.
    const recentDocuments = await queryFirmDb(
      `select id, client_id, filename, parse_status, parse_run_id,
              parse_enqueued_at, parse_event_sent_at, parse_started_at,
              duplicate_of,
              case when parse_summary is not null
                   then parse_summary->>'reason' end as duplicate_reason,
              created_at
       from documents
       where created_at > now() - interval '24 hours'
       order by created_at desc
       limit 10`
    ).catch((err) => ({ rows: [], error: err?.message || String(err) }));
    const recentCronEvents = await queryFirmDb(
      `select action, created_at, metadata
       from audit_events
       where action in ('document.parse.queued',
                        'document.parse.completed',
                        'document.parse.failed',
                        'document.parse.duplicate_pending',
                        'storage.orphan_cleaned')
         and created_at > now() - interval '15 minutes'
       order by created_at desc
       limit 20`
    ).catch((err) => ({ rows: [], error: err?.message || String(err) }));
    summary.diagnostics = {
      deployment: {
        vercel_url: process.env.VERCEL_URL || null,
        node_env: process.env.NODE_ENV || null,
        ...resolveDeploymentReceipt(process.env)
      },
      env_set: {
        CRON_SECRET: hasEnv('CRON_SECRET'),
        DONNA_ACCESS_TOKEN: hasEnv('DONNA_ACCESS_TOKEN'),
        DATABASE_URL: hasEnv('DATABASE_URL') || hasEnv('POSTGRES_URL') || hasEnv('SUPABASE_DB_URL'),
        INNGEST_EVENT_KEY: hasEnv('INNGEST_EVENT_KEY'),
        INNGEST_SIGNING_KEY: hasEnv('INNGEST_SIGNING_KEY'),
        SUPABASE_URL: hasEnv('SUPABASE_URL') || hasEnv('VITE_SUPABASE_URL'),
        SUPABASE_SERVICE_ROLE_KEY: hasEnv('SUPABASE_SERVICE_ROLE_KEY')
          || hasEnv('SUPABASE_SERVICE_KEY')
          || hasEnv('SUPABASE_SECRET_KEY'),
        OPENAI_API_KEY: hasEnv('OPENAI_API_KEY'),
        ANTHROPIC_API_KEY: hasEnv('ANTHROPIC_API_KEY')
      },
      // Why the reconciliation strong path runs or silently falls back to the
      // weighted/legacy matchers — readable from the data, no source dive.
      // A missing ANTHROPIC_API_KEY yields legacy sources + null
      // authorization bands (the recurring Honeybee shakedown symptom).
      // Mode/policy values are non-secret; the key is a presence flag only.
      reconciliation: {
        // Code truth since the batch-2 dead-branch delete
        // (docs/donna-batch2-matcher-mode-dead-branch-plan.md): LLM-primary
        // is unconditional — the RECONCILIATION_MATCHER_MODE gate no longer
        // exists. The env var's own deletion receipt lives in
        // flag_env_census below (expected null once removed).
        matcher_mode: 'llm',
        anthropic_api_key_set: hasEnv('ANTHROPIC_API_KEY'),
        // Resolved matcher model — what the strong path actually calls. When
        // RECONCILIATION_MATCHER_LLM_MODEL is unset this is the matcher's
        // DEFAULT_MODEL, NOT null. The raw override is surfaced separately so a
        // null no longer reads as "no strong model" (a prior Honeybee diagnostic
        // showed matcher_llm_model: null while the default model ran, which
        // misled the session into doubting the strong path).
        matcher_llm_model: getReconciliationMatcherModel(),
        matcher_llm_model_override: process.env.RECONCILIATION_MATCHER_LLM_MODEL || null,
        auto_match_policy: process.env.RECONCILIATION_AUTO_MATCH_POLICY || null,
        auto_match_clients: process.env.RECONCILIATION_AUTO_MATCH_CLIENTS || null
      },
      // Full rollout-flag env census, read from the RUNNING deployment —
      // the receipt-grade source for the graduation ledger
      // (docs/donna-flag-graduation-census.md). Added 2026-07-05 after
      // `vercel env pull` returned empty strings for values this runtime
      // provably reads (auto_match_policy '1' at the same moment the pull
      // said ""). Values are stage digits, mode words, and client slugs —
      // never secrets (those stay presence-booleans in env_set above).
      // null = unset in this deployment; '' = set to an empty string.
      flag_env_census: Object.fromEntries([
        // Batch 1 — shimmed GATE-whole pairs + the two NARROW-only traps
        'RECONCILIATION_SETTLED_VERDICT', 'RECONCILIATION_SETTLED_VERDICT_CLIENTS',
        'RECONCILIATION_MINT_VERDICT_ACCOUNT', 'RECONCILIATION_MINT_VERDICT_ACCOUNT_CLIENTS',
        'RECONCILIATION_CODE_MATCHED_NO_REVIEW', 'RECONCILIATION_CODE_MATCHED_NO_REVIEW_CLIENTS',
        'RECONCILIATION_VENDOR_CODELESS_FALLBACK', 'RECONCILIATION_VENDOR_CODELESS_FALLBACK_CLIENTS',
        'RECONCILIATION_MATERIAL_AUTO_FYI', 'RECONCILIATION_MATERIAL_AUTO_FYI_CLIENTS',
        'RECONCILIATION_DELEGATED_AUTHORITY', 'RECONCILIATION_DELEGATED_AUTHORITY_CLIENTS',
        'RECONCILIATION_DISPOSITION_DRIVEN_ASK', 'RECONCILIATION_DISPOSITION_DRIVEN_ASK_CLIENTS',
        'RECONCILIATION_ASK_QUIESCENCE_GATE', 'RECONCILIATION_ASK_QUIESCENCE_GATE_CLIENTS',
        'RECONCILIATION_EXACT_MATCH_BACKSTOP', 'RECONCILIATION_EXACT_MATCH_BACKSTOP_CLIENTS',
        'RECONCILIATION_AUTO_MATCH_POLICY', 'RECONCILIATION_AUTO_MATCH_CLIENTS',
        // Gate E's deterministic ceiling (loop-recon review F1): a tuning
        // knob censused read-only, same posture as DOCUMENT_ROUTER_MIN_CONFIDENCE.
        // Since RT-11/RT-11b (2026-09-02) the ceiling FOLLOWS THE PACK
        // (reconciliation.materiality_ceiling, home currency) and this env
        // value is the ONLY override; unset here means the client's pack
        // decides, and a packless client REFUSES act-mode (matches hold at
        // 'suggested' with reason materiality_ceiling_unset) — never ∞.
        'RECONCILIATION_AUTO_MATCH_MATERIALITY_CEILING',
        // The disposition-side deterministic ceiling (F1's parser half),
        // same shape since RT-11b: the pack's reconciliation.disposition_ceiling
        // decides, this env value is the only override, and unset+packless
        // fails the auto_explain guard closed — never ∞. Censused so the
        // override in force is readable next to the Gate E one.
        'DISPOSITION_MATERIALITY_CEILING',
        // EXTRACTOR_MODE / EXTRACTOR_FAMILIES / EXTRACTOR_CLIENTS were censused
        // here until RT-12 (2026-09-02) deleted the cluster: the unified
        // extractor is the appliance's code default; only its kill switch
        // (UNIFIED_EXTRACTOR_DISABLED) and tuning knobs remain in env.
        // DOCUMENT_ROUTER_SHADOW_ONLY + DOCUMENT_ROUTER_PROMOTE_FAMILIES were
        // censused here until RT-05 (2026-09-01) deleted shadow mode for good.
        // Router pair added 2026-07-05 (session 22, graduation-plan step 0):
        // ENABLED was never censused (unset ⇒ router OFF, so its prod value
        // is load-bearing); MIN_CONFIDENCE is a tuning knob, censused
        // read-only so the router pass has a receipt for it.
        'DOCUMENT_ROUTER_ENABLED', 'DOCUMENT_ROUTER_MIN_CONFIDENCE',
        'RECONCILIATION_MATCHER_MODE',
        'SALES_INVOICE_MATCHER_ENABLED', 'BILL_MATCHER_ENABLED',
        'BANK_STATEMENT_MATCHER_ENABLED', 'RECEIPT_MATCHER_ENABLED',
        'PAYMENT_CONFIRMATION_MATCHER_ENABLED', 'PAYMENT_ACCOUNT_STATEMENT_MATCHER_ENABLED',
        'BILL_MATCHER_AUTO_PROMOTE_TIER_1',
        'BANK_LINE_DISPOSITION_MODE',
        // BANK_LINE_AUTO_EXPLAIN_ENABLED and RECEIPT_RULE_LEARNING_ENABLED
        // were censused here until RT-14 (2026-09-02) deleted their readers
        // (the env-dark bank-line auto-explain chain and the nightly rule
        // learner): no code reads either name any more — remove the env rows
        // on sight, verified against the env LIST.
        'BILL_AUTO_EXPLAIN_ENABLED',
        'RECEIPT_AUTO_EXPLAIN_ENABLED', 'SALES_INVOICE_AUTO_EXPLAIN_ENABLED',
        'LOOPS_SHADOW', 'LOOPS_TIER',
        'DOCUMENT_EXTRACTORS_ENABLED', 'DOCUMENT_LINES_ENABLED', 'PARSER_REPAIR_ENABLED',
        'RECEIPT_CLASSIFIER_ENABLED',
        // Kill switches (env-legit forever, shown for completeness)
        'CLIENT_CONFIG_FORCE_DISABLE', 'AUTO_AI_CODING_ENABLED',
        'RECONCILE_ASK_AUTORESOLVE_DISABLED'
      ].map((name) => [name, process.env[name] ?? null])),
      auth: {
        authorized_as: authorizedAs
      },
      inngest_configured: isInngestConfigured(),
      // parse_dispatch summarises the two parallel paths that move
      // documents from parse_status='pending' → 'completed':
      //
      //   1. Inngest event dispatch — the `outbox` cron sends
      //      `document/parse.requested` events to Inngest Cloud,
      //      which webhooks back into `/api/inngest`. Requires
      //      INNGEST_EVENT_KEY at runtime, gated by
      //      isInngestConfigured(). When unconfigured (the appliance),
      //      the same cron requeues a `parse-document` local job for
      //      every pending row without its job-exists receipt (RT-14b).
      //
      //   2. Inline drain — the `drain` cron pulls pending rows
      //      past a short threshold and runs the worker function
      //      directly (see runParseInline). NOT gated by Inngest
      //      configuration — this is the fallback that keeps the
      //      pipeline moving when option #1 isn't available.
      //
      // If `inngest_configured` is false but `documents_by_status_24h`
      // shows pending → completed progression, the drain path is
      // doing the work. That's the supported deploy mode for
      // environments without Inngest Cloud.
      parse_dispatch: {
        inngest_events: isInngestConfigured() ? 'configured' : 'not_configured',
        inline_drain: 'always_enabled'
      },
      documents_by_status_24h: counts.rows.map((row) => ({
        parse_status: row.parse_status,
        count: Number(row.count || 0),
        oldest_enqueued_at: row.oldest_enqueued_at
          ? new Date(row.oldest_enqueued_at).toISOString()
          : null
      })),
      recent_documents_24h: recentDocuments.rows.map((row) => ({
        id: row.id,
        client_id: row.client_id,
        filename: row.filename,
        parse_status: row.parse_status,
        parse_run_id: row.parse_run_id || null,
        duplicate_of: row.duplicate_of || null,
        duplicate_reason: row.duplicate_reason || null,
        parse_enqueued_at: row.parse_enqueued_at ? new Date(row.parse_enqueued_at).toISOString() : null,
        parse_event_sent_at: row.parse_event_sent_at ? new Date(row.parse_event_sent_at).toISOString() : null,
        parse_started_at: row.parse_started_at ? new Date(row.parse_started_at).toISOString() : null,
        created_at: row.created_at ? new Date(row.created_at).toISOString() : null
      })),
      recent_cron_relevant_audit_events_15m: recentCronEvents.rows.map((row) => ({
        action: row.action,
        created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
        metadata: row.metadata || {}
      })),
      counts_error: counts.error || null,
      recent_documents_error: recentDocuments.error || null,
      audit_error: recentCronEvents.error || null
    };
  }

  // Essential outbox/recovery work runs first. Observation cannot consume the
  // invocation before those durable responsibilities have made progress.
  if (task === 'outbox' || task === 'all') {
    const readiness = await renewCloudHostReadinessIfDue();
    if (readiness) summary.runtime_readiness = readiness;
  }
  return summary;
};

const donnaFirmsApiHandler = async (req, res) => {
  const readStartedAt = performance.now();
  let diagnosticPath = null;
  try {
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    // Apply the authenticated membership default once at the HTTP boundary.
    // Explicit targets survive unchanged and remain subject to assertFirmAccess.
    if (req.donnaAuth?.firmId && !requestUrl.searchParams.has('firm_id')) {
      requestUrl.searchParams.set('firm_id', req.donnaAuth.firmId);
    }
    const readBody = async (options) => {
      const body = await readJsonBody(req, options);
      if (!req.donnaAuth?.firmId || !body || typeof body !== 'object' || Array.isArray(body)) return body;
      return { firm_id: requestUrl.searchParams.get('firm_id'), ...body };
    };
    diagnosticPath = requestUrl.pathname;
    if (await handlePhysicalReconciliationRequest({ req, res, requestUrl, readBody })) return;

    // Production isolation: the in-memory seed snapshot is a local-dev
    // convenience. When the DB is unconfigured and the seed fallback is not
    // allowed (i.e. production, or a mistyped DATABASE_URL), refuse with a hard
    // 503 instead of silently serving demo books to a real user. Returns true
    // when it has handled the response.
    const seedFallbackBlocked = () => {
      if (isFirmDatabaseConfigured() || isSeedFallbackAllowed()) return false;
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        error: 'Firm database is not configured; refusing to serve demo seed data in production.',
        code: 'FIRM_DB_NOT_CONFIGURED'
      }));
      return true;
    };

    if (requestUrl.pathname === '/health' && req.method === 'GET') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      // Expose the running build's commit alongside DB status so "what is
      // actually deployed" is readable without any token. Deploy-vintage
      // receipt: a code merge is not deployed reality (CLAUDE.md "the model id
      // is the receipt" / "verify the running tree") — confirm this matches
      // the SHA you expect before trusting any prod-quality conclusion. Same
      // VERCEL_GIT_COMMIT_SHA the diagnostics task already reads. This route
      // is exempted from the access-token gate via isPublicDonnaHealthPath —
      // receipt fields ONLY here; anything more must go behind the gate.
      // Model-lane status (RT-01): one boolean per provider — key PRESENCE,
      // never a value — so "which lanes are dark on this host" is readable
      // from the same receipt as the deploy vintage. Mirrors the boot line
      // (desktop/capabilityReceipt.js) and Host A's model_routes receipt; a
      // dark lane is a receipt, not a host failure.
      // Deploy SOURCE coordinates (deployment id, repo, branch — 2026-09-21):
      // the sha alone could not tell a git-integration build of main from a
      // CLI push of another checkout or a stale promotion. Same owner as the
      // diagnostics block (resolveDeploymentReceipt); coordinates only.
      const laneReceipt = buildModelLaneReceipt(process.env);
      res.end(JSON.stringify({
        database_configured: isFirmDatabaseConfigured(),
        ...resolveDeploymentReceipt(process.env),
        model_lanes: {
          openai: laneReceipt.openai,
          anthropic: laneReceipt.anthropic,
          openai_compatible: laneReceipt.openai_compatible
        }
      }));
      return;
    }

    if (requestUrl.pathname === '/runtime-liveness' && req.method === 'GET') {
      // The desktop watchdog's wedge probe (task_44a5069a): serves-the-loop
      // plus a bounded pool `select 1`. Token-gated on purpose (unlike
      // /health): main owns the token, and a liveness oracle needs no public
      // surface. Body carries no book data — see runtimeLiveness.js.
      const probe = await runtimeLivenessProbe({
        queryFn: (sql) => queryFirmDb(sql),
        databaseConfigured: isFirmDatabaseConfigured()
      });
      res.statusCode = probe.status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(probe.body));
      return;
    }

    if ((requestUrl.pathname === '/snapshot' || requestUrl.pathname === '/' || requestUrl.pathname === '') && req.method === 'GET') {
      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      if (isFirmDatabaseConfigured()) {
        const snapshot = await getAuthorizedFirmSnapshotFromDb({ firmId, auth: req.donnaAuth });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(snapshot));
        return;
      }

      if (seedFallbackBlocked()) return;
      const snapshot = await getFirmSeedSnapshot();
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ...snapshot, warning: 'DATABASE_URL is not configured; returned seed data only.' }));
      return;
    }

    // Read-only accounting import planner. The source bytes are inspected in
    // memory and are never registered as evidence or written to the book. The
    // route is client-scoped because even a preview contains business data;
    // application is a later, independently-authorized named-writer slice.
    if (requestUrl.pathname === '/imports/inspect' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Accounting imports require the firm database.', code: 'FIRM_DB_NOT_CONFIGURED' }));
        return;
      }
      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = String(requestUrl.searchParams.get('client_id') || '').trim();
      if (!clientId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Choose a venture before inspecting accounting data.', code: 'CLIENT_ID_REQUIRED' }));
        return;
      }
      await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      const rawMapping = String(requestUrl.searchParams.get('mapping') || '');
      if (rawMapping.length > 8_192) {
        const error = new Error('The column mapping is too large.');
        error.statusCode = 413;
        error.code = 'IMPORT_MAPPING_TOO_LARGE';
        throw error;
      }
      let requestedMapping = {};
      if (rawMapping) {
        try {
          const parsed = JSON.parse(rawMapping);
          if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('mapping shape');
          requestedMapping = Object.fromEntries(
            Object.entries(parsed).map(([field, column]) => [String(field), column == null ? null : String(column)])
          );
        } catch {
          const error = new Error('Column mapping must be a JSON object.');
          error.statusCode = 400;
          error.code = 'IMPORT_MAPPING_INVALID';
          throw error;
        }
      }
      const bytes = await readRawBodyBytes(req, { maxBytes: ACCOUNTING_IMPORT_LIMITS.maxFileBytes });
      const result = inspectAccountingImport({
        bytes,
        filename: requestUrl.searchParams.get('filename') || 'accounting-data',
        mimeType: req.headers['content-type'] || '',
        requestedImportKind: requestUrl.searchParams.get('import_kind') || null,
        requestedSheetHandle: requestUrl.searchParams.get('sheet_handle') || null,
        requestedMapping,
        dateConvention: requestUrl.searchParams.get('date_convention') || 'safe',
        numberConvention: requestUrl.searchParams.get('number_convention') || 'safe'
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(result));
      return;
    }

    if (requestUrl.pathname === '/feed' && req.method === 'GET') {
      // Exception-Routing Close Engine — Phase 2 global feed. Reads
      // the firm snapshot and returns reconciliation_matches +
      // transaction_review_queue rows bucketed by routing disposition.
      // Auth flows through the same getAuthorizedFirmSnapshotFromDb
      // path as /snapshot, so client-scoped collaborators only see
      // items for clients they have access to.
      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const bucket = requestUrl.searchParams.get('bucket') || null;
      const clientId = requestUrl.searchParams.get('client_id') || null;

      if (seedFallbackBlocked()) return;
      const snapshot = isFirmDatabaseConfigured()
        ? await getAuthorizedFirmSnapshotFromDb({ firmId, auth: req.donnaAuth })
        : await getFirmSeedSnapshot();

      // Ask lane: live drafts are firm-wide rows the snapshot doesn't carry.
      // Filter to the snapshot's clients — that list is already scoped by
      // the same authorization the snapshot read enforced.
      let askBatchDrafts = [];
      if (isFirmDatabaseConfigured()) {
        const snapshotClientIds = new Set((snapshot.clients || []).map((c) => c.id));
        askBatchDrafts = (await getAskBatchDraftsForFirmFromDb({ firmId }))
          .filter((batch) => snapshotClientIds.has(batch.client_id));
      }

      try {
        const feed = buildFirmFeed({
          firm: snapshot.firm,
          clients: snapshot.clients,
          transactions: snapshot.transactions,
          documents: snapshot.documents,
          reconciliationMatches: snapshot.reconciliationMatches,
          transactionReviewQueue: snapshot.transactionReviewQueue,
          clientEvidenceRequests: snapshot.clientEvidenceRequests,
          askBatches: askBatchDrafts,
          bucket,
          clientId
        });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(
          isFirmDatabaseConfigured()
            ? feed
            : { ...feed, warning: 'DATABASE_URL is not configured; returned seed-derived feed.' }
        ));
      } catch (error) {
        res.statusCode = /unknown bucket/.test(String(error?.message)) ? 400 : 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'feed_build_failed' }));
      }
      return;
    }

    // Workspace-maintainer repair inbox. A collaborator or bounded seat cannot
    // read this firm-wide operational surface or acquire its retry authority.
    const runtimeRepairAction = requestUrl.pathname.match(/^\/runtime-policy-incidents\/(\d+)\/(claim|retry)$/);
    if ((requestUrl.pathname === '/runtime-policy-incidents' && req.method === 'GET')
      || (runtimeRepairAction && req.method === 'POST')) {
      const body = req.method === 'POST' ? await readBody() : {};
      const firmId = body?.firm_id || requestUrl.searchParams.get('firm_id') || DEFAULT_FIRM_ID;
      const access = await assertFirmAccess({ firmId, auth: req.donnaAuth, requireMember: true });
      const principal = await resolveDesktopClientCreationPrincipal({ firmId, principal: access.principal });
      if (principal?.principalType !== 'firm_member') {
        const error = new Error('An identified workspace member is required for runtime repairs.');
        error.statusCode = 403;
        error.code = 'RUNTIME_POLICY_MEMBER_REQUIRED';
        throw error;
      }
      let result;
      if (req.method === 'GET') {
        const incidents = await withFirmDbClient((client) => listRuntimePolicyIncidents({
          client, firmId, afterFailureId: requestUrl.searchParams.get('after') || null
        }));
        result = { incidents, member_id: principal.principalId,
          next_cursor: incidents.length === 50 ? incidents.at(-1).failure_id : null };
      } else if (runtimeRepairAction[2] === 'claim') {
        const incident = await withFirmDbClient((client) => claimRuntimePolicyIncident({
          client, firmId, failureId: runtimeRepairAction[1], principal
        }));
        result = { incident };
      } else {
        result = await retryRuntimePolicyIncidentInDb({
          firmId, failureId: runtimeRepairAction[1], principal,
          idempotencyKey: body?.idempotency_key, repairNote: body?.repair_note
        });
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
      return;
    }

    // Desktop backups (plan §8), the settings-card surface: list the verified
    // packages on this appliance and run one on demand. Host-gated on
    // DONNA_DESKTOP_BACKUP_DIR — on cloud hosts the card gets {enabled:false},
    // never an error. Same firm-member gate as /firm-facts; the run reuses the
    // daily cron's exact machinery (createBackupPackage → rotate, findPgBin),
    // so a manual backup and a scheduled one are the same artifact.
    if (requestUrl.pathname === '/desktop-backups' && (req.method === 'GET' || req.method === 'POST')) {
      const backupsDir = process.env.DONNA_DESKTOP_BACKUP_DIR || null;
      const blobDir = process.env.DONNA_DESKTOP_BLOB_DIR || null;
      const respond = (statusCode, payload) => {
        res.statusCode = statusCode;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(payload));
      };
      const firmId = requestUrl.searchParams.get('firm_id') || DEFAULT_FIRM_ID;
      await assertFirmAccess({ firmId, auth: req.donnaAuth, requireMember: true });
      if (!backupsDir) {
        respond(200, { enabled: false, backups: [], cron: null });
        return;
      }
      const { createBackupPackage, listBackupPackages, rotateBackupPackages } =
        await import('./desktop/backupPackage.js');
      if (req.method === 'POST') {
        try {
          const { findPgBin } = await import('./desktop/pgSupervisor.js');
          const created = await createBackupPackage({
            backupsDir,
            blobDir,
            pgBin: findPgBin(),
            databaseUrl: process.env.DATABASE_URL,
            reason: 'manual',
            logger: console
          });
          rotateBackupPackages({
            backupsDir,
            keep: Number(process.env.DONNA_DESKTOP_BACKUP_KEEP || 14),
            logger: console
          });
          respond(200, {
            enabled: true,
            created: { name: created.packageDir.split('/').pop(), verified: created.verified },
            backups: listBackupPackages({ backupsDir }),
            cron: process.env.DONNA_DESKTOP_BACKUP_CRON || '30 1 * * *'
          });
        } catch (error) {
          // createBackupPackage already guarantees no half-package remains.
          respond(500, { error: error?.message || 'Backup failed.', code: 'DESKTOP_BACKUP_FAILED' });
        }
        return;
      }
      respond(200, {
        enabled: true,
        backups: listBackupPackages({ backupsDir }),
        cron: process.env.DONNA_DESKTOP_BACKUP_CRON || '30 1 * * *'
      });
      return;
    }

    // Governance read: list the firm's memory (firm_facts) for the Facts panel —
    // both active and dismissed, with provenance + the distiller model. Same
    // firm-member gate as the dismiss write (firm-scoped memory, no clientIds).
    if (requestUrl.pathname === '/firm-facts' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const firmId = requestUrl.searchParams.get('firm_id') || DEFAULT_FIRM_ID;
      const status = requestUrl.searchParams.get('status') || null;
      await assertFirmAccess({ firmId, auth: req.donnaAuth, requireMember: true });
      const facts = await withFirmDbClient(
        (dbClient) => listFirmFacts({ client: dbClient, firmId, status })
      );
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ facts }));
      return;
    }

    // #5 Slice 6 — the §14 delegated-authority metrics the canary rollout is
    // GATED on (docs/proposal-2026-06-23-delegated-authority-material-matches.md
    // §14/§15). Pure observability: it reads only persisted state (grants 040,
    // authorization requests 041, the delegated-accept receipt on matches) and
    // adds NO inference (trust-the-strong-LLM). The model id rides FROM THE DATA
    // in `models` (CLAUDE.md "the model id is the receipt"). Firm-governance read,
    // gated like /firm-facts (requireMember); optional ?client_id narrows every
    // aggregate. In V1 (canary off) every counter is expected to read ZERO.
    if (requestUrl.pathname === '/delegated-authority-metrics' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const firmId = requestUrl.searchParams.get('firm_id') || DEFAULT_FIRM_ID;
      const clientId = requestUrl.searchParams.get('client_id') || requestUrl.searchParams.get('clientId') || null;
      await assertFirmAccess({ firmId, auth: req.donnaAuth, requireMember: true });
      const metrics = await withFirmDbClient(
        (dbClient) => computeDelegatedAuthorityMetrics({ client: dbClient, firmId, clientId })
      );
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ metrics }));
      return;
    }

    // Descent ladder (Q5) — the read-only lane report for the settings
    // surface: the lane registry + aggregated challenger receipts. Pure
    // observability (no inference, no write path); challenger model ids
    // ride from the receipts, never from config. Firm-governance read,
    // gated like /firm-facts (requireMember). Renders zeros until the
    // ladder actually runs somewhere.
    if (requestUrl.pathname === '/jev-preview' && req.method === 'GET') {
      const firmId = requestUrl.searchParams.get('firm_id') || DEFAULT_FIRM_ID;
      const clientId = requestUrl.searchParams.get('client_id');
      const documentId = requestUrl.searchParams.get('document_id');
      if (!clientId || !documentId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id and document_id are required.' }));
        return;
      }
      await assertFirmAccess({ firmId, auth: req.donnaAuth, requireMember: true, clientIds: collectClientIds(clientId) });
      const status = await withFirmDbClient(async client => {
        const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
        const { rows } = await client.query(`select payload, model, evaluated_at from reconciliation_evaluations
          where firm_id=$1 and client_id=$2 and target_id=$3 and target_type='document'
          and payload->>'decision_engine'='jev' order by evaluated_at desc limit 1`, [firmId, clientId, documentId]);
        const last = rows[0];
        return { enabled: clientFlagActs({ flagKey: 'JEV_RECONCILIATION', snapshot, envFallback: () => false }),
          last_run: last ? { outcome: last.payload.selected_terminal, execution: last.payload.execution === 'existing_reconciliation_writer' ? 'applied'
            : last.payload.execution === 'held_for_authority' ? 'held' : 'not_applied',
            reason: last.payload.execution_reason, model: last.model, probability: last.payload.probability, evaluated_at: last.evaluated_at } : null };
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(status));
      return;
    }

    if (requestUrl.pathname === '/jev-preview' && req.method === 'POST') {
      const body = await readBody();
      const firmId = body?.firm_id || DEFAULT_FIRM_ID;
      const clientId = typeof body?.client_id === 'string' ? body.client_id.trim() : '';
      const documentId = typeof body?.document_id === 'string' ? body.document_id.trim() : '';
      if (!clientId || !documentId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id and document_id are required.' }));
        return;
      }
      await assertFirmAccess({ firmId, auth: req.donnaAuth, clientIds: collectClientIds(clientId), requireMember: true });
      try {
        if (!isFirmDatabaseConfigured()) throw Object.assign(new Error('Firm database is not configured.'), { statusCode: 503 });
        if (!process.env.TYPESAFE_API_KEY || !process.env.TYPESAFE_MODEL) throw Object.assign(new Error('Jev is not configured in this Donna runtime.'), { statusCode: 503, code: 'jev_not_configured' });
        const result = jevDecisionPreview(await withFirmDbClient(client => decideJevReconciliation({ client, firmId, clientId, documentId })));
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
      } catch (error) {
        res.statusCode = error?.statusCode || 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Jev preview failed.', code: error?.code || 'jev_preview_failed' }));
      }
      return;
    }

    if (requestUrl.pathname === '/model-lanes' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const firmId = requestUrl.searchParams.get('firm_id') || DEFAULT_FIRM_ID;
      await assertFirmAccess({ firmId, auth: req.donnaAuth, requireMember: true });
      const report = await withFirmDbClient(
        (dbClient) => computeModelLaneReport({ client: dbClient, firmId })
      );
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(report));
      return;
    }

    // Descent ladder Q6c (the model lab) — set/clear a lane's deciding-model
    // policy. The WRITE half of the model-policy feed: model must sit inside
    // the lane's qualified set (the store refuses anything else, so this
    // route can never widen model choice — the free picker stays
    // structurally impossible), the flip is receipted (audit_events in the
    // same transaction), and body.model null/'' clears back to the strong
    // default. requireMember like every governance write.
    if (requestUrl.pathname === '/model-lanes/policy' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readBody();
      const firmId = body?.firm_id || DEFAULT_FIRM_ID;
      const laneId = typeof body?.lane === 'string' ? body.lane.trim() : '';
      if (!laneId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'lane is required.' }));
        return;
      }
      const access = await assertFirmAccess({ firmId, auth: req.donnaAuth, requireMember: true });
      const actorId = access?.principal?.collaborator?.id || access?.principal?.email || req.donnaAuth?.email || req.donnaAuth?.userId || 'unknown';
      const clientId = body?.client_id || null;
      const model = typeof body?.model === 'string' ? body.model.trim() : '';
      const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 400) : null;
      try {
        const outcome = await withFirmDbClient((dbClient) => (model
          ? setLaneDecidingPolicy({
            client: dbClient, firmId, clientId, laneId,
            decidingModel: model, basis: 'experiment', reason,
            actorType: 'firm_member', actorId
          })
          : clearLaneDecidingPolicy({
            client: dbClient, firmId, clientId, laneId, reason,
            actorType: 'firm_member', actorId
          })));
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(outcome));
      } catch (error) {
        const badRequest = ['UNKNOWN_LANE', 'LANE_NOT_GOVERNED', 'MODEL_NOT_QUALIFIED', 'UNKNOWN_BASIS'].includes(error?.code);
        res.statusCode = badRequest ? 400 : 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Policy write failed.' }));
      }
      return;
    }

    // Donna Loops Phase 4 — read-only close-blocker dashboard. Lists the client's
    // open close blockers (the non-terminal cases still waiting on someone), each
    // with its blockers; the UI groups them by who we wait on. This is the first
    // Loops read path that drives UI, so it is double-gated to stay invisible
    // until the spine is validated:
    //   - LOOPS_SHADOW off (prod default) → { enabled:false, cases:[] }
    //   - migration 033 absent → { enabled:false, cases:[] }
    // Either way a 200 with an honest empty payload, never an error, so prod is
    // unchanged. Renders the PERSISTED case status (rail #1), never a fresh
    // inference. Client-scoped (cases are client-scoped), so a firm member sees
    // their client and the access gate is the standard clientIds check.
    if (requestUrl.pathname === '/close-blockers' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = requestUrl.searchParams.get('client_id') || requestUrl.searchParams.get('clientId') || '';
      await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      if (!clientId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id is required.' }));
        return;
      }
      if (!isLoopSystemEnabled()) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ enabled: false, cases: [] }));
        return;
      }
      const cases = await withFirmDbClient(async (dbClient) => {
        if (!(await loopsTablesPresent(dbClient))) return null;
        const baseCases = await listCloseBlockersForClient({
          client: dbClient,
          firmId: firmId || DEFAULT_FIRM_ID,
          clientId
        });
        // Step 8 — attach each case's persisted GoalReport (Goal / done-when / progress
        // / regression history) so the panel can render the verdict (INV-13). Additive:
        // a case with no report gets goal:null and renders exactly as before.
        return attachGoalSummaries({
          client: dbClient,
          firmId: firmId || DEFAULT_FIRM_ID,
          clientId,
          cases: baseCases
        });
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ enabled: cases !== null, cases: cases || [] }));
      return;
    }

    // Donna Loops Step 8 — read-only "resolved goals" dashboard, the complement of
    // /close-blockers. close-blockers lists only NON-terminal cases with an open
    // blocker, so a case whose goal was MET (and went terminal) drops off it with no
    // trace; this surfaces those terminal cases whose latest persisted goal report is
    // met/waived (INV-13 — render the persisted verdict, never a fresh inference).
    // Double-gated exactly like /close-blockers so prod is unchanged until validated:
    //   - LOOPS_SHADOW off (prod default) → { enabled:false, cases:[] }
    //   - migration 033/037 absent        → { enabled:false, cases:[] }
    // Client-scoped; the access gate is the standard clientIds check.
    if (requestUrl.pathname === '/resolved-goals' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = requestUrl.searchParams.get('client_id') || requestUrl.searchParams.get('clientId') || '';
      await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      if (!clientId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id is required.' }));
        return;
      }
      if (!isLoopSystemEnabled()) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ enabled: false, cases: [] }));
        return;
      }
      const cases = await withFirmDbClient(async (dbClient) => {
        if (!(await loopsTablesPresent(dbClient))) return null;
        // listResolvedGoalsForClient enriches each case with its GoalReport (INV-13);
        // it self-filters to terminal cases whose LATEST report is met/waived and
        // soft-fails to [] on a pre-037 deploy, so this stays empty until the goal
        // layer is producing reports.
        return listResolvedGoalsForClient({
          client: dbClient,
          firmId: firmId || DEFAULT_FIRM_ID,
          clientId
        });
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ enabled: cases !== null, cases: cases || [] }));
      return;
    }

    // S3 — the Team roster surface (specialist-roles doc §5). One read + four
    // writer-routed mutations, all in roles/roleRoster.js + roleEmployment.js;
    // these blocks add auth + transport only. Client-scoped access; the acting
    // principal is the authenticated user — actor_type 'owner' (self-service
    // doctrine), actor_id the real principal (attribution rail). Mutations are
    // gated on the bench UI flag ACTING for the client (canary/auto); the read
    // returns the flag mode so the UI renders honestly at every stage.
    if (requestUrl.pathname === '/roles/roster' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const firmId = requestUrl.searchParams.get('firm_id') || DEFAULT_FIRM_ID;
      const clientId = requestUrl.searchParams.get('client_id') || requestUrl.searchParams.get('clientId') || '';
      if (!clientId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id is required.' }));
        return;
      }
      await assertFirmAccess({
        firmId, auth: req.donnaAuth, clientIds: collectClientIds(clientId)
      });
      try {
        const roster = await withFirmDbClient(
          (dbClient) => readRoleRoster(dbClient, { firmId, clientId })
        );
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ roster }));
      } catch (error) {
        res.statusCode = error?.statusCode || 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error' }));
      }
      return;
    }

    // Spelled as literal pathname comparisons so vercelRewrites.test.js can
    // scan them — a lookup object here shipped exactly the dev-works/prod-404s
    // bug that guard exists to stop.
    const roleEmploymentRoute =
      (requestUrl.pathname === '/roles/hire' && 'hire')
      || (requestUrl.pathname === '/roles/end' && 'end')
      || (requestUrl.pathname === '/roles/grants/approve' && 'approve_grant')
      || (requestUrl.pathname === '/roles/grants/revoke' && 'revoke_grant')
      || null;
    if (roleEmploymentRoute && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readBody();
      const firmId = body?.firm_id || DEFAULT_FIRM_ID;
      const clientId = body?.client_id || body?.clientId || '';
      if (!clientId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id is required.' }));
        return;
      }
      const access = await assertFirmAccess({
        firmId, auth: req.donnaAuth, clientIds: collectClientIds(clientId)
      });
      const actorId = access.principal?.email || access.principal?.userId || access.principal?.principalId || 'workspace';
      try {
        const result = await withFirmDbClient(async (dbClient) => {
          const snapshot = await readClientConfigSnapshot(dbClient, { firmId, clientId });
          if (benchUiMode({ snapshot }) !== 'act') {
            const err = new Error('The team surface is not enabled for this venture.');
            err.statusCode = 403;
            throw err;
          }
          await dbClient.query('begin');
          try {
            const base = { firmId, clientId, actorType: 'owner', actorId, reason: body?.reason || null };
            let out;
            if (roleEmploymentRoute === 'hire') {
              out = await hireRole(dbClient, { ...base, roleId: String(body?.role_id || '') });
            } else if (roleEmploymentRoute === 'end') {
              out = await endRoleAssignment(dbClient, { ...base, roleId: String(body?.role_id || '') });
            } else if (roleEmploymentRoute === 'approve_grant') {
              // A time bound is REQUIRED by the writer; when the owner sets
              // neither, default to review-in-90-days (the operator lever's
              // DEFAULT_REVIEW_AFTER_DAYS posture) — echoed on the receipt.
              const expiresAt = body?.expires_at || null;
              const reviewAfter = body?.review_after
                || (expiresAt ? null : new Date(Date.now() + 90 * 86400000).toISOString());
              out = await approveRoleGrant(dbClient, {
                ...base,
                roleId: String(body?.role_id || ''),
                grantShape: String(body?.grant_shape || ''),
                actionType: String(body?.action_type || ''),
                scopeKind: body?.scope_kind || 'counterparty',
                scopeKey: String(body?.scope_key || ''),
                amountCeiling: body?.amount_ceiling,
                currency: body?.currency,
                expiresAt,
                reviewAfter
              });
            } else {
              out = await revokeRoleGrant(dbClient, { ...base, grantId: String(body?.grant_id || '') });
            }
            await dbClient.query('commit');
            return out;
          } catch (error) {
            await dbClient.query('rollback');
            throw error;
          }
        });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
      } catch (error) {
        // Writer refusals (occupied role, authority outside the leash, missing
        // time bound) are owner-visible messages, not server faults.
        res.statusCode = error?.statusCode || 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error' }));
      }
      return;
    }

    // Human seats (docs/design-donna-seats-roles-access.md): roster + invite
    // + lifecycle + entity assignment. Auth + transport only here — the
    // authorization law (owner-gated admin, partner entity management, scoped
    // subset rules, external fencing) and every in-transaction audit live in
    // seatsDb.js. Spelled as literal pathname comparisons (the
    // vercelRewrites.test.js rule above).
    if (requestUrl.pathname === '/seats' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const firmId = requestUrl.searchParams.get('firm_id') || DEFAULT_FIRM_ID;
      const access = await assertFirmAccess({ firmId, auth: req.donnaAuth });
      if (await principalIsFirmInvitedOwnerInDb({ firmId, principal: access.principal })) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'A client portal owner cannot manage the firm’s team.', code: 'CLIENT_OWNER_PORTAL_ONLY' }));
        return;
      }
      try {
        const roster = await listFirmSeats({
          firmId,
          principal: access.principal,
          allowedClientIds: access.allowedClientIds
        });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(roster));
      } catch (error) {
        res.statusCode = error?.statusCode || 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error' }));
      }
      return;
    }

    const seatWriteRoute =
      (requestUrl.pathname === '/seats/invite' && 'invite')
      || (requestUrl.pathname === '/seats/invite-email' && 'invite_email')
      || (requestUrl.pathname === '/seats/update' && 'update')
      || (requestUrl.pathname === '/seats/entities' && 'entities')
      || null;
    if (seatWriteRoute && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readBody();
      const firmId = body?.firm_id || DEFAULT_FIRM_ID;
      const access = await assertFirmAccess({ firmId, auth: req.donnaAuth });
      if (await principalIsFirmInvitedOwnerInDb({ firmId, principal: access.principal })) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'A client portal owner cannot manage the firm’s team.', code: 'CLIENT_OWNER_PORTAL_ONLY' }));
        return;
      }
      try {
        let payload;
        if (seatWriteRoute === 'invite') {
          const seat = await inviteSeatInDb({
            firmId,
            actorPrincipal: access.principal,
            allowedClientIds: access.allowedClientIds,
            invite: {
              name: body?.name,
              email: body?.email,
              seatRole: body?.seat_role || body?.seatRole,
              affiliation: body?.affiliation || 'internal',
              clientIds: body?.client_ids || body?.clientIds || [],
              endsAt: body?.ends_at || body?.endsAt || null
            }
          });
          const firmName = String(body?.firm_name || '').trim() || 'your team';
          const inviteEmail = await sendSeatInviteEmail({ seat, firmName });
          // Stamp the outcome onto the row (migration 125) so a skipped or
          // failed send survives the transient notice; non-fatal — the seat
          // and the send already happened, and a resend re-stamps.
          const stamped = await recordSeatInviteEmailOutcome({
            firmId, actorPrincipal: access.principal, seatId: seat.id, outcome: inviteEmail
          });
          payload = {
            seat: {
              ...seat,
              invite_email_status: stamped.invite_email_status,
              invite_email_reason: stamped.invite_email_reason,
              invite_email_at: stamped.invite_email_at
            },
            invite_email: inviteEmail
          };
        } else if (seatWriteRoute === 'invite_email') {
          payload = await resendSeatInviteEmail({
            firmId,
            actorPrincipal: access.principal,
            allowedClientIds: access.allowedClientIds,
            seatId: String(body?.seat_id || ''),
            firmName: String(body?.firm_name || '').trim() || 'your team'
          });
        } else if (seatWriteRoute === 'update') {
          const seat = await updateSeatInDb({
            firmId,
            actorPrincipal: access.principal,
            allowedClientIds: access.allowedClientIds,
            seatId: String(body?.seat_id || ''),
            op: String(body?.op || ''),
            params: { seat_role: body?.seat_role, ends_at: body?.ends_at }
          });
          payload = { seat };
        } else {
          const seat = await setSeatEntitiesInDb({
            firmId,
            actorPrincipal: access.principal,
            allowedClientIds: access.allowedClientIds,
            seatId: String(body?.seat_id || ''),
            clientIds: body?.client_ids || body?.clientIds || []
          });
          payload = { seat };
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(payload));
      } catch (error) {
        res.statusCode = error?.statusCode || 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error', code: error?.code }));
      }
      return;
    }

    // Client-owner portal invites (clientOwnerInvitesDb.js, migration 166):
    // the firm invites its client's business owner into THAT client's portal.
    // Auth + transport only here; the authorization law (firm owner only,
    // never a portal principal), the same-firm conflict rule and every
    // in-transaction receipt live in the module. Literal pathnames, like the
    // seat routes above.
    const ownerAccessWriteRoute =
      (requestUrl.pathname === '/owner-access/invite' && 'invite')
      || (requestUrl.pathname === '/owner-access/resend' && 'resend')
      || (requestUrl.pathname === '/owner-access/revoke' && 'revoke')
      || (requestUrl.pathname === '/owner-access/remove' && 'remove')
      || null;
    if ((requestUrl.pathname === '/owner-access' && req.method === 'GET')
      || (ownerAccessWriteRoute && req.method === 'POST')) {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = ownerAccessWriteRoute ? await readBody() : null;
      const firmId = resolveRequestFirmId({ body, query: requestUrl.searchParams, auth: req.donnaAuth });
      const clientId = String(body?.client_id || requestUrl.searchParams.get('client_id') || '').trim();
      try {
        if (!clientId) throw Object.assign(new Error('client_id is required.'), { statusCode: 400, code: 'CLIENT_ID_REQUIRED' });
        const access = await assertFirmAccess({ firmId, auth: req.donnaAuth, clientIds: [clientId] });
        const actorPrincipal = access.principal;
        let payload;
        if (!ownerAccessWriteRoute) {
          payload = await getClientOwnerAccessInDb({ firmId, clientId, actorPrincipal });
        } else if (ownerAccessWriteRoute === 'invite' || ownerAccessWriteRoute === 'resend') {
          const minted = ownerAccessWriteRoute === 'invite'
            ? await inviteClientOwnerInDb({ firmId, clientId, actorPrincipal,
              invite: { name: body?.name, email: body?.email, language: body?.language ?? null } })
            : await resendClientOwnerInviteInDb({ firmId, clientId, actorPrincipal });
          // Post-commit, best-effort, stamped — the staff-invite posture. The
          // token leaves this process only inside the email.
          const firmName = await readFirmNameInDb({ firmId });
          const inviteEmail = await sendClientOwnerInviteEmail({ invite: minted.invite, token: minted.token,
            firmName, companyName: minted.emailContext.companyName, language: minted.emailContext.language });
          await recordClientOwnerInviteEmailOutcomeInDb({ firmId, clientId, inviteId: minted.invite.id,
            actorPrincipal, outcome: inviteEmail });
          payload = { ...(await getClientOwnerAccessInDb({ firmId, clientId, actorPrincipal })), invite_email: inviteEmail };
        } else if (ownerAccessWriteRoute === 'revoke') {
          payload = await revokeClientOwnerInviteInDb({ firmId, clientId, actorPrincipal });
        } else {
          payload = await removeClientOwnerAccessInDb({ firmId, clientId, actorPrincipal });
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(payload));
      } catch (error) {
        res.statusCode = error?.statusCode || 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error', code: error?.code }));
      }
      return;
    }

    // Acceptance: the signed-in person whose VERIFIED email matches the invite
    // becomes that client's owner principal. The token names the firm and the
    // client; nothing on the request can. Admitted past the auth gate only for
    // this path (resolveSubmittedDonnaAuth).
    if (requestUrl.pathname === '/owner-invites/accept' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readJsonBody(req);
      try {
        const accepted = await acceptClientOwnerInviteInDb({ auth: req.donnaAuth, token: String(body?.token || '') });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(accepted));
      } catch (error) {
        res.statusCode = error?.statusCode || 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.statusCode ? error.message : 'Could not accept the invitation.', code: error?.code }));
      }
      return;
    }

    // MCP consent surface (design-donna-mcp-surface.md §8 item 1): the
    // owner's per-entity "expose this venture to Claude" read + write, in
    // mcp/mcpConsent.js; these blocks add auth + transport only. This is the
    // OWNER surface — it may list every entity the principal can see with
    // its exposure state (the no-existence-leak rule binds the /api/donna/mcp
    // external-model funnel, not this screen). The write is the SAME audited
    // setClientFlagStage path the enable script uses: client-specific row,
    // canary to expose / off to revoke, actor_type 'owner' with the real
    // principal id (the S3 roles pattern above).
    if (requestUrl.pathname === '/mcp-exposure' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const firmId = requestUrl.searchParams.get('firm_id') || DEFAULT_FIRM_ID;
      const access = await assertFirmAccess({ firmId, auth: req.donnaAuth });
      try {
        const exposure = await listEntityExposure({
          firmId, allowedClientIds: access.allowedClientIds
        });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(exposure));
      } catch (error) {
        res.statusCode = error?.statusCode || 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error' }));
      }
      return;
    }

    if (requestUrl.pathname === '/mcp-exposure' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readBody();
      const firmId = body?.firm_id || DEFAULT_FIRM_ID;
      const clientId = body?.client_id || body?.clientId || '';
      const access = await assertFirmAccess({
        firmId, auth: req.donnaAuth, clientIds: collectClientIds(clientId)
      });
      const actorId = access.principal?.email || access.principal?.userId
        || access.principal?.principalId || 'workspace';
      try {
        const result = await setEntityExposure({
          firmId,
          clientId,
          expose: body?.expose,
          reason: typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim() : null,
          actorId
        });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (error) {
        res.statusCode = error?.statusCode || 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error', code: error?.code || null }));
      }
      return;
    }

    // G15/D12 — the owner Actions surface (the workspace tab the digest
    // deep-links into). One read + three writer-routed mutations, all in
    // outbound/ownerActionsSurface.js; these blocks add auth + transport only.
    // Client-scoped access (the standard clientIds gate); the acting principal
    // is the authenticated user — actor_type 'owner' (this is the owner
    // dashboard surface, D12), actor_id the real principal (attribution rail).
    if (requestUrl.pathname === '/outbound/owner-actions' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const firmId = requestUrl.searchParams.get('firm_id') || DEFAULT_FIRM_ID;
      const clientId = requestUrl.searchParams.get('client_id') || requestUrl.searchParams.get('clientId') || '';
      if (!clientId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id is required.' }));
        return;
      }
      await assertFirmAccess({
        firmId, auth: req.donnaAuth, clientIds: collectClientIds(clientId)
      });
      const surface = await withFirmDbClient(
        (dbClient) => readOwnerActionsSurface(dbClient, { firmId, clientId })
      );
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ surface }));
      return;
    }

    if (requestUrl.pathname === '/outbound/owner-actions/decide' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readBody();
      const firmId = body?.firm_id || DEFAULT_FIRM_ID;
      const clientId = body?.client_id || body?.clientId || '';
      const access = await assertFirmAccess({
        firmId, auth: req.donnaAuth, clientIds: collectClientIds(clientId)
      });
      const actorId = access.principal?.email || access.principal?.userId || access.principal?.principalId || 'workspace';
      const result = await withFirmDbClient((dbClient) => decideOwnerAction(dbClient, {
        firmId, clientId,
        actionId: String(body?.action_id || ''),
        decision: String(body?.decision || ''),
        actorType: 'owner', actorId
      }));
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
      return;
    }

    if (requestUrl.pathname === '/outbound/owner-actions/edit' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readBody();
      const firmId = body?.firm_id || DEFAULT_FIRM_ID;
      const clientId = body?.client_id || body?.clientId || '';
      const access = await assertFirmAccess({
        firmId, auth: req.donnaAuth, clientIds: collectClientIds(clientId)
      });
      const actorId = access.principal?.email || access.principal?.userId || access.principal?.principalId || 'workspace';
      const result = await withFirmDbClient((dbClient) => editOwnerHeldDraft(dbClient, {
        firmId, clientId,
        actionId: String(body?.action_id || ''),
        renderValues: body?.render_values && typeof body.render_values === 'object' ? body.render_values : {},
        actorType: 'owner', actorId
      }));
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
      return;
    }

    if (requestUrl.pathname === '/outbound/owner-actions/party-language' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readBody();
      const firmId = body?.firm_id || DEFAULT_FIRM_ID;
      const clientId = body?.client_id || body?.clientId || '';
      const access = await assertFirmAccess({
        firmId, auth: req.donnaAuth, clientIds: collectClientIds(clientId)
      });
      const actorId = access.principal?.email || access.principal?.userId || access.principal?.principalId || 'workspace';
      const result = await withFirmDbClient((dbClient) => setOwnerActionPartyLanguage(dbClient, {
        firmId, clientId,
        actionId: String(body?.action_id || ''),
        attribute: String(body?.attribute || ''),
        language: String(body?.language || ''),
        actorType: 'owner', actorId
      }));
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
      return;
    }

    if (requestUrl.pathname === '/outbound/owner-actions/mark-wrong' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readBody();
      const firmId = body?.firm_id || DEFAULT_FIRM_ID;
      const clientId = body?.client_id || body?.clientId || '';
      const access = await assertFirmAccess({
        firmId, auth: req.donnaAuth, clientIds: collectClientIds(clientId)
      });
      const actorId = access.principal?.email || access.principal?.userId || access.principal?.principalId || 'workspace';
      const result = await withFirmDbClient((dbClient) => markOwnerAutoSentWrong(dbClient, {
        firmId, clientId,
        actionId: String(body?.action_id || ''),
        actorType: 'owner', actorId
      }));
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
      return;
    }

    if (requestUrl.pathname === '/outbound/owner-actions/reverse-post' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readBody();
      const firmId = body?.firm_id || DEFAULT_FIRM_ID;
      const clientId = body?.client_id || body?.clientId || '';
      const access = await assertFirmAccess({
        firmId, auth: req.donnaAuth, clientIds: collectClientIds(clientId)
      });
      const actorId = access.principal?.email || access.principal?.userId || access.principal?.principalId || 'workspace';
      const result = await withFirmDbClient((dbClient) => reverseOwnerAutoSentPost(dbClient, {
        firmId, clientId,
        actionId: String(body?.action_id || ''),
        actorType: 'owner', actorId
      }));
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
      return;
    }

    if (requestUrl.pathname === '/outbound/owner-actions/case' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readBody();
      const firmId = body?.firm_id || DEFAULT_FIRM_ID;
      const clientId = body?.client_id || body?.clientId || '';
      const access = await assertFirmAccess({
        firmId, auth: req.donnaAuth, clientIds: collectClientIds(clientId)
      });
      const actorId = access.principal?.email || access.principal?.userId || access.principal?.principalId || 'workspace';
      const result = await withFirmDbClient((dbClient) => actOnOwnerReceivableCase(dbClient, {
        firmId, clientId,
        caseId: String(body?.case_id || ''),
        verb: String(body?.verb || ''),
        reason: body?.reason ? String(body.reason) : null,
        actorType: 'owner', actorId
      }));
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
      return;
    }

    // Donna Loops Phase 6.2 — governance read path for memory candidates (the
    // front-gate to firm_facts). Lists a client's candidates with their PERSISTED
    // status (rail #1) so a human can promote/dismiss them; a 'conflicted'
    // candidate carries conflicts_with (the contradicting active facts) so the
    // resolve UI can show what it disagrees with. Double-gated exactly like the
    // close-blocker dashboard so prod stays unchanged until LOOPS_SHADOW is
    // validated:
    //   - LOOPS_SHADOW off (prod default) → { enabled:false, candidates:[] }
    //   - migration 036 absent → { enabled:false, candidates:[] }
    // Either way a 200 with an honest empty payload, never an error. Candidates
    // are client-scoped, so the gate is the standard clientIds check (a member
    // sees their own client).
    if (requestUrl.pathname === '/memory-candidates' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = requestUrl.searchParams.get('client_id') || requestUrl.searchParams.get('clientId') || '';
      const status = requestUrl.searchParams.get('status') || null;
      await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      if (!clientId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id is required.' }));
        return;
      }
      // DMEM-R1 W1 (audit F-10 / N-05): the ONE resolved posture — the
      // MEMORY_CANDIDATES plane key for this client. The governance surface
      // renders (acts) exactly when the producers stage under an acting
      // posture; the raw LOOPS_SHADOW read that split the pair is gone.
      const resolved = await withFirmDbClient(async (dbClient) => {
        const posture = await resolveMemoryCandidatesPosture({ client: dbClient, firmId: firmId || DEFAULT_FIRM_ID, clientId });
        if (!memoryCandidatesGovernanceMayAct(posture.posture)) return { posture, candidates: null };
        if (!(await memoryCandidatesTablePresent(dbClient))) return { posture, candidates: null };
        return {
          posture,
          candidates: await listMemoryCandidatesWithConflicts({
            client: dbClient,
            firmId: firmId || DEFAULT_FIRM_ID,
            clientId,
            status
          })
        };
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        enabled: resolved.candidates !== null,
        posture: resolved.posture.posture,
        candidates: resolved.candidates || []
      }));
      return;
    }

    // Donna Loops Phase 6.2 — the FIRST Loops write surface: promote/dismiss a
    // memory candidate (the human "yes"/"no" governing what reaches firm_facts).
    // Flag-gated like the read path — when LOOPS_SHADOW is off the write is a
    // no-op { enabled:false } so the surface is inert in prod until validated. The
    // primitives are the single writers: promoteMemoryCandidate mints the fact via
    // saveFirmFact + marks the candidate promoted (never overriding a human "no"),
    // dismissMemoryCandidate flips it dismissed and cascades to retire any minted
    // fact. Wrapped in an explicit transaction so the candidate transition and the
    // firm_facts side effect commit atomically. Client-scoped — the body carries
    // client_id and the gate is the standard clientIds check.
    const memoryCandidateAction = requestUrl.pathname.match(/^\/memory-candidates\/([^/]+)\/(promote|dismiss)$/);
    if (memoryCandidateAction && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const candidateId = decodeURIComponent(memoryCandidateAction[1]);
      const action = memoryCandidateAction[2];
      const body = await readBody();
      const firmId = body?.firm_id || DEFAULT_FIRM_ID;
      const clientId = body?.client_id || body?.clientId || '';
      // W1 (F-04, INV-05 / INV-12): the write fails closed without the legal
      // entity and the version token the human read — 400, never a silent no-op.
      const expectedVersion = body?.expected_version || body?.expectedVersion || null;
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      if (!clientId || !expectedVersion) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          error: !clientId ? 'client_id is required.' : 'expected_version is required (the candidate version the list returned).',
          refused: !clientId ? 'missing_legal_entity' : 'missing_expected_version',
          candidate_id: candidateId
        }));
        return;
      }
      const decidedBy = access.principal?.email || access.principal?.userId || access.principal?.principalId || 'system';
      const result = await withFirmDbClient(async (dbClient) => {
        // The ONE posture (F-10): the write acts only while MEMORY_CANDIDATES acts.
        const posture = await resolveMemoryCandidatesPosture({ client: dbClient, firmId, clientId });
        if (!memoryCandidatesGovernanceMayAct(posture.posture)) return { enabled: false, posture: posture.posture };
        if (!(await memoryCandidatesTablePresent(dbClient))) return { enabled: false, posture: posture.posture };
        await dbClient.query('begin');
        try {
          const out = action === 'promote'
            ? await promoteMemoryCandidate({ client: dbClient, firmId, clientId, candidateId, expectedVersion, decidedBy })
            : await dismissMemoryCandidate({ client: dbClient, firmId, clientId, candidateId, expectedVersion, decidedBy });
          await dbClient.query('commit');
          return { enabled: true, posture: posture.posture, ...out };
        } catch (error) {
          await dbClient.query('rollback');
          throw error;
        }
      });
      res.statusCode = result?.refused === 'version_mismatch' ? 409 : 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ candidate_id: candidateId, promoted: false, dismissed: false, ...(result || { enabled: false }) }));
      return;
    }

    // Governance write: dismiss a firm fact by its stable id (flips
    // firm_facts.status to 'dismissed' via the single dismissFirmFact writer).
    // Firm-member only — firm_facts are firm-scoped memory, not client-scoped —
    // so requireMember is true and no clientIds are involved. Idempotent:
    // dismissing an already-inactive fact returns dismissed:false.
    const firmFactDismiss = requestUrl.pathname.match(/^\/firm-facts\/([^/]+)\/dismiss$/);
    if (firmFactDismiss && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const factId = decodeURIComponent(firmFactDismiss[1]);
      const body = await readBody();
      const firmId = body?.firm_id || DEFAULT_FIRM_ID;
      const dismissAccess = await assertFirmAccess({ firmId, auth: req.donnaAuth, requireMember: true });
      // G1c: the writer now emits the in-transaction `firm_fact.dismissed`
      // audit (audit-as-precondition), so the route wraps a transaction and
      // threads the authenticated principal — the dismiss is no longer silent.
      const dismissed = await withFirmDbClient(async (dbClient) => {
        await dbClient.query('begin');
        try {
          const out = await dismissFirmFact({
            client: dbClient,
            firmId,
            factId,
            actorId: chatApplyActorId(dismissAccess.principal),
            reason: typeof body?.reason === 'string' ? body.reason : null,
            source: 'governance_panel'
          });
          await dbClient.query('commit');
          return out;
        } catch (error) {
          await dbClient.query('rollback');
          throw error;
        }
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ dismissed, fact_id: factId }));
      return;
    }

    // Governance write: ERASE a firm fact — "delete this personal
    // information" (G1c / build-spec PR-10). Scrub-and-rekey via the single
    // eraseFirmFact writer: content replaced by a hash receipt, the row
    // re-keyed to a content-free tombstone, the fact's prior audit metadata
    // scrubbed, `firm_fact.erased` recorded, and re-minting the same content
    // blocked forever (restore-after-erasure). Distinct from dismiss on
    // purpose: dismiss KEEPS content as the governance "no"; erase REMOVES
    // it. Firm-member only, same posture as dismiss. Chat exposure is
    // deliberately deferred to G4-local (recorded in plan §5 G1c).
    const firmFactErase = requestUrl.pathname.match(/^\/firm-facts\/([^/]+)\/erase$/);
    if (firmFactErase && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const factId = decodeURIComponent(firmFactErase[1]);
      const body = await readBody();
      const firmId = body?.firm_id || DEFAULT_FIRM_ID;
      const eraseAccess = await assertFirmAccess({ firmId, auth: req.donnaAuth, requireMember: true });
      const outcome = await withFirmDbClient(async (dbClient) => {
        await dbClient.query('begin');
        try {
          const out = await eraseFirmFact({
            client: dbClient,
            firmId,
            factId,
            actorId: chatApplyActorId(eraseAccess.principal),
            reason: typeof body?.reason === 'string' ? body.reason : null
          });
          await dbClient.query('commit');
          return out;
        } catch (error) {
          await dbClient.query('rollback');
          throw error;
        }
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ fact_id: factId, ...outcome }));
      return;
    }


    if (requestUrl.pathname === '/hmrc/connect' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = requestUrl.searchParams.get('client_id') || requestUrl.searchParams.get('clientId') || '';
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      if (access.principal?.unrestricted || access.principal?.principalType !== 'firm_collaborator') {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ code: 'HMRC_OWNER_GRANT_REQUIRED', error: 'HMRC must be connected by the business owner from the client portal.' }));
        return;
      }
      await assertClientEntitled({ firmId, clientId, principal: access.principal, billingEnabled: isBillingEnabled() });
      const redirectUri = buildOAuthCallbackUrl({ origin: resolveOAuthCallbackOrigin(req), system: 'hmrc' });
      const payload = await startHmrcConnectionInDb({
        firmId,
        clientId,
        returnTo: safeFirmReturnTo(requestUrl.searchParams.get('return_to') || requestUrl.searchParams.get('returnTo') || '/client'),
        redirectUri,
        hmrcUserType: requestUrl.searchParams.get('hmrc_user_type') || requestUrl.searchParams.get('hmrcUserType') || 'organisation',
        principal: access.principal
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(payload));
      return;
    }

    if (requestUrl.pathname === '/hmrc/callback' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const code = requestUrl.searchParams.get('code') || '';
      const state = requestUrl.searchParams.get('state') || '';
      const result = await completeHmrcConnectionInDb({ code, state });
      const returnTo = new URL(safeFirmReturnTo(result.state?.return_to || '/client'), 'http://localhost');
      returnTo.searchParams.set('hmrc', 'connected');
      res.statusCode = 302;
      res.setHeader('Location', `${returnTo.pathname}${returnTo.search}`);
      res.end();
      return;
    }

    if (requestUrl.pathname === '/xero/connect' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = requestUrl.searchParams.get('client_id') || requestUrl.searchParams.get('clientId') || '';
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      await assertClientEntitled({ firmId, clientId, principal: access.principal, billingEnabled: isBillingEnabled() });
      const adapter = getAccountingSystemAdapter(await getClientAccountingSystemFromDb({ firmId, clientId }));
      // Host-derive the OAuth callback URL from THIS request (verified +
      // allow-listed) so the provider redirects back to the deployment the
      // operator actually loaded — not a possibly-stale *_REDIRECT_URI env.
      // resolveOAuthCallbackOrigin throws a 400 (surfaced by the top-level
      // handler) on a spoofed Host or a non-allow-listed origin, failing loud
      // instead of emitting an authorize URL with an unsafe callback. The
      // 'none' adapter has no OAuth callback (startConnection refuses anyway).
      const redirectUri = adapter.id === 'xero' || adapter.id === 'qbo' || adapter.id === 'procountor'
        ? buildOAuthCallbackUrl({ origin: resolveOAuthCallbackOrigin(req), system: adapter.id })
        : undefined;
      const payload = await adapter.startConnection({
        firmId,
        clientId,
        returnTo: safeFirmReturnTo(requestUrl.searchParams.get('return_to') || requestUrl.searchParams.get('returnTo')),
        redirectUri
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ...payload, access: { principal_type: access.principal?.principalType || null } }));
      return;
    }

    if (requestUrl.pathname === '/xero/callback' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const code = requestUrl.searchParams.get('code') || '';
      const state = requestUrl.searchParams.get('state') || '';
      const result = await completeXeroConnectionInDb({ code, state });
      const returnTo = new URL(safeFirmReturnTo(result.state?.return_to), 'http://localhost');
      returnTo.searchParams.set('xero', 'connected');
      returnTo.searchParams.set('xero_tenants', String(result.connections.length));
      res.statusCode = 302;
      res.setHeader('Location', `${returnTo.pathname}${returnTo.search}`);
      res.end();
      return;
    }

    if ((requestUrl.pathname === '/qbo/callback' || requestUrl.pathname === '/procountor/callback') && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      // QBO returns the realm_id as a callback query param (?realmId=...) — it
      // IS the connection, there is no /connections fan-out like Xero.
      const code = requestUrl.searchParams.get('code') || '';
      const state = requestUrl.searchParams.get('state') || '';
      const isProcountorCallback = requestUrl.pathname === '/procountor/callback';
      const realmId = requestUrl.searchParams.get('realmId') || requestUrl.searchParams.get('realm_id') || '';
      const companyId = requestUrl.searchParams.get('companyId') || requestUrl.searchParams.get('company_id') || requestUrl.searchParams.get('company') || realmId;
      try {
        const result = isProcountorCallback
          ? await completeProcountorConnectionInDb({ code, state, companyId })
          : await completeQboConnectionInDb({ code, state, realmId });
        const returnTo = new URL(safeFirmReturnTo(result.state?.return_to), 'http://localhost');
        returnTo.searchParams.set(isProcountorCallback ? 'procountor' : 'qbo', 'connected');
        returnTo.searchParams.set(isProcountorCallback ? 'procountor_company' : 'qbo_realm', String(result.connection?.companyId || result.connection?.realmId || ''));
        res.statusCode = 302;
        res.setHeader('Location', `${returnTo.pathname}${returnTo.search}`);
        res.end();
        return;
      } catch (callbackError) {
        // Surface the failure IN THE APP instead of dead-ending on a raw error
        // page (the connect uses same-tab navigation, so a thrown callback left
        // the operator on an opaque error with no clue what broke — token
        // exchange, redirect_uri, missing company id, unconfigured env). Recover
        // the operator's return path from the signed state (best-effort — an
        // expired/invalid state just falls back to the accounting tab) and
        // redirect back with ?<system>_error so the card can render it.
        if (!isProcountorCallback) throw callbackError;
        let returnPath = '/firms?tab=accounting';
        try { returnPath = safeFirmReturnTo(verifyProcountorState(state)?.return_to); } catch { /* expired/forged state — use the default */ }
        const returnTo = new URL(returnPath, 'http://localhost');
        returnTo.searchParams.set('procountor_error', String(callbackError?.message || 'Procountor connection failed.').slice(0, 300));
        res.statusCode = 302;
        res.setHeader('Location', `${returnTo.pathname}${returnTo.search}`);
        res.end();
        return;
      }
    }

    // Procountor M2M connect — the operator pastes a Procountor API key (created
    // in Procountor UI) and Donna mints a client_credentials token from it. No
    // OAuth redirect: Procountor provisions our client for the M2M grant, not the
    // interactive authorization_code grant. Member-gated + entitlement-checked,
    // like a connect that stores a durable credential.
    if (requestUrl.pathname === '/procountor/connect-apikey' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || body?.clientId || '';
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId),
        requireMember: true
      });
      await assertClientEntitled({ firmId, clientId, principal: access.principal, billingEnabled: isBillingEnabled() });
      const actorId = access.principal?.email || access.principal?.userId || access.principal?.principalId || 'system';
      const result = await connectProcountorWithApiKeyInDb({
        firmId,
        clientId,
        apiKey: body?.api_key || body?.apiKey || '',
        actorId
      });
      const snapshot = await getFirmSnapshotFromDb({ firmId });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ...filterFirmSnapshotForAccess(snapshot, access), procountor_connection: result.connection }));
      return;
    }

    // Disconnect dispatches by the CLIENT's accounting_system, so it answers to
    // BOTH the legacy /qbo/disconnect path and the symmetric /xero/disconnect
    // alias — a Xero client tears down its xero_connections row, a QBO client
    // its qbo_connections row, whichever prefix the caller hits. (Connect / sync
    // / mirror already dispatch this way; disconnect was the one verb that had
    // only the QBO half, so a Xero connection could never be torn down.)
    if (
      (requestUrl.pathname === '/xero/disconnect' || requestUrl.pathname === '/qbo/disconnect' || requestUrl.pathname === '/procountor/disconnect') &&
      req.method === 'POST'
    ) {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || body?.clientId || '';
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      const adapter = getAccountingSystemAdapter(await getClientAccountingSystemFromDb({ firmId, clientId }));
      const connectionId = body?.connection_id || body?.connectionId || undefined;
      if (adapter.id === 'qbo') {
        await disconnectQboConnectionInDb({ firmId, clientId, connectionId });
      } else if (adapter.id === 'procountor') {
        await disconnectProcountorConnectionInDb({ firmId, clientId, connectionId });
      } else if (adapter.id === 'xero') {
        await disconnectXeroConnectionInDb({ firmId, clientId, connectionId });
      }
      // The 'none' adapter has no connection to tear down — fall through to the
      // fresh snapshot so the card reconciles to its real (unconnected) state.
      // Return the fresh snapshot (source: 'database') so the operator card can
      // reconcile the now-disconnected status the same way the profile-write
      // path does.
      const snapshot = filterFirmSnapshotForAccess(await getFirmSnapshotFromDb({ firmId }), access);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(snapshot));
      return;
    }

    // Pod-safety #2 — the reverse EXECUTOR endpoint. FOUNDER-ONLY (requireMember: true, plus
    // the capability layer on the compiled reverse action_type as defense-in-depth). dryRun
    // defaults TRUE: a bare call returns the plan (what would reverse / stale / needs a ledger
    // adjustment) with no write. Set { execute: true } (or dry_run: false) to apply. A posted
    // line is SURFACED (needs_ledger_adjustment), never auto-un-posted — Kari posts the dated
    // adjustment journal.
    if (requestUrl.pathname === '/operator/reverse' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || body?.clientId || '';
      if (!clientId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id is required.' }));
        return;
      }
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId),
        requireMember: true
      });
      const actorId = access.principal?.email || access.principal?.userId || access.principal?.principalId || 'system';
      // Defense-in-depth over requireMember: the capability layer refuses reverse below founder
      // once staged. (requireMember already means firm-member = founder class, so this is inert
      // today — it hardens against a future where a scoped principal could reach this route.)
      try {
        await assertActionCapability({ firmId, clientId, principal: access.principal, actionType: REVERSE_ACTION_TYPE });
      } catch (capError) {
        res.statusCode = capError?.statusCode || 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: capError?.message || 'Capability denied.' }));
        return;
      }
      const dryRun = !(body?.execute === true || body?.dry_run === false || body?.dryRun === false);
      const proposalIds = Array.isArray(body?.proposal_ids)
        ? body.proposal_ids
        : (Array.isArray(body?.proposalIds) ? body.proposalIds : null);
      const result = await reverseAppliesInDb({ firmId, clientId, proposalIds, actorId, dryRun });
      const { snapshot, ...rest } = result;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        ...rest,
        ...(snapshot ? { snapshot: filterFirmSnapshotForAccess(snapshot, access) } : {})
      }));
      return;
    }

    if (requestUrl.pathname === '/xero/status' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = requestUrl.searchParams.get('client_id') || requestUrl.searchParams.get('clientId') || '';
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId),
        requireMember: !clientId
      });
      const snapshot = filterFirmSnapshotForAccess(await getFirmSnapshotFromDb({ firmId }), access);
      const matchesClient = (item) => !clientId || item?.client_id === clientId;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          connections: (snapshot.xeroConnections || []).filter(matchesClient),
          accounts: (snapshot.xeroAccounts || []).filter(matchesClient),
          contacts: (snapshot.xeroContacts || []).filter(matchesClient),
          syncRuns: (snapshot.xeroSyncRuns || []).filter(matchesClient)
        })
      );
      return;
    }

    if (
      (requestUrl.pathname === '/xero/sync-reference-data' ||
        requestUrl.pathname === '/procountor/sync-reference-data') &&
      req.method === 'POST'
    ) {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || body?.clientId || '';
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      const adapter = getAccountingSystemAdapter(await getClientAccountingSystemFromDb({ firmId, clientId }));
      const snapshot = await adapter.syncReferenceData({
        firmId,
        clientId,
        connectionId: body?.connection_id || body?.connectionId || undefined
      });
      // Canonical-role resolution over the freshly synced chart — the lane's
      // first production caller (proposer → planner → owner ask; flag-dark by
      // default via CANONICAL_ROLE_RESOLUTION on the config plane). Fail-soft:
      // a resolution error must never fail the sync that triggered it, and the
      // receipt rides the response so the caller sees what happened rather
      // than a silent side effect.
      let canonicalRoleResolution = null;
      if (clientId) {
        try {
          // Donna is the actor (model proposes, Keep layer refuses); the
          // authenticated principal who triggered the sync rides the receipt
          // for attribution (the actor-attribution rail).
          canonicalRoleResolution = await runCanonicalRoleResolutionForClient({
            firmId,
            clientId,
            triggeredBy: `xero_sync_reference_data:${access?.principal?.principalId || 'unknown'}`
          });
        } catch (error) {
          canonicalRoleResolution = {
            status: 'error',
            reason: error?.code || error?.message || 'unknown'
          };
        }
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        ...filterFirmSnapshotForAccess(snapshot, access),
        canonical_role_resolution: canonicalRoleResolution
      }));
      return;
    }

    if (requestUrl.pathname === '/xero/provision-coa' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || body?.clientId || '';
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      const adapter = getAccountingSystemAdapter(await getClientAccountingSystemFromDb({ firmId, clientId }));
      const result = await adapter.provisionChartOfAccounts({
        firmId,
        clientId,
        connectionId: body?.connection_id || body?.connectionId || undefined,
        dryRun: body?.dry_run !== false && body?.execute !== true
      });
      const responsePayload = result.snapshot
        ? {
            ...filterFirmSnapshotForAccess(result.snapshot, access),
            xero_coa_provision: result.xero_coa_provision
          }
        : result;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(responsePayload));
      return;
    }

    // Connector writeback/mirror verbs dispatch by the CLIENT's
    // accounting_system (resolved into an adapter below), so the path prefix is
    // cosmetic: each answers to BOTH the legacy `/xero/<verb>` path and the
    // symmetric `/qbo/<verb>` alias. A QBO client therefore mirrors to
    // QuickBooks whether the caller hits `/xero/...` or `/qbo/...`; the alias
    // just lets QBO tooling target a non-Xero-named path. Both literals are kept
    // inline (not behind a helper) so a path grep lands on the handler.
    if (
      (requestUrl.pathname === '/xero/writeback-transaction' ||
        requestUrl.pathname === '/qbo/writeback-transaction' ||
        requestUrl.pathname === '/procountor/writeback-transaction') &&
      req.method === 'POST'
    ) {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || body?.clientId || '';
      const transactionId = body?.transaction_id || body?.transactionId || '';
      // INT-5: a live push requires a firm member (the #804 gap — /ledger/post-*
      // had this, the writeback routes did not) AND, once OPERATOR_CAPABILITY_ENFORCE
      // is staged, sync_to_accounting capability (partner-class since the seat
      // build — irreversible external push; requireMember additionally keeps
      // collaborator-backed seats off this route in v1, the fail-closed
      // direction until PARTNER push is deliberately opened). Dry-run previews
      // stay open to any book reader.
      const executing = body?.dry_run === false || body?.execute === true || body?.force === true;
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId),
        requireMember: executing
      });
      if (executing) {
        await assertActionCapability({ firmId, clientId, principal: access.principal, actionType: 'sync_to_accounting' });
      }
      const adapter = getAccountingSystemAdapter(await getClientAccountingSystemFromDb({ firmId, clientId }));
      const actorId = access.principal?.email || access.principal?.userId || access.principal?.principalId || 'system';
      const result = await adapter.writebackTransaction({
        firmId,
        clientId,
        transactionId,
        connectionId: body?.connection_id || body?.connectionId || undefined,
        dryRun: body?.dry_run !== false && body?.execute !== true,
        force: body?.force === true,
        actorId
      });
      const responsePayload = result.snapshot
        ? {
            ...filterFirmSnapshotForAccess(result.snapshot, access),
            xero_writeback: result.xero_writeback
          }
        : result;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(responsePayload));
      return;
    }

    if (requestUrl.pathname === '/ledger/post-transaction' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || body?.clientId || '';
      const transactionId = body?.transaction_id || body?.transactionId || '';
      const executing = body?.dry_run === false || body?.execute === true || body?.force === true;
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId),
        requireMember: executing
      });
      // INT-5: posting is the head of the sync_to_accounting path — founder
      // capability once OPERATOR_CAPABILITY_ENFORCE is staged (route-gating only).
      if (executing) {
        await assertActionCapability({ firmId, clientId, principal: access.principal, actionType: 'sync_to_accounting' });
      }
      const actingPrincipal = executing
        ? await resolveDesktopClientCreationPrincipal({ firmId, principal: access.principal }) : access.principal;
      if (executing && (actingPrincipal?.role === 'viewer' || ['viewer', 'read_only'].includes(actingPrincipal?.accessLevel))) {
        throw Object.assign(new Error('Accounting write authority is required to post this transaction.'), { code:'LEDGER_POST_AUTHORITY_REQUIRED',statusCode:403 });
      }
      const actorId = actingPrincipal?.principalId || actingPrincipal?.userId || actingPrincipal?.email || 'system';
      const result = await postLedgerTransactionInDb({
        firmId,
        clientId,
        transactionId,
        dryRun: body?.dry_run !== false && body?.execute !== true,
        force: body?.force === true,
        actorId
      });
      const responsePayload = result.snapshot
        ? {
            ...filterFirmSnapshotForAccess(result.snapshot, access),
            ledger_posting: result.ledger_posting
          }
        : result;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(responsePayload));
      return;
    }

    if (requestUrl.pathname === '/ledger/post-period' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || body?.clientId || '';
      const executing = body?.dry_run === false || body?.execute === true || body?.force === true;
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId),
        requireMember: executing
      });
      // INT-5: same founder gate as post-transaction (whole-period live post).
      if (executing) {
        await assertActionCapability({ firmId, clientId, principal: access.principal, actionType: 'sync_to_accounting' });
      }
      const actorId = access.principal?.email || access.principal?.userId || access.principal?.principalId || 'system';
      const result = await postLedgerPeriodInDb({
        firmId,
        clientId,
        periodStart: body?.period_start || body?.periodStart || undefined,
        periodEnd: body?.period_end || body?.periodEnd || undefined,
        dryRun: body?.dry_run !== false && body?.execute !== true,
        force: body?.force === true,
        reviewStates: body?.review_states || body?.reviewStates || ['accepted'],
        limit: body?.limit,
        actorId
      });
      const responsePayload = result.snapshot
        ? {
            ...filterFirmSnapshotForAccess(result.snapshot, access),
            ledger_period_posting: result.ledger_period_posting
          }
        : result;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(responsePayload));
      return;
    }

    if (requestUrl.pathname === '/ledger/adjustment' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || body?.clientId || '';
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId),
        requireMember: true
      });
      const actorId = access.principal?.principalId || access.principal?.userId || access.principal?.email || 'system';
      const result = await postLedgerAdjustmentInDb({
        firmId,
        clientId,
        originalJournalId: body?.original_journal_id || body?.originalJournalId || undefined,
        transactionId: body?.transaction_id || body?.transactionId || undefined,
        journalDate: body?.journal_date || body?.journalDate || undefined,
        reason: body?.reason || body?.correction_reason || body?.correctionReason || '',
        lines: Array.isArray(body?.lines) ? body.lines : [],
        reverseOriginal: body?.reverse_original !== false && body?.reverseOriginal !== false,
        actorId
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
      return;
    }

    if ((requestUrl.pathname === '/ledger/period' || requestUrl.pathname === '/close/period-preview') && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = requestUrl.searchParams.get('client_id') || requestUrl.searchParams.get('clientId') || '';
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      const preview = await getLedgerPeriodPreviewFromDb({
        firmId,
        clientId,
        periodStart: requestUrl.searchParams.get('period_start') || requestUrl.searchParams.get('periodStart') || undefined,
        periodEnd: requestUrl.searchParams.get('period_end') || requestUrl.searchParams.get('periodEnd') || undefined
      });
      const allowed = !Array.isArray(access.allowedClientIds) || access.allowedClientIds.includes(preview.client_id);
      if (!allowed) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'You do not have access to this firm data.', code: 'FIRM_ACCESS_DENIED' }));
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(preview));
      return;
    }

    // Slice 1 of the realtime-truthful-feedback arc
    // (docs/design-realtime-truthful-feedback.md): the polled changes-cursor
    // the FE ticks on instead of page refreshes. Read-side only; sanitized
    // projection of audit receipts + parse-stage deltas + touched-row ids.
    if (requestUrl.pathname === '/feed-events' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = requestUrl.searchParams.get('client_id') || requestUrl.searchParams.get('clientId') || '';
      if (!clientId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id is required.' }));
        return;
      }
      await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      const feedEvents = await buildFeedEventsFromDb({
        firmId: firmId || DEFAULT_FIRM_ID,
        clientId,
        sinceEventId: requestUrl.searchParams.get('since_event_id'),
        sinceTs: requestUrl.searchParams.get('since_ts'),
        limit: requestUrl.searchParams.get('limit') || undefined,
        query: queryFirmDb
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ feed_events: feedEvents }));
      return;
    }


    if (requestUrl.pathname === '/procountor/export-package' && req.method === 'GET') {
      // Read-only Donna ledger package for a human accounting-team review. This
      // route does not call Procountor and does not require stored credentials.
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = requestUrl.searchParams.get('client_id') || requestUrl.searchParams.get('clientId') || '';
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      // External seats: no bulk data egress (build spec §4.3).
      assertSeatExportAllowed(access.principal);
      const payload = await getProcountorExportPackageFromDb({
        firmId,
        clientId,
        periodStart: requestUrl.searchParams.get('period_start') || requestUrl.searchParams.get('periodStart') || undefined,
        periodEnd: requestUrl.searchParams.get('period_end') || requestUrl.searchParams.get('periodEnd') || undefined
      });
      const allowed = !Array.isArray(access.allowedClientIds) || access.allowedClientIds.includes(payload.package.meta.client_id);
      if (!allowed) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'You do not have access to this firm data.', code: 'FIRM_ACCESS_DENIED' }));
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(payload));
      return;
    }

    if (requestUrl.pathname === '/reports/financial-statements' && req.method === 'GET') {
      // Read-only financial statements (P&L + Balance Sheet + Trial Balance + cash) from
      // Donna's posted ledger. Same access gate as /ledger/period: a firm member
      // sees any of their clients; a client-scoped collaborator (the portal) only
      // their own client. The numbers are deterministic GL aggregation, never an
      // LLM/re-inference; the response carries an honest draft verdict.
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = requestUrl.searchParams.get('client_id') || requestUrl.searchParams.get('clientId') || '';
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      const report = await getFinancialReportFromDb({
        firmId,
        clientId,
        periodStart: requestUrl.searchParams.get('period_start') || requestUrl.searchParams.get('periodStart') || undefined,
        periodEnd: requestUrl.searchParams.get('period_end') || requestUrl.searchParams.get('periodEnd') || undefined,
        basis: requestUrl.searchParams.get('basis') || undefined
      });
      const allowed = !Array.isArray(access.allowedClientIds) || access.allowedClientIds.includes(report.client_id);
      if (!allowed) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'You do not have access to this firm data.', code: 'FIRM_ACCESS_DENIED' }));
        return;
      }
      const format = String(requestUrl.searchParams.get('format') || 'json').toLowerCase();
      // External seats: the in-app JSON view stays (scoped queue work needs
      // the numbers); the DOWNLOAD formats are the fenced statement egress
      // (build spec §4.3).
      if (format === 'csv' || format === 'pdf') assertSeatExportAllowed(access.principal);
      if (format === 'csv') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${financialReportFilename(report, 'csv')}"`);
        res.end(buildFinancialReportCsv(report));
        return;
      }
      if (format === 'pdf') {
        const pdfBytes = await buildFinancialReportPdf(report);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${financialReportFilename(report, 'pdf')}"`);
        res.end(Buffer.from(pdfBytes));
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(report));
      return;
    }

    if (requestUrl.pathname === '/reports/singapore-gst-f5-draft' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const firmId = resolveRequestFirmId({ query: requestUrl.searchParams, auth: req.donnaAuth });
      const clientId = requestUrl.searchParams.get('client_id') || '';
      const access = await assertFirmAccess({ firmId, auth: req.donnaAuth,
        clientIds: collectClientIds(clientId), requireMember: true });
      // JSON downloads are statement egress too; keep the shared export gate.
      assertSeatExportAllowed(access.principal);
      const artifact = await getSingaporeGstDraftArtifactFromDb({ firmId, clientId,
        period: requestUrl.searchParams.get('period') || '', readAt: new Date().toISOString() });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Disposition', `attachment; filename="${singaporeGstDraftFilename(artifact)}"`);
      res.end(JSON.stringify(artifact, null, 2));
      return;
    }

    if (requestUrl.pathname === '/reports/finland-annual-return' && req.method === 'GET') {
      // FI-12 read surface (docs/design-donna-finland-fi12-read-surface.md):
      // the persisted annual-return verdict, verbatim. Deterministic aggregation
      // over the posted ledger — no model call, no write. The DB caller's
      // FINLAND_ANNUAL_RETURN + FINLAND_TILIKAUSI gate is the single source of
      // truth; flag-off surfaces as its typed 403 through the central catch.
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = requestUrl.searchParams.get('client_id') || requestUrl.searchParams.get('clientId') || '';
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      const allowed = !Array.isArray(access.allowedClientIds) || access.allowedClientIds.includes(clientId);
      if (!allowed) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'You do not have access to this firm data.', code: 'FIRM_ACCESS_DENIED' }));
        return;
      }
      const taxYearParam = requestUrl.searchParams.get('tax_year') || requestUrl.searchParams.get('taxYear');
      const envelope = await getFinlandAnnualReturnFromDb({
        firmId,
        clientId,
        taxYear: taxYearParam ? Number(taxYearParam) : new Date().getUTCFullYear(),
        basis: requestUrl.searchParams.get('basis') || undefined,
        readAt: new Date().toISOString()
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(envelope));
      return;
    }

    if (requestUrl.pathname === '/reports/finland-alv-return' && req.method === 'GET') {
      // FI-3 read: the deterministic ALV-return compute envelope for a verokausi
      // (docs/design-donna-finland-fi3-alv-return.md). No model call, no write;
      // the DB caller's FINLAND_ALV_RETURN gate surfaces as its typed 403.
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = requestUrl.searchParams.get('client_id') || requestUrl.searchParams.get('clientId') || '';
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      const allowed = !Array.isArray(access.allowedClientIds) || access.allowedClientIds.includes(clientId);
      if (!allowed) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'You do not have access to this firm data.', code: 'FIRM_ACCESS_DENIED' }));
        return;
      }
      const envelope = await getFinlandAlvReturnFromDb({
        firmId,
        clientId,
        period: requestUrl.searchParams.get('period') || '',
        readAt: new Date().toISOString()
      });
      // Render-the-persisted-verdict: the lifecycle row (pending/filed/cancelled
      // with its receipts) rides along so the surface shows the return's actual
      // state, never a client-side inference. Soft-fails to null pre-migration.
      const lifecycle = await getAlvReturnForPeriodInDb({
        firmId,
        clientId,
        periodKey: envelope.period?.key
      }).catch(() => null);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ...envelope, lifecycle }));
      return;
    }

    if (requestUrl.pathname === '/reports/gb-vat-return' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) { res.statusCode = 503; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: 'Firm database is not configured.' })); return; }
      const firmId = resolveRequestFirmId({ query: requestUrl.searchParams, auth: req.donnaAuth });
      const clientId = requestUrl.searchParams.get('client_id') || '';
      const access = await assertFirmAccess({ firmId, auth: req.donnaAuth, clientIds: collectClientIds(clientId) });
      const allowed = !Array.isArray(access.allowedClientIds) || access.allowedClientIds.includes(clientId);
      if (!allowed) { res.statusCode = 403; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: 'You do not have access to this firm data.', code: 'FIRM_ACCESS_DENIED' })); return; }
      const clientRow = await queryFirmDb('select jurisdiction from clients where firm_id = $1 and id = $2 limit 1', [firmId, clientId]);
      if (String(clientRow.rows[0]?.jurisdiction || '').toUpperCase() !== 'GB') { res.statusCode = 404; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 'GB_VAT_SURFACE_NOT_AVAILABLE' })); return; }
      const prepared = await prepareGbVatReturnFromDb({ firmId, clientId, periodKey: requestUrl.searchParams.get('period') || undefined });
      res.statusCode = 200; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(prepared)); return;
    }

    if (requestUrl.pathname === '/reports/gb-statutory' && req.method === 'GET') {
      const firmId = resolveRequestFirmId({ query: requestUrl.searchParams, auth: req.donnaAuth }); const clientId = requestUrl.searchParams.get('client_id') || '';
      await assertFirmAccess({ firmId, auth: req.donnaAuth, clientIds: collectClientIds(clientId) });
      const rows = await queryFirmDb(`select jurisdiction, entity_type, profile from clients where firm_id = $1 and id = $2 limit 1`, [firmId, clientId]); const client = rows.rows[0] || {};
      if (String(client.jurisdiction || '').toUpperCase() !== 'GB' || resolveSellerJurisdiction(client).jurisdiction !== 'gb') { res.statusCode = 404; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 'GB_STATUTORY_SURFACE_NOT_AVAILABLE' })); return; }
      const envelope = await getGbStatutoryReportFromDb({ firmId, clientId, clientRecord: client, asOf: toLocalIsoDay(new Date()) });
      res.statusCode = 200; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(envelope)); return;
    }

    if (requestUrl.pathname === '/reports/gb-ltd-close' && req.method === 'GET') {
      const firmId = resolveRequestFirmId({ query: requestUrl.searchParams, auth: req.donnaAuth });
      const clientId = requestUrl.searchParams.get('client_id') || '';
      await assertFirmAccess({ firmId, auth: req.donnaAuth, clientIds: collectClientIds(clientId) });
      // Jurisdiction gate only (the report-twin 404 pattern). Everything else —
      // the gb-ltd entity gate, the GB_LTD_MONTHLY_CLOSE flag gate, the
      // owner-fact refusals — lives in getGbLtdMonthlyCloseFromDb; this route
      // renders the consumer's verdicts and computes nothing.
      const rows = await queryFirmDb('select jurisdiction, profile from clients where firm_id = $1 and id = $2 limit 1', [firmId, clientId]);
      const clientRow = rows.rows[0] || {};
      if (String(clientRow.jurisdiction || clientRow.profile?.jurisdiction || '').toUpperCase() !== 'GB') {
        res.statusCode = 404; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 'GB_LTD_CLOSE_SURFACE_NOT_AVAILABLE' })); return;
      }
      try {
        // persist: false — a GET never mints statutory blockers (the consumer's
        // default is TRUE and mints; pinned by gbOwnerEndpointsSeam.test.js).
        const envelope = await getGbLtdMonthlyCloseFromDb({ firmId, clientId, readAt: new Date().toISOString(), persist: false });
        res.statusCode = 200; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(envelope)); return;
      } catch (error) {
        const code = String(error?.code || '');
        // A missing owner FACT is not an error on this surface: the pack's
        // NAMED refusal renders as the honest on_owner blocker row. One at a
        // time by construction — the evaluator refuses on the first missing
        // fact, and each supplied fact surfaces the next.
        if (/_NOT_ESTABLISHED$/.test(code)) {
          res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(buildGbLtdCloseRefusalEnvelope(code)));
          return;
        }
        // The consumer's own gates pass through untranslated: 403 DISABLED
        // keeps the surface dark for an un-staged client (born-dark holds on
        // every path, including missing facts); 409 names the non-Ltd case.
        if (error?.statusCode && code) {
          res.statusCode = error.statusCode; res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ code })); return;
        }
        throw error;
      }
    }

    if (requestUrl.pathname === '/reports/finland-alv-threshold' && req.method === 'GET') {
      // FI production-readiness P0 — the ALV registration-threshold watch for a
      // non-registered client (docs/design-donna-finland-production-readiness.md).
      // Read-only, deterministic; the DB caller's FINLAND_ALV_THRESHOLD_WATCH
      // gate surfaces as its typed 403 (the panel hides the surface).
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = requestUrl.searchParams.get('client_id') || requestUrl.searchParams.get('clientId') || '';
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      const allowed = !Array.isArray(access.allowedClientIds) || access.allowedClientIds.includes(clientId);
      if (!allowed) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'You do not have access to this firm data.', code: 'FIRM_ACCESS_DENIED' }));
        return;
      }
      const yearParam = requestUrl.searchParams.get('year');
      const envelope = await getFinlandAlvThresholdWatchFromDb({
        firmId,
        clientId,
        year: yearParam ? Number(yearParam) : null,
        readAt: new Date().toISOString()
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(envelope));
      return;
    }

    if (requestUrl.pathname === '/reports/finland-yel' && req.method === 'GET') {
      // G-4 (FI-15) — the YEL watch: profile + premium-debit signals mapped
      // onto the closed status enum; never determines the income
      // (docs/design-donna-finland-production-readiness.md). Read-only; the
      // DB caller's FINLAND_YEL_WATCH gate surfaces as its typed 403.
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = requestUrl.searchParams.get('client_id') || requestUrl.searchParams.get('clientId') || '';
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      const allowed = !Array.isArray(access.allowedClientIds) || access.allowedClientIds.includes(clientId);
      if (!allowed) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'You do not have access to this firm data.', code: 'FIRM_ACCESS_DENIED' }));
        return;
      }
      const envelope = await getFinlandYelStatusFromDb({
        firmId,
        clientId,
        readAt: new Date().toISOString()
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(envelope));
      return;
    }

    if (requestUrl.pathname === '/reports/finland-ennakkovero' && req.method === 'GET') {
      // G-5 (FI-15) — the ennakkovero watch: posted-ledger profit forecast +
      // the owner-recorded decision mapped onto the closed status enum; never
      // computes a tax amount (docs/design-donna-finland-production-
      // readiness.md). Read-only; the DB caller's FINLAND_ENNAKKOVERO_WATCH
      // gate surfaces as its typed 403 (the panel hides the surface).
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = requestUrl.searchParams.get('client_id') || requestUrl.searchParams.get('clientId') || '';
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      const allowed = !Array.isArray(access.allowedClientIds) || access.allowedClientIds.includes(clientId);
      if (!allowed) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'You do not have access to this firm data.', code: 'FIRM_ACCESS_DENIED' }));
        return;
      }
      const envelope = await getFinlandEnnakkoveroStatusFromDb({
        firmId,
        clientId,
        readAt: new Date().toISOString()
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(envelope));
      return;
    }

    if (requestUrl.pathname === '/reports/finland-issued-invoices' && req.method === 'GET') {
      // G-8 (FI-15) — partial-payment awareness on Donna-issued invoices:
      // issued rows + issued credit notes + viitenumero-matched money-in bank
      // lines, evaluated at read time onto closed payment states (docs/
      // design-donna-finland-fi15-g8-credit-notes.md). Read-only, deterministic
      // arithmetic — no LLM, no stored derived state. The DB caller's
      // FINLAND_INVOICING gate surfaces as its typed 403.
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = requestUrl.searchParams.get('client_id') || requestUrl.searchParams.get('clientId') || '';
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      const allowed = !Array.isArray(access.allowedClientIds) || access.allowedClientIds.includes(clientId);
      if (!allowed) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'You do not have access to this firm data.', code: 'FIRM_ACCESS_DENIED' }));
        return;
      }
      const envelope = await getFinlandIssuedInvoicesFromDb({
        firmId,
        clientId,
        readAt: new Date().toISOString()
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(envelope));
      return;
    }

    if (requestUrl.pathname === '/reports/finland-quotes' && req.method === 'GET') {
      // C-1c (FI-15) — the quotes read surface: issued_quotes rows annotated at
      // read time (expiry never stored) + the open/sent/converted funnel
      // (docs/design-donna-finland-c1-quote-send.md, D-C1-8's named follow-up).
      // Read-only, deterministic — no LLM, no stored derived state. The DB
      // caller's FINLAND_QUOTES gate surfaces as its typed 403.
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = requestUrl.searchParams.get('client_id') || requestUrl.searchParams.get('clientId') || '';
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      const allowed = !Array.isArray(access.allowedClientIds) || access.allowedClientIds.includes(clientId);
      if (!allowed) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'You do not have access to this firm data.', code: 'FIRM_ACCESS_DENIED' }));
        return;
      }
      const envelope = await getFinlandQuotesFromDb({
        firmId,
        clientId,
        readAt: new Date().toISOString()
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(envelope));
      return;
    }

    if (requestUrl.pathname === '/reports/finland-prepayment-register' && req.method === 'GET') {
      // G-6 (FI-15) — the prepayment-register watch: own status + the book's
      // supplier-bill vendors joined to their latest recorded checks, mapped
      // onto closed verdicts (docs/design-donna-finland-production-
      // readiness.md). Read-only, never calls the registry; the DB caller's
      // FINLAND_PREPAYMENT_REGISTER_WATCH gate surfaces as its typed 403.
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = requestUrl.searchParams.get('client_id') || requestUrl.searchParams.get('clientId') || '';
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      const allowed = !Array.isArray(access.allowedClientIds) || access.allowedClientIds.includes(clientId);
      if (!allowed) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'You do not have access to this firm data.', code: 'FIRM_ACCESS_DENIED' }));
        return;
      }
      const envelope = await getFinlandPrepaymentRegisterFromDb({
        firmId,
        clientId,
        readAt: new Date().toISOString()
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(envelope));
      return;
    }

    if (requestUrl.pathname === '/reports/finland-cutover' && req.method === 'GET') {
      // G-10 (FI-15) — the cutover-pack reconciliation: profile.cutover
      // (itemized open AR/AP, fixed-asset tax bases, prior losses, prior-year
      // net worth, ALV opening) checked against the POSTED avaava tase at
      // read time (docs/design-donna-finland-fi15-g10-g14-p2-batch.md).
      // Read-only, deterministic; the DB caller's FINLAND_OPENING_BALANCES +
      // FINLAND_TILIKAUSI gate surfaces as its typed 403.
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = requestUrl.searchParams.get('client_id') || requestUrl.searchParams.get('clientId') || '';
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      const allowed = !Array.isArray(access.allowedClientIds) || access.allowedClientIds.includes(clientId);
      if (!allowed) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'You do not have access to this firm data.', code: 'FIRM_ACCESS_DENIED' }));
        return;
      }
      const envelope = await getFinlandCutoverPackFromDb({
        firmId,
        clientId,
        readAt: new Date().toISOString()
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(envelope));
      return;
    }

    if (requestUrl.pathname === '/finland/prepayment-register/check' && req.method === 'POST') {
      // G-6 — record a dated registry check (YTJ). MEMBER-ONLY: the check is a
      // firm act, audited in-transaction with the acting member attributed. A
      // not-registered supplier with recent bills escalates to the OWNER
      // through the existing ask lane in the same motion.
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || body?.clientId || '';
      if (!clientId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id is required.' }));
        return;
      }
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId),
        requireMember: true
      });
      const actorId = access.principal?.email || access.principal?.userId || access.principal?.principalId || 'system';
      const result = await recordPrepaymentRegisterCheckInDb({
        firmId,
        clientId,
        check: body?.check && typeof body.check === 'object' ? body.check : body || {},
        actorId
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
      return;
    }

    if (requestUrl.pathname === '/reports/finland-scope-drift' && req.method === 'GET') {
      // G-7 (FI-15) — scope-drift detection: deterministic signals from the
      // posted ledger + bank feed mapped onto the closed verdict enum
      // (docs/design-donna-finland-production-readiness.md). Read-only; the
      // DB caller's FINLAND_SCOPE_DRIFT_WATCH gate surfaces as its typed 403
      // (the panel hides the surface).
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = requestUrl.searchParams.get('client_id') || requestUrl.searchParams.get('clientId') || '';
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      const allowed = !Array.isArray(access.allowedClientIds) || access.allowedClientIds.includes(clientId);
      if (!allowed) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'You do not have access to this firm data.', code: 'FIRM_ACCESS_DENIED' }));
        return;
      }
      const envelope = await getFinlandScopeDriftFromDb({
        firmId,
        clientId,
        readAt: new Date().toISOString()
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(envelope));
      return;
    }

    if (requestUrl.pathname === '/reports/finland-oy-onboarding' && req.method === 'GET') {
      // FI-13 13.0A-2b — the Oy onboarding convergence read: acceptance
      // envelope (D-FI13-13) over the persisted ownership/authority models +
      // the D-FI13-12 capability contract, in one deterministic surface
      // (docs/design-donna-finland-fi13-osakeyhtio.md). Read-only, no model
      // call. Deliberately NOT flag-gated: qualification precedes enabling,
      // and the contract renders not_enabled honestly for a dark client.
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = requestUrl.searchParams.get('client_id') || requestUrl.searchParams.get('clientId') || '';
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      const allowed = !Array.isArray(access.allowedClientIds) || access.allowedClientIds.includes(clientId);
      if (!allowed) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'You do not have access to this firm data.', code: 'FIRM_ACCESS_DENIED' }));
        return;
      }
      const envelope = await getFinlandOyOnboardingStateFromDb({
        firmId,
        clientId,
        asOf: requestUrl.searchParams.get('as_of') || null,
        readAt: new Date().toISOString()
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(envelope));
      return;
    }

    if (requestUrl.pathname === '/reports/finland-suomifi-mandate' && req.method === 'GET') {
      // G-3 (FI-15) — the Suomi.fi mandate status for a client: the persisted
      // grant + a dated validity evaluation (the same verdict the filing gate
      // uses). Read-only; docs/design-donna-finland-production-readiness.md.
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = requestUrl.searchParams.get('client_id') || requestUrl.searchParams.get('clientId') || '';
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      const allowed = !Array.isArray(access.allowedClientIds) || access.allowedClientIds.includes(clientId);
      if (!allowed) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'You do not have access to this firm data.', code: 'FIRM_ACCESS_DENIED' }));
        return;
      }
      const envelope = await getSuomifiMandateStatusInDb({
        firmId,
        clientId,
        scope: requestUrl.searchParams.get('scope') || undefined,
        readAt: new Date().toISOString()
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(envelope));
      return;
    }

    if (requestUrl.pathname === '/finland/suomifi-mandate' && req.method === 'POST') {
      // G-3 — record a verified Suomi.fi mandate grant. MEMBER-ONLY: recording
      // a legal authorization is a firm act, audited in-transaction with the
      // acting member attributed. One active grant per (client, scope) — a
      // duplicate is a typed 409, revoke first.
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || body?.clientId || '';
      if (!clientId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id is required.' }));
        return;
      }
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId),
        requireMember: true
      });
      const actorId = access.principal?.email || access.principal?.userId || access.principal?.principalId || 'system';
      const mandate = await recordSuomifiMandateInDb({
        firmId,
        clientId,
        scope: body?.scope || undefined,
        grantedOn: body?.granted_on || body?.grantedOn || '',
        expiresOn: body?.expires_on || body?.expiresOn || null,
        reference: body?.reference || null,
        provenance: body?.provenance && typeof body.provenance === 'object' ? body.provenance : {},
        actorId
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ mandate }));
      return;
    }

    if (requestUrl.pathname === '/finland/suomifi-mandate/revoke' && req.method === 'POST') {
      // G-3 — revoke a recorded mandate (the owner withdrew it in Suomi.fi, or
      // the record was wrong). MEMBER-ONLY, audited; the revoked row is the
      // terminal-with-receipt, and future filings refuse until a new grant is
      // recorded.
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || body?.clientId || '';
      const mandateId = body?.mandate_id || body?.mandateId || '';
      if (!clientId || !mandateId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id and mandate_id are required.' }));
        return;
      }
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId),
        requireMember: true
      });
      const actorId = access.principal?.email || access.principal?.userId || access.principal?.principalId || 'system';
      const mandate = await revokeSuomifiMandateInDb({
        firmId,
        clientId,
        mandateId,
        reason: body?.reason || undefined,
        actorId
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ mandate }));
      return;
    }

    if (requestUrl.pathname === '/finland/alv-returns/start' && req.method === 'POST') {
      // FI-3 slice P — the compute-and-file lane's start motion (D3, Kari
      // 2026-07-10). Member-gated: the trigger is a firm ACTION, not a resting
      // state — the resulting row rests either on the owner (confirm ask) or at
      // a receipted terminal. FINLAND_ALV_FILING gates inside (typed 403 when
      // dark); needs_review computes escalate to the owner and mint NO row.
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readBody();
      const firmId = body?.firm_id || DEFAULT_FIRM_ID;
      const clientId = String(body?.client_id || body?.clientId || '').trim();
      const period = String(body?.period || '').trim();
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        requireMember: true,
        clientIds: collectClientIds(clientId)
      });
      const actorId = access.principal?.email || access.principal?.userId || access.principal?.principalId || 'system';
      const result = await startFinlandAlvReturnFilingInDb({ firmId, clientId, period, actorId });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
      return;
    }

    if (requestUrl.pathname === '/ledger/audit-trail' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = requestUrl.searchParams.get('client_id') || requestUrl.searchParams.get('clientId') || '';
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      const payload = await getLedgerAuditTrailFromDb({
        firmId,
        clientId,
        transactionId: requestUrl.searchParams.get('transaction_id') || requestUrl.searchParams.get('transactionId') || undefined,
        ledgerJournalId: requestUrl.searchParams.get('ledger_journal_id') || requestUrl.searchParams.get('ledgerJournalId') || undefined,
        periodStart: requestUrl.searchParams.get('period_start') || requestUrl.searchParams.get('periodStart') || undefined,
        periodEnd: requestUrl.searchParams.get('period_end') || requestUrl.searchParams.get('periodEnd') || undefined
      });
      const allowed = !Array.isArray(access.allowedClientIds) || access.allowedClientIds.includes(payload.client_id);
      if (!allowed) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'You do not have access to this firm data.', code: 'FIRM_ACCESS_DENIED' }));
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(payload));
      return;
    }

    if ((requestUrl.pathname === '/close/diagnostics' || requestUrl.pathname === '/close/exceptions' || requestUrl.pathname === '/xero/mirror-diff') && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = requestUrl.searchParams.get('client_id') || requestUrl.searchParams.get('clientId') || '';
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      const periodArgs = {
        firmId,
        clientId,
        periodStart: requestUrl.searchParams.get('period_start') || requestUrl.searchParams.get('periodStart') || undefined,
        periodEnd: requestUrl.searchParams.get('period_end') || requestUrl.searchParams.get('periodEnd') || undefined
      };
      const payload = requestUrl.pathname === '/close/exceptions'
        ? await getCloseExceptionsFromDb(periodArgs)
        : await getCloseDiagnosticsFromDb(periodArgs);
      const allowed = !Array.isArray(access.allowedClientIds) || access.allowedClientIds.includes(payload.client_id);
      if (!allowed) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'You do not have access to this firm data.', code: 'FIRM_ACCESS_DENIED' }));
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(requestUrl.pathname === '/xero/mirror-diff' ? payload.xero_mirror_diff : payload));
      return;
    }

    if (requestUrl.pathname === '/close/archive-preview' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = requestUrl.searchParams.get('client_id') || requestUrl.searchParams.get('clientId') || '';
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      const actorId = access.principal?.email || access.principal?.userId || access.principal?.principalId || 'system';
      const archive = await getCloseArchivePreviewFromDb({
        firmId,
        clientId,
        periodStart: requestUrl.searchParams.get('period_start') || requestUrl.searchParams.get('periodStart') || undefined,
        periodEnd: requestUrl.searchParams.get('period_end') || requestUrl.searchParams.get('periodEnd') || undefined,
        actorId
      });
      const allowed = !Array.isArray(access.allowedClientIds) || access.allowedClientIds.includes(archive.client_id);
      if (!allowed) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'You do not have access to this firm data.', code: 'FIRM_ACCESS_DENIED' }));
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(archive));
      return;
    }

    if (requestUrl.pathname === '/close/archive-export' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = requestUrl.searchParams.get('client_id') || requestUrl.searchParams.get('clientId') || '';
      const archiveId = requestUrl.searchParams.get('archive_id') || requestUrl.searchParams.get('archiveId') || '';
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      // External seats: no bulk data egress (build spec §4.3).
      assertSeatExportAllowed(access.principal);
      const actorId = access.principal?.email || access.principal?.userId || access.principal?.principalId || 'system';
      const bundle = await getCloseArchiveExportFromDb({
        firmId,
        clientId,
        archiveId,
        periodStart: requestUrl.searchParams.get('period_start') || requestUrl.searchParams.get('periodStart') || undefined,
        periodEnd: requestUrl.searchParams.get('period_end') || requestUrl.searchParams.get('periodEnd') || undefined,
        actorId
      });
      const allowed = !Array.isArray(access.allowedClientIds) || access.allowedClientIds.includes(bundle.client_id);
      if (!allowed) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'You do not have access to this firm data.', code: 'FIRM_ACCESS_DENIED' }));
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${bundle.filename || 'donna-close-archive.json'}"`);
      res.end(JSON.stringify(bundle, null, 2));
      return;
    }

    if (requestUrl.pathname === '/close/archive' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || body?.clientId || '';
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      const actorId = access.principal?.email || access.principal?.userId || access.principal?.principalId || 'system';
      const result = await createCloseArchiveInDb({
        firmId,
        clientId,
        periodStart: body?.period_start || body?.periodStart || undefined,
        periodEnd: body?.period_end || body?.periodEnd || undefined,
        actorId
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
      return;
    }

    if ((requestUrl.pathname === '/close/checks/run' || requestUrl.pathname === '/close/lock') && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || body?.clientId || '';
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId),
        requireMember: requestUrl.pathname === '/close/lock'
      });
      const actorId = access.principal?.principalId || access.principal?.userId || access.principal?.email || 'system';
      const action = requestUrl.pathname === '/close/lock' ? lockClosePeriodInDb : runCloseChecksInDb;
      const result = await action({
        firmId,
        clientId,
        periodStart: body?.period_start || body?.periodStart || undefined,
        periodEnd: body?.period_end || body?.periodEnd || undefined,
        actorId,
        force: body?.force === true
      });
      const responsePayload = result.snapshot
        ? {
            ...filterFirmSnapshotForAccess(result.snapshot, access),
            ...(result.close_checks_run ? { close_checks_run: result.close_checks_run } : {}),
            ...(result.close_lock ? { close_lock: result.close_lock } : {})
          }
        : result;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(responsePayload));
      return;
    }

    if (
      (requestUrl.pathname === '/xero/mirror-retry' ||
        requestUrl.pathname === '/qbo/mirror-retry' ||
        requestUrl.pathname === '/procountor/mirror-retry') &&
      req.method === 'POST'
    ) {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || body?.clientId || '';
      const transactionIds = body?.transaction_ids || body?.transactionIds || [];
      // INT-5: a live mirror-retry re-posts to the external ledger — same
      // member + founder-capability gate as the writeback verbs (execute only).
      const executing = body?.dry_run === false || body?.execute === true || body?.force === true;
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId),
        requireMember: executing
      });
      if (executing) {
        await assertActionCapability({ firmId, clientId, principal: access.principal, actionType: 'sync_to_accounting' });
      }
      const adapter = getAccountingSystemAdapter(await getClientAccountingSystemFromDb({ firmId, clientId }));
      const actorId = access.principal?.email || access.principal?.userId || access.principal?.principalId || 'system';
      const result = await adapter.retryMirror({
        firmId,
        clientId,
        transactionIds,
        connectionId: body?.connection_id || body?.connectionId || undefined,
        periodStart: body?.period_start || body?.periodStart || undefined,
        periodEnd: body?.period_end || body?.periodEnd || undefined,
        dryRun: body?.dry_run !== false && body?.execute !== true,
        force: body?.force === true,
        limit: body?.limit,
        actorId
      });
      const responsePayload = result.snapshot
        ? {
            ...filterFirmSnapshotForAccess(result.snapshot, access),
            xero_mirror_retry: result.xero_mirror_retry
          }
        : result;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(responsePayload));
      return;
    }

    if (
      (requestUrl.pathname === '/xero/mirror-verify' ||
        requestUrl.pathname === '/qbo/mirror-verify' ||
        requestUrl.pathname === '/procountor/mirror-verify') &&
      req.method === 'POST'
    ) {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || body?.clientId || '';
      const transactionIds = body?.transaction_ids || body?.transactionIds || [];
      await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      const adapter = getAccountingSystemAdapter(await getClientAccountingSystemFromDb({ firmId, clientId }));
      const result = await adapter.verifyMirror({
        firmId,
        clientId,
        transactionIds,
        connectionId: body?.connection_id || body?.connectionId || undefined,
        periodStart: body?.period_start || body?.periodStart || undefined,
        periodEnd: body?.period_end || body?.periodEnd || undefined,
        limit: body?.limit
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
      return;
    }

    if (
      (requestUrl.pathname === '/xero/writeback-transactions' ||
        requestUrl.pathname === '/qbo/writeback-transactions' ||
        requestUrl.pathname === '/procountor/writeback-transactions') &&
      req.method === 'POST'
    ) {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || body?.clientId || '';
      const transactionIds = body?.transaction_ids || body?.transactionIds || [];
      // INT-5: the batch export is the highest-blast-radius push verb — same
      // member + founder-capability gate as the single writeback (execute only).
      const executing = body?.dry_run === false || body?.execute === true || body?.force === true;
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId),
        requireMember: executing
      });
      if (executing) {
        await assertActionCapability({ firmId, clientId, principal: access.principal, actionType: 'sync_to_accounting' });
      }
      const adapter = getAccountingSystemAdapter(await getClientAccountingSystemFromDb({ firmId, clientId }));
      const actorId = access.principal?.email || access.principal?.userId || access.principal?.principalId || 'system';
      const result = await adapter.writebackBatch({
        firmId,
        clientId,
        transactionIds,
        connectionId: body?.connection_id || body?.connectionId || undefined,
        dryRun: body?.dry_run !== false && body?.execute !== true,
        force: body?.force === true,
        limit: body?.limit,
        includeAll: body?.include_all === true || body?.includeAll === true,
        actorId
      });
      const responsePayload = result.snapshot
        ? {
            ...filterFirmSnapshotForAccess(result.snapshot, access),
            xero_writeback_batch: result.xero_writeback_batch
          }
        : result;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(responsePayload));
      return;
    }

    // Self-serve workspace provisioning — the signup funnel's post-auth step.
    // Deliberately NOT requireMember (and NOT assertFirmAccess): the caller is a
    // freshly-authenticated owner with no membership yet, which is the whole
    // point. Authn is the Supabase bearer (requireDonnaAccess already verified
    // it); identity comes from req.donnaAuth. Idempotent per owner, so a retry
    // or double-submit returns the same client rather than a second workspace.
    if (requestUrl.pathname === '/self-provision' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      // The RAW caller body: server-derived routing (the membership default
      // the boundary injects as firm_id) must never enter caller-input
      // validation — the strict owner-revalidation check below rejects any
      // key the caller did not send, and a caller-selected firm still meets
      // the provisioning firm-scope guard.
      const body = await readJsonBody(req);
      // `workspace: 'firm'` — an accounting-firm identity provisions its OWN
      // firm workspace (firmSelfProvision.js); everything else stays the
      // business-owner client path below. Idempotent per verified identity.
      if (body?.workspace === 'firm') {
        const result = await selfProvisionFirmWorkspace({ auth: req.donnaAuth, input: body });
        res.statusCode = result.created ? 201 : 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ firm_id: result.firmId, member_id: result.memberId, created: result.created }));
        return;
      }
      if (Object.hasOwn(body || {}, 'owner_revalidation') && (!body.owner_revalidation || Object.keys(body).some(key => key !== 'owner_revalidation'))) {
        throw Object.assign(new Error('Owner confirmation accepts only the reviewed server-owned workspace.'), {
          code: 'OWNER_REVALIDATION_INPUT_INVALID', statusCode: 400
        });
      }
      const result = await selfProvisionClientWorkspace({
        firmId: body?.firm_id || undefined,
        auth: req.donnaAuth,
        companyName: body?.company_name || body?.companyName || null,
        bandId: body?.band_id || body?.bandId || null,
        jurisdiction: body?.jurisdiction || null,
        entityType: body?.entity_type || body?.entityType || null,
        incorporationDate: body?.incorporation_date || body?.incorporationDate || null,
        ownerRevalidation: body?.owner_revalidation ?? null
      });
      if (body?.owner_revalidation != null) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
        return;
      }
      // Reopening an already-ready owned workspace is navigation, not another
      // lifecycle observation. Workers can hold the entity's shared lease;
      // login must not request an exclusive lease just to return its identity.
      // This returns no readiness authority: every work/write gate still reads
      // current host/entity state, including invalidation after this SELECT.
      const existingReady = !result.created && (await queryFirmDb(
        "select 1 from entity_readiness_sagas where firm_id=$1 and client_id=$2 and state='ready' limit 1",
        [resolveRequestFirmId({ body, query: requestUrl.searchParams, auth: req.donnaAuth }), result.clientId]
      )).rows.length > 0;
      if (!existingReady) {
        await provisionEntityReadiness({
          withFirmDbClientFn: withFirmDbClient,
          firmId: resolveRequestFirmId({ body, query: requestUrl.searchParams, auth: req.donnaAuth }),
          clientId: result.clientId,
          creationPath: 'self_provision',
          lifecycle: result.created ? 'cold_create' : 'retry',
          compatibilityScope: result.created ? 'birth_residue_proof' : 'current_generation_compatibility',
          initiatingPrincipal: {
            actor_type: 'supabase_user',
            actor_id: req.donnaAuth?.userId || req.donnaAuth?.sub || req.donnaAuth?.subject || null
          },
          authorityBasis: {
            source: 'authenticated_self_provision_route',
            principal_id: req.donnaAuth?.userId || req.donnaAuth?.sub || req.donnaAuth?.subject || null
          }
        });
      }
      res.statusCode = result.created ? 201 : 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ client_id: result.clientId, created: result.created }));
      return;
    }

    // Gate 3 — first-run firm mint (desktop only; docs/desktop-m0a-findings.md
    // Gate 0 finding 2). Guards live in the mint module: 403 off-desktop,
    // 409 once any firm exists (inert on every live book), 400 on bad input.
    if (requestUrl.pathname === '/first-run' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readBody();
      const result = await mintFirstRunFirm({
        input: normalizeFirstRunInput(body),
        deps: {
          withFirmDbClientFn: withFirmDbClient,
          isDesktopHost: isDesktopHostEnv,
          seedFirmMetadata: seedDesktopFirmMetadataWithClient
        }
      });
      // Re-point the live default-firm binding NOW, in-session — the
      // snapshot refetch that follows this response must find the minted
      // firm, not the baked-in demo id (adopt is desktop-gated + loud).
      adoptResolvedDefaultFirmId(result.firmId, { reason: 'desktop_first_run_mint' });
      res.statusCode = 201;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        firm_id: result.firmId,
        member_id: result.memberId,
        jurisdiction: result.jurisdiction,
        currency: result.currency
      }));
      return;
    }

    if (requestUrl.pathname === '/clients' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const body = await readBody();
      // Sole-firm resolution before the legacy demo-id default — on the
      // appliance (and any single-firm deployment) a create that names no
      // firm lands on the real firm, not on 'donna-demo-firm' (Gate 3;
      // resolveClientCreateFirmId in firstRunFirmMint.js is the pure logic).
      const firmId = await resolveClientCreateFirmIdInDb({ requestedFirmId: body?.firm_id || null });
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        requireMember: true
      });
      const creationPrincipal = await resolveDesktopClientCreationPrincipal({
        firmId,
        principal: access.principal
      });
      const intake = { profile: body?.profile, queue: Array.isArray(body?.queue) ? body.queue : [] };
      const { profile, queue } = body?.id_scope === 'firm'
        ? await resolveFirmIntakeIdentity({ firmId, ...intake, withFirmDbClientFn: withFirmDbClient })
        : intake;
      const createResult = await createClientInDb({
        firmId,
        profile,
        queue,
        processingReviewFacts: body?.processing_review ?? null,
        creationPrincipal: {
          principalType: creationPrincipal?.principalType,
          principalId: creationPrincipal?.principalId,
          authoritySource: 'authenticated_firm_create_route'
        }
      });
      const jurisdiction = String(body?.profile?.jurisdiction || '').trim().toUpperCase();
      // createClientInDb is an upsert: a re-upload for an existing client
      // lands here too. Only a client BORN in this request proves birth
      // residue; a pre-existing book certifies its current generation (the
      // self-provision routes' pattern — a legacy client judged under birth
      // scope fails on its own live business state).
      await provisionEntityReadiness({
        withFirmDbClientFn: withFirmDbClient,
        firmId,
        clientId: profile?.id,
        // A US client is the generic route unless it was born into, or is
        // already enrolled in, the US hosted pilot (HOSTED_MARKET_PROFILES).
        creationPath: jurisdiction === 'US' && !createResult.hosted_birth
          && !(await withFirmDbClient(client => readInternalPilotSendRestrictionWithClient(client, { firmId, clientId: profile?.id })))
          ? 'generic_client_route' : 'desktop_firm_intake',
        lifecycle: createResult.created ? 'cold_create' : 'legacy_upgrade',
        compatibilityScope: createResult.created ? 'birth_residue_proof' : 'current_generation_compatibility',
        initiatingPrincipal: {
          actor_type: creationPrincipal?.principalType,
          actor_id: creationPrincipal?.principalId
        },
        authorityBasis: {
          source: 'authenticated_firm_create_route',
          principal_id: creationPrincipal?.principalId
        }
      });
      const snapshot = await getFirmSnapshotFromDb({ firmId });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ...filterFirmSnapshotForAccess(snapshot, access), created_client_id: profile?.id }));
      return;
    }

    const readinessRetryMatch = requestUrl.pathname.match(/^\/clients\/([^/]+)\/readiness\/retry$/);
    if (readinessRetryMatch && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readBody();
      const firmId = await resolveClientCreateFirmIdInDb({ requestedFirmId: body?.firm_id || null });
      const clientId = decodeURIComponent(readinessRetryMatch[1]);
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId),
        requireMember: true
      });
      // reopen_exhausted is the explicit operator exit from 'exhausted': it
      // starts a fresh bounded episode and writes its own reopen receipt.
      const reopenExhausted = body?.reopen_exhausted === true;
      await provisionEntityReadiness({
        withFirmDbClientFn: withFirmDbClient,
        firmId,
        clientId,
        retry: true,
        reopenExhausted,
        lifecycle: 'retry',
        compatibilityScope: 'current_generation_compatibility',
        initiatingPrincipal: {
          actor_type: access.principal?.principalType,
          actor_id: access.principal?.principalId
        },
        authorityBasis: {
          source: reopenExhausted ? 'authenticated_readiness_reopen' : 'authenticated_readiness_retry',
          principal_id: access.principal?.principalId
        }
      });
      const snapshot = await getFirmSnapshotFromDb({ firmId });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(filterFirmSnapshotForAccess(snapshot, access)));
      return;
    }

    if (requestUrl.pathname === '/provision-workspace' && req.method === 'POST') {
      // Self-serve workspace provisioning. A verified Supabase identity with NO
      // firm membership (the "Workspace pending" 403 case) gets a scoped
      // client-owner workspace minted here so the funnel signup -> portal ->
      // offer-redeem -> Stripe chain can complete without a manual firm step.
      // Auth is a normal supabase_user bearer (requireDonnaAccess already
      // verified it); deliberately NOT requireMember — a new user is, by
      // definition, not yet a member.
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      // The firm this request is about (explicit, else the live default) —
      // for the demo-firm isolation guard every other firm route reaches and
      // for the readiness provisioning below. The provisioner itself keeps
      // receiving the request's explicit-or-absent firm unchanged.
      const requestFirmId = resolveRequestFirmId({ body, query: requestUrl.searchParams, auth: req.donnaAuth });
      assertFirmScopeAllowed(requestFirmId);
      if (!isSelfServeProvisioningEnabled()) {
        // Off by default: decline so the app keeps the manual "Workspace
        // pending" / request-access flow, byte-identical to before.
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          code: 'SELF_SERVE_PROVISIONING_DISABLED',
          error: 'Self-serve workspace provisioning is not enabled.'
        }));
        return;
      }
      const result = await provisionClientWorkspaceForAuth({ firmId, auth: req.donnaAuth });
      await provisionEntityReadiness({
        withFirmDbClientFn: withFirmDbClient,
        firmId: requestFirmId,
        clientId: result.client_id,
        creationPath: 'self_provision',
        lifecycle: result.provisioned ? 'cold_create' : 'retry',
        compatibilityScope: result.provisioned ? 'birth_residue_proof' : 'current_generation_compatibility',
        initiatingPrincipal: {
          actor_type: 'supabase_user',
          actor_id: req.donnaAuth?.userId || req.donnaAuth?.sub || req.donnaAuth?.subject || null
        },
        authorityBasis: {
          source: 'authenticated_workspace_provision_route',
          principal_id: req.donnaAuth?.userId || req.donnaAuth?.sub || req.donnaAuth?.subject || null
        }
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
      return;
    }

    const archiveMatch = requestUrl.pathname.match(/^\/clients\/([^/]+)$/);
    if (archiveMatch && req.method === 'DELETE') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        requireMember: true
      });
      const snapshot = await deleteClientInDb({
        firmId,
        clientId: decodeURIComponent(archiveMatch[1]),
        // G-9 (D-G9-3): break-the-glass past a KPL 2:10 retention hold — the
        // override is explicit and receipted on the client.delete audit event.
        retentionOverride: requestUrl.searchParams.get('retention_override') === 'true'
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(filterFirmSnapshotForAccess(snapshot, access)));
      return;
    }

    const pilotSetupMatch = requestUrl.pathname.match(/^\/clients\/([^/]+)\/finnish-pilot-setup$/);
    if (pilotSetupMatch && ['GET', 'POST'].includes(req.method)) {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.', code: 'PILOT_DATABASE_REQUIRED' }));
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      try {
        const body = req.method === 'POST' ? await readBody() : {};
        const result = await handleFinnishPilotOperator({ auth: req.donnaAuth, method: req.method, body,
          recovery: requestUrl.searchParams.get('recovery') === 'owner',
          firmId: body?.firm_id || requestUrl.searchParams.get('firm_id'), clientId: decodeURIComponent(pilotSetupMatch[1]) });
        res.statusCode = 200;
        res.end(JSON.stringify(result));
      } catch (error) {
        // Infrastructure failures can carry connection details. Only the
        // bounded setup/access refusals have human-readable public messages.
        const known = String(error?.code || '').startsWith('PILOT_') || String(error?.code || '').startsWith('OWNER_REVALIDATION_') || error?.code === 'FIRM_ACCESS_DENIED';
        res.statusCode = known ? error.statusCode || 409 : 503;
        res.end(JSON.stringify({ code: known ? error.code : 'PILOT_SETUP_UNAVAILABLE',
          error: known ? error.message : 'Pilot setup is unavailable. Review the current setup before trying again.',
          processing_readiness: 'INCOMPLETE' }));
      }
      return;
    }

    const profileMatch = requestUrl.pathname.match(/^\/clients\/([^/]+)\/profile$/);
    if (profileMatch && req.method === 'GET') {
      const firmId = requestUrl.searchParams.get('firm_id') || DEFAULT_FIRM_ID;
      const clientId = decodeURIComponent(profileMatch[1]);
      await assertFirmAccess({ firmId, auth: req.donnaAuth, clientIds: collectClientIds(clientId) });
      const result = await withFirmDbClient(client => readFinnishProfileIntakeWithClient(client, { firmId, clientId }));
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(result));
      return;
    }
    if (profileMatch && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const body = await readBody();
      const firmId = resolveRequestFirmId({ body, auth: req.donnaAuth });
      const clientId = decodeURIComponent(profileMatch[1]);
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      if (body?.owner_setup === true) {
        if (Object.keys(body).some(key => !['owner_setup', 'profile_patch'].includes(key))) {
          throw Object.assign(new Error('Initial company setup accepts only the company fields.'), { code: 'OWNER_COMPANY_SETUP_REQUIRED', statusCode: 400 });
        }
        await completeOwnerCompanySetup({
          firmId, clientId, auth: req.donnaAuth, profilePatch: body.profile_patch
        });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ client_id: clientId, company_setup_saved: true }));
        return;
      }
      await assertClientEntitled({ firmId, clientId, principal: access.principal, billingEnabled: isBillingEnabled() });
      const profilePrincipal = await resolveDesktopClientCreationPrincipal({ firmId, principal: access.principal });
      const actorId = profilePrincipal?.principalId || access.principal?.userId || access.principal?.email || null;
      const result = await updateClientProfileInDb({
        firmId,
        clientId,
        profilePatch: body?.profile_patch,
        actorId,
        principal: profilePrincipal || access.principal
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(filterFirmSnapshotForAccess(result.snapshot, access)));
      return;
    }

    // Row 17's fiscal-period step — the owner surface over the explicit
    // fiscal-period intake (fiscalPeriodIntake.js / registerFiscalPeriodFromDb,
    // flag-gated FISCAL_PERIOD_INTAKE in the writer). GET reports persisted
    // periods + whether the intake acts (the FE never guesses a flag); POST
    // registers owner-stated bounds. The writer refuses by name (disabled /
    // overlap / label conflict / statutory too-long), so both routes carry
    // their own catch to surface { error, code } to the portal card.
    // Owner VAT-return envelope — the server-owned verdict for the portal's
    // "Your VAT return" card (unconditional for covered jurisdictions; see
    // ownerVatReturnSurface.js, the market-neutral dispatcher — jurisdiction
    // picks the preparation). Same auth shape as fiscal-periods below: an
    // owner is a client-scoped principal on their own client.
    const ownerVatReturnMatch = requestUrl.pathname.match(/^\/clients\/([^/]+)\/vat-return$/);
    if (ownerVatReturnMatch && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = decodeURIComponent(ownerVatReturnMatch[1]);
      await assertFirmAccess({ firmId, auth: req.donnaAuth, clientIds: collectClientIds(clientId) });
      try {
        const result = await ownerVatReturnFromDb({
          ...(firmId ? { firmId } : {}),
          clientId,
          periodKey: requestUrl.searchParams.get('period') || undefined
        });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
      } catch (error) {
        res.statusCode = error?.statusCode || 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error', ...(error?.code ? { code: error.code } : {}) }));
      }
      return;
    }

    // VAT-registration status reply (RT-19) — the structured answer to the
    // statutory "are you VAT registered?" ask: registered or not; if
    // registered, the TRN, the effective date and the FTA-assigned period(s).
    // Jurisdiction picks the reply path (AE only today; every other market
    // refuses by name until its own lane exists — the ownerVatReturnSurface
    // dispatch posture). Same auth shape as the vat-return GET above: an
    // owner is a client-scoped principal on their own client; a firm member
    // may record the answer received out-of-band (actor attribution rides
    // the audit either way).
    const vatRegistrationReplyMatch = requestUrl.pathname.match(/^\/clients\/([^/]+)\/vat-registration\/reply$/);
    if (vatRegistrationReplyMatch && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readBody();
      const firmId = body?.firm_id || requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = decodeURIComponent(vatRegistrationReplyMatch[1]);
      const access = await assertFirmAccess({ firmId, auth: req.donnaAuth, clientIds: collectClientIds(clientId) });
      const actorId = access.principal?.email || access.principal?.userId || access.principal?.principalId || null;
      const actorType = ['firm_member', 'access_token'].includes(access.principal?.principalType) ? 'firm' : 'client';
      try {
        const rows = await queryFirmDb('select jurisdiction, profile from clients where firm_id = $1 and id = $2 limit 1', [firmId || DEFAULT_FIRM_ID, clientId]);
        const clientRow = rows.rows[0] || {};
        const jurisdiction = String(clientRow.jurisdiction || clientRow.profile?.jurisdiction || '').toLowerCase();
        if (jurisdiction !== 'ae') {
          res.statusCode = 409; res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ code: 'VAT_REGISTRATION_REPLY_NOT_AVAILABLE', error: `No VAT-registration reply path exists for jurisdiction ${JSON.stringify(jurisdiction || null)} yet.` }));
          return;
        }
        const { recordAeVatRegistrationReply } = await import('./statutoryRegistry.js');
        const result = await recordAeVatRegistrationReply({
          ...(firmId ? { firmId } : {}),
          clientId,
          evidenceRequestId: body?.evidence_request_id,
          actorId,
          actorType,
          answer: body?.answer || {},
          reply: body?.reply || null,
          source: body?.source || null
        });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
      } catch (error) {
        res.statusCode = error?.statusCode || 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error', ...(error?.code ? { code: error.code } : {}), ...(error?.details ? { details: error.details } : {}) }));
      }
      return;
    }

    const aeOpeningMatch = requestUrl.pathname.match(/^\/clients\/([^/]+)\/ae-opening-balances$/);
    if (aeOpeningMatch && ['GET', 'POST'].includes(req.method)) {
      const body = req.method === 'POST' ? await readBody() : {};
      const firmId = body?.firm_id || requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = decodeURIComponent(aeOpeningMatch[1]);
      try {
        const access = await assertFirmAccess({ firmId, auth: req.donnaAuth, clientIds: collectClientIds(clientId) });
        const openingPrincipal = await resolveDesktopClientCreationPrincipal({ firmId, principal: access.principal });
        const actorId = openingPrincipal?.principalId;
        if (req.method === 'POST') await assertClientEntitled({ firmId, clientId, principal: access.principal, billingEnabled: isBillingEnabled() });
        const result = req.method === 'GET' ? await readAeOpeningFromDb({ firmId, clientId })
          : await actAeOpeningFromDb({ firmId, clientId, actorId,
            authorityBasis: { source: 'owner_portal_intake', actor_id: actorId },
            action: body.action, intake: body.intake, askId: body.ask_id,
            proposalDigest: body.proposal_digest, reply: body.reply });
        res.statusCode = result.action === 'stale' ? 409 : 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
      } catch (error) {
        res.statusCode = error?.statusCode || 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Opening intake failed.', code: error?.code || null }));
      }
      return;
    }

    const fiscalPeriodsMatch = requestUrl.pathname.match(/^\/clients\/([^/]+)\/fiscal-periods$/);
    if (fiscalPeriodsMatch && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = decodeURIComponent(fiscalPeriodsMatch[1]);
      await assertFirmAccess({ firmId, auth: req.donnaAuth, clientIds: collectClientIds(clientId) });
      try {
        const result = await listFiscalPeriodsFromDb({ firmId, clientId });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
      } catch (error) {
        res.statusCode = error?.statusCode || 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error', ...(error?.code ? { code: error.code } : {}) }));
      }
      return;
    }
    if (fiscalPeriodsMatch && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = decodeURIComponent(fiscalPeriodsMatch[1]);
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      await assertClientEntitled({ firmId, clientId, principal: access.principal, billingEnabled: isBillingEnabled() });
      const actorId = access.principal?.email || access.principal?.userId || access.principal?.principalId || 'system';
      const endsOn = typeof body?.ends_on === 'string' ? body.ends_on : null;
      // The label is a registry key, not an owner-facing fact — derive it from
      // the end year when the caller doesn't supply one, so the card asks only
      // for the dates the owner actually knows. A same-year collision surfaces
      // as the writer's named FISCAL_PERIOD_LABEL_CONFLICT.
      const label = (typeof body?.label === 'string' && body.label.trim())
        ? body.label.trim()
        : (endsOn ? endsOn.slice(0, 4) : null);
      try {
        const result = await registerFiscalPeriodFromDb({
          firmId,
          clientId,
          label,
          startsOn: typeof body?.starts_on === 'string' ? body.starts_on : null,
          endsOn,
          authorityBasis: 'owner_portal_intake',
          actorId
        });
        res.statusCode = result.created ? 201 : 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
      } catch (error) {
        res.statusCode = error?.statusCode || 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error', ...(error?.code ? { code: error.code } : {}) }));
      }
      return;
    }

    // Slice 4 (autonomous-loop demo) — the firm-level autonomy settings toggle. Today it
    // governs `auto_send_client_asks`: the standing human authorization that lets Donna
    // SEND a drafted client question on its own (forbidden by default; Slice 1's
    // human_authorized unlock). Authority-only (requireMember → firm staff / access
    // token), audited in the writer. An owner/client can never reach this.
    if (requestUrl.pathname === '/settings/auto-send' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        requireMember: true
      });
      const actorId = access.principal?.email || access.principal?.userId || access.principal?.principalId || 'system';
      const result = await updateFirmLoopSettingsInDb({
        firmId,
        autoSendClientAsks: body?.auto_send_client_asks,
        actorId
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(filterFirmSnapshotForAccess(result.snapshot, access)));
      return;
    }

    // /documents/sync — the pre-tray "documents arrive with their transactions
    // inline" fast-path — was deleted in RT-14 (audit F-19): it wrote
    // parse_status='completed' outside the run-token path, bypassing the
    // tray, the duplicate layers and the readiness fence. Every intake
    // (drop, CSV, the FI e-invoice lane, the owner channels) registers
    // through /documents/register and parses as a run.
    if (requestUrl.pathname === '/documents/register' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const rawDocuments = Array.isArray(body?.documents) ? body.documents : [];
      if (!rawDocuments.length) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'documents[] is required.', code: 'DOCUMENTS_REQUIRED' }));
        return;
      }
      if (rawDocuments.length > 100) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Too many documents in one register call (max 100).', code: 'TOO_MANY_DOCUMENTS' }));
        return;
      }

      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(rawDocuments)
      });
      // Server-side paywall backstop: a client-scoped owner can't register
      // documents for an inactive-plan client (no-op for members / when billing
      // is off). The UI gate hides the portal; this refuses the direct call.
      await assertClientEntitled({
        firmId,
        clientIds: collectClientIds(rawDocuments),
        principal: access.principal,
        billingEnabled: isBillingEnabled()
      });

      // Process documents in order. We could parallelise, but each
      // insert hits the unique-on-storage-object-key index — keeping
      // them sequential lets us surface PARSE_RATE_LIMITED on the
      // first row that breaches the cap rather than racing N attempts.
      const results = [];
      for (const doc of rawDocuments) {
        try {
          const registration = await registerDocumentInDb({
            firmId,
            document: doc,
            uploadPrincipal: access.principal
          });
          if (registration.created && registration.parse_run_id) {
            try {
              // RT-08: the Inngest event in the cloud, a `parse-document`
              // local job on the appliance (dedupe_key = parse_run_id);
              // parse_event_sent_at is the "a job exists" receipt either way.
              await requestParseRun({
                firmId: firmId || registration.document.firm_id,
                documentId: registration.document.id,
                parseRunId: registration.parse_run_id,
                clientId: registration.document.client_id,
                documentType: registration.document.document_type
              });
              await markParseEventSentInDb({
                firmId: firmId || registration.document.firm_id,
                documentId: registration.document.id,
                parseRunId: registration.parse_run_id
              });
              registration.event_sent = true;
            } catch (sendErr) {
              // The outbox sweeper picks this up within ~60s on BOTH hosts
              // (`?task=outbox`: the Inngest re-send in the cloud, a local-job
              // requeue on the appliance since RT-14b); do NOT fail the API
              // call — the row exists, the parse is just delayed by one
              // sweeper tick. Surface the warning so the caller can log it.
              registration.event_sent = false;
              registration.event_send_warning = sendErr?.message || 'Failed to enqueue parse event.';
            }
          }
          results.push(registration);
        } catch (registerErr) {
          if (registerErr?.code === 'PARSE_RATE_LIMITED') {
            res.statusCode = 429;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              error: registerErr.message,
              code: 'PARSE_RATE_LIMITED',
              details: registerErr.details || null,
              partial_results: results
            }));
            return;
          }
          res.statusCode = registerErr?.statusCode || 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            error: registerErr?.message || 'Failed to register document.',
            code: registerErr?.code || 'REGISTER_FAILED',
            partial_results: results
          }));
          return;
        }
      }

      void access;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        documents: results.map((r) => ({
          ...r.document,
          already_exists: r.already_exists,
          duplicate_reason: r.duplicate_reason,
          event_sent: r.event_sent ?? null,
          event_send_warning: r.event_send_warning || null
        }))
      }));
      return;
    }

    if (requestUrl.pathname === '/documents/parse-status' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const rawIds = requestUrl.searchParams.get('ids') || '';
      const ids = rawIds
        .split(',')
        .map((value) => decodeURIComponent(value.trim()))
        .filter(Boolean);
      if (!ids.length) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ documents: [] }));
        return;
      }
      if (ids.length > 100) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Too many ids (max 100).', code: 'TOO_MANY_IDS' }));
        return;
      }
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        // Empty clientIds with requireMember=true → only firm members
        // with at least the firm role can call this without scoping. A
        // collaborator's view is filtered below via allowedClientIds.
        requireMember: false
      });
      const allowedClientIds = Array.isArray(access?.allowedClientIds) ? access.allowedClientIds : null;
      const documents = await getParseStatusForDocumentsInDb({
        firmId,
        documentIds: ids,
        clientIds: allowedClientIds
      });

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ documents }));
      return;
    }

    if (requestUrl.pathname === '/documents/retry-parse' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const documentIds = Array.isArray(body?.document_ids)
        ? body.document_ids.filter(Boolean)
        : [];
      if (!documentIds.length) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'document_ids[] is required.', code: 'DOCUMENT_IDS_REQUIRED' }));
        return;
      }
      if (documentIds.length > 100) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Too many document ids (max 100).', code: 'TOO_MANY_IDS' }));
        return;
      }

      // Retry is firm-only per docs/async-parsing-plan.md → /retry-parse.
      // requireMember=true gates this on firm membership (vs. a
      // client-scoped collaborator) and assertFirmAccess returns the
      // member's principal so the audit-event helper inside the DB
      // layer logs the actor — but we don't need allowedClientIds
      // here, because firm members can retry any doc in the firm.
      await assertFirmAccess({ firmId, auth: req.donnaAuth, requireMember: true });

      const { retried, skipped } = await retryParseRunsInDb({ firmId, documentIds });
      const sendResults = [];
      for (const row of retried) {
        try {
          // RT-08: a new run, its own job (and its own attempt budget).
          await requestParseRun({
            firmId: firmId || row.firm_id,
            documentId: row.id,
            parseRunId: row.parse_run_id,
            clientId: row.client_id,
            documentType: row.document_type
          });
          await markParseEventSentInDb({
            firmId: firmId || row.firm_id,
            documentId: row.id,
            parseRunId: row.parse_run_id
          });
          sendResults.push({ id: row.id, event_sent: true });
        } catch (sendErr) {
          sendResults.push({
            id: row.id,
            event_sent: false,
            event_send_warning: sendErr?.message || 'Failed to enqueue parse event.'
          });
        }
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        documents: retried.map((row) => {
          const send = sendResults.find((entry) => entry.id === row.id) || {};
          return {
            ...row,
            event_sent: send.event_sent ?? null,
            event_send_warning: send.event_send_warning || null
          };
        }),
        // Rows that were ignored because their parse_status isn't
        // retryable (`completed`/`pending`/`processing`/`skipped`).
        // The FE only renders Retry on terminal-recoverable states,
        // so this list is normally empty — but we surface it so a
        // caller that ignored the FE guard gets a clear answer.
        skipped
      }));
      return;
    }

    const resolveDuplicateMatch = requestUrl.pathname.match(/^\/documents\/([^/]+)\/resolve-duplicate$/);
    if (resolveDuplicateMatch && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const documentId = decodeURIComponent(resolveDuplicateMatch[1]);
      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const action = String(body?.action || '').trim();
      if (!action || !['create', 'replace', 'cancel'].includes(action)) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          error: 'action must be one of create, replace, cancel.',
          code: 'UNSUPPORTED_RESOLVE_ACTION'
        }));
        return;
      }

      // Resolve scoping: collaborators can resolve a dup only for clients
      // they're assigned to; firm members can resolve any dup in the
      // firm. Fetch the doc's client_id first, then gate via
      // assertFirmAccess. The DB helper repeats the firm_id check inside
      // its FOR UPDATE transaction for defence-in-depth.
      const docMeta = await getDocumentForParseInDb({ firmId, documentId });
      if (!docMeta) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Document was not found.', code: 'DOCUMENT_NOT_FOUND' }));
        return;
      }
      await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(docMeta.client_id)
      });

      try {
        const result = await resolveDuplicateInDb({ firmId, documentId, action });

        // On create/replace we now need to fire the Inngest event for
        // the freshly-pending row — same pattern as /register. The DB
        // helper minted the new parse_run_id; the API layer is
        // responsible for the event send + stamping parse_event_sent_at.
        let eventSent = null;
        let eventSendWarning = null;
        if (result.applied && result.parse_run_id && result.document?.id) {
          try {
            // RT-08: same producer fork as /register (job on the appliance).
            await requestParseRun({
              firmId: firmId || result.document.firm_id,
              documentId: result.document.id,
              parseRunId: result.parse_run_id,
              clientId: result.document.client_id,
              documentType: result.document.document_type
            });
            await markParseEventSentInDb({
              firmId: firmId || result.document.firm_id,
              documentId: result.document.id,
              parseRunId: result.parse_run_id
            });
            eventSent = true;
          } catch (sendErr) {
            // Outbox sweeper picks this up — same as /register.
            eventSent = false;
            eventSendWarning = sendErr?.message || 'Failed to enqueue parse event.';
          }
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          document: result.document,
          action: result.action,
          applied: result.applied,
          parse_run_id: result.parse_run_id || null,
          deleted_document_id: result.deleted_document_id || null,
          orphaned_storage_object_key: result.orphaned_storage_object_key || null,
          event_sent: eventSent,
          event_send_warning: eventSendWarning
        }));
        return;
      } catch (resolveErr) {
        if (resolveErr?.code === 'REPLACE_BLOCKED_REVIEWED_TX') {
          res.statusCode = 409;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            error: resolveErr.message,
            code: 'REPLACE_BLOCKED_REVIEWED_TX',
            blocked_reason: 'Existing transactions have been reviewed — only the firm can replace this. Contact the firm.',
            details: resolveErr.details || null
          }));
          return;
        }
        res.statusCode = resolveErr?.statusCode || 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          error: resolveErr?.message || 'Failed to resolve duplicate.',
          code: resolveErr?.code || 'RESOLVE_DUPLICATE_FAILED'
        }));
        return;
      }
    }

    if (requestUrl.pathname === '/documents/parse-cron' && (req.method === 'GET' || req.method === 'POST')) {
      // Combined cron worker — the CLOUD's entry to runParseCronTask (above).
      // `?task=outbox` resends Inngest events for pending rows whose
      // `parse_event_sent_at IS NULL` (on a host without Inngest it requeues
      // the local parse job instead — RT-14b). `?task=stuck` fails rows that have
      // been stuck in `processing` past the heartbeat threshold.
      // `?task=drain` runs the worker inline for pending docs past the
      // threshold (the cloud's Inngest-free path). `?task=storage_orphans`
      // does the daily evidence-store orphan cleanup. All run on
      // vercel.json's `crons:` schedules here; the appliance schedules the
      // same tasks from its handler manifest and calls the runner
      // in-process (RT-14).
      //
      // Auth is handled by the upstream requireDonnaAccess gate,
      // which accepts (a) DONNA_ACCESS_TOKEN for operator triggers
      // and (b) CRON_SECRET for Vercel cron invocations (scoped to
      // this path). If execution reaches here, the caller is
      // authorized.
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ skipped: true, reason: 'firm_db_not_configured' }));
        return;
      }
      // Validate `task` up front — an unknown value previously fell
      // through to an empty summary + 200 OK, which masked typoed
      // cron configs as success. Reject explicitly with the list of
      // supported tasks so vercel.json drift is loud.
      const task = requestUrl.searchParams.get('task') || 'all';
      if (!SUPPORTED_CRON_TASKS.has(task)) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          error: `Unsupported parse-cron task: ${task}`,
          code: 'CRON_TASK_UNSUPPORTED',
          details: { supported: Array.from(SUPPORTED_CRON_TASKS) }
        }));
        return;
      }
      const summary = await runParseCronTask({
        task,
        clientId: requestUrl.searchParams.get('client_id') || '',
        authorizedAs: req.donnaAuth?.type || 'unknown'
      });
      // A task whose work failed is not a 200: the scheduler records a
      // failed invocation instead of a success. The summary still rides out
      // so the receipt is complete; a clean run's body is unchanged.
      const failures = parseCronSummaryFailures(summary);
      if (failures.length) {
        console.error('[parse-cron] task failed', { task, failures });
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          ...summary,
          error: `Parse-cron task ${task} failed.`,
          code: 'PARSE_CRON_TASK_FAILED',
          failures
        }));
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(summary));
      return;
    }

    const cloudPilotAction = requestUrl.pathname.match(/^\/clients\/([^/]+)\/cloud-pilot\/(review|probe|enable|send-review|send-release)$/);
    const cloudPilotReadAction = ['review', 'send-review'].includes(cloudPilotAction?.[2]);
    if (cloudPilotAction && ((cloudPilotReadAction && req.method === 'GET') || (!cloudPilotReadAction && req.method === 'POST'))) {
      const body = req.method === 'POST' ? await readBody() : {};
      const firmId = resolveRequestFirmId({body,query:requestUrl.searchParams,auth:req.donnaAuth});
      const clientId = decodeURIComponent(cloudPilotAction[1]);
      // Send release is also a staff-seat action (partner and up, via the one
      // capability resolver); the other pilot operations stay member-only.
      const sendReleaseAction = ['send-review', 'send-release'].includes(cloudPilotAction[2]);
      const access = await assertFirmAccess({firmId,auth:req.donnaAuth,clientIds:[clientId],requireMember:!sendReleaseAction});
      const scope = {firmId,clientId,principal:access.principal};
      if (sendReleaseAction) await authorizePilotSendRelease(scope);
      const result = cloudPilotAction[2] === 'review' ? await reviewCloudPilotOperations(scope)
        : cloudPilotAction[2] === 'probe' ? await runCloudPilotDependencyProbes(scope)
        : cloudPilotAction[2] === 'send-review' ? await reviewInternalPilotSendRelease(scope)
        : cloudPilotAction[2] === 'send-release' ? await releaseInternalPilotSendContainment(scope,{reviewDigest:body.review_digest,confirmed:body.confirmed})
        : await enableCloudPilotProcessing(scope,{reviewDigest:body.review_digest,confirmed:body.confirmed});
      res.statusCode = 200;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;
    }

    if (requestUrl.pathname === '/documents/upload-url' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const body = await readBody();
      // ONE firm for the whole request (RT-03, audit F-03): the key prefix,
      // the access check and the readiness admission all scope to the firm
      // the request names, else the LIVE default the desktop boot re-pointed
      // to the sole minted firm. The literal 'donna-demo-firm' that used to
      // prefix the key, and the env-only resolver that used to pick the
      // admission firm, each sent a first-run firm's evidence to the demo
      // tenant with its upload boundaries silently unenforced.
      const firmId = resolveRequestFirmId({ body, query: requestUrl.searchParams, auth: req.donnaAuth });
      const clientId = String(body?.client_id || body?.clientId || '').trim();
      if (!clientId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Client id is required.', code: 'CLIENT_ID_REQUIRED' }));
        return;
      }
      const declaredMimeType = String(body?.mime_type || body?.mimeType || '').trim();
      const uploadFilename = String(body?.filename || '').trim();
      // Windows/Excel declares .csv as application/vnd.ms-excel (and some
      // browsers as empty/octet-stream). This gate sees metadata only — the
      // bytes go straight to signed storage — so the extension is trusted for
      // exactly this normalization and nothing else; the bank-statement
      // extractor's own content behavior downstream is the sniff layer. A
      // vnd.ms-excel WITHOUT a .csv filename stays refused: a true .xls must
      // not ride in on the trap fix (design-donna-csv-statement-intake.md §3).
      const csvMisdeclaredMimes = new Set(['', 'application/vnd.ms-excel', 'application/octet-stream']);
      const mimeType = /\.csv$/i.test(uploadFilename) && csvMisdeclaredMimes.has(declaredMimeType.toLowerCase())
        ? 'text/csv'
        : declaredMimeType;
      const size = Number(body?.size || 0);
      const allowedMimeTypes = new Set([
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/heic',
        'image/heif',
        'application/pdf',
        'text/csv'
      ]);
      if (!allowedMimeTypes.has(mimeType)) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Unsupported evidence file type.', code: 'EVIDENCE_FILE_TYPE_UNSUPPORTED' }));
        return;
      }
      if (!Number.isFinite(size) || size <= 0 || size > 10 * 1024 * 1024) {
        res.statusCode = 413;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Evidence file size is outside the allowed range.', code: 'EVIDENCE_FILE_SIZE_INVALID' }));
        return;
      }
      const uploadAccess = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      await withFirmDbClient(client => requireClientInFirm({ client, firmId, clientId }));
      const bucket = process.env.DONNA_EVIDENCE_BUCKET || process.env.SUPABASE_EVIDENCE_BUCKET || 'donna-evidence';
      const genericKey = () => buildEvidenceStorageKey({
        firmId,
        clientId,
        evidenceRequestId: body?.evidence_request_id || body?.evidenceRequestId || null,
        transactionId: body?.transaction_id || body?.transactionId || null,
        checksum: body?.checksum_sha256 || body?.checksumSha256 || null,
        filename: body?.filename || 'evidence'
      });
      const signed = isLocalEvidenceStorage()
        ? await withFirmDbClient(async (client) => {
            const key = genericKey();
            await client.query('begin');
            try {
              const admission = await checkEntityReadinessAdmissionWithClient({
                client,
                firmId,
                clientId,
                boundary: 'upload_sign',
                resourceType: 'evidence_upload',
                resourceId: key
              });
              if (!admission.allowed) {
                await client.query('commit');
                throw new EntityReadinessAdmissionError(admission);
              }
              await lockUploadClientInFirm({ client, firmId, clientId });
              const result = await createEvidenceSignedUploadUrl({
                bucket,
                key,
                expiresIn: 600,
                readinessClaim: admission.enforced ? {
                  firm_id: firmId,
                  client_id: clientId,
                  entity_dependency_digest: admission.entity_dependency_digest
                } : null
              });
              await client.query('commit');
              return result;
            } catch (error) {
              await client.query('rollback').catch(() => {});
              throw error;
            }
          })
        : await createCloudPilotUpload({ firmId,clientId,principal:uploadAccess.principal,bucket,filename:uploadFilename,
            checksum:body?.checksum_sha256 || body?.checksumSha256 || null,size,mimeType })
          || await withCloudReadinessClient(async (client, signal) => {
            const key = genericKey();
            await client.query('begin');
            try {
              await lockUploadClientInFirm({ client, firmId, clientId });
              const result = await createEvidenceSignedUploadUrl({ bucket, key, expiresIn: 600, signal });
              signal.throwIfAborted();
              await client.query('commit');
              return result;
            } catch (error) {
              await client.query('rollback').catch(() => {});
              throw error;
            }
          });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        source: 'evidence_upload_url',
        ...signed,
        checksum_sha256: body?.checksum_sha256 || body?.checksumSha256 || null,
        content_type: mimeType,
        size
      }));
      return;
    }

    if (requestUrl.pathname === '/transaction-intel/refresh' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const requestedClientIds = Array.isArray(body?.client_ids) ? body.client_ids.filter(Boolean) : [];
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: requestedClientIds,
        requireMember: requestedClientIds.length === 0
      });
      const baseSnapshot = await getFirmSnapshotFromDb({ firmId });
      const clientIds = requestedClientIds.length
        ? requestedClientIds
        : baseSnapshot.clients.map((client) => client.id).filter(Boolean);
      const snapshot = await refreshTransactionIntelInDb({ firmId, clientIds });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(filterFirmSnapshotForAccess(snapshot, access)));
      return;
    }

    if (requestUrl.pathname === '/transaction-intel/suggest' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const transactionId = body?.transaction_id || body?.transactionId || '';
      const currentSnapshot = await getFirmSnapshotFromDb({ firmId });
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(getFirmItemClientId(currentSnapshot.transactions, transactionId))
      });
      const codingClientId = getFirmItemClientId(currentSnapshot.transactions, transactionId);
      const snapshot = await suggestTransactionCodingInDb({ firmId, transactionId });
      if (codingClientId) {
        try {
          await runCodingAutoPostForTransaction({ firmId, clientId: codingClientId, transactionId });
        } catch (error) {
          console.warn('[coding_auto_post] near-realtime trigger failed after suggest', {
            transaction_id: transactionId,
            client_id: codingClientId,
            error_name: error?.name || 'Error',
            error_message: error?.message || ''
          });
        }
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(filterFirmSnapshotForAccess(snapshot, access)));
      return;
    }

    if (requestUrl.pathname === '/transaction-intel/batch-suggest' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const requestedClientIds = Array.isArray(body?.client_ids) ? body.client_ids.filter(Boolean) : [];
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: requestedClientIds,
        requireMember: requestedClientIds.length === 0
      });
      const baseSnapshot = await getFirmSnapshotFromDb({ firmId });
      const clientIds = requestedClientIds.length
        ? requestedClientIds
        : baseSnapshot.clients.map((client) => client.id).filter(Boolean);
      const snapshot = await batchSuggestTransactionCodingInDb({
        firmId,
        clientIds,
        limit: body?.limit || 80,
        autoApply: body?.auto_apply !== false
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(filterFirmSnapshotForAccess(snapshot, access)));
      return;
    }

    // POST /reconciliation-matches — firm manually links a document
    // to a transaction. Writes a confirmed match row + the standard
    // confirmed-branch cascade.
    if (requestUrl.pathname === '/reconciliation-matches' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || '';
      const documentId = body?.document_id || '';
      const bankTransactionId = body?.bank_transaction_id || '';
      const reviewerNote = body?.reviewer_note || body?.note || null;

      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      // Pod-safety gap #1: record WHICH operator linked it, not a bare 'system'.
      const actorId = access.principal?.email
        || access.principal?.userId
        || access.principal?.principalId
        || 'system';

      try {
        const result = await createManualReconciliationMatchInDb({
          firmId,
          clientId,
          documentId,
          bankTransactionId,
          actorId,
          reviewerNote
        });
        res.statusCode = 201;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          match_id: result.matchId,
          matched_object_type: result.matchedObjectType,
          snapshot: filterFirmSnapshotForAccess(result.snapshot, access)
        }));
      } catch (error) {
        const status = error?.statusCode || 500;
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error' }));
      }
      return;
    }

    // GET /document-chat?client_id=...&document_id=... — load the
    // chat thread for a document. PR 27 — informational chat only.
    // Returns messages oldest-first plus the set of action types
    // whose Apply path is currently wired (empty in PR 27).
    if (requestUrl.pathname === '/document-chat' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const clientId = requestUrl.searchParams.get('client_id') || '';
      const documentId = requestUrl.searchParams.get('document_id') || '';
      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      if (!clientId || !documentId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id and document_id are required.' }));
        return;
      }
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      try {
        const messages = await getDocumentChatThreadFromDb({ firmId, clientId, documentId });
        const viewerActorId = chatApplyActorId(access.principal);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          messages: projectChatMessagesForViewer(messages, viewerActorId),
          // PR 27 — empty set. PR 28 wires link_transaction; PR 29
          // wires the rest. The FE reads this to enable/disable
          // each action card's Apply button.
          appliable_action_types: DOCUMENT_CHAT_APPLIABLE_ACTION_TYPES
        }));
      } catch (error) {
        const status = error?.statusCode || 500;
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error' }));
      }
      return;
    }

    // POST /document-chat/messages — firm sends a chat message. The
    // server persists the user turn, calls the LLM with the
    // current document + candidate-tx context, persists the
    // assistant turn (text + proposed actions), and returns the
    // assistant reply. PR 27 ships informational chat only — no
    // backend write happens beyond message persistence.
    if (requestUrl.pathname === '/document-chat/messages' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || '';
      const documentId = body?.document_id || '';
      const userMessage = typeof body?.message === 'string' ? body.message : '';
      const candidateContext = Array.isArray(body?.candidate_transactions)
        ? body.candidate_transactions
        : [];
      const addressedAgentRef = body?.addressed_agent || null;
      if (!clientId || !documentId || !userMessage.trim()) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id, document_id, and a non-empty message are required.' }));
        return;
      }
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      try {
        const viewerActorId = chatApplyActorId(access.principal);
        const addressedAgent = await resolveDirectDonnaChatRef({
          firmId,
          clientId,
          ref: addressedAgentRef
        });
        // Persist the user message FIRST so a failed LLM call
        // leaves the user turn intact in the case file (firm can
        // see what they asked even if Donna didn't answer).
        const userMessageRow = await appendDocumentChatMessageInDb({
          firmId,
          clientId,
          documentId,
          id: newMessageId({ documentId, kind: 'user' }),
          role: 'user',
          content: userMessage.trim(),
          payload: addressedAgent
            ? { kind: 'agent_instruction', mentions: [addressedAgent] }
            : {},
          actorType: 'firm',
          actorId: viewerActorId
        });
        // Load thread history AFTER persisting the new user turn so
        // the LLM sees the full conversation.
        const history = await getDocumentChatThreadFromDb({ firmId, clientId, documentId });
        const sourceDocument = (await queryFirmDb(
          `select id, client_id, document_type, filename, vendor_name, customer_name,
                  total_amount, currency, document_date, due_date, payment_status, parse_status,
                  parse_summary, payload
             from documents where firm_id = $1 and client_id = $2 and id = $3`,
          [firmId || DEFAULT_FIRM_ID, clientId, documentId]
        )).rows[0];
        if (!sourceDocument) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Document was not found.', code: 'DOCUMENT_NOT_FOUND' }));
          return;
        }
        const sourceMatches = (await queryFirmDb(
          `select m.status, m.match_confidence, m.bank_transaction_id,
                  t.transaction_date, t.description, t.money_in, t.money_out, t.currency
             from reconciliation_matches m
             join transactions t on t.id = m.bank_transaction_id
              and t.firm_id = m.firm_id and t.client_id = m.client_id
            where m.firm_id = $1 and m.client_id = $2 and m.matched_object_id = $3
              and m.status in ('confirmed', 'auto_matched', 'suggested')
            order by case m.status when 'confirmed' then 0 when 'auto_matched' then 1 else 2 end, m.id`,
          [firmId || DEFAULT_FIRM_ID, clientId, documentId]
        )).rows;
        sourceDocument.reconciliation_matches = sourceMatches.map((row) => ({
          status: row.status, match_confidence: row.match_confidence, bank_transaction_id: row.bank_transaction_id,
          linked_transaction: {
            id: row.bank_transaction_id, date: toIsoDay(row.transaction_date),
            description: row.description, money_in: Number(row.money_in || 0),
            money_out: Number(row.money_out || 0), currency: row.currency || null
          }
        }));
        sourceDocument.reconciliation_match = sourceDocument.reconciliation_matches[0] || null;
        const context = buildDocumentChatContext({
          document: sourceDocument,
          candidates: candidateContext
        });
        const reply = await generateDocumentChatReply({
          context,
          // The new user turn is the last item in history; the LLM
          // client expects it as a separate arg + history minus
          // the last turn.
          history: history.slice(0, -1),
          userMessage: userMessage.trim()
        });
        if (reply.kind !== 'ok') {
          // Persist a system message describing the failure so the
          // case file records the gap. Status code maps to the LLM
          // failure code so the FE can render an appropriate
          // empty-reply state.
          const failureMessage = await appendDocumentChatMessageInDb({
            firmId,
            clientId,
            documentId,
            id: newMessageId({ documentId, kind: 'system' }),
            role: 'system',
            content: `Chat unavailable: ${reply.reason || reply.code || 'unknown'}.`,
            payload: { failure_code: reply.code || 'unknown' },
            actorType: 'system'
          });
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            error: reply.reason || 'Chat unavailable.',
            failure_code: reply.code || 'unknown',
            user_message: projectChatMessageForViewer(userMessageRow, viewerActorId),
            system_message: failureMessage
          }));
          return;
        }
        const assistantMessage = await appendDocumentChatMessageInDb({
          firmId,
          clientId,
          documentId,
          id: newMessageId({ documentId, kind: 'assistant' }),
          role: 'assistant',
          content: reply.text,
          payload: { actions: reply.actions },
          model: reply.model,
          actorType: 'llm'
        });
        res.statusCode = 201;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          user_message: projectChatMessageForViewer(userMessageRow, viewerActorId),
          assistant_message: assistantMessage,
          appliable_action_types: DOCUMENT_CHAT_APPLIABLE_ACTION_TYPES
        }));
      } catch (error) {
        const status = error?.statusCode || 500;
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          error: error?.message || 'Unknown error',
          ...(error?.code ? { code: error.code } : {})
        }));
      }
      return;
    }

    // POST /document-chat/messages/:messageId/actions/:index/apply
    //   — PR 28. Apply a proposed action from a persisted chat
    //   message. PR 28 wires `link_transaction` only; the type
    //   gate is enforced server-side against
    //   DOCUMENT_CHAT_APPLIABLE_ACTION_TYPES so a stale FE can't
    //   trigger a not-yet-wired writer.
    //
    //   Idempotent: if the action is already `applied`, returns the
    //   current state with 200 rather than re-running the writer.
    //   Action params come from the persisted payload, not the
    //   request body — the FE could be stale or tampered.
    const docChatApplyMatch = requestUrl.pathname.match(/^\/document-chat\/messages\/([^/]+)\/actions\/(\d+)\/apply$/);
    if (docChatApplyMatch && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const messageId = decodeURIComponent(docChatApplyMatch[1]);
      const actionIndex = Number(docChatApplyMatch[2]);
      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || '';
      const documentId = body?.document_id || '';
      const reviewerNote = body?.reviewer_note || body?.note || null;
      if (!clientId || !documentId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id and document_id are required.' }));
        return;
      }
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      try {
        const message = await getDocumentChatMessageFromDb({
          firmId,
          clientId,
          documentId,
          messageId
        });
        // Pod-safety #4 — the ONE compile→authorize spine for every chat apply
        // route (chatApplySpine.gateChatApplyAction): action resolution from the
        // PERSISTED message, idempotent replay, status + type gates, the #3
        // capability gate (dormant until OPERATOR_CAPABILITY_ENFORCE acts), and
        // actor attribution. Idempotent replay note: re-clicking Apply on an
        // already-applied action returns the current state instead of re-running
        // the writer (which would 409 on the existing confirmed match anyway);
        // the FE may rely on this to recover after a network blip.
        const gate = await gateChatApplyAction({
          surface: 'document_chat',
          firmId,
          clientId,
          principal: access.principal,
          message: bindDocumentChatCorrectionTarget(message),
          actionIndex,
          appliableActionTypes: DOCUMENT_CHAT_APPLIABLE_ACTION_TYPES,
          assertCapability: assertActionCapability
        });
        if (gate.disposition === 'replay') {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            assistant_message: message,
            applied: true,
            idempotent_replay: true
          }));
          return;
        }
        if (gate.disposition !== 'proceed') {
          res.statusCode = gate.statusCode;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(gate.body));
          return;
        }
        const action = gate.action;
        if (action.type === 'correct_document_field') {
          if (action.field_path !== 'currency') {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'This document action supports currency correction only.', code: 'UNKNOWN_FIELD_PATH' }));
            return;
          }
          const exec = await executeChatApplyAction({
            action,
            fallbackErrorMessage: 'Document currency correction failed.',
            exposeErrorDetails: true,
            execute: async () => {
              const correction = await recordDocumentCorrectionInDb({
                firmId, clientId, documentId, fieldPath: action.field_path,
                correctedValue: action.corrected_value, correctedBy: gate.actorId,
                sourceModel: message.model || null
              });
              return { result: {
                document_id: documentId, field_path: correction.field_path,
                prior_value: correction.prior_value, corrected_value: correction.corrected_value,
                correction_id: correction.id
              }, snapshot: await getFirmSnapshotFromDb({ firmId }) };
            },
            stamp: {
              write: updateDocumentChatActionStatusInDb,
              scope: { firmId, clientId, documentId, messageId, actionIndex }
            }
          });
          res.statusCode = exec.disposition === 'applied' ? 201 : exec.statusCode;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(exec.disposition === 'applied' ? {
            assistant_message: exec.updatedMessage, applied: true,
            snapshot: filterFirmSnapshotForAccess(exec.executed.snapshot, access)
          } : exec.body));
          return;
        }
        // PR 28 — link_transaction is the only wired type. Branch
        // on action.type here as the apply matrix grows in PRs 29+.
        if (action.type === 'link_transaction') {
          const transactionId = action.transaction_id;
          if (!transactionId) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Proposed link_transaction action is missing transaction_id.' }));
            return;
          }
          // Pod-safety gap #1: the spine attributed the operator who applied this
          // link, so the audit records who acted, not a bare 'system'.
          const actorId = gate.actorId;
          // Pod-safety #4 (writer-dispatch leg) — the spine executor owns the
          // writer-error → HTTP mapping and the applied-status stamp; the writer
          // call and result shape stay verbatim. On a writer failure the action
          // is NOT flipped to 'failed' (deferred — only clearly non-transient
          // failures should flip; a 409 means another user beat us to it and the
          // link DOES exist), so the FE can re-enable Apply on the next load.
          const exec = await executeChatApplyAction({
            action,
            fallbackErrorMessage: 'Apply failed.',
            execute: async () => {
              // Pod-safety #2: the writer captures the before/after of the fields it
              // mutates (race-free, inside its own transaction) so the shadow receipt
              // records what a reverse would restore.
              const writerResult = await createManualReconciliationMatchInDb({
                firmId,
                clientId,
                documentId,
                bankTransactionId: transactionId,
                actorId,
                captureBeforeState: true,
                reviewerNote: reviewerNote || `Applied from Donna chat (action ${actionIndex} of message ${messageId}).`
              });
              // Same consequence-on-the-result discipline as the
              // transaction-chat link_document apply: confirmed + reconciled,
              // read from the writer's own capture.
              return {
                result: {
                  match_id: writerResult.matchId,
                  matched_object_type: writerResult.matchedObjectType,
                  bank_transaction_id: transactionId,
                  match_status: writerResult?.after_state?.match_status || null,
                  from_status: writerResult?.before_state?.match_status ?? null,
                  reconciliation_status: writerResult?.after_state?.transaction?.reconciliation_status || null
                },
                writerResult
              };
            },
            stamp: {
              write: updateDocumentChatActionStatusInDb,
              scope: { firmId, clientId, documentId, messageId, actionIndex }
            }
          });
          if (exec.disposition !== 'applied') {
            res.statusCode = exec.statusCode;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(exec.body));
            return;
          }
          const { writerResult } = exec.executed;
          const updatedMessage = exec.updatedMessage;
          // Loops shadow (LOOPS_SHADOW, default OFF) — Slice F. Mirror the applied
          // link as the durable Operator-Contract triple (proposal card + check
          // report + apply receipt). Own transaction, post-commit, no-throw — can
          // never affect this response. Closes the document-chat receipt+preflight
          // gap (registry: link_transaction).
          await onDocumentChatActionApplied({
            firmId,
            clientId,
            documentId,
            transactionId,
            action,
            actionIndex,
            messageId,
            model: message?.model || null,
            promptVersion: message?.model_version || null,
            beforeAfter: writerResult?.before_state && writerResult?.after_state
              ? [{ target: String(transactionId), before: writerResult.before_state, after: writerResult.after_state }]
              : null,
            // Slice-C signal (risk flags + convergence), loaded only inside the shadow
            // gate. riskContext now resolves `materiality_band` (per-scope authority
            // ceiling) and `first_use_account` (the client's coded-account history);
            // suspense/evidence/convergence resolve from the focus row; the remaining
            // context-dependent flags (duplicate/tax) stay honestly `unknown`.
            loadCaseSnapshot: () =>
              loadShadowCaseSnapshotWithRiskContext({ firmId, clientId, transactionId }),
            withClient: withFirmDbClient
          });
          res.statusCode = 201;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            assistant_message: updatedMessage,
            applied: true,
            snapshot: filterFirmSnapshotForAccess(writerResult.snapshot, access)
          }));
          return;
        }
        // G1(a) (godmode build-spec PR-8) — the three remaining doc-chat verbs,
        // dispatched through the SAME spine to EXISTING writers (INV-1). Each
        // branch mirrors its receipt through the loops-shadow hook with a
        // DOCUMENT-object card (the hook grew that shape in this slice — the
        // capability contract refuses a new write verb with no receipt lane).
        if (action.type === 'draft_evidence_request') {
          if (!action.question) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Proposed draft_evidence_request action is missing question.' }));
            return;
          }
          const actorId = gate.actorId;
          const exec = await executeChatApplyAction({
            action,
            fallbackErrorMessage: 'Evidence request failed.',
            execute: async () => {
              // The document-anchored owner ask (FI-9 doc-first pattern):
              // per-document open-ask dedup lives in the writer. The ask
              // always goes to the OWNER — the action's `recipient` names
              // who the owner should chase, carried in the question text.
              const evidenceResult = await createClientEvidenceRequestInDb({
                firmId,
                clientId,
                documentId,
                question: action.question,
                evidenceType: 'supporting_document',
                actorId
              });
              const evidenceRequest = evidenceResult.evidence_request || null;
              return {
                result: {
                  evidence_request_id: evidenceRequest?.id || null,
                  consequence: 'An evidence request now awaits the owner — this document rests as asked, not as firm work.'
                },
                evidenceResult,
                evidenceRequest
              };
            },
            stamp: {
              write: updateDocumentChatActionStatusInDb,
              scope: { firmId, clientId, documentId, messageId, actionIndex }
            }
          });
          if (exec.disposition !== 'applied') {
            res.statusCode = exec.statusCode;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(exec.body));
            return;
          }
          // Loops shadow (Slice F posture) — document-object card, no-throw, gated.
          await onDocumentChatActionApplied({
            firmId, clientId, documentId, action, actionIndex, messageId,
            model: message?.model || null, promptVersion: message?.model_version || null,
            withClient: withFirmDbClient
          });
          res.statusCode = 201;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            assistant_message: exec.updatedMessage,
            applied: true,
            evidence_request: exec.executed.evidenceRequest,
            snapshot: filterFirmSnapshotForAccess(exec.executed.evidenceResult.snapshot, access)
          }));
          return;
        }
        if (action.type === 'leave_review_note') {
          if (!action.note) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Proposed leave_review_note action is missing note.' }));
            return;
          }
          const actorId = gate.actorId;
          const exec = await executeChatApplyAction({
            action,
            fallbackErrorMessage: 'Review note failed.',
            execute: async () => {
              // The document's note home is its payload (single-key overwrite,
              // the same shape feed chat uses on the review queue). The writer's
              // own audit row is actor-less by design; the actor-attributed row
              // follows via the spine emitter.
              const snapshot = await updateDocumentInDb({
                firmId,
                documentId,
                producer: true,
                actor: { actorType: 'firm', actorId },
                patch: {
                  reviewer_note: action.note,
                  reviewer_note_by: actorId,
                  reviewer_note_at: new Date().toISOString(),
                  ...(action.follow_up_at ? { follow_up_at: action.follow_up_at } : {})
                }
              });
              await auditChatApplyEvent({
                query: queryFirmDb,
                firmId,
                clientId,
                actorId,
                action: 'document.note_added',
                resourceType: 'document',
                resourceId: documentId,
                metadata: {
                  note: action.note,
                  follow_up_at: action.follow_up_at || null,
                  source: 'document_chat',
                  message_id: messageId,
                  action_index: actionIndex
                }
              });
              return {
                result: {
                  document_id: documentId,
                  consequence: 'A note now rides the document for later review — nothing else changed: no ledger entry, no match, no state flip.'
                },
                snapshot
              };
            },
            stamp: {
              write: updateDocumentChatActionStatusInDb,
              scope: { firmId, clientId, documentId, messageId, actionIndex }
            }
          });
          if (exec.disposition !== 'applied') {
            res.statusCode = exec.statusCode;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(exec.body));
            return;
          }
          // Loops shadow (Slice F posture) — document-object card, no-throw, gated.
          await onDocumentChatActionApplied({
            firmId, clientId, documentId, action, actionIndex, messageId,
            model: message?.model || null, promptVersion: message?.model_version || null,
            withClient: withFirmDbClient
          });
          res.statusCode = 201;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            assistant_message: exec.updatedMessage,
            applied: true,
            snapshot: filterFirmSnapshotForAccess(exec.executed.snapshot, access)
          }));
          return;
        }
        if (action.type === 'mark_immaterial') {
          // The Keep-layer preflight (plan §5 G1a): deterministic refusals
          // where arithmetic can rule — amount vs the disposition ceiling,
          // the action's own stated threshold, tax impact, parse red flags.
          // Blocked → 422 and the action STAYS PROPOSED (no stamp).
          const documentRow = await queryFirmDb(
            `select d.id, d.total_amount, d.tax_amount, d.parse_summary, d.payload,
                    c.jurisdiction as client_jurisdiction
               from documents d
               left join clients c on c.firm_id = d.firm_id and c.id = d.client_id
              where d.firm_id = $1 and d.client_id = $2 and d.id = $3`,
            [firmId || DEFAULT_FIRM_ID, clientId, documentId]
          );
          if (!documentRow.rows.length) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Document not found for this firm/client.' }));
            return;
          }
          // RT-11b — the disposition ceiling follows the client's pack (home
          // currency); env is the only override; no pack ⇒ the preflight's own
          // unset refusal ("never means infinity").
          const materialityPolicy = getDispositionMaterialityPolicy({ jurisdiction: documentRow.rows[0].client_jurisdiction ?? null });
          const materialityCeiling = Number.isFinite(materialityPolicy.ceiling) ? materialityPolicy.ceiling : null;
          const preflight = evaluateMarkImmaterialPreflight({
            document: documentRow.rows[0],
            action,
            ceiling: materialityCeiling
          });
          if (!preflight.allowed) {
            res.statusCode = 422;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              error: 'mark_immaterial refused by the materiality preflight; the action stays proposed.',
              preflight
            }));
            return;
          }
          const actorId = gate.actorId;
          const exec = await executeChatApplyAction({
            action,
            fallbackErrorMessage: 'Mark immaterial failed.',
            execute: async () => {
              // The persisted VERDICT (render-the-persisted-verdict rail):
              // an `immaterial` payload key following the established
              // producer-verdict pattern (no_line_disposition, owner_notified).
              const snapshot = await updateDocumentInDb({
                firmId,
                documentId,
                producer: true,
                actor: { actorType: 'firm', actorId },
                patch: {
                  immaterial: {
                    verdict: 'immaterial',
                    reason: action.reason || null,
                    threshold_amount: action.threshold_amount ?? null,
                    ceiling: materialityCeiling,
                    ceiling_source: materialityPolicy.source,
                    marked_by: actorId,
                    marked_at: new Date().toISOString(),
                    source: { surface: 'document_chat', message_id: messageId, action_index: actionIndex },
                    preflight_checks: preflight.checks
                  }
                }
              });
              await auditChatApplyEvent({
                query: queryFirmDb,
                firmId,
                clientId,
                actorId,
                action: 'document.marked_immaterial',
                resourceType: 'document',
                resourceId: documentId,
                metadata: {
                  reason: action.reason || null,
                  threshold_amount: action.threshold_amount ?? null,
                  ceiling: materialityCeiling,
                  ceiling_source: materialityPolicy.source,
                  preflight_checks: preflight.checks,
                  source: 'document_chat',
                  message_id: messageId,
                  action_index: actionIndex
                }
              });
              return {
                result: {
                  document_id: documentId,
                  verdict: 'immaterial',
                  consequence: preflight.consequence,
                  preflight
                },
                snapshot
              };
            },
            stamp: {
              write: updateDocumentChatActionStatusInDb,
              scope: { firmId, clientId, documentId, messageId, actionIndex }
            }
          });
          if (exec.disposition !== 'applied') {
            res.statusCode = exec.statusCode;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(exec.body));
            return;
          }
          // Loops shadow (Slice F posture) — document-object card, no-throw, gated.
          await onDocumentChatActionApplied({
            firmId, clientId, documentId, action, actionIndex, messageId,
            model: message?.model || null, promptVersion: message?.model_version || null,
            withClient: withFirmDbClient
          });
          res.statusCode = 201;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            assistant_message: exec.updatedMessage,
            applied: true,
            preflight,
            snapshot: filterFirmSnapshotForAccess(exec.executed.snapshot, access)
          }));
          return;
        }
        // Unreachable: gated above by DOCUMENT_CHAT_APPLIABLE_ACTION_TYPES.
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Unhandled appliable action type.' }));
      } catch (error) {
        const status = error?.statusCode || 500;
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error' }));
      }
      return;
    }

    // ─── Transaction chat ────────────────────────────────────────────
    //
    // Mirrors the document-chat routes above but keyed on a bank
    // transaction. The bank-feed artifact opens a chat thread per
    // (firm, client, transaction); the LLM proposes structured
    // actions (categorise, ask client, remember merchant, etc.)
    // that the firm reviews and applies. Apply is gated by
    // TRANSACTION_CHAT_ALL_APPLIABLE_ACTION_TYPES — the state-correction
    // verbs plus the separately-guarded remedial verbs (retry_parse).
    // Other types (diagnose, future_action) render proposed-only.

    // GET /transaction-chat?client_id=...&transaction_id=...
    if (requestUrl.pathname === '/transaction-chat' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const clientId = requestUrl.searchParams.get('client_id') || '';
      const transactionId = requestUrl.searchParams.get('transaction_id') || '';
      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      if (!clientId || !transactionId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id and transaction_id are required.' }));
        return;
      }
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      try {
        const messages = await getTransactionChatThreadFromDb({ firmId, clientId, transactionId });

        // The artifact poll (transaction-artifact.jsx `tick`) re-fetches this
        // route on an interval but uses ONLY `messages` — it never touches
        // `explanation`. Building the snapshot (a match query, a document
        // query, and a `createSignedUrl` network call) on every poll was pure
        // waste on the open hot path. `explanation=0` lets the poll skip it;
        // the mount fetch and the explicit refresh omit the flag and still get
        // the verdict card.
        const wantExplanation = requestUrl.searchParams.get('explanation') !== '0';

        let explanation = null;
        if (wantExplanation) {
          try {
            // The artifact drawer is the FIRST consumer of the
            // BookCaseSnapshot read model (operatorCaseSnapshot.js, contract
            // §1) — the explanation block this used to assemble inline now
            // comes from the shared assembler, so the drawer and a future
            // chat turn can never drift. The drawer reads one block.
            //
            // `include` is the snapshot's budget control: the explanation
            // needs only the matched-document graph (matches + documents).
            // The default include also runs an `audit` query and assembles
            // `pipeline_state`, both discarded here — scope it down.
            const snapshot = await getOperatorCaseSnapshot({
              firmId,
              clientId,
              focus: { type: 'transaction', id: transactionId },
              include: ['matches', 'documents'],
              actorId: signedUrlActorFromAccess(access),
              deps: { createSignedUrl: createEvidenceSignedUrl }
            });
            explanation = snapshot.focus_state?.explanation || null;
          } catch {
            // Soft-degrade: explanation is optional
          }
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          messages: projectChatMessagesForViewer(messages, chatApplyActorId(access.principal)),
          appliable_action_types: TRANSACTION_CHAT_ALL_APPLIABLE_ACTION_TYPES,
          explanation
        }));
      } catch (error) {
        const status = error?.statusCode || 500;
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error' }));
      }
      return;
    }

    // GET /case-snapshot?client_id=&focus_type=&focus_id=&include=
    //
    // The BookCaseSnapshot read model (operatorCaseSnapshot.js, contract
    // §1): ONE server-side "book checkout" assembled from persisted state,
    // consumed by the artifact drawer, chat turns, and support tooling.
    // A stale FE payload never feeds a reasoning call — this is the single
    // source. `include` is a comma-separated budget control; an omitted
    // block is marked absent, never dropped silently.
    if (requestUrl.pathname === '/case-snapshot' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const clientId = requestUrl.searchParams.get('client_id') || '';
      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const focusType = requestUrl.searchParams.get('focus_type') || 'transaction';
      const focusId =
        requestUrl.searchParams.get('focus_id') ||
        requestUrl.searchParams.get('transaction_id') ||
        requestUrl.searchParams.get('document_id') ||
        '';
      const includeParam = requestUrl.searchParams.get('include');
      const include = includeParam
        ? includeParam.split(',').map((s) => s.trim()).filter(Boolean)
        : null;
      if (!clientId || !focusId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id and focus_id (or transaction_id) are required.' }));
        return;
      }
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      try {
        const snapshot = await getOperatorCaseSnapshot({
          firmId,
          clientId,
          focus: { type: focusType, id: focusId },
          include,
          actorId: signedUrlActorFromAccess(access),
          deps: { createSignedUrl: createEvidenceSignedUrl }
        });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(snapshot));
      } catch (error) {
        const status = error?.statusCode || 500;
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error' }));
      }
      return;
    }

    // GET /transaction-chat/unread-summary?client_id=...
    //
    // Per-transaction rollup of the latest `client_reply_received`
    // system message timestamp. Powers the bank-feed unread dot —
    // the FE compares each row's latest_client_reply_at against a
    // local last-seen timestamp to decide whether to badge it.
    // Transactions with no client reply ever do not appear in the
    // result (absence = no badge).
    if (requestUrl.pathname === '/transaction-chat/unread-summary' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const clientId = requestUrl.searchParams.get('client_id') || '';
      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      if (!clientId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id is required.' }));
        return;
      }
      await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      try {
        const summary = await getTransactionChatUnreadSummaryFromDb({ firmId, clientId });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ summary }));
      } catch (error) {
        const status = error?.statusCode || 500;
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error' }));
      }
      return;
    }

    // POST /transaction-chat/messages
    // ── Universal @mentions (slice 3): the artifact comment lane ──────────
    // The typeahead's eligible-actor roster: humans with entity access +
    // the client's hired bench + the operator. Entity isolation lives HERE
    // (the roster is assembled from eligible rows only) and again at the
    // comment write (refs are validated against this same roster).
    if (requestUrl.pathname === '/mentions/roster' && req.method === 'GET') {
      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = requestUrl.searchParams.get('client_id') || '';
      const query = requestUrl.searchParams.get('query') || '';
      if (!clientId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id is required.' }));
        return;
      }
      const { principal } = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      try {
        const roster = await buildMentionRosterForClient({ firmId: firmId || DEFAULT_FIRM_ID, clientId });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          actors: filterMentionRoster(roster, query),
          requested_by: chatApplyActorId(principal)
        }));
      } catch (error) {
        res.statusCode = error?.statusCode || 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error' }));
      }
      return;
    }

    // POST /chat-comments — a human comment / edit-version / thread
    // resolution on an artifact's thread. NOT a prompt to Donna: no LLM call
    // happens here; the row persists with attributed actor_id and its audit
    // row in one transaction (the appenders' comment lane). An 'ask' flavor
    // additionally mints the SEAT-audience fact question through the slice-2
    // primitive — the ask is minted FIRST (it is the load-bearing blocker;
    // a crash between the two leaves the ask standing, never an orphan
    // blocker-less question).
    if (requestUrl.pathname === '/chat-comments' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || '';
      const surface = body?.surface === 'document_chat' ? 'document_chat' : 'transaction_chat';
      const threadId = surface === 'document_chat' ? (body?.document_id || '') : (body?.transaction_id || '');
      const kind = body?.kind === 'thread_resolution' ? 'thread_resolution' : 'comment';
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      if (!clientId || !threadId || (kind === 'comment' && !text)) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id, the artifact thread id, and non-empty text are required.' }));
        return;
      }
      const { principal } = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      try {
        const actorId = chatApplyActorId(principal);
        // Staff-seat posters carry the ladder metadata into the comment
        // receipt (build 1 §4.5); owners/legacy principals carry none.
        const actorSeat = principal?.seatRole
          ? { seat_role: principal.seatRole, affiliation: principal.affiliation || 'internal' }
          : null;
        // The row id is minted BEFORE the append so the notification rows'
        // deterministic ids can reference it (fan-out commits in the same
        // transaction as the message — notificationEvents law).
        const messageRowId = surface === 'document_chat'
          ? newMessageId({ documentId: threadId, kind: 'user' })
          : newTransactionChatMessageId({ transactionId: threadId, kind: 'user' });
        let payload;
        let mintedAsk = null;
        let notificationRows = [];
        if (kind === 'thread_resolution') {
          payload = buildThreadResolutionPayload({
            outcomeNote: text || body?.outcome_note || '',
            policyMemoryCandidate: body?.policy_memory_candidate === true
          });
        } else {
          const roster = await buildMentionRosterForClient({ firmId: firmId || DEFAULT_FIRM_ID, clientId });
          const submission = validateMentionSubmission({
            flavor: body?.flavor,
            refs: Array.isArray(body?.mentions) ? body.mentions : [],
            roster
          });
          if (!submission.ok) {
            const refusalReason = submission.refusals[0]?.reason || 'mention_not_resolved';
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              error: refusalReason === 'agent_requires_ask'
                ? 'Agents do not receive FYI mentions — ask the agent to get a reply.'
                : 'Mention refs did not resolve.',
              code: refusalReason.toUpperCase(),
              refusals: submission.refusals
            }));
            return;
          }
          // The poster's own roster entry — display + seat vocabulary for
          // receipts, provenance, and notification rows.
          const actorRosterEntry = roster.find((e) => e.actor_type === 'seat'
            && e.principal_type === principal?.principalType
            && e.principal_id === principal?.principalId) || null;
          if (submission.flavor === 'assign') {
            const addressee = submission.resolved[0];
            if (addressee.actor_type !== 'seat') {
              // An agent has no queue: ownership resting on an agent would be
              // the forbidden agent-resting-state (CLAUDE.md, two-terminal
              // generalization). Tasking an agent is the ASK flavor — the
              // runtime answers or escalates on a bound; it never *holds*.
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'An agent cannot hold an assignment — ask the agent instead (the ask flavor); it answers or escalates, never sits on a queue.', code: 'AGENT_ASSIGN_NOT_SUPPORTED' }));
              return;
            }
            // Eligibility (design §1): you cannot assign an approval to a seat
            // that lacks authority for it. This is the composer-honesty gate —
            // a bounded staff seat is refused an artifact above its materiality
            // bound (or with an unresolvable amount: fail-closed upward, the
            // build-1 law). Owner seats and legacy collaborators pass: owners
            // are unbounded, and legacy principals keep their staged dormant
            // posture exactly (build 1's enforcement asymmetry, mirrored
            // deliberately). Hard enforcement stays at APPLY time either way —
            // the born-enforced seat lane routes an over-authority apply no
            // matter who was assigned.
            if (addressee.seat_role && addressee.seat_role !== 'owner') {
              const amountMinor = await resolveMentionArtifactAmountMinor({
                firmId: firmId || DEFAULT_FIRM_ID, clientId, surface, threadId
              });
              const decision = decideSeatAuthority({
                seatRole: addressee.seat_role,
                actionType: 'apply_category',
                amountMinor
              });
              if (decision.outcome !== 'allow') {
                res.statusCode = 403;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({
                  error: `${addressee.display || 'That seat'} does not carry authority for this item — route it to ${decision.route_to_role} or above.`,
                  code: 'ASSIGNEE_NOT_AUTHORIZED',
                  routing: decision
                }));
                return;
              }
            }
          }
          if (submission.flavor === 'ask') {
            const addressee = submission.resolved[0];
            if (addressee.actor_type !== 'seat') {
              // ── @agent ask → a scoped runtime task on the artifact
              // (slice 4). The task is the agent-audience ask itself: the
              // mint opens the evidence case with a SYSTEM-owned blocker
              // (Donna-owed, never a resting state — projects hanging until
              // answered), and the enqueued answer request is its bounded
              // execution: the runtime answers, or escalates back to the
              // instructing seat on the retry bound.
              //
              // Execution-tier gate FIRST: below canary the runtime would
              // never answer, and minting Donna-owed work with no executor
              // parks a permanent hang — refuse honestly instead.
              const { firmMetadata } = await readFirmExecutionContext(
                { query: queryFirmDb }, firmId || DEFAULT_FIRM_ID
              );
              const executionGate = decideLoopExecution({
                loopKey: AGENT_ASK_LOOP_KEY,
                firmMetadata,
                requestedAction: 'proposal_creation'
              });
              if (!executionGate.allowed || executionGate.actionAllowed === false) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({
                  error: 'Agent execution is not enabled for this firm yet — ask a colleague instead.',
                  code: 'AGENT_EXECUTION_NOT_ENABLED',
                  reason: executionGate.actionBlockedReason || executionGate.blockedReason
                }));
                return;
              }
              // D7 — authority composition, enforced from birth (a NEW lane
              // has no legacy behavior to stage around): the task's compiled
              // verb authorizes against min(instructing seat's class, agent's
              // effective class); founder-only verbs never compose.
              const assignmentRole = await getAssignmentRoleForPrincipal({
                firmId: firmId || DEFAULT_FIRM_ID, clientId, principal
              });
              const instructingClass = resolveCapabilityClass({ principal, assignmentRole });
              const composition = decideInstructedAgentAction({
                actionType: AGENT_ANSWER_ACTION_TYPE,
                instructingClass,
                agentClass: agentEffectiveCapabilityClass({
                  agentId: addressee.agent_id, roleId: addressee.role
                })
              });
              if (!composition.allowed) {
                res.statusCode = 403;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({
                  error: `You cannot task ${addressee.display || 'this agent'} with this — the composed authority (${composition.effective_class}) does not cover it.`,
                  code: 'AGENT_INSTRUCTION_NOT_AUTHORIZED',
                  composition
                }));
                return;
              }
              const minted = await createClientEvidenceRequestInDb({
                firmId,
                clientId,
                transactionId: surface === 'transaction_chat' ? threadId : undefined,
                documentId: surface === 'document_chat' ? threadId : undefined,
                question: text,
                evidenceType: 'agent_answer',
                actorId,
                audience: 'agent',
                addresseePrincipalType: 'ai_occupant',
                addresseePrincipalId: addressee.agent_id,
                // Persisted provenance — the receipt's two identities (D7):
                // the consumer composes from exactly this at execution time.
                requestContext: {
                  instructed_by: {
                    principal_type: principal?.principalType || null,
                    principal_id: principal?.principalId || null,
                    display: actorRosterEntry?.display || null,
                    actor_id: actorId,
                    ...(principal?.seatRole
                      ? { seat_role: principal.seatRole, affiliation: principal.affiliation || 'internal' }
                      : {}),
                    capability_class: instructingClass
                  },
                  agent: { agent_id: addressee.agent_id, role: addressee.role || null },
                  authority_composition: composition
                },
                returnSnapshot: false
              });
              mintedAsk = minted?.evidence_request || null;
              // The durable execution request (the producer re-gates and
              // coalesces; a crash after the mint leaves the ask standing
              // and the next mint attempt re-enqueues).
              await onAgentAskCreatedRequestAnswer({
                client: { query: queryFirmDb },
                firmId: firmId || DEFAULT_FIRM_ID,
                clientId,
                evidenceRequestId: mintedAsk?.id || null
              });
            } else {
              const minted = await createClientEvidenceRequestInDb({
                firmId,
                clientId,
                transactionId: surface === 'transaction_chat' ? threadId : undefined,
                documentId: surface === 'document_chat' ? threadId : undefined,
                question: text,
                evidenceType: 'colleague_answer',
                actorId,
                audience: 'seat',
                addresseePrincipalType: addressee.principal_type,
                addresseePrincipalId: addressee.principal_id,
                returnSnapshot: false
              });
              mintedAsk = minted?.evidence_request || null;
            }
          }
          payload = buildCommentPayload({
            flavor: submission.flavor,
            mentions: submission.resolved,
            supersedesMessageId: body?.supersedes_message_id || null,
            askId: mintedAsk?.id || null
          });
          // Fan-out (§7): one notification row per mentioned SEAT, eligible
          // by construction (the refs just validated against the roster),
          // never the poster themself, never an agent. Committed inside the
          // appender's transaction below.
          notificationRows = buildMentionNotificationRows({
            firmId: firmId || DEFAULT_FIRM_ID,
            clientId,
            surface,
            threadId,
            messageId: messageRowId,
            askId: mintedAsk?.id || null,
            flavor: submission.flavor,
            resolvedMentions: submission.resolved,
            actorPrincipal: principal
              ? { principal_type: principal.principalType, principal_id: principal.principalId }
              : null,
            actorId,
            actorDisplay: actorRosterEntry?.display || null,
            text
          });
        }
        const append = surface === 'document_chat'
          ? appendDocumentChatMessageInDb({
              firmId,
              clientId,
              documentId: threadId,
              id: messageRowId,
              role: 'user',
              content: kind === 'comment' ? text : (text || payload.outcome_note || 'Thread resolved.'),
              payload,
              actorType: 'firm',
              actorId,
              actorSeat,
              notificationRows
            })
          : appendTransactionChatMessageInDb({
              firmId,
              clientId,
              transactionId: threadId,
              id: messageRowId,
              role: 'user',
              content: kind === 'comment' ? text : (text || payload.outcome_note || 'Thread resolved.'),
              payload,
              actorType: 'firm',
              actorId,
              actorSeat,
              notificationRows
            });
        const messageRow = await append;
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          message: projectChatMessageForViewer(messageRow, actorId),
          evidence_request: mintedAsk
        }));
      } catch (error) {
        res.statusCode = error?.statusCode || 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error', code: error?.code || undefined }));
      }
      return;
    }

    // POST /chat-comments/redact — the owner-capability erase path (the one
    // sanctioned content mutation; firm members only, per the capability
    // partition — a scoped collaborator never redacts).
    if (requestUrl.pathname === '/chat-comments/redact' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || '';
      const surface = body?.surface === 'document_chat' ? 'document_chat' : 'transaction_chat';
      const threadId = surface === 'document_chat' ? (body?.document_id || '') : (body?.transaction_id || '');
      const messageId = body?.message_id || '';
      if (!clientId || !threadId || !messageId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id, the artifact thread id, and message_id are required.' }));
        return;
      }
      const { principal } = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId),
        requireMember: true
      });
      try {
        const redacted = await redactChatCommentInDb({
          firmId,
          clientId,
          surface,
          threadId,
          messageId,
          actorId: chatApplyActorId(principal),
          actorType: 'firm',
          reason: typeof body?.reason === 'string' ? body.reason : null
        });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ message: redacted }));
      } catch (error) {
        res.statusCode = error?.statusCode || 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error', code: error?.code || undefined }));
      }
      return;
    }

    // GET /mentions/notifications — the CALLER'S Mentions lane (D10): the
    // union of their mention/assign notification rows (unread state) and
    // their open seat asks read LIVE from the store of record. Always
    // self-scoped — there is no "someone else's notifications" surface.
    if (requestUrl.pathname === '/mentions/notifications' && req.method === 'GET') {
      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const unreadOnly = requestUrl.searchParams.get('unread') === '1';
      const { principal } = await assertFirmAccess({ firmId, auth: req.donnaAuth });
      try {
        const [notifications, openAsks, unreadCount] = await Promise.all([
          listMentionNotifications({ firmId: firmId || DEFAULT_FIRM_ID, principal, unreadOnly }),
          listOpenSeatAsksForPrincipal({ firmId: firmId || DEFAULT_FIRM_ID, principal }),
          countUnreadMentionNotifications({ firmId: firmId || DEFAULT_FIRM_ID, principal })
        ]);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          notifications: notifications.map((row) => ({ ...row, payload: buildNotificationPayload(row) })),
          open_asks: openAsks,
          unread_count: unreadCount,
          digest: buildMentionDigest({ openAsks, notifications })
        }));
      } catch (error) {
        res.statusCode = error?.statusCode || 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error' }));
      }
      return;
    }

    // POST /mentions/notifications/read — mark the caller's own rows read
    // ({ ids: [...] } or everything when ids is omitted).
    if (requestUrl.pathname === '/mentions/notifications/read' && req.method === 'POST') {
      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const { principal } = await assertFirmAccess({ firmId, auth: req.donnaAuth });
      try {
        const result = await markMentionNotificationsRead({
          firmId: firmId || DEFAULT_FIRM_ID,
          principal,
          ids: Array.isArray(body?.ids) ? body.ids : null
        });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
      } catch (error) {
        res.statusCode = error?.statusCode || 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error' }));
      }
      return;
    }

    if (requestUrl.pathname === '/transaction-chat/messages' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readBody();
      // Resolve the same default as access, persistence and apply before raw evidence reads.
      const firmId = body?.firm_id || DEFAULT_FIRM_ID;
      const clientId = body?.client_id || '';
      const transactionId = body?.transaction_id || '';
      const userMessage = typeof body?.message === 'string' ? body.message : '';
      const transactionContext = body?.transaction_context || null;
      const candidateDocuments = Array.isArray(body?.candidate_documents)
        ? body.candidate_documents
        : [];
      const addressedAgentRef = body?.addressed_agent || null;
      if (!clientId || !transactionId || !userMessage.trim()) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id, transaction_id, and a non-empty message are required.' }));
        return;
      }
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      try {
        const viewerActorId = chatApplyActorId(access.principal);
        const addressedAgent = await resolveDirectDonnaChatRef({
          firmId,
          clientId,
          ref: addressedAgentRef
        });
        const userMessageRow = await appendTransactionChatMessageInDb({
          firmId,
          clientId,
          transactionId,
          id: newTransactionChatMessageId({ transactionId, kind: 'user' }),
          role: 'user',
          content: userMessage.trim(),
          payload: addressedAgent
            ? { kind: 'agent_instruction', mentions: [addressedAgent] }
            : {},
          actorType: 'firm',
          actorId: viewerActorId
        });
        const history = await getTransactionChatThreadFromDb({ firmId, clientId, transactionId });
        // Both ends of context loading use the coding reader's canonical match
        // order. Other match pickers legitimately rank competing documents
        // differently; their choice is not proof that this source changed.
        const initialChatCodingEvidence = await withFirmDbClient((client) =>
          captureFiChatCodingEvidence({ client, firmId, clientId, transactionId }));
        // Start this independent read immediately so re-hydrating date-only
        // accounting fields adds no avoidable waterfall to Donna's response.
        const persistedCandidateDocumentsPromise = withFirmDbClient((dbClient) =>
          fetchTransactionChatCandidateDocuments({
            client: dbClient,
            firmId: firmId || DEFAULT_FIRM_ID,
            clientId,
            candidateDocuments
          })
        ).catch((err) => {
          console.warn('[transaction-chat] candidate document hydration failed', err?.message || err);
          return [];
        });
        // The mounted row can flatten a many-candidate collision to one card.
        // Hydrate the complete same-merchant/same-amount neighborhood directly
        // from persisted accounting state so Donna can reason across both
        // transactions/documents and can tell local evidence from missing evidence.
        const collisionGroupPromise = withFirmDbClient((dbClient) =>
          fetchTransactionChatCollisionGroup({
            client: dbClient,
            firmId: firmId || DEFAULT_FIRM_ID,
            clientId,
            transactionId
          })
        ).catch((err) => {
          console.warn('[transaction-chat] collision group hydration failed', err?.message || err);
          return null;
        });
        // Source-of-truth lookup for the active match: trusting client-
        // supplied match state here would let a stale FE payload tell
        // the LLM "no match exists" when one actually does, which is
        // exactly the regression PR #200 fixed at the candidate-docs
        // level. Server-side query is one round-trip and keeps the
        // LLM's "existing match" view aligned with reconciliation_matches.
        const existingMatch = await withFirmDbClient((client) =>
          fetchActiveTransactionMatch({
            client,
            firmId: firmId || DEFAULT_FIRM_ID,
            bankTransactionId: transactionId
          })
        ).catch((err) => {
          // Log so the next regression is loud — PR #201's first cut
          // silently ate a "column does not exist" for an entire PR
          // cycle. .catch returning null preserves the chat working
          // even if the lookup blows up, but a console trace makes
          // failure visible in deploy logs.
          console.warn('[transaction-chat] existing_match lookup failed', err?.message || err);
          return null;
        });
        // The client's account menu — without it the chat model's only
        // account vocabulary was the system prompt's examples, and it
        // proposed placeholders ("Meals and entertainment" for a
        // coworking charge) while the real menu had a proper home.
        // A policy-resolution failure stops this coding-capable turn before
        // provider invocation; unrelated lookup failures retain their prior handling.
        const accountOptions = await getClientAccountOptionsFromDb({ firmId, clientId }).catch((err) => {
          if (isCodingPolicyError(err)) throw err;
          console.warn('[transaction-chat] account options lookup failed', err?.message || err);
          return [];
        });
        // Whose business this is (jurisdiction, tax profile) — what
        // lets the model judge tax treatment for THIS client instead
        // of flip-flopping between regimes. Unresolved policy is a typed
        // refusal; it must not become a context-free provider request.
        const clientProfile = await getClientChatProfileFromDb({ firmId, clientId }).catch((err) => {
          if (isCodingPolicyError(err)) throw err;
          console.warn('[transaction-chat] client profile lookup failed', err?.message || err);
          return null;
        });
        // The persisted coding verdict — server-side lookup for the
        // same reason as existingMatch above: a stale FE payload must
        // not tell the LLM there is no verdict (or a different one)
        // when the row carries one. The chat argued with a phantom
        // "Revenue" suggestion because the verdict never reached it.
        const persistedRow = await withFirmDbClient(async (client) => {
          const result = await client.query(
            'select payload, coding_state from transactions where firm_id = $1 and id = $2',
            [firmId || DEFAULT_FIRM_ID, transactionId]
          );
          return result.rows[0] || null;
        }).catch((err) => {
          console.warn('[transaction-chat] coding verdict lookup failed', err?.message || err);
          return null;
        });
        const persistedVerdict = persistedRow?.payload?.ai_suggestion || null;
        // The row's persisted review_state is what the prompt branches on
        // (apply_category for a row still in review vs recode_decided for a
        // settled one). Source it server-side for the same reason as the
        // verdict above — a stale FE must not tell the model a decided row is
        // still in review, or the reverse. The recode_decided apply route
        // re-verifies it at write time regardless (INV-4); this only lets the
        // model PROPOSE the right verb.
        const persistedReviewState = legacyReviewStateFor(persistedRow?.coding_state) || null;
        const collisionGroup = await collisionGroupPromise;
        const focusedCollisionTransaction = collisionGroup?.transactions?.find(
          (candidate) => String(candidate.id) === String(transactionId)
        ) || null;
        const collisionTransactionContext = focusedCollisionTransaction
          ? {
              transaction_date: focusedCollisionTransaction.transaction_date,
              description: focusedCollisionTransaction.description,
              currency: focusedCollisionTransaction.currency,
              reconciliation_status: focusedCollisionTransaction.reconciliation_status,
              ...(collisionGroup.key?.direction === 'money_in'
                ? { money_in: focusedCollisionTransaction.amount, money_out: 0 }
                : { money_in: 0, money_out: focusedCollisionTransaction.amount })
            }
          : null;
        const transactionForContext = (transactionContext || collisionTransactionContext || persistedVerdict || persistedReviewState)
          ? {
              id: transactionId,
              ...(transactionContext || {}),
              ...(collisionTransactionContext || {}),
              ...(persistedVerdict ? { ai_suggestion: persistedVerdict } : {}),
              ...(persistedReviewState ? { review_state: persistedReviewState } : {})
            }
          : null;
        // Layer-2 facts for this line's merchant + the client + its
        // jurisdiction. Soft-degrades to none, never to a dead chat.
        // clientId is the entity key (G−1(c)): merchant facts resolve per
        // legal entity; legacy rows ride with legacy_firm_scope: true.
        const firmFacts = await withFirmDbClient((dbClient) =>
          getFirmFactsForSubjects({
            client: dbClient,
            firmId: firmId || DEFAULT_FIRM_ID,
            clientId,
            chatAdmission: true, // FIK-0b: no jurisdiction-scope rule grounds a chat answer
            subjects: [
              {
                scope: 'merchant',
                value: `${transactionForContext?.description || ''} ${transactionForContext?.raw_description || ''}`
              },
              { scope: 'client', value: clientProfile?.registration_number || clientProfile?.name || '' },
              { scope: 'jurisdiction', value: clientProfile?.jurisdiction || '' },
              { scope: 'firm', value: firmId || DEFAULT_FIRM_ID }
            ]
          })
        ).catch((err) => {
          console.warn('[transaction-chat] firm facts lookup failed', err?.message || err);
          return [];
        });
        // The matched document's parse pipeline_state, from the
        // BookCaseSnapshot read model (operatorCaseSnapshot.js, contract
        // §1) — the snapshot's SECOND consumer (the GET handler's
        // explanation block was the first). This is what makes the
        // read-only `diagnose` verb pin a stuck document's parse stage
        // FROM PERSISTED DATA instead of guessing (CLAUDE.md "diagnose,
        // don't guess"; the READING·1-OF-1 rail). One assembler, N
        // consumers — the chat reads the SAME checkout the drawer does,
        // just a different block. Soft-degrades to null: a snapshot
        // hiccup must never kill the turn, the same contract as the
        // existing_match / verdict / facts lookups above.
        const pipelineState = await getOperatorCaseSnapshot({
          firmId,
          clientId,
          focus: { type: 'transaction', id: transactionId },
          include: ['matches', 'documents', 'pipeline_state']
        })
          .then((snap) => snap.pipeline_state || null)
          .catch((err) => {
            console.warn('[transaction-chat] pipeline_state snapshot failed', err?.message || err);
            return null;
          });
        // Slice I — L2 playbook retrieval (bookkeepingPlaybooks.js): curated
        // procedure guidance for a recognized transaction pattern, retrieved
        // per-case and staged per client through the config plane
        // (BOOKKEEPING_PLAYBOOK_RETRIEVAL — dormant without a row; env fallback
        // false). Selection is deterministic recall that gates nothing. Stage
        // semantics: acts (canary/auto) → inject into the prompt + stamp the ids
        // on the persisted assistant payload (`playbooks_injected` — the record
        // the apply receipt's `playbooks_used` renders); observes-only (shadow)
        // → stamp the would-fire match (`playbooks_matched`) for sizing, prompt
        // untouched. Fail-CLOSED: a config-read failure means no injection —
        // missing config never broadens scope (plan §6).
        let playbooksForPrompt = [];
        let playbooksMatchedIds = [];
        try {
          const chatConfigSnapshot = await withFirmDbClient((dbClient) =>
            readClientConfigSnapshot(dbClient, { firmId: firmId || DEFAULT_FIRM_ID, clientId }));
          if (playbookRetrievalObserves({ snapshot: chatConfigSnapshot })) {
            const matched = selectPlaybooksForCase({
              description: transactionForContext?.description || '',
              raw_description: transactionForContext?.raw_description || '',
              counterparty: transactionForContext?.counterparty || ''
            });
            playbooksMatchedIds = matched.map((playbook) => playbook.id);
            if (playbookRetrievalActs({ snapshot: chatConfigSnapshot })) {
              playbooksForPrompt = renderPlaybooksForPrompt(matched);
            }
          }
        } catch (playbookErr) {
          console.warn('[transaction-chat] playbook config lookup failed (no injection)', playbookErr?.message || playbookErr);
        }
        // This LINE's live owner asks — the cancel_ask / resend_ask target
        // universe (G1b), scoped to this transaction so the per-case chat can
        // never reach another line's question. Soft-degrades to []: both verbs
        // then have nothing to target, which is the safe direction.
        const knownAsks = await getOpenClientEvidenceRequestsForChatFromDb({
          firmId: firmId || DEFAULT_FIRM_ID,
          clientId,
          transactionId,
          limit: 20
        }).catch((err) => {
          console.warn('[transaction-chat] open asks lookup failed', err?.message || err);
          return [];
        });
        // Candidate ids come from the mounted artifact, but every accounting
        // field is re-read from PostgreSQL. In particular, DATE values must
        // stay calendar dates rather than browser-serialized UTC timestamps.
        const persistedCandidateDocuments = await persistedCandidateDocumentsPromise;
        const allCandidateDocuments = [...persistedCandidateDocuments];
        const candidateIds = new Set(allCandidateDocuments.map((doc) => String(doc.id)));
        for (const doc of collisionGroup?.documents || []) {
          if (candidateIds.has(String(doc.id))) continue;
          candidateIds.add(String(doc.id));
          allCandidateDocuments.push({
            ...doc,
            vendor_name: doc.counterparty || null,
            customer_name: doc.counterparty || null
          });
        }
        const chatCodingEvidence = await withFirmDbClient((client) =>
          captureFiChatCodingEvidence({ client, firmId, clientId, transactionId }));
        const context = buildTransactionChatContext({
          transaction: chatCodingEvidence ? { ...chatCodingEvidence.transaction, transaction_date: chatCodingEvidence.transaction.date } : transactionForContext,
          candidateDocuments: allCandidateDocuments,
          existingMatch: chatCodingEvidence ? (chatCodingEvidence.document ? {
            matched_object_id: chatCodingEvidence.document.document_id,
            status: chatCodingEvidence.document.match_status,
            source: 'current_coding_evidence'
          } : null) : existingMatch,
          collisionGroup,
          accountOptions,
          clientProfile,
          firmFacts,
          knownAsks,
          pipelineState,
          playbooks: playbooksForPrompt
        });
        if (clientProfile?.codingPolicy?.nativeMenu) Object.assign(context, await withFirmDbClient(client =>
          captureNativeChatCodingContextWithClient({ client, firmId, clientId, transactionIds: [transactionId] })));
        if (chatCodingEvidence) {
          const evidence = chatCodingEvidence.document;
          const source = chatCodingEvidence.transaction;
          const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
          const shownDocument = (doc) => [doc.document_type, doc.filename, doc.counterparty || null,
            doc.total_amount, doc.currency, doc.document_date];
          const currentDocument = evidence ? [evidence.document_type, String(evidence.filename || '').slice(0, 200),
            String(evidence.vendor_name || evidence.customer_name || '').slice(0, 120) || null,
            evidence.total_amount, evidence.currency, evidence.document_date] : null;
          const focusedSnapshot = context.collision_group?.transactions?.find(row => row.id === transactionId);
          const documentSnapshots = [...context.candidate_documents, ...(context.collision_group?.documents || [])]
            .filter(doc => doc.id === evidence?.document_id);
          const captureChanged = !initialChatCodingEvidence
            || initialChatCodingEvidence.receipt.evidence_digest !== chatCodingEvidence.receipt.evidence_digest
            || initialChatCodingEvidence.receipt.bank_source_digest !== chatCodingEvidence.receipt.bank_source_digest;
          const groupKey = context.collision_group?.key;
          const groupKeyChanged = groupKey && !same([groupKey.direction, groupKey.amount, groupKey.currency, groupKey.counterparty],
            [Number(source.money_in || 0) > 0 ? 'money_in' : 'money_out', Number(source.money_in || source.money_out || 0),
              String(source.currency || '').toUpperCase(), compactMerchantKey(source.contact || source.counterparty_guess || source.description || source.raw_description) || null]);
          const inconsistent = captureChanged || groupKeyChanged || (focusedSnapshot && !same(
            [focusedSnapshot.transaction_date, focusedSnapshot.description, focusedSnapshot.amount, focusedSnapshot.currency],
            [source.date, String(source.description || source.raw_description || '').slice(0, 240),
              Number(source.money_in || source.money_out || 0), source.currency]))
            || documentSnapshots.some(doc => !same(shownDocument(doc), currentDocument));
          if (inconsistent) throw Object.assign(new Error('The focused evidence changed while loading this conversation. Please ask Donna again for a fresh correction.'),
            { code: 'TRANSACTION_CHAT_CONTEXT_CHANGED', statusCode: 409 });
          context.current_coding_evidence = evidence ? {
            handle: 'matched_document', match_status: evidence.match_status,
            document_type: evidence.document_type, filename: evidence.filename,
            vendor_name: evidence.vendor_name, customer_name: evidence.customer_name,
            total_amount: evidence.total_amount, tax_amount: evidence.tax_amount,
            currency: evidence.currency, document_date: evidence.document_date,
            lines: evidence.lines.map((line, index) => ({ handle: `line_${index + 1}`,
              description: line.description, amount: line.amount })),
            matched_line: evidence.matched_line ? { handle: 'matched_settlement_line',
              line_no: evidence.matched_line.line_no, description: evidence.matched_line.description,
              amount: evidence.matched_line.amount, settlement_row: evidence.matched_line.settlement_row } : null
          } : null;
        }
        if (['posted', 'synced', 'closed'].includes(persistedRow?.coding_state)
          || persistedRow?.payload?.ledger_journal_id) {
          const postedCase = await withFirmDbClient(client => readJevCase({ client,
            firmId: firmId || DEFAULT_FIRM_ID, clientId, transactionId,
            evidenceOnly: true, includePostingLines: true }));
          context.current_posted_accounting = {
            provenance: 'persisted_ledger_observation',
            coverage: postedCase.caseEvidence.coverage,
            journals: postedCase.caseEvidence.postings.filter(row => row.source_id === transactionId)
              .map((row, index) => ({ handle: `journal_${index + 1}`, status: row.status,
                lines: row.lines || [] }))
          };
        }
        const reply = await generateTransactionChatReply({
          context,
          history: history.slice(0, -1),
          userMessage: userMessage.trim()
        });
        if (reply.kind !== 'ok') {
          // Same diagnostic surfacing as the feed chat below — the shared
          // engine carries model + stop_reason + a bounded snippet on a
          // shape failure; render it so the cause is on the receipt
          // (CLAUDE.md model-id + diagnose-don't-guess rails).
          const diagnostic = reply.diagnostic || null;
          const failureContent = diagnostic
            ? `Chat unavailable: ${reply.reason || reply.code || 'unknown'} (model=${diagnostic.model || 'unknown'}, stop_reason=${diagnostic.stop_reason || 'unknown'}).`
            : `Chat unavailable: ${reply.reason || reply.code || 'unknown'}.`;
          const failureMessage = await appendTransactionChatMessageInDb({
            firmId,
            clientId,
            transactionId,
            id: newTransactionChatMessageId({ transactionId, kind: 'system' }),
            role: 'system',
            content: failureContent,
            payload: { failure_code: reply.code || 'unknown', ...(diagnostic ? { diagnostic } : {}) },
            actorType: 'system'
          });
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            error: reply.reason || 'Chat unavailable.',
            failure_code: reply.code || 'unknown',
            ...(diagnostic ? { diagnostic } : {}),
            user_message: projectChatMessageForViewer(userMessageRow, viewerActorId),
            system_message: failureMessage
          }));
          return;
        }
        await withFirmDbClient(client => revalidateNativeChatCodingContextWithClient({ client, firmId, clientId, context, actions: reply.actions }));
        const assistantMessageId = newTransactionChatMessageId({ transactionId, kind: 'assistant' });
        const evidencedActions = reply.actions.map((action, actionIndex) => {
          // Never preserve a provider-authored authority field, including outside FI.
          const { coding_evidence: ignored, ...proposal } = action;
          return chatCodingEvidence && ['apply_category', 'recode_decided'].includes(action.type)
            ? { ...proposal, coding_evidence: { ...chatCodingEvidence.receipt,
              message_id: assistantMessageId, action_index: actionIndex } } : proposal;
        });
        const assistantMessage = await appendTransactionChatMessageInDb({
          firmId,
          clientId,
          transactionId,
          id: assistantMessageId,
          role: 'assistant',
          content: reply.text,
          // Persist the triage receipt (operator-loop Phase 1) next to the
          // proposed actions — the assistant message records WHY the turn
          // was handled the way it was, validated against the contract.
          // Slice I: the playbook stamp is the mint-time RECORD of what the
          // prompt saw (injected) or would have seen (matched, observe-only)
          // — the receipt side renders it, never re-derives (an empty stamp
          // is never written, so absence means "no playbook in play").
          payload: {
            actions: evidencedActions,
            ...(reply.triage ? { triage: reply.triage } : {}),
            ...(playbooksForPrompt.length
              ? { playbooks_injected: playbooksForPrompt.map((playbook) => playbook.id) }
              : (playbooksMatchedIds.length ? { playbooks_matched: playbooksMatchedIds } : {}))
          },
          model: reply.model,
          actorType: 'llm'
        });
        res.statusCode = 201;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          user_message: projectChatMessageForViewer(userMessageRow, viewerActorId),
          assistant_message: assistantMessage,
          appliable_action_types: TRANSACTION_CHAT_ALL_APPLIABLE_ACTION_TYPES
        }));
      } catch (error) {
        const status = error?.statusCode || 500;
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          error: error?.message || 'Unknown error',
          ...(error?.code ? { code: error.code } : {})
        }));
      }
      return;
    }

    // POST /transaction-chat/messages/:messageId/actions/:index/apply
    const txChatApplyMatch = requestUrl.pathname.match(/^\/transaction-chat\/messages\/([^/]+)\/actions\/(\d+)\/apply$/);
    if (txChatApplyMatch && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const messageId = decodeURIComponent(txChatApplyMatch[1]);
      const actionIndex = Number(txChatApplyMatch[2]);
      const body = await readBody();
      const firmId = body?.firm_id || DEFAULT_FIRM_ID;
      const clientId = body?.client_id || '';
      const transactionId = body?.transaction_id || '';
      if (!clientId || !transactionId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id and transaction_id are required.' }));
        return;
      }
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      try {
        const message = await getTransactionChatMessageFromDb({
          firmId,
          clientId,
          transactionId,
          messageId
        });
        // Pod-safety #4 — the ONE compile→authorize spine for every chat apply
        // route (chatApplySpine.gateChatApplyAction): action resolution from the
        // PERSISTED message, idempotent replay, status + type gates, the #3
        // capability gate, and actor attribution. This is the pod surface —
        // sub-founder collaborators are blocked from sync_to_accounting /
        // remember_* / recode_decided here once OPERATOR_CAPABILITY_ENFORCE is
        // staged on for the client (dormant until then).
        const gate = await gateChatApplyAction({
          surface: 'transaction_chat',
          firmId,
          clientId,
          principal: access.principal,
          message,
          actionIndex,
          appliableActionTypes: TRANSACTION_CHAT_ALL_APPLIABLE_ACTION_TYPES,
          assertCapability: assertActionCapability
        });
        if (gate.disposition === 'replay') {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            assistant_message: message,
            applied: true,
            idempotent_replay: true
          }));
          return;
        }
        if (gate.disposition !== 'proceed') {
          res.statusCode = gate.statusCode;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(gate.body));
          return;
        }
        const action = gate.action;
        // Best-effort lookups shared by all wired branches. The
        // jurisdiction is keyed into merchant_signal_rollup so SG vs
        // IE bookkeeping for the same merchant don't pool; the
        // transaction row gives us description / raw_description to
        // canonicalise into the signal's merchant_key.
        const firmRow = await queryFirmDb(
          'select jurisdiction from firms where id = $1 limit 1',
          [firmId]
        );
        const jurisdiction = firmRow.rows[0]?.jurisdiction || '';
        const txRow = await queryFirmDb(
          `select id, description, raw_description, currency, money_in, money_out,
                  payload->>'account_currency' as account_currency,
                  payload->>'proposed_account' as proposed_account,
                  payload->>'contact' as contact,
                  payload->>'account_name' as account_name
             from transactions
            where firm_id = $1 and client_id = $2 and id = $3
            limit 1`,
          [firmId, clientId, transactionId]
        );
        const transactionRecord = txRow.rows[0] || null;

        // Loops shadow (LOOPS_SHADOW, default OFF) — Slice F. A reusable Slice-C
        // snapshot loader shared by every wired apply branch's shadow hook. It is a
        // thunk, so the read only happens inside the hook's shadow gate (no latency
        // when shadow is off). riskContext now resolves `materiality_band` (per-scope
        // authority ceiling) and `first_use_account` (the client's coded-account
        // history); suspense/evidence/convergence resolve from the focus row; the
        // remaining context-dependent flags (duplicate/tax) stay honestly `unknown`.
        const loadCaseSnapshotForShadow = async () => ({
          ...(await loadShadowCaseSnapshotWithRiskContext({ firmId, clientId, transactionId })),
          // Slice I: the mint-time playbook stamp from the PERSISTED assistant
          // message (payload.playbooks_injected — no extra read; the message is
          // already loaded for the gate). Rendered onto the receipt's
          // playbooks_used by the shadow hook; null when no stamp (nothing was
          // injected for this message) keeps the receipt's bare [].
          playbooks_injected: playbookIdsFromMessagePayload(message?.payload)
        });

        const codingEvidenceAuthority = ['apply_category', 'recode_decided'].includes(action.type)
          ? { receipt: action.coding_evidence, messageId, actionIndex, actorId: gate.actorId, model: message.model }
          : null;
        if (codingEvidenceAuthority) await withFirmDbClient((client) =>
          assertChatCodingEvidence({ client, firmId, clientId, transactionId, authority: codingEvidenceAuthority }));

        const actionCodingPolicy = ['apply_category', 'mark_personal', 'recode_decided'].includes(action.type)
          ? await validateCodingPolicyForChatActionInDb({ firmId, clientId, transactionId, action })
          : null;

        // Branch on action.type as the apply matrix grows. State-correction
        // verbs (apply_category, remember_merchant, …) and the remedial
        // retry_parse branch below; all gated upstream by
        // TRANSACTION_CHAT_ALL_APPLIABLE_ACTION_TYPES.
        if (action.type === 'apply_category') {
          if (!action.account_name) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Proposed apply_category action is missing account_name.' }));
            return;
          }
          // G1d apply-time backstop: this chat has NO proposal-time
          // sanitizer, so a teaching-claiming correction_scope (or an
          // unenforceable time bound) must read a refusal HERE — a
          // correction can never carry a scope its receipt would have to
          // lie about. The refusal text names the right verb.
          const correctionRefusal = validateCorrectionFieldsForApply(action);
          if (correctionRefusal) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: correctionRefusal, action_type: action.type }));
            return;
          }
          // Find the review item for this transaction. The bank-feed
          // workflow PATCHes a transaction_review_queue row to flip
          // it to 'accepted' with the chosen coding; mirror that
          // path here so the chat Apply is semantically identical
          // to clicking Apply in the row.
          const reviewLookup = await queryFirmDb(
            `select id from transaction_review_queue
              where firm_id = $1 and client_id = $2
                and (payload->>'transaction_id' = $3 or item_id = $3)
              order by updated_at desc nulls last
              limit 1`,
            [firmId, clientId, transactionId]
          );
          let reviewItemId = reviewLookup.rows[0]?.id;
          if (!reviewItemId) {
            // Bare line (confidently coded, never queued by intel) — mint the
            // case-file row so the existing writer can proceed; null means the
            // transaction itself is unknown for this client.
            reviewItemId = await ensureTransactionReviewItemInDb({
              firmId, clientId, transactionId, source: 'transaction_chat_apply'
            });
          }
          if (!reviewItemId) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'No transaction found for this id.' }));
            return;
          }
          let resolvedAccountCode = action.account_code || null;
          if (!resolvedAccountCode) {
            resolvedAccountCode = (await findLedgerAccountByNameOrAlias({
              query: queryFirmDb, firmId, clientId, name: action.account_name
            }))?.code || null;
          }
          // G1d (build-spec PR-11): the patch is the pure builder — it
          // NEVER sets learn_rule, so an ordinary chat correction mints no
          // client rule (durable teaching is the explicit remember_merchant
          // verb, one Apply click per consequence). The unconditional
          // `learn_rule = true` that used to live here was the tree's one
          // unchosen teaching path from a chat correction.
          const codingPatch = buildApplyCategoryCodingPatch({ action, accountCode: resolvedAccountCode });
          // Pod-safety gap #1: the spine attributed the operator who applied this
          // coding, so the review audit + the human-outcome receipt record who
          // acted, not a bare 'system'.
          const actorId = gate.actorId;
          // Pod-safety #4 (writer-dispatch leg) — the spine executor owns the
          // writer-error → HTTP mapping and the applied-status stamp; the writer
          // call, the post step, and the result shape stay verbatim.
          const exec = await executeChatApplyAction({
            action,
            fallbackErrorMessage: 'Apply failed.',
            execute: async () => {
              // Pod-safety #2: the writer captures the before/after of the fields it
              // mutates (race-free, inside its own transaction) so the shadow receipt
              // records what a reverse would restore.
              let writerBeforeAfter = null;
              const writerResult = await updateTransactionReviewItemInDb({
                firmId,
                reviewItemId,
                patch: { ...codingPatch, ...(action.coding_evidence ? { proposed_account: action.account_name, tax_treatment: action.tax_treatment } : {}), coding_policy: actionCodingPolicy, require_coding_policy: true, ...(action.native_choice ? { native_choice: action.native_choice, native_source: action.native_source_by_transaction?.[transactionId], account_id: action.account_id, account_code: action.account_code, proposed_account: action.account_name, tax_treatment: action.tax_treatment } : {}) },
                actorId,
                codingEvidenceAuthority,
                ...(action.native_choice ? { nativeCodingAuthority: { surface: 'transaction_chat', messageId, actionIndex, memberId: (await resolveDesktopClientCreationPrincipal({ firmId, principal: access.principal })).principalId } } : {}),
                captureBeforeState: true
              });
              const writerSnapshot = writerResult?.snapshot || null;
              if (writerResult?.before_state && writerResult?.after_state) {
                writerBeforeAfter = [{
                  target: String(transactionId),
                  before: writerResult.before_state,
                  after: writerResult.after_state
                }];
              }
              // "Categorise & post" runs the SAME post step row-Apply runs
              // (a pilot-client receipt: the chat apply categorised but never
              // posted, so the line stayed on the unreconciled list with a
              // live AI button next to an already-decided row). Donna-ledger
              // clients post to the local ledger; connector clients run the
              // adapter writeback. Best-effort: a posting failure rides the
              // action result as a warning — the accept itself stands, same
              // contract as the feed's error chip.
              let postingOutcome = null;
              let postedSnapshot = null;
              try {
                const accountingSystem = String((await getClientAccountingSystemFromDb({ firmId, clientId })) || 'none');
                const scope = await readRetainedProcessingScopeInDb({ firmId,clientId });
                if (!scope.allowed) {
                  postingOutcome = { step:'review_saved',status:'unavailable',reason:scope.reason_code,accounting_ready:false };
                } else if (accountingSystem === 'none') {
                  const posted = await postLedgerTransactionInDb({ firmId, clientId, transactionId, dryRun: false, actorId: gate.actorId });
                  postedSnapshot = posted?.snapshot || null;
                  postingOutcome = { step: 'ledger_post', status: posted?.ledger_posting?.status || 'posted' };
                } else {
                  const adapter = getAccountingSystemAdapter(accountingSystem);
                  const written = await adapter.writebackTransaction({ firmId, clientId, transactionId, dryRun: false });
                  postedSnapshot = written?.snapshot || null;
                  postingOutcome = { step: 'writeback', status: written?.xero_writeback?.status || 'synced' };
                }
              } catch (postError) {
                console.warn('[transactionChat] apply_category post step failed (the accept stands)', postError);
                postingOutcome = { step: 'post', status: 'error', error: postError?.message || 'Posting failed.' };
              }
              return {
                result: {
                  review_item_id: reviewItemId,
                  account_name: action.account_name,
                  account_code: resolvedAccountCode,
                  posting: postingOutcome,
                  // The correction≠teaching receipt (G1d): what this
                  // correction did NOT teach, knowable at writer time —
                  // the patch above mints no rule, no memory, and (since
                  // §7.6's dated call, 2026-08-14) no cross-firm signal:
                  // this surface's post-stamp apply_category signal write
                  // is deleted, so the full negative is provable here and
                  // the receipt matches the feed's word for word.
                  teaching: buildCorrectionTeachingReceipt({
                    action,
                    changedCount: 1,
                    // W1 (S04/L3): from the writer's COMMITTED learning, never intent.
                    committed: writerResult?.learning || null
                  })
                },
                writerSnapshot,
                writerBeforeAfter,
                postingOutcome,
                postedSnapshot
              };
            },
            stamp: {
              write: updateTransactionChatActionStatusInDb,
              scope: { firmId, clientId, transactionId, messageId, actionIndex }
            }
          });
          if (exec.disposition !== 'applied') {
            res.statusCode = exec.statusCode;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(exec.body));
            return;
          }
          const { writerSnapshot, writerBeforeAfter, postingOutcome, postedSnapshot } = exec.executed;
          const updatedMessage = exec.updatedMessage;
          // No cross-client signal capture here — §7.6's dated call
          // (Kari, 2026-08-14): an ordinary apply_category correction
          // contributes NO cross-firm merchant signal. The only signal
          // mint is remember_merchant's, atomic with its rule mint below;
          // the writer additionally refuses the retired 'apply_category'
          // kind fail-closed (SIGNAL_KIND_WEIGHT), so nothing stale can
          // re-arm this path. The teaching receipt built inside the
          // writer transaction states the full negative — no separate
          // response-side signal receipt exists anymore.
          // Loops shadow (LOOPS_SHADOW, default OFF) — Slice F. Mirror the applied
          // coding as the durable Operator-Contract triple (proposal card + check
          // report + apply receipt). Own transaction, post-commit, no-throw — can
          // never affect this response. The remaining transaction-chat verbs share
          // this hook and are wired in the named fast-follow.
          await onTransactionChatActionApplied({
            firmId,
            clientId,
            transactionId,
            action,
            actionIndex,
            messageId,
            model: message?.model || null,
            promptVersion: message?.model_version || null,
            beforeAfter: writerBeforeAfter,
            loadCaseSnapshot: loadCaseSnapshotForShadow,
            withClient: withFirmDbClient
          });
          res.statusCode = 201;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            assistant_message: updatedMessage,
            applied: true,
            // The post step's snapshot is newer than the writer's when
            // posting succeeded — ship the freshest state to the FE.
            snapshot: filterFirmSnapshotForAccess(postedSnapshot || writerSnapshot, access),
            posting: postingOutcome,
            teaching: exec.executed.result?.teaching
          }));
          return;
        }
        if (action.type === 'remember_merchant') {
          if (!action.account_name) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Proposed remember_merchant action is missing account_name.' }));
            return;
          }
          if (!transactionRecord) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Transaction not found for this firm/client.' }));
            return;
          }
          // Build the payload shape saveMerchantRuleForPayload expects.
          // The function reads merchant_pattern + description from this
          // payload and runs canonicalMerchantPattern internally; we
          // pass the action's explicit pattern when present and the
          // transaction's description as a fallback so the canonical
          // key matches what the signal writer will derive.
          const writerPayload = {
            merchant_pattern: action.merchant_pattern || transactionRecord.description || '',
            description: transactionRecord.description || '',
            raw_description: transactionRecord.raw_description || '',
            account_code: action.account_code || action.account_name,
            proposed_account: action.account_name,
            account_name: action.account_name,
            account_label: action.account_name,
            xero_tax_type: action.tax_treatment || null,
            tax_treatment: action.tax_treatment || null,
            contact: action.contact_name || null
          };
          // Pod-safety #4 (writer-dispatch leg) — the spine executor owns the
          // writer-error → HTTP mapping and the applied-status stamp; the
          // unusable-pattern skip is a verb-owned `respond` terminal (the
          // action stays proposed, no stamp).
          const exec = await executeChatApplyAction({
            action,
            fallbackErrorMessage: 'Apply failed.',
            execute: async () => {
              // Rule + signal in one DB transaction so a half-applied
              // state is impossible. If either INSERT fails, neither
              // commits and the chat action stays `proposed`.
              const txn = await withFirmDbClient(async (client) => {
                await client.query('begin');
                try {
                  // Pod-safety #1 + the #4 audit half: the writer now emits the
                  // mint's audit row inside THIS transaction (audit-as-
                  // precondition — a failed audit rolls the rule back), with the
                  // spine-attributed operator on it.
                  const rule = await saveMerchantRuleForPayload({
                    client,
                    firmId,
                    clientId,
                    transactionId,
                    payload: writerPayload,
                    supportNote: action.reason || '',
                    source: 'chat_remember_merchant',
                    actorId: gate.actorId
                  });
                  // G−1(d) posture split, stated on purpose: this signal
                  // stays ATOMIC with the rule mint (a signal/audit failure
                  // rolls the rule back) — the "never fails the apply"
                  // clause is apply_category's alone. The writer's audit
                  // row rides THIS transaction (audit-as-precondition).
                  const signal = await recordMerchantSignalInDb({
                    client,
                    firmId,
                    clientId,
                    transactionId,
                    chatMessageId: messageId,
                    actionIndex,
                    action,
                    transaction: transactionRecord,
                    signalKind: 'remember_merchant',
                    jurisdiction,
                    actorId: gate.actorId
                  });
                  await client.query('commit');
                  return { rule, signal };
                } catch (err) {
                  await client.query('rollback');
                  throw err;
                }
              });
              const ruleResult = txn.rule;
              // saveMerchantRuleForPayload returns null when the canonical
              // pattern is empty or the account is missing. Surface that
              // as `applied: false, skipped_reason` rather than a 5xx —
              // the firm doesn't need to retry, and the chat action
              // stays proposed so they can edit the proposal.
              if (!ruleResult) {
                return {
                  respond: {
                    statusCode: 200,
                    body: {
                      applied: false,
                      skipped_reason: 'merchant_pattern_unusable',
                      action_type: action.type
                    }
                  }
                };
              }
              return {
                result: {
                  rule_id: ruleResult.ruleId,
                  merchant_pattern: ruleResult.rulePayload?.merchant_pattern || null,
                  account_name: action.account_name,
                  account_code: action.account_code || null,
                  cascade: ruleResult.cascadeResult || null
                },
                ruleResult,
                signalOutcome: txn.signal
              };
            },
            stamp: {
              write: updateTransactionChatActionStatusInDb,
              scope: { firmId, clientId, transactionId, messageId, actionIndex }
            }
          });
          if (exec.disposition !== 'applied') {
            res.statusCode = exec.statusCode;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(exec.body));
            return;
          }
          const { ruleResult, signalOutcome } = exec.executed;
          const updatedMessage = exec.updatedMessage;
          // Loops shadow (Slice F) — durable Operator-Contract triple; no-throw, gated.
          await onTransactionChatActionApplied({
            firmId, clientId, transactionId, action, actionIndex, messageId,
            model: message?.model || null, promptVersion: message?.model_version || null,
            loadCaseSnapshot: loadCaseSnapshotForShadow, withClient: withFirmDbClient
          });
          res.statusCode = 201;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            assistant_message: updatedMessage,
            applied: true,
            rule_id: ruleResult.ruleId,
            merchant_signal: signalOutcome
          }));
          return;
        }
        if (action.type === 'ask_client') {
          if (!action.question) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Proposed ask_client action is missing question.' }));
            return;
          }
          if (['receipt', 'supporting_document'].includes(String(action.evidence_type || ''))) {
            const collisionGroup = await withFirmDbClient((dbClient) =>
              fetchTransactionChatCollisionGroup({
                client: dbClient,
                firmId,
                clientId,
                transactionId
              }));
            if (collisionGroup?.available_evidence_for_focused_transaction === true) {
              res.statusCode = 409;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({
                error: 'A plausible document is already available locally. Review or reconcile the local evidence before asking the client.',
                action_type: action.type,
                local_document_ids: (collisionGroup.documents || []).map((doc) => doc.id)
              }));
              return;
            }
          }
          const actorId = gate.actorId;
          // Pod-safety #4 (writer-dispatch leg) — the spine executor owns the
          // writer-error → HTTP mapping and the applied-status stamp; the writer
          // call, case-file mirror, and result shape stay verbatim.
          const exec = await executeChatApplyAction({
            action,
            fallbackErrorMessage: 'Ask client failed.',
            execute: async () => {
              const evidenceResult = await createClientEvidenceRequestInDb({
                firmId,
                clientId,
                transactionId,
                question: action.question,
                evidenceType: action.evidence_type || 'business_purpose',
                actorId
              });
              const evidenceRequest = evidenceResult.evidence_request || null;
              await appendTransactionChatMessageInDb({
                firmId,
                clientId,
                transactionId,
                id: newTransactionChatMessageId({ transactionId, kind: 'user' }),
                role: 'user',
                content: action.question,
                payload: {
                  kind: 'client_question_sent',
                  evidence_request_id: evidenceRequest?.id || null,
                  evidence_type: action.evidence_type || 'business_purpose'
                },
                actorType: 'firm'
              });
              return {
                result: {
                  evidence_request_id: evidenceRequest?.id || null
                },
                evidenceResult,
                evidenceRequest
              };
            },
            stamp: {
              write: updateTransactionChatActionStatusInDb,
              scope: { firmId, clientId, transactionId, messageId, actionIndex }
            }
          });
          if (exec.disposition !== 'applied') {
            res.statusCode = exec.statusCode;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(exec.body));
            return;
          }
          const { evidenceResult, evidenceRequest } = exec.executed;
          // Loops shadow (Slice F) — durable Operator-Contract triple; no-throw, gated.
          await onTransactionChatActionApplied({
            firmId, clientId, transactionId, action, actionIndex, messageId,
            model: message?.model || null, promptVersion: message?.model_version || null,
            loadCaseSnapshot: loadCaseSnapshotForShadow, withClient: withFirmDbClient
          });
          res.statusCode = 201;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            assistant_message: exec.updatedMessage,
            applied: true,
            evidence_request: evidenceRequest,
            snapshot: filterFirmSnapshotForAccess(evidenceResult.snapshot, access)
          }));
          return;
        }
        if (action.type === 'cancel_ask' || action.type === 'amend_ask' || action.type === 'resend_ask') {
          if (!action.ask_id) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: `Proposed ${action.type} action is missing ask_id.` }));
            return;
          }
          if (action.type === 'amend_ask' && !action.amendment_text) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Proposed amend_ask action is missing amendment_text.' }));
            return;
          }
          const actorId = gate.actorId;
          const isCancel = action.type === 'cancel_ask';
          const isAmend = action.type === 'amend_ask';
          // Pod-safety #4 — the spine executor owns the writer-error → HTTP
          // mapping and the applied-status stamp. Both verbs route to the
          // ask-pipeline writers (INV-1) with THIS transaction as the anchor
          // scope: the per-case chat has no proposal-time sanitizer, so an ask
          // id from a sibling line must read as not-found at the writer.
          const exec = await executeChatApplyAction({
            action,
            fallbackErrorMessage: isCancel ? 'Cancel ask failed.' : (isAmend ? 'Amend ask failed.' : 'Resend ask failed.'),
            execute: async () => {
              const outcome = isCancel
                ? await cancelClientEvidenceRequestInDb({
                    firmId,
                    clientId,
                    transactionId,
                    evidenceRequestId: String(action.ask_id),
                    reason: action.reason || '',
                    actorId
                  })
                : isAmend
                  ? await amendClientEvidenceRequestInDb({
                      firmId,
                      clientId,
                      transactionId,
                      evidenceRequestId: String(action.ask_id),
                      amendmentText: String(action.amendment_text),
                      reason: action.reason || '',
                      actorId
                    })
                  : await resendClientEvidenceRequestInDb({
                      firmId,
                      clientId,
                      transactionId,
                      evidenceRequestId: String(action.ask_id),
                      reason: action.reason || '',
                      actorId
                    });
              return { result: outcome, outcome };
            },
            stamp: {
              write: updateTransactionChatActionStatusInDb,
              scope: { firmId, clientId, transactionId, messageId, actionIndex }
            }
          });
          if (exec.disposition !== 'applied') {
            res.statusCode = exec.statusCode;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(exec.body));
            return;
          }
          const { outcome } = exec.executed;
          // A writer-reported skip (already answered / already closed / never
          // sent) is NOT an apply. 200 + skipped_reason so the action stays
          // proposed and the firm sees why, rather than a green tick over a
          // no-op — the same posture the feed's memory verbs take.
          const didAct = isCancel
            ? outcome.cancelled
            : (isAmend ? outcome.amended : (outcome.resent && outcome.delivered));
          if (!didAct) {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              applied: false,
              action_type: action.type,
              skipped_reason: outcome.skipped_reason
                || (isCancel ? 'not_cancellable' : (isAmend ? 'not_amendable' : 'no_channel_delivered')),
              status: outcome.status || null,
              ...(isCancel || isAmend ? {} : { delivered: Boolean(outcome.delivered) })
            }));
            return;
          }
          // Loops shadow (Slice F) — durable Operator-Contract triple; no-throw, gated.
          await onTransactionChatActionApplied({
            firmId, clientId, transactionId, action, actionIndex, messageId,
            model: message?.model || null, promptVersion: message?.model_version || null,
            loadCaseSnapshot: loadCaseSnapshotForShadow, withClient: withFirmDbClient
          });
          res.statusCode = 201;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            assistant_message: exec.updatedMessage,
            applied: true,
            action_type: action.type,
            evidence_request_id: outcome.evidence_request_id,
            status: outcome.status,
            ...(isCancel
              // The two-terminal-states consequence, on the response as well as
              // the audit: cancelling took the line off the owner without
              // auto-reconciling it.
              ? { prior_status: outcome.prior_status, leaves_line_hanging: outcome.leaves_line_hanging ?? null }
              : isAmend
                // The no-silent-edit receipt: the original is preserved in the
                // composite (and in the audit's prior_question); the response
                // shows both so the firm sees exactly what the owner will.
                ? { question: outcome.question, prior_question: outcome.prior_question, amendment_count: outcome.amendment_count }
                : { delivered: outcome.delivered, send_count: outcome.send_count, channel_fanout: outcome.channel_fanout })
          }));
          return;
        }
        if (action.type === 'mark_personal') {
          if (!action.note && !action.reason) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'mark_personal requires a note or reason.' }));
            return;
          }
          // G1d apply-time backstop — same rail as apply_category above.
          const correctionRefusal = validateCorrectionFieldsForApply(action);
          if (correctionRefusal) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: correctionRefusal, action_type: action.type }));
            return;
          }
          const reviewLookup = await queryFirmDb(
            `select id from transaction_review_queue
              where firm_id = $1 and client_id = $2
                and (payload->>'transaction_id' = $3 or item_id = $3)
              order by updated_at desc nulls last
              limit 1`,
            [firmId, clientId, transactionId]
          );
          let reviewItemId = reviewLookup.rows[0]?.id;
          if (!reviewItemId) {
            // Bare line — mint the case-file row (see apply_category above).
            reviewItemId = await ensureTransactionReviewItemInDb({
              firmId, clientId, transactionId, source: 'transaction_chat_apply'
            });
          }
          if (!reviewItemId) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'No transaction found for this id.' }));
            return;
          }
          const personalAccount = action.account_name;
          const personalAccountCode = (await findLedgerAccountByNameOrAlias({
            query: queryFirmDb, firmId, clientId, name: personalAccount
          }))?.code || null;
          const codingPatch = {
            status: 'accepted',
            review_state: 'accepted',
            category: personalAccount,
            account_name: personalAccount,
            account_label: personalAccount,
            reviewer_note: action.note || action.reason || 'Marked as personal expense.',
            is_personal: true
          };
          if (personalAccountCode) {
            codingPatch.account_code = personalAccountCode;
            codingPatch.xero_account_code = personalAccountCode;
          }
          // Pod-safety #4 (writer-dispatch leg) — the spine executor owns the
          // writer-error → HTTP mapping and the applied-status stamp; the writer
          // call and result shape stay verbatim.
          const exec = await executeChatApplyAction({
            action,
            fallbackErrorMessage: 'Mark personal failed.',
            execute: async () => {
              // Pod-safety #1 + #2: spine-attributed operator + capture before/after.
              const actorId = gate.actorId;
              const writerResult = await updateTransactionReviewItemInDb({
                firmId,
                reviewItemId,
                patch: { ...codingPatch, coding_policy: actionCodingPolicy, require_coding_policy: true },
                actorId,
                captureBeforeState: true
              });
              return {
                result: {
                  review_item_id: reviewItemId,
                  account_name: personalAccount,
                  account_code: personalAccountCode,
                  is_personal: true,
                  // G1d: mark_personal mints nothing and never had a
                  // signal path — the receipt states the full negative.
                  teaching: buildCorrectionTeachingReceipt({ action, changedCount: 1 })
                },
                writerSnapshot: writerResult?.snapshot || null,
                writerBeforeAfter: writerResult?.before_state && writerResult?.after_state
                  ? [{ target: String(transactionId), before: writerResult.before_state, after: writerResult.after_state }]
                  : null
              };
            },
            stamp: {
              write: updateTransactionChatActionStatusInDb,
              scope: { firmId, clientId, transactionId, messageId, actionIndex }
            }
          });
          if (exec.disposition !== 'applied') {
            res.statusCode = exec.statusCode;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(exec.body));
            return;
          }
          // Loops shadow (Slice F) — durable Operator-Contract triple; no-throw, gated.
          await onTransactionChatActionApplied({
            firmId, clientId, transactionId, action, actionIndex, messageId,
            model: message?.model || null, promptVersion: message?.model_version || null,
            beforeAfter: exec.executed.writerBeforeAfter,
            loadCaseSnapshot: loadCaseSnapshotForShadow, withClient: withFirmDbClient
          });
          res.statusCode = 201;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            assistant_message: exec.updatedMessage,
            applied: true,
            snapshot: filterFirmSnapshotForAccess(exec.executed.writerSnapshot, access)
          }));
          return;
        }
        if (action.type === 'resolve_match_group') {
          const proposedPairs = Array.isArray(action.match_pairs) ? action.match_pairs : [];
          if (proposedPairs.length < 2) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'resolve_match_group requires at least two match_pairs.' }));
            return;
          }
          // Re-read the entire group at Apply. The model cannot license its own
          // scope, and a proposal that went stale must fail as a unit rather
          // than confirm only whichever pair still happens to be valid.
          const collisionGroup = await withFirmDbClient((dbClient) =>
            fetchTransactionChatCollisionGroup({
              client: dbClient,
              firmId,
              clientId,
              transactionId
            }));
          const expectedPairs = collisionGroup?.complete_date_pairing
            ? (collisionGroup.suggested_date_pairs || [])
            : [];
          const expectedKeys = expectedPairs
            .map((pair) => `${pair.transaction_id}|${pair.document_id}`)
            .sort();
          const proposedKeys = proposedPairs
            .map((pair) => `${pair?.transaction_id || ''}|${pair?.document_id || ''}`)
            .sort();
          if (expectedKeys.length < 2
              || proposedKeys.length !== expectedKeys.length
              || new Set(proposedKeys).size !== proposedKeys.length
              || proposedKeys.some((key, index) => key !== expectedKeys[index])) {
            res.statusCode = 409;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              error: 'The collision group changed after this proposal. Refresh Donna before applying.',
              action_type: action.type,
              expected_pairs: expectedPairs
            }));
            return;
          }
          const exec = await executeChatApplyAction({
            action,
            fallbackErrorMessage: 'Pair and reconcile group failed.',
            execute: async () => {
              const groupResult = await createManualReconciliationMatchInDb({
                firmId,
                clientId,
                pairings: proposedPairs,
                actorId: gate.actorId,
                captureBeforeState: true,
                reviewerNote: action.reason || 'Paired a date-aligned collision group via transaction chat.'
              });
              return {
                result: {
                  pairings: groupResult.results.map((result) => ({
                    transaction_id: result.transaction_id,
                    document_id: result.document_id,
                    match_id: result.matchId
                  })),
                  retired_match_ids: groupResult.retiredMatches.map((match) => match.id),
                  reconciled_count: groupResult.results.length
                },
                groupResult
              };
            },
            stamp: {
              write: updateTransactionChatActionStatusInDb,
              scope: { firmId, clientId, transactionId, messageId, actionIndex }
            }
          });
          if (exec.disposition !== 'applied') {
            res.statusCode = exec.statusCode;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(exec.body));
            return;
          }
          const { groupResult } = exec.executed;
          await onTransactionChatActionApplied({
            firmId, clientId, transactionId, action, actionIndex, messageId,
            model: message?.model || null, promptVersion: message?.model_version || null,
            beforeAfter: groupResult.before_after,
            loadCaseSnapshot: loadCaseSnapshotForShadow, withClient: withFirmDbClient
          });
          res.statusCode = 201;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            assistant_message: exec.updatedMessage,
            applied: true,
            pairings: groupResult.results.map((result) => ({
              transaction_id: result.transaction_id,
              document_id: result.document_id,
              match_id: result.matchId
            })),
            retired_match_ids: groupResult.retiredMatches.map((match) => match.id),
            snapshot: groupResult.snapshot
              ? filterFirmSnapshotForAccess(groupResult.snapshot, access)
              : undefined
          }));
          return;
        }
        if (action.type === 'link_document') {
          if (!action.document_id) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'link_document requires a document_id.' }));
            return;
          }
          // Pod-safety gap #1: the spine attributed the operator.
          const actorId = gate.actorId;
          // Pod-safety #4 (writer-dispatch leg) — the spine executor owns the
          // writer-error → HTTP mapping and the applied-status stamp; the writer
          // call and result shape stay verbatim.
          const exec = await executeChatApplyAction({
            action,
            fallbackErrorMessage: 'Link document failed.',
            execute: async () => {
              // Pod-safety #2: capture the before/after of the fields the link mutates.
              const matchResult = await createManualReconciliationMatchInDb({
                firmId,
                clientId,
                documentId: action.document_id,
                bankTransactionId: transactionId,
                actorId,
                captureBeforeState: true,
                reviewerNote: action.reason || 'Linked via transaction chat.'
              });
              // The consequence rides the result (from the writer's own
              // race-free capture, never asserted client-side): the manual
              // link CONFIRMS the match and reconciles the line in one
              // transaction — the receipt must say so.
              return {
                result: {
                  match_id: matchResult?.matchId || null,
                  document_id: action.document_id,
                  match_status: matchResult?.after_state?.match_status || null,
                  from_status: matchResult?.before_state?.match_status ?? null,
                  reconciliation_status: matchResult?.after_state?.transaction?.reconciliation_status || null
                },
                matchResult
              };
            },
            stamp: {
              write: updateTransactionChatActionStatusInDb,
              scope: { firmId, clientId, transactionId, messageId, actionIndex }
            }
          });
          if (exec.disposition !== 'applied') {
            res.statusCode = exec.statusCode;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(exec.body));
            return;
          }
          const { matchResult } = exec.executed;
          // Loops shadow (Slice F) — durable Operator-Contract triple; no-throw, gated.
          await onTransactionChatActionApplied({
            firmId, clientId, transactionId, action, actionIndex, messageId,
            model: message?.model || null, promptVersion: message?.model_version || null,
            beforeAfter: matchResult?.before_state && matchResult?.after_state
              ? [{ target: String(transactionId), before: matchResult.before_state, after: matchResult.after_state }]
              : null,
            loadCaseSnapshot: loadCaseSnapshotForShadow, withClient: withFirmDbClient
          });
          res.statusCode = 201;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            assistant_message: exec.updatedMessage,
            applied: true,
            match_id: matchResult?.matchId || null,
            snapshot: matchResult?.snapshot
              ? filterFirmSnapshotForAccess(matchResult.snapshot, access)
              : undefined
          }));
          return;
        }
        if (action.type === 'leave_review_note') {
          if (!action.note) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'leave_review_note requires a note.' }));
            return;
          }
          const reviewLookup = await queryFirmDb(
            `select id from transaction_review_queue
              where firm_id = $1 and client_id = $2
                and (payload->>'transaction_id' = $3 or item_id = $3)
              order by updated_at desc nulls last
              limit 1`,
            [firmId, clientId, transactionId]
          );
          // NO bare-line mint for notes (unlike apply_category/mark_personal
          // above): a note is commentary, not a decision — minting an OPEN
          // 'suggested' row from it would manufacture a hanging queue row.
          const reviewItemId = reviewLookup.rows[0]?.id;
          if (!reviewItemId) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'No review item found for this transaction.' }));
            return;
          }
          // Pod-safety #4 (writer-dispatch leg) — the spine executor owns the
          // writer-error → HTTP mapping and the applied-status stamp; the note
          // write + its precondition audit stay verbatim inside the thunk.
          const exec = await executeChatApplyAction({
            action,
            fallbackErrorMessage: 'Leave review note failed.',
            execute: async () => {
              await queryFirmDb(
                `update transaction_review_queue
                 set payload = payload || $3::jsonb,
                     updated_at = now()
                 where firm_id = $1 and id = $2`,
                [firmId, reviewItemId, JSON.stringify({
                  reviewer_note: action.note,
                  ...(action.follow_up_at ? { follow_up_at: action.follow_up_at } : {})
                })]
              );
              // #4 audit half: the spine emitter, with the operator attributed
              // (this row shipped actor-LESS pre-spine). bestEffort: false keeps
              // this site's existing semantics — an audit failure fails the
              // request via the executor's refusal mapping, same as before.
              await auditChatApplyEvent({
                query: queryFirmDb,
                firmId,
                clientId,
                actorId: gate.actorId,
                action: 'review.note_added',
                resourceType: 'transaction_review',
                resourceId: reviewItemId,
                metadata: {
                  note: action.note,
                  follow_up_at: action.follow_up_at || null
                },
                bestEffort: false
              });
              return {
                result: {
                  review_item_id: reviewItemId,
                  note: action.note,
                  follow_up_at: action.follow_up_at || null
                }
              };
            },
            stamp: {
              write: updateTransactionChatActionStatusInDb,
              scope: { firmId, clientId, transactionId, messageId, actionIndex }
            }
          });
          if (exec.disposition !== 'applied') {
            res.statusCode = exec.statusCode;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(exec.body));
            return;
          }
          // Loops shadow (Slice F) — durable Operator-Contract triple; no-throw, gated.
          await onTransactionChatActionApplied({
            firmId, clientId, transactionId, action, actionIndex, messageId,
            model: message?.model || null, promptVersion: message?.model_version || null,
            loadCaseSnapshot: loadCaseSnapshotForShadow, withClient: withFirmDbClient
          });
          res.statusCode = 201;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            assistant_message: exec.updatedMessage,
            applied: true
          }));
          return;
        }
        if (action.type === 'retry_parse') {
          // Remedial verb (operator-loop Phase 2, contract INV-5): re-queue
          // the parse of THIS case's matched document. The TARGET is
          // resolved server-side from the transaction's confirmed match
          // through the SAME CaseSnapshot read model the message turn used —
          // never the model's word for its own scope (the anti-self-licensing
          // rule). The write is the EXISTING parse-requeue writer
          // (retryParseRunsInDb, INV-1), which re-verifies the document is in
          // a retryable state (failed/duplicate_pending) at write time
          // (INV-4) and audits each requeue (the "counted"). A non-retryable
          // doc is reported back, never force-run, and the action stays
          // proposed so the firm sees why.
          const snap = await getOperatorCaseSnapshot({
            firmId,
            clientId,
            focus: { type: 'transaction', id: transactionId },
            include: ['matches', 'documents', 'pipeline_state']
          }).catch(() => null);
          const matchedDocId = snap?.pipeline_state?.present ? snap.pipeline_state.document_id : null;
          if (!matchedDocId) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              error: 'No matched document for this case to retry.',
              action_type: action.type
            }));
            return;
          }
          // Pod-safety #4 (writer-dispatch leg) — the spine executor owns the
          // writer-error → HTTP mapping and the applied-status stamp; the
          // writer's not-retryable refusal is a verb-owned `respond` terminal
          // (409, the action stays proposed so the firm sees why).
          const exec = await executeChatApplyAction({
            action,
            fallbackErrorMessage: 'Retry parse failed.',
            execute: async () => {
              const retryResult = await retryParseRunsInDb({ firmId, documentIds: [matchedDocId] });
              const retried = retryResult?.retried?.[0] || null;
              if (!retried) {
                // The writer re-verified and refused (not in a retryable state,
                // or the status changed under us). Keep the action proposed and
                // surface the observed reason instead of a silent no-op.
                const skip = retryResult?.skipped?.[0] || null;
                return {
                  respond: {
                    statusCode: 409,
                    body: {
                      error: skip?.reason === 'parse_status_not_retryable'
                        ? `Document is not in a retryable parse state (parse_status=${skip?.parse_status}).`
                        : (skip?.reason || 'Document could not be retried.'),
                      action_type: action.type,
                      document_id: matchedDocId,
                      skipped: skip
                    }
                  }
                };
              }
              return {
                result: {
                  document_id: matchedDocId,
                  parse_run_id: retried.parse_run_id || null,
                  parse_status: retried.parse_status || 'pending'
                }
              };
            },
            stamp: {
              write: updateTransactionChatActionStatusInDb,
              scope: { firmId, clientId, transactionId, messageId, actionIndex }
            }
          });
          if (exec.disposition !== 'applied') {
            res.statusCode = exec.statusCode;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(exec.body));
            return;
          }
          const updatedMessage = exec.updatedMessage;
          // Loops shadow (Slice F) — durable Operator-Contract triple; no-throw, gated.
          await onTransactionChatActionApplied({
            firmId, clientId, transactionId, action, actionIndex, messageId,
            model: message?.model || null, promptVersion: message?.model_version || null,
            loadCaseSnapshot: loadCaseSnapshotForShadow, withClient: withFirmDbClient
          });
          res.statusCode = 201;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            assistant_message: updatedMessage,
            applied: true
          }));
          return;
        }
        if (action.type === 'recode_decided') {
          // Guarded verb (operator-loop Phase 2, contract INV-5): re-code a row
          // the firm has ALREADY DECIDED. apply_category is forbidden from
          // touching a decided row; recode_decided is the only door, behind TWO
          // guards that never trust the model alone:
          //   • the DOOR FLAG (action.targets_decided) — the model may set it
          //     only when the firm's words cover a decided row (prompt-enforced);
          //   • a WRITE-TIME re-verify (INV-4) — re-read the row's review_state
          //     server-side and refuse if it is NOT decided.
          // It routes to the EXISTING coding writer (updateTransactionReviewItemInDb,
          // INV-1) and PRESERVES the row's decided level (never downgrades a
          // posted row). Ledger: an unposted decided row re-posts fresh; a row
          // already posted to the ledger keeps its journal and the re-code needs
          // a reversal adjustment — surfaced as ledger_adjustment_required
          // (reversible_via_adjustment), never a silent double-post (the post
          // step has no reversal; force would double-post).
          if (!action.account_name) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Proposed recode_decided action is missing account_name.' }));
            return;
          }
          if (action.targets_decided !== true) {
            // The door is closed unless the model explicitly opened it. A
            // recode_decided without the flag is a malformed proposal, not a
            // licence to recode — refuse rather than guess.
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              error: 'recode_decided requires the decided-row door (targets_decided=true).',
              action_type: action.type
            }));
            return;
          }
          // G1d apply-time backstop — same rail as apply_category above.
          const correctionRefusal = validateCorrectionFieldsForApply(action);
          if (correctionRefusal) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: correctionRefusal, action_type: action.type }));
            return;
          }
          const reviewLookup = await queryFirmDb(
            `select id, payload from transaction_review_queue
              where firm_id = $1 and client_id = $2
                and (payload->>'transaction_id' = $3 or item_id = $3)
              order by updated_at desc nulls last
              limit 1`,
            [firmId, clientId, transactionId]
          );
          let reviewRow = reviewLookup.rows[0];
          if (!reviewRow?.id) {
            // Confident batch coding writes its verdict directly to the
            // transaction, so the decided line can legitimately have no queue
            // row. Mint that missing case file through the existing writer,
            // preserving only the transaction's persisted decided state, then
            // re-read it for the normal INV-4 write-time guard below.
            const ensuredReviewItemId = await ensureTransactionReviewItemInDb({
              firmId,
              clientId,
              transactionId,
              source: 'transaction_chat_recode_decided',
              preserveTransactionReviewState: true
            });
            if (!ensuredReviewItemId) {
              res.statusCode = 404;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'No transaction found for this id.' }));
              return;
            }
            const ensuredLookup = await queryFirmDb(
              `select id, status, payload from transaction_review_queue
                where firm_id = $1 and client_id = $2 and id = $3
                limit 1`,
              [firmId, clientId, ensuredReviewItemId]
            );
            reviewRow = ensuredLookup.rows[0];
          }
          const reviewItemId = reviewRow?.id;
          if (!reviewItemId) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Review case could not be created for this transaction.' }));
            return;
          }
          // INV-4: re-verify the row really is decided at write time. The
          // proposal flag is never trusted alone — a row that moved back to
          // review (or was never decided) is refused, pointing at apply_category.
          // RT-16: the decided state is the TRANSACTION's coding_state (the
          // case file carries none), read fresh and projected to the label
          // the close path speaks.
          const currentStateRow = await queryFirmDb(
            'select coding_state from transactions where firm_id = $1 and client_id = $2 and id = $3 limit 1',
            [firmId, clientId, transactionId]
          );
          const currentReviewState = legacyReviewStateFor(currentStateRow.rows[0]?.coding_state) || null;
          if (!DECIDED_TRANSACTION_REVIEW_STATES.includes(currentReviewState)) {
            res.statusCode = 409;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              error: `Row is not in a decided state (review_state=${currentReviewState || 'unknown'}); use apply_category to code a row still in review.`,
              action_type: action.type,
              review_state: currentReviewState
            }));
            return;
          }
          // Re-code via the existing coding writer, PRESERVING the decided
          // level so a posted row is never downgraded to 'accepted'. No
          // learn_rule: a recode must not silently mint a merchant rule.
          const codingPatch = {
            status: 'resolved',
            review_state: currentReviewState,
            category: action.account_name,
            account_name: action.account_name,
            account_label: action.account_name,
            reviewer_note: action.reason || 'Re-coded a decided row via chat.'
          };
          if (action.account_code) {
            codingPatch.account_code = action.account_code;
            codingPatch.xero_account_code = action.account_code;
          } else {
            const recodeAccount = await findLedgerAccountByNameOrAlias({
              query: queryFirmDb, firmId, clientId, name: action.account_name
            });
            if (recodeAccount) {
              codingPatch.account_code = recodeAccount.code;
              codingPatch.xero_account_code = recodeAccount.code;
            } else {
              // No ledger account answers to this name or palette alias (an
              // authored local-ledger palette, name-only until first posted).
              // Same convention as apply_category's buildApplyCategoryCodingPatch:
              // replace the old transaction code with the name so the writer's
              // coalesce cannot leave a prior account attached to the new
              // category; posting reads a code equal to the name as name-only.
              codingPatch.account_code = action.account_name;
            }
          }
          if (action.tax_treatment) {
            codingPatch.xero_tax_type = action.tax_treatment;
          }
          if (action.contact_name) {
            codingPatch.contact = action.contact_name;
          }
          // Pod-safety #4 (writer-dispatch leg) — the spine executor owns the
          // writer-error → HTTP mapping and the applied-status stamp; the writer
          // call, ledger consequence, and audit line stay verbatim in the thunk.
          const exec = await executeChatApplyAction({
            action,
            fallbackErrorMessage: 'Re-code failed.',
            execute: async () => {
              // Pod-safety #1 + #2: attribute the operator and capture before/after —
              // a re-code of a DECIDED row is exactly the write a reverse must restore.
              let writerBeforeAfter = null;
              const recodeActorId = gate.actorId;
              const writerResult = await updateTransactionReviewItemInDb({
                firmId,
                reviewItemId,
                patch: { ...codingPatch, ...(action.coding_evidence ? { proposed_account: action.account_name, tax_treatment: action.tax_treatment } : {}), coding_policy: actionCodingPolicy, require_coding_policy: true, ...(action.native_choice ? { native_choice: action.native_choice, native_source: action.native_source_by_transaction?.[transactionId], account_id: action.account_id, account_code: action.account_code, proposed_account: action.account_name, tax_treatment: action.tax_treatment } : {}) },
                actorId: recodeActorId,
                codingEvidenceAuthority,
                ...(action.native_choice ? { nativeCodingAuthority: { surface: 'transaction_chat', messageId, actionIndex, memberId: (await resolveDesktopClientCreationPrincipal({ firmId, principal: access.principal })).principalId } } : {}),
                captureBeforeState: true
              });
              const writerSnapshot = writerResult?.snapshot || null;
              if (writerResult?.before_state && writerResult?.after_state) {
                writerBeforeAfter = [{
                  target: String(transactionId),
                  before: writerResult.before_state,
                  after: writerResult.after_state
                }];
              }
              // Ledger: re-post a not-yet-posted decided row fresh; for a row
              // already posted, complete the re-code with a delta reclass
              // adjustment (attemptLedgerReclass → the existing audited
              // correction writer) — never a blind re-post. When the reclass
              // can't run unambiguously (split journal, unknown prior coding)
              // the pending state is surfaced, not silently double-posted.
              const ledgerRow = await queryFirmDb(
                `select payload->>'ledger_journal_id' as ledger_journal_id
                   from transactions where firm_id = $1 and client_id = $2 and id = $3 limit 1`,
                [firmId, clientId, transactionId]
              );
              const ledgerJournalId = ledgerRow.rows[0]?.ledger_journal_id || null;
              let postingOutcome = null;
              let postedSnapshot = null;
              let ledgerAdjustmentRequired = false;
              const scope = await readRetainedProcessingScopeInDb({ firmId,clientId });
              if (!scope.allowed) {
                postingOutcome = { step:'review_saved',status:'unavailable',reason:scope.reason_code,accounting_ready:false };
              } else if (ledgerJournalId) {
                let reclass = null;
                try {
                  reclass = await attemptLedgerReclass({
                    firmId,
                    clientId,
                    transactionId,
                    newAccount: { name: action.account_name, code: codingPatch.account_code || null },
                    previousAccountName:
                      writerResult?.prior_transaction_coding?.account_name || writerResult?.before_state?.account_name || writerResult?.before_state?.category || null,
                    reason: action.reason || `Re-coded a decided row via chat.`,
                    actorId: recodeActorId,
                    d: { queryFirmDb, postLedgerAdjustmentInDb }
                  });
                } catch (reclassError) {
                  console.warn('[transactionChat] recode_decided reclass failed (the re-code stands)', reclassError);
                  reclass = { status: 'pending', reason: reclassError?.message || 'reclass failed', original_journal_id: ledgerJournalId };
                }
                if (reclass.status === 'reclassed') {
                  postingOutcome = {
                    step: 'ledger_reclass',
                    status: 'posted',
                    original_journal_id: ledgerJournalId,
                    adjustment_journal_ids: (reclass.ledger_adjustment?.journals || []).map((j) => j.ledger_journal_id)
                  };
                } else if (reclass.status === 'noop') {
                  postingOutcome = { step: 'ledger_reclass', status: 'noop', original_journal_id: ledgerJournalId };
                } else {
                  ledgerAdjustmentRequired = true;
                  postingOutcome = {
                    step: 'ledger_adjustment_required',
                    status: 'pending',
                    reversibility: 'reversible_via_adjustment',
                    original_journal_id: ledgerJournalId,
                    ...(reclass.reason ? { reason: reclass.reason } : {})
                  };
                }
              } else {
                try {
                  const accountingSystem = String((await getClientAccountingSystemFromDb({ firmId, clientId })) || 'none');
                  if (accountingSystem === 'none') {
                    const posted = await postLedgerTransactionInDb({ firmId, clientId, transactionId, dryRun: false });
                    postedSnapshot = posted?.snapshot || null;
                    postingOutcome = { step: 'ledger_post', status: posted?.ledger_posting?.status || 'posted' };
                  } else {
                    const adapter = getAccountingSystemAdapter(accountingSystem);
                    const written = await adapter.writebackTransaction({ firmId, clientId, transactionId, dryRun: false });
                    postedSnapshot = written?.snapshot || null;
                    postingOutcome = { step: 'writeback', status: written?.xero_writeback?.status || 'synced' };
                  }
                } catch (postError) {
                  console.warn('[transactionChat] recode_decided post step failed (the re-code stands)', postError);
                  postingOutcome = { step: 'post', status: 'error', error: postError?.message || 'Posting failed.' };
                }
              }
              // The decided-row recode is the careful one — its own audit line,
              // recording the door usage and the ledger consequence. #4 audit half:
              // the spine emitter, with the operator attributed (this row shipped
              // actor-LESS pre-spine). bestEffort: false (G2 PR-12,
              // audit-as-precondition): an audit failure PROPAGATES — the recode
              // itself has committed, but the apply reports the error and the
              // action stays proposed and re-appliable instead of a warn line.
              await auditChatApplyEvent({
                query: queryFirmDb,
                firmId,
                clientId,
                actorId: gate.actorId,
                action: 'review.recode_decided',
                resourceType: 'transaction_review',
                resourceId: reviewItemId,
                metadata: {
                  from_review_state: currentReviewState,
                  account_name: action.account_name,
                  ledger_adjustment_required: ledgerAdjustmentRequired,
                  original_journal_id: ledgerJournalId,
                  // G1d: the declared correction grammar rides the audit
                  // row (null = the narrowest scope, no taxonomy match).
                  correction_scope: action.correction_scope || null,
                  reason_code: action.reason_code || null
                },
                bestEffort: false
              });
              return {
                result: {
                  review_item_id: reviewItemId,
                  account_name: action.account_name,
                  account_code: action.account_code || null,
                  from_review_state: currentReviewState,
                  posting: postingOutcome,
                  ledger_adjustment_required: ledgerAdjustmentRequired,
                  // G1d: a decided-row recode mints nothing (this block has
                  // ALWAYS refused learn_rule) and has no signal path — the
                  // receipt now says so instead of leaving it implicit.
                  teaching: buildCorrectionTeachingReceipt({ action, changedCount: 1 })
                },
                writerSnapshot,
                writerBeforeAfter,
                postingOutcome,
                postedSnapshot,
                ledgerAdjustmentRequired
              };
            },
            stamp: {
              write: updateTransactionChatActionStatusInDb,
              scope: { firmId, clientId, transactionId, messageId, actionIndex }
            }
          });
          if (exec.disposition !== 'applied') {
            res.statusCode = exec.statusCode;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(exec.body));
            return;
          }
          const {
            writerSnapshot,
            writerBeforeAfter,
            postingOutcome,
            postedSnapshot,
            ledgerAdjustmentRequired
          } = exec.executed;
          const updatedMessage = exec.updatedMessage;
          // Loops shadow (Slice F) — durable Operator-Contract triple; no-throw, gated.
          await onTransactionChatActionApplied({
            firmId, clientId, transactionId, action, actionIndex, messageId,
            model: message?.model || null, promptVersion: message?.model_version || null,
            beforeAfter: writerBeforeAfter,
            loadCaseSnapshot: loadCaseSnapshotForShadow, withClient: withFirmDbClient
          });
          res.statusCode = 201;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            assistant_message: updatedMessage,
            applied: true,
            snapshot: filterFirmSnapshotForAccess(postedSnapshot || writerSnapshot, access),
            posting: postingOutcome,
            ledger_adjustment_required: ledgerAdjustmentRequired
          }));
          return;
        }
        if (action.type === 'sync_to_accounting') {
          // Guarded verb — the single-row form of the feed-chat batch verb
          // (the "not on this surface" fix, Kari's dated call 2026-08-16):
          // POST the focused row to the ledger/accounting system.
          // apply_category's post step on its own, for a row already
          // accepted/resolved whose posting has not happened (failed earlier,
          // or deferred). INV-1: routes to the SAME writers the artifact
          // button, the feed batch, and recode_decided's post step use
          // (postLedgerTransactionInDb / adapter.writebackTransaction) —
          // never a second posting path. INV-4: POST-ACCEPTED-ONLY re-verified
          // at write time from the row's PERSISTED state — a not-decided or
          // already-synced row is refused with the reason, never force-posted.
          // The #3 capability gate already ran in gateChatApplyAction
          // (sync_to_accounting is founder-only).
          let syncPostingOutcome = null;
          let syncAccountingSystem = 'none';
          const exec = await executeChatApplyAction({
            action,
            fallbackErrorMessage: 'Posting to the ledger failed.',
            exposeErrorDetails: true,
            execute: async () => {
              // RT-16: the ONE coding state, projected to the legacy label
              // this gate speaks (the transaction status is the fallback).
              const stateRow = await queryFirmDb(
                `select coalesce(coding_state, status, '') as review_state,
                        coalesce(payload->>'xero_writeback_status', payload->>'xero_sync_status', '') as sync_status,
                        coalesce(payload->>'xero_bank_transaction_id', '') as xero_id
                   from transactions
                  where firm_id = $1 and client_id = $2 and id = $3
                  limit 1`,
                [firmId, clientId, transactionId]
              );
              const stateInfo = stateRow.rows[0];
              if (!stateInfo) {
                return {
                  respond: {
                    statusCode: 404,
                    body: { error: 'Transaction not found.', action_type: action.type }
                  }
                };
              }
              const reviewState = legacyReviewStateFor(stateInfo.review_state) || String(stateInfo.review_state || '').toLowerCase();
              const alreadySynced =
                stateInfo.sync_status === 'synced'
                || String(stateInfo.xero_id || '').length > 0
                || reviewState === 'synced'
                || reviewState === 'posted';
              if (alreadySynced) {
                return {
                  respond: {
                    statusCode: 409,
                    body: {
                      error: 'This row is already posted — nothing to sync.',
                      action_type: action.type,
                      review_state: reviewState || null
                    }
                  }
                };
              }
              if (reviewState !== 'accepted' && reviewState !== 'resolved') {
                return {
                  respond: {
                    statusCode: 409,
                    body: {
                      error: `This row is not decided yet (review_state=${reviewState || 'unknown'}) — accept it first; apply_category codes AND posts in one step.`,
                      action_type: action.type,
                      review_state: reviewState || null
                    }
                  }
                };
              }
              syncAccountingSystem = String(
                (await getClientAccountingSystemFromDb({ firmId, clientId }).catch(() => 'none')) || 'none'
              );
              if (syncAccountingSystem === 'none') {
                const posted = await postLedgerTransactionInDb({
                  firmId, clientId, transactionId, dryRun: false, actorId: gate.actorId
                });
                syncPostingOutcome = { step: 'ledger_post', status: posted?.ledger_posting?.status || 'posted' };
              } else {
                const adapter = getAccountingSystemAdapter(syncAccountingSystem);
                const written = await adapter.writebackTransaction({
                  firmId, clientId, transactionId, dryRun: false, actorId: gate.actorId
                });
                syncPostingOutcome = { step: 'writeback', status: written?.xero_writeback?.status || 'synced' };
              }
              // Chat-apply receipt, audit-as-precondition (born bestEffort:
              // false per the G2 PR-12 end-state): an audit failure
              // propagates — the apply errors and the action stays proposed
              // (a re-apply is safe: the post writer refuses a re-post and
              // the eligibility re-read reports already_synced).
              await auditChatApplyEvent({
                query: queryFirmDb,
                firmId,
                clientId,
                actorId: gate.actorId,
                action: 'transaction.sync_to_accounting',
                resourceType: 'transaction',
                resourceId: transactionId,
                metadata: {
                  accounting_system: syncAccountingSystem,
                  posting: syncPostingOutcome,
                  surface: 'transaction_chat'
                },
                bestEffort: false
              });
              return {
                result: {
                  accounting_system: syncAccountingSystem,
                  posting: syncPostingOutcome
                }
              };
            },
            stamp: {
              write: updateTransactionChatActionStatusInDb,
              scope: { firmId, clientId, transactionId, messageId, actionIndex }
            }
          });
          if (exec.disposition !== 'applied') {
            res.statusCode = exec.statusCode;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(exec.body));
            return;
          }
          const updatedMessage = exec.updatedMessage;
          // Loops shadow (Slice F) — durable Operator-Contract triple; no-throw, gated.
          await onTransactionChatActionApplied({
            firmId, clientId, transactionId, action, actionIndex, messageId,
            model: message?.model || null, promptVersion: message?.model_version || null,
            loadCaseSnapshot: loadCaseSnapshotForShadow, withClient: withFirmDbClient
          });
          res.statusCode = 201;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            assistant_message: updatedMessage,
            applied: true,
            posting: syncPostingOutcome
          }));
          return;
        }
        if (action.type === 'reject_match') {
          // State-correction verb (operator-loop Phase 2): reject the CURRENT
          // active reconciliation match for this case. The TARGET match is
          // resolved server-side from persisted state (anti-self-licensing —
          // never the model's word for its own scope), re-verified to be in an
          // active/rejectable status (the status filter + not-found refusal),
          // and rejected via the EXISTING reconciliation-match writer
          // (updateReconciliationMatchInDb, INV-1) — the same writer the FE's
          // match PATCH uses, so a chat reject is semantically identical.
          const matchLookup = await queryFirmDb(
            `select id, status, matched_object_id
               from reconciliation_matches
              where firm_id = $1 and bank_transaction_id = $2
                and status in ('confirmed', 'auto_matched', 'suggested')
              order by case status
                         when 'confirmed' then 1
                         when 'auto_matched' then 2
                         when 'suggested' then 3
                       end
              limit 1`,
            [firmId, transactionId]
          );
          const activeMatch = matchLookup.rows[0];
          if (!activeMatch) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              error: 'No active reconciliation match to reject for this case.',
              action_type: action.type
            }));
            return;
          }
          // Optional doc-id guard: when the firm named the document being
          // unlinked, re-verify it is STILL the active match before rejecting,
          // so a stale proposal can't reject a different (newer) match. The
          // resolved object id is the source of truth (anti-self-licensing),
          // never the proposal's word for its own scope.
          if (action.document_id && String(action.document_id) !== String(activeMatch.matched_object_id)) {
            res.statusCode = 409;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              error: 'The proposed document is no longer the active match for this case; nothing was changed.',
              action_type: action.type,
              proposed_document_id: action.document_id,
              active_matched_object_id: activeMatch.matched_object_id
            }));
            return;
          }
          // Pod-safety #1 + #2: spine-attributed operator + capture before/after.
          const rejectActorId = gate.actorId;
          // Pod-safety #4 (writer-dispatch leg) — the spine executor owns the
          // writer-error → HTTP mapping and the applied-status stamp; the writer
          // call and audit line stay verbatim in the thunk.
          const exec = await executeChatApplyAction({
            action,
            fallbackErrorMessage: 'Reject match failed.',
            execute: async () => {
              let rejectBeforeAfter = null;
              const writerResult = await updateReconciliationMatchInDb({
                firmId,
                matchId: activeMatch.id,
                patch: { status: 'rejected', reviewer_note: action.reason || null },
                actorId: rejectActorId,
                captureBeforeState: true
              });
              const rejectedSnapshot = writerResult?.snapshot || null;
              if (writerResult?.before_state && writerResult?.after_state) {
                rejectBeforeAfter = [{
                  target: String(transactionId),
                  before: writerResult.before_state,
                  after: writerResult.after_state
                }];
              }
              // #4 audit half: the spine emitter (this row was already attributed).
              // bestEffort: false (G2 PR-12, audit-as-precondition): an audit
              // failure propagates — the reject has committed, but the apply
              // reports the error and the action stays proposed instead of a
              // warn line.
              await auditChatApplyEvent({
                query: queryFirmDb,
                firmId,
                clientId,
                actorId: rejectActorId,
                action: 'reconciliation.reject_match',
                resourceType: 'reconciliation_match',
                resourceId: activeMatch.id,
                metadata: {
                  from_status: activeMatch.status,
                  matched_object_id: activeMatch.matched_object_id,
                  reason: action.reason || null,
                  source: 'transaction_chat'
                },
                bestEffort: false
              });
              return {
                result: {
                  match_id: activeMatch.id,
                  from_status: activeMatch.status,
                  matched_object_id: activeMatch.matched_object_id,
                  rejected: true,
                  // A reject removes the wrong link; it does not settle the
                  // line. The proposal contract requires a later settle/ask
                  // companion, and this receipt makes the intermediate
                  // consequence explicit instead of presenting clean "done".
                  leaves_line_hanging: true
                },
                rejectedSnapshot,
                rejectBeforeAfter
              };
            },
            stamp: {
              write: updateTransactionChatActionStatusInDb,
              scope: { firmId, clientId, transactionId, messageId, actionIndex }
            }
          });
          if (exec.disposition !== 'applied') {
            res.statusCode = exec.statusCode;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(exec.body));
            return;
          }
          const { rejectedSnapshot, rejectBeforeAfter } = exec.executed;
          const updatedMessage = exec.updatedMessage;
          // Loops shadow (Slice F) — durable Operator-Contract triple; no-throw, gated.
          await onTransactionChatActionApplied({
            firmId, clientId, transactionId, action, actionIndex, messageId,
            model: message?.model || null, promptVersion: message?.model_version || null,
            beforeAfter: rejectBeforeAfter,
            loadCaseSnapshot: loadCaseSnapshotForShadow, withClient: withFirmDbClient
          });
          res.statusCode = 201;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            assistant_message: updatedMessage,
            applied: true,
            snapshot: filterFirmSnapshotForAccess(rejectedSnapshot, access)
          }));
          return;
        }
        if (action.type === 'accept_match') {
          // State-correction verb — the affirmative twin of reject_match:
          // CONFIRM the current SUGGESTED reconciliation match for this case.
          // The TARGET match is resolved server-side from persisted state
          // (anti-self-licensing), re-verified to still be 'suggested' (an
          // already-settled match refuses instead of double-confirming), and
          // confirmed via the EXISTING reconciliation-match writer
          // (updateReconciliationMatchInDb, INV-1) — the same writer the FE's
          // match accept uses, so the confirm cascade (bank line →
          // reconciled) and the cross-entity learned-name mint behave
          // identically from chat and from a click.
          const matchLookup = await queryFirmDb(
            `select id, status, matched_object_id
               from reconciliation_matches
              where firm_id = $1 and bank_transaction_id = $2
                and status in ('confirmed', 'auto_matched', 'suggested')
              order by case status
                         when 'confirmed' then 1
                         when 'auto_matched' then 2
                         when 'suggested' then 3
                       end
              limit 1`,
            [firmId, transactionId]
          );
          const activeMatch = matchLookup.rows[0];
          if (!activeMatch) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              error: 'No reconciliation match to accept for this case.',
              action_type: action.type
            }));
            return;
          }
          if (activeMatch.status !== 'suggested') {
            res.statusCode = 409;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              error: 'The active match is already settled; nothing to accept.',
              action_type: action.type,
              active_match_status: activeMatch.status
            }));
            return;
          }
          if (action.document_id && String(action.document_id) !== String(activeMatch.matched_object_id)) {
            res.statusCode = 409;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              error: 'The proposed document is no longer the active match for this case; nothing was changed.',
              action_type: action.type,
              proposed_document_id: action.document_id,
              active_matched_object_id: activeMatch.matched_object_id
            }));
            return;
          }
          const acceptActorId = gate.actorId;
          const exec = await executeChatApplyAction({
            action,
            fallbackErrorMessage: 'Accept match failed.',
            execute: async () => {
              let acceptBeforeAfter = null;
              const writerResult = await updateReconciliationMatchInDb({
                firmId,
                matchId: activeMatch.id,
                patch: { status: 'confirmed', reviewer_note: action.reason || null },
                actorId: acceptActorId,
                captureBeforeState: true
              });
              const acceptedSnapshot = writerResult?.snapshot || null;
              if (writerResult?.before_state && writerResult?.after_state) {
                acceptBeforeAfter = [{
                  target: String(transactionId),
                  before: writerResult.before_state,
                  after: writerResult.after_state
                }];
              }
              // bestEffort: false (G2 PR-12, audit-as-precondition): an audit
              // failure propagates — the confirm has committed, but the apply
              // reports the error and the action stays proposed instead of a
              // warn line.
              await auditChatApplyEvent({
                query: queryFirmDb,
                firmId,
                clientId,
                actorId: acceptActorId,
                action: 'reconciliation.accept_match',
                resourceType: 'reconciliation_match',
                resourceId: activeMatch.id,
                metadata: {
                  from_status: activeMatch.status,
                  matched_object_id: activeMatch.matched_object_id,
                  reason: action.reason || null,
                  source: 'transaction_chat'
                },
                bestEffort: false
              });
              return {
                result: {
                  match_id: activeMatch.id,
                  from_status: activeMatch.status,
                  matched_object_id: activeMatch.matched_object_id,
                  confirmed: true
                },
                acceptedSnapshot,
                acceptBeforeAfter
              };
            },
            stamp: {
              write: updateTransactionChatActionStatusInDb,
              scope: { firmId, clientId, transactionId, messageId, actionIndex }
            }
          });
          if (exec.disposition !== 'applied') {
            res.statusCode = exec.statusCode;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(exec.body));
            return;
          }
          const { acceptedSnapshot, acceptBeforeAfter } = exec.executed;
          const updatedMessage = exec.updatedMessage;
          // Loops shadow (Slice F) — durable Operator-Contract triple; no-throw, gated.
          await onTransactionChatActionApplied({
            firmId, clientId, transactionId, action, actionIndex, messageId,
            model: message?.model || null, promptVersion: message?.model_version || null,
            beforeAfter: acceptBeforeAfter,
            loadCaseSnapshot: loadCaseSnapshotForShadow, withClient: withFirmDbClient
          });
          res.statusCode = 201;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            assistant_message: updatedMessage,
            applied: true,
            snapshot: filterFirmSnapshotForAccess(acceptedSnapshot, access)
          }));
          return;
        }
        if (action.type === 'correct_document_field') {
          // State-correction verb (operator-loop Phase 2): correct a PARSED
          // FIELD on this case's matched document. The TARGET document is
          // resolved server-side from the active reconciliation match
          // (anti-self-licensing — never the model's word for which document),
          // the optional document_id is re-verified against it (409 on drift),
          // the document is scope-checked to THIS case's client, and the
          // correction routes to the EXISTING corrections writer
          // (recordDocumentCorrectionInDb, INV-1) — the same writer the
          // artifact panel's field-edit uses, so the chat correction writes the
          // same row + documents writeback and feeds the same next-parse
          // few-shot. The writer re-validates field_path + value at write time
          // (INV-4); ALLOWED_CORRECTION_FIELDS is the contract.
          if (!action.field_path) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              error: 'Proposed correct_document_field action is missing field_path.',
              action_type: action.type,
              allowed_fields: ALLOWED_CORRECTION_FIELDS
            }));
            return;
          }
          const matchLookup = await queryFirmDb(
            `select id, status, matched_object_id
               from reconciliation_matches
              where firm_id = $1 and bank_transaction_id = $2
                and status in ('confirmed', 'auto_matched', 'suggested')
              order by case status
                         when 'confirmed' then 1
                         when 'auto_matched' then 2
                         when 'suggested' then 3
                       end
              limit 1`,
            [firmId, transactionId]
          );
          const activeMatch = matchLookup.rows[0];
          if (!activeMatch || !activeMatch.matched_object_id) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              error: 'No matched document to correct for this case.',
              action_type: action.type
            }));
            return;
          }
          // Optional doc-id guard: when the firm named the document, re-verify
          // it is STILL the matched document before writing — a stale proposal
          // can't correct a different (newer) match. The resolved object id is
          // the source of truth, never the proposal's word for its own scope.
          if (action.document_id && String(action.document_id) !== String(activeMatch.matched_object_id)) {
            res.statusCode = 409;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              error: 'The proposed document is no longer the matched document for this case; nothing was changed.',
              action_type: action.type,
              proposed_document_id: action.document_id,
              active_matched_object_id: activeMatch.matched_object_id
            }));
            return;
          }
          const documentId = activeMatch.matched_object_id;
          // Scope-check: the matched document must belong to THIS case's client
          // before a chat on this case writes to it — defence in depth on top
          // of the writer's firm-scoping, so a cross-client match row can't
          // reach into another client's document.
          const docMeta = await getDocumentForParseInDb({ firmId, documentId });
          if (!docMeta) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              error: 'Matched document was not found.',
              action_type: action.type
            }));
            return;
          }
          if (clientId && docMeta.client_id && String(docMeta.client_id) !== String(clientId)) {
            res.statusCode = 409;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              error: 'The matched document belongs to a different client; nothing was changed.',
              action_type: action.type
            }));
            return;
          }
          const correctedBy = access.principal?.email
            || access.principal?.userId
            || access.principal?.principalId
            || 'transaction_chat';
          // Pod-safety #4 (writer-dispatch leg) — the spine executor owns the
          // writer-error → HTTP mapping and the applied-status stamp; this site
          // opts into surfacing the writer's code/details on the error body
          // (its pre-spine contract). The corrections writer already emits its
          // own document.correction audit (prior/corrected value) inside its
          // transaction — no second audit here; just stamp the chat action
          // receipt so the thread shows it applied.
          const exec = await executeChatApplyAction({
            action,
            fallbackErrorMessage: 'Document field correction failed.',
            exposeErrorDetails: true,
            execute: async () => {
              const correction = await recordDocumentCorrectionInDb({
                firmId,
                documentId,
                fieldPath: action.field_path,
                correctedValue: action.corrected_value,
                correctedBy,
                sourceModel: message?.model || null
              });
              return {
                result: {
                  document_id: documentId,
                  field_path: correction.field_path,
                  prior_value: correction.prior_value,
                  corrected_value: correction.corrected_value,
                  correction_id: correction.id
                },
                correction
              };
            },
            stamp: {
              write: updateTransactionChatActionStatusInDb,
              scope: { firmId, clientId, transactionId, messageId, actionIndex }
            }
          });
          if (exec.disposition !== 'applied') {
            res.statusCode = exec.statusCode;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(exec.body));
            return;
          }
          const { correction } = exec.executed;
          const updatedMessage = exec.updatedMessage;
          // Loops shadow (Slice F) — durable Operator-Contract triple; no-throw, gated.
          await onTransactionChatActionApplied({
            firmId, clientId, transactionId, action, actionIndex, messageId,
            model: message?.model || null, promptVersion: message?.model_version || null,
            loadCaseSnapshot: loadCaseSnapshotForShadow, withClient: withFirmDbClient
          });
          res.statusCode = 201;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            assistant_message: updatedMessage,
            applied: true,
            correction,
            snapshot: filterFirmSnapshotForAccess(await getFirmSnapshotFromDb({ firmId }), access)
          }));
          return;
        }
        // Unreachable: gated above by TRANSACTION_CHAT_ALL_APPLIABLE_ACTION_TYPES.
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Unhandled appliable action type.' }));
      } catch (error) {
        const status = error?.statusCode || 500;
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error', ...(error?.code ? { code: error.code } : {}) }));
      }
      return;
    }

    // ── Feed chat — the client-level mass-command surface ──────────────
    // One thread per (firm, client), persisted in
    // transaction_chat_messages under the FEED_CHAT_TRANSACTION_ID
    // sentinel. See server/donna/feedChat.js for the doctrine notes.

    // GET /feed-chat?client_id=...&role_id=...
    // role_id (S3) switches the read onto that role's thread sentinel — same
    // store, same shapes; an unknown role 400s. Reading is not gated on the
    // hire (a re-hired role finds its history waiting).
    if (requestUrl.pathname === '/feed-chat' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const clientId = requestUrl.searchParams.get('client_id') || '';
      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const roleId = requestUrl.searchParams.get('role_id') || '';
      if (!clientId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id is required.' }));
        return;
      }
      if (roleId && !findRoleDefinition(roleId)) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: `Unknown role '${roleId}'.` }));
        return;
      }
      await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      try {
        const messages = await getTransactionChatThreadFromDb({
          firmId,
          clientId,
          transactionId: roleId ? roleChatThreadId(roleId) : FEED_CHAT_TRANSACTION_ID
        });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          messages,
          appliable_action_types: FEED_CHAT_ALL_APPLIABLE_ACTION_TYPES
        }));
      } catch (error) {
        const status = error?.statusCode || 500;
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error' }));
      }
      return;
    }

    // POST /feed-chat/messages
    if (requestUrl.pathname === '/feed-chat/messages' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || '';
      const roleId = String(body?.role_id || '');
      const userMessage = typeof body?.message === 'string' ? body.message : '';
      const requestedDocumentIds = Array.from(new Set(
        (Array.isArray(body?.document_ids) ? body.document_ids : [])
          .map((id) => String(id || '').trim())
          .filter(Boolean)
      ));
      const selectedDocumentIds = requestedDocumentIds.slice(0, FEED_CHAT_MAX_SELECTED_DOCUMENTS);
      if (!clientId || !userMessage.trim()) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id and a non-empty message are required.' }));
        return;
      }
      if (roleId && !findRoleDefinition(roleId)) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: `Unknown role '${roleId}'.` }));
        return;
      }
      await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      // A role thread SPEAKS only while the role is hired and the bench UI
      // flag acts for the client (S3). Reading stays open above; minting
      // replies and proposals in a teammate's name does not.
      let roleAssignment = null;
      if (roleId) {
        const gate = await withFirmDbClient(async (dbClient) => {
          const snapshot = await readClientConfigSnapshot(dbClient, {
            firmId: firmId || DEFAULT_FIRM_ID, clientId
          });
          if (benchUiMode({ snapshot }) !== 'act') {
            return { ok: false, error: 'The team surface is not enabled for this venture.' };
          }
          const assignment = await readActiveSpecialistAssignment(dbClient, {
            firmId: firmId || DEFAULT_FIRM_ID, clientId, roleId
          });
          if (!assignment) return { ok: false, error: 'Hire the role before chatting in its thread.' };
          return { ok: true, assignment };
        });
        if (!gate.ok) {
          res.statusCode = 409;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: gate.error }));
          return;
        }
        roleAssignment = gate.assignment;
      }
      const threadId = roleId ? roleChatThreadId(roleId) : FEED_CHAT_TRANSACTION_ID;
      // Occupant attribution (S4): the persisted rows carry which role AND
      // which AI occupant profile spoke — receipts, not vibes (INV-S7).
      const roleTag = roleId
        ? {
            role_id: roleId,
            ...(roleAssignment?.ai_profile ? { ai_profile: roleAssignment.ai_profile } : {})
          }
        : {};
      try {
        const userMessageRow = await appendTransactionChatMessageInDb({
          firmId,
          clientId,
          transactionId: threadId,
          id: newFeedChatMessageId({ kind: 'user' }),
          role: 'user',
          content: userMessage.trim(),
          ...(roleId ? { payload: { ...roleTag } } : {}),
          actorType: 'firm'
        });
        const history = await getTransactionChatThreadFromDb({
          firmId,
          clientId,
          transactionId: threadId
        });
        // The scope-resolution universe — server-side, never a
        // FE-supplied row list (a stale payload must not tell the LLM
        // a different feed than the one persisted).
        const { rows: feedRows, totalCount } = await getFeedChatRowsFromDb({ firmId, clientId });
        // Same context channels as the per-transaction chat, plus the
        // principals registry (#370): no thinner call on the surface
        // that proposes mass postings.
        const accountOptions = await getClientAccountOptionsFromDb({ firmId, clientId }).catch((err) => {
          if (isCodingPolicyError(err)) throw err;
          console.warn('[feed-chat] account options lookup failed', err?.message || err);
          return [];
        });
        const clientProfile = await getClientChatProfileFromDb({ firmId, clientId }).catch((err) => {
          if (isCodingPolicyError(err)) throw err;
          console.warn('[feed-chat] client profile lookup failed', err?.message || err);
          return null;
        });
        const principals = await withFirmDbClient(async (dbClient) => {
          const result = await dbClient.query(
            'select profile from clients where firm_id = $1 and id = $2',
            [firmId || DEFAULT_FIRM_ID, clientId]
          );
          return knownPrincipalsForClientProfile(result.rows[0]?.profile || {});
        }).catch((err) => {
          console.warn('[feed-chat] principals lookup failed', err?.message || err);
          return [];
        });
        const firmFacts = await withFirmDbClient((dbClient) =>
          getFirmFactsForSubjects({
            client: dbClient,
            firmId: firmId || DEFAULT_FIRM_ID,
            chatAdmission: true, // FIK-0b: no jurisdiction-scope rule grounds a chat answer
            subjects: [
              { scope: 'client', value: clientProfile?.registration_number || clientProfile?.name || '' },
              { scope: 'jurisdiction', value: clientProfile?.jurisdiction || '' },
              { scope: 'firm', value: firmId || DEFAULT_FIRM_ID }
            ]
          })
        ).catch((err) => {
          console.warn('[feed-chat] firm facts lookup failed', err?.message || err);
          return [];
        });
        // This client's ACTIVE rules — the retire_rule target universe (G1c).
        // Bounded in buildFeedChatContext; ids only from this list may be
        // targeted (the transaction_ids anti-fabrication rail). Soft-degrades
        // to [] (retire_rule then demotes at sanitize time — never a dead
        // Apply), same contract as the lookups above.
        const knownRules = await withFirmDbClient(async (dbClient) => {
          const result = await dbClient.query(
            `select id, rule_type, pattern_text, category_override, account_code, status
               from client_rules
              where firm_id = $1 and client_id = $2 and status = 'active'
              order by updated_at desc
              limit 40`,
            [firmId || DEFAULT_FIRM_ID, clientId]
          );
          return result.rows;
        }).catch((err) => {
          console.warn('[feed-chat] client rules lookup failed', err?.message || err);
          return [];
        });
        // This client's LIVE owner asks — the cancel_ask / resend_ask target
        // universe (G1b). Feed rows carry a client_asks TAB but no ask id, so
        // without this the lifecycle verbs cannot name a target at all. Same
        // soft-degrade contract as the lookups above: [] means both verbs
        // demote at sanitize time rather than showing a dead Apply.
        const knownAsks = await getOpenClientEvidenceRequestsForChatFromDb({
          firmId: firmId || DEFAULT_FIRM_ID,
          clientId
        }).catch((err) => {
          console.warn('[feed-chat] open asks lookup failed', err?.message || err);
          return [];
        });
        // The parse pipeline_state of matched documents that are NOT
        // cleanly parsed — the feed chat's `diagnose` targets (the
        // READING·1-OF-1 class). #396 wired the SINGLE matched doc of the
        // per-transaction chat; the feed is client-scoped, so this is a
        // per-row ARRAY — the snapshot's THIRD consumer. Each row is shaped
        // through the SAME read model the per-transaction chat and the
        // drawer use (pipelineStateFromDoc), so the block is byte-identical
        // across surfaces; the only difference is cardinality. A cleanly
        // 'completed' matched doc is excluded upstream, so the healthy case
        // fetches nothing. Soft-degrades to []: a lookup hiccup must never
        // kill the turn, the same contract as the other lookups above.
        const pipelineStates = await getFeedChatPipelineDocsFromDb({
          firmId,
          clientId,
          transactionIds: feedRows.map((row) => row.id),
          limit: FEED_CHAT_MAX_PIPELINE_STATES
        })
          .then((docs) => docs.map((doc) => ({
            transaction_id: doc.transaction_id || null,
            ...pipelineStateFromDoc(doc)
          })))
          .catch((err) => {
            console.warn('[feed-chat] pipeline_state lookup failed', err?.message || err);
            return [];
          });
        // The client's agreement (contract) documents with obligations — the
        // source for the read-only agreement-evidence CheckReport attached to
        // relevant apply_category proposals. Soft-degrades to []: an evidence
        // lookup must never kill the turn (same contract as the lookups above).
        const agreementDocuments = await getFeedChatAgreementDocsFromDb({ firmId, clientId }).catch((err) => {
          console.warn('[feed-chat] agreement docs lookup failed', err?.message || err);
          return [];
        });
        // An explicit Documents multi-selection is re-read from the persisted
        // client scope. The renderer supplies ids only; it cannot inject document
        // fields or widen access. Unlike optional enrichment, failure here is
        // loud because silently dropping the set would make Donna answer a
        // different question from the one the operator asked.
        const selectedDocuments = selectedDocumentIds.length
          ? await withFirmDbClient(async (dbClient) => {
              const result = await dbClient.query(
                `select id, filename, document_type, status, payload,
                        vendor_name, customer_name, total_amount, currency,
                        document_date, due_date, payment_status, parse_status, parse_summary
                 from documents
                 where firm_id = $1 and client_id = $2 and id = any($3::text[])`,
                [firmId || DEFAULT_FIRM_ID, clientId, selectedDocumentIds]
              );
              const byId = new Map(result.rows.map((document) => [document.id, document]));
              return selectedDocumentIds.map((id) => byId.get(id)).filter(Boolean);
            })
          : [];
        // The client's document index — open_document's target universe
        // (two-surface IA P4): "find that PDF" resolves against these
        // PERSISTED rows, newest-first so the bounded tail drops the oldest.
        // Column-lean on purpose (no payload/parse_summary — the compactor
        // only reads those as fallbacks for columns selected here), with the
        // pre-limit total as a window count so truncation stays honest in one
        // round-trip. Soft-degrades to [] (retrieval unavailable is an honest
        // reply; the sanitize rail then demotes any open_document the model
        // emits).
        const { documentIndexRows, documentIndexTotal } = await withFirmDbClient(async (dbClient) => {
          const result = await dbClient.query(
            `select id, filename, document_type,
                    vendor_name, customer_name, total_amount, currency,
                    document_date, due_date, payment_status, parse_status,
                    count(*) over ()::int as index_total
             from documents
             where firm_id = $1 and client_id = $2
             order by coalesce(document_date, created_at::date) desc, created_at desc
             limit 200`,
            [firmId || DEFAULT_FIRM_ID, clientId]
          );
          return {
            documentIndexRows: result.rows,
            documentIndexTotal: result.rows[0]?.index_total ?? result.rows.length
          };
        }).catch((err) => {
          console.warn('[feed-chat] document index lookup failed', err?.message || err);
          return { documentIndexRows: [], documentIndexTotal: 0 };
        });
        // The HIRED bench (S4): persisted assignments → the context's team
        // block, the sole role_id universe for intent→role tags and the
        // grounding for delegation narration. Soft-degrades to [] — no
        // teammates named is always an honest reply.
        const team = await withFirmDbClient(async (dbClient) => {
          const assignments = await listSpecialistAssignments(dbClient, {
            firmId: firmId || DEFAULT_FIRM_ID, clientId
          });
          const active = assignments.filter((assignment) => assignment.status === 'active');
          // Standing authority rides the team block (team-screen recede):
          // the id universe revoke_role_grant may target, and the honest
          // ground for "what may she do without asking".
          const grants = active.length
            ? await listRoleAuthorityGrants(dbClient, { firmId: firmId || DEFAULT_FIRM_ID, clientId })
            : [];
          return active
            .map((assignment) => {
              const definition = findRoleDefinition(assignment.role);
              if (!definition) return null;
              const profile = AI_PROFILES[assignment.ai_profile || definition.default_ai_profile] || null;
              return {
                role_id: definition.id,
                persona: profile?.persona || null,
                title: definition.title,
                responsibilities: definition.responsibilities,
                grantable_actions: grantableActionsForRole(definition),
                standing_authority: grants
                  .filter((grant) => grant.provenance?.role_id === definition.id && grant.status === 'active')
                  .map((grant) => ({
                    id: grant.id,
                    action_type: grant.action_type,
                    scope_key: grant.scope_key,
                    amount_ceiling: grant.amount_ceiling,
                    currency: grant.currency,
                    expires_at: grant.expires_at,
                    review_after: grant.review_after
                  }))
              };
            })
            .filter(Boolean);
        }).catch((err) => {
          console.warn('[feed-chat] team roster lookup failed', err?.message || err);
          return [];
        });
        const context = buildFeedChatContext({
          clientProfile,
          principals,
          feedRows,
          agreementDocuments,
          totalRowCount: totalCount,
          accountOptions,
          firmFacts,
          knownRules,
          knownAsks,
          pipelineStates,
          selectedDocuments,
          selectedDocumentTotalCount: requestedDocumentIds.length,
          indexDocuments: documentIndexRows,
          documentIndexTotalCount: documentIndexTotal,
          team
        });
        if (clientProfile?.codingPolicy?.nativeMenu) Object.assign(context, await withFirmDbClient(client =>
          captureNativeChatCodingContextWithClient({ client, firmId, clientId, transactionIds: context.feed_rows.map(row => row.id) })));
        const reply = await generateFeedChatReply({
          context,
          history: history.slice(0, -1),
          userMessage: userMessage.trim(),
          validTransactionIds: feedRows.map((row) => row.id),
          agreementDocuments,
          // S4 persona: a role thread compiles through the SAME step with the
          // role-mode system prompt — the occupant's voice over the same truth.
          ...(roleId ? { role: { roleId, aiProfileId: roleAssignment?.ai_profile || null } } : {})
        });
        if (reply.kind !== 'ok') {
          // Surface the captured diagnostic instead of dropping it. A
          // bare "invalid_response_shape" is undiagnosable; the model id +
          // stop_reason on the failure itself tell us whether a downgraded
          // model answered (CLAUDE.md model-id rail) and whether the reply
          // truncated, and the bounded raw_snippet rides in the payload so
          // the cause is read off the receipt, not guessed (the
          // diagnose-don't-guess rail).
          const diagnostic = reply.diagnostic || null;
          const failureContent = diagnostic
            ? `Chat unavailable: ${reply.reason || reply.code || 'unknown'} (model=${diagnostic.model || 'unknown'}, stop_reason=${diagnostic.stop_reason || 'unknown'}).`
            : `Chat unavailable: ${reply.reason || reply.code || 'unknown'}.`;
          const failureMessage = await appendTransactionChatMessageInDb({
            firmId,
            clientId,
            transactionId: threadId,
            id: newFeedChatMessageId({ kind: 'system' }),
            role: 'system',
            content: failureContent,
            payload: { failure_code: reply.code || 'unknown', ...(diagnostic ? { diagnostic } : {}), ...roleTag },
            actorType: 'system'
          });
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            error: reply.reason || 'Chat unavailable.',
            failure_code: reply.code || 'unknown',
            ...(diagnostic ? { diagnostic } : {}),
            user_message: userMessageRow,
            system_message: failureMessage
          }));
          return;
        }
        // `open_financials` is model-selected but ledger-grounded: resolve a
        // missing "latest" month from posted journals and attach the exact
        // report summary before the action becomes part of the durable thread.
        const hydratedActions = await hydrateFinancialReportActions({
          actions: reply.actions,
          firmId: firmId || DEFAULT_FIRM_ID,
          defaultClientId: clientId,
          resolveLatestPeriod: getLatestPostedLedgerPeriodFromDb,
          loadReport: getFinancialReportFromDb
        });
        await withFirmDbClient(client => revalidateNativeChatCodingContextWithClient({ client, firmId, clientId, context, actions: reply.actions }));
        // Slice H (feed leg): the mint-time facts stamp — the ids the prompt's
        // known_facts ACTUALLY carried this turn (the same Slice-I stamp
        // pattern: record at mint, render on the receipt, never re-derive).
        // Unconditional because known_facts already rides the prompt
        // unconditionally — the stamp adds no behaviour, only the record. An
        // empty list is never written: absence means "no facts in the prompt".
        const feedFactsAvailable = (Array.isArray(context.known_facts) ? context.known_facts : [])
          .map((fact) => fact?.id)
          .filter(Boolean);
        const assistantMessage = await appendTransactionChatMessageInDb({
          firmId,
          clientId,
          transactionId: threadId,
          id: newFeedChatMessageId({ kind: 'assistant' }),
          role: 'assistant',
          content: reply.text,
          // Persist the triage receipt alongside the proposed actions.
          payload: {
            actions: hydratedActions,
            ...(reply.triage ? { triage: reply.triage } : {}),
            ...(feedFactsAvailable.length ? { facts_available: feedFactsAvailable } : {}),
            ...roleTag
          },
          model: reply.model,
          actorType: 'llm'
        });
        res.statusCode = 201;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          user_message: userMessageRow,
          assistant_message: assistantMessage,
          appliable_action_types: FEED_CHAT_ALL_APPLIABLE_ACTION_TYPES
        }));
      } catch (error) {
        const status = error?.statusCode || 500;
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error' }));
      }
      return;
    }

    // POST /feed-chat/messages/:messageId/actions/:index/apply
    const feedChatApplyMatch = requestUrl.pathname.match(/^\/feed-chat\/messages\/([^/]+)\/actions\/(\d+)\/apply$/);
    if (feedChatApplyMatch && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const messageId = decodeURIComponent(feedChatApplyMatch[1]);
      const actionIndex = Number(feedChatApplyMatch[2]);
      const body = await readBody();
      const firmId = body?.firm_id || DEFAULT_FIRM_ID;
      const clientId = body?.client_id || '';
      // role_id (S3) resolves the message off that role's thread sentinel; the
      // spine below is thread-agnostic (actions carry their own target ids and
      // the acting principal's leash is resolved from their OWN assignment —
      // the S1 attribution law — never from the thread they clicked in).
      const applyRoleId = String(body?.role_id || '');
      if (!clientId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id is required.' }));
        return;
      }
      if (applyRoleId && !findRoleDefinition(applyRoleId)) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: `Unknown role '${applyRoleId}'.` }));
        return;
      }
      const applyThreadId = applyRoleId ? roleChatThreadId(applyRoleId) : FEED_CHAT_TRANSACTION_ID;
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      try {
        const message = await getTransactionChatMessageFromDb({
          firmId,
          clientId,
          transactionId: applyThreadId,
          messageId
        });
        // S4 routing seam — the ACTING role for this apply. Claimed-lane rule:
        // the persisted action's sanitized role tag routes as the acting role
        // ONLY when that role's own action_set claims the action type (the
        // work genuinely is the lane's) AND the role is actively hired here.
        // Anything else stays null — attribution metadata never becomes
        // authority, and a narration tag on an unclaimed verb can never mint
        // shadow would-blocks. The feed grammar's verbs are unclaimed today,
        // so this resolves null until role verbs enter the chat grammar; the
        // principal's OWN assignment always outranks it inside
        // assertActionCapability regardless.
        const proposedAction = Array.isArray(message?.payload?.actions)
          ? message.payload.actions[actionIndex]
          : null;
        let actingSpecialistRoleId = null;
        const taggedRole = proposedAction?.role_id ? findRoleDefinition(proposedAction.role_id) : null;
        if (taggedRole && taggedRole.action_set.includes(proposedAction?.type)) {
          const hired = await withFirmDbClient((dbClient) => readActiveSpecialistAssignment(dbClient, {
            firmId, clientId, roleId: taggedRole.id
          })).catch(() => null);
          if (hired) actingSpecialistRoleId = taggedRole.id;
        }
        // Pod-safety #4 — the ONE compile→authorize spine for every chat apply
        // route (chatApplySpine.gateChatApplyAction). This CLOSES the drift the
        // per-route prologues invited: the feed-chat route previously shipped
        // WITHOUT the #3 capability gate the other two surfaces ran — the gate
        // now runs here too (dormant until OPERATOR_CAPABILITY_ENFORCE acts for
        // the client, exactly like txn-/doc-chat).
        const gate = await gateChatApplyAction({
          surface: 'feed_chat',
          firmId,
          clientId,
          principal: access.principal,
          message,
          actionIndex,
          appliableActionTypes: FEED_CHAT_ALL_APPLIABLE_ACTION_TYPES,
          specialistRoleId: actingSpecialistRoleId,
          assertCapability: assertActionCapability
        });
        if (gate.disposition === 'replay') {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            assistant_message: message,
            applied: true,
            idempotent_replay: true
          }));
          return;
        }
        if (gate.disposition !== 'proceed') {
          res.statusCode = gate.statusCode;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(gate.body));
          return;
        }
        const action = gate.action;
        const actorId = gate.actorId;
        // Pod-safety #4 (writer-dispatch leg) — the spine executor owns the
        // writer-error → HTTP mapping and the applied-status stamp. The shadow
        // hook rides INSIDE the thunk to keep its pre-spine ordering (apply →
        // mirror → respond-or-stamp): it observes not-applied outcomes too.
        const exec = await executeChatApplyAction({
          action,
          fallbackErrorMessage: 'Apply failed.',
          execute: async () => {
            const outcome = await applyFeedChatAction({
              ...(action.native_choice ? { nativeMemberId: (await resolveDesktopClientCreationPrincipal({ firmId, principal: access.principal })).principalId } : {}),
              firmId,
              clientId,
              action,
              actorId,
              messageId,
              actionIndex
            });
            // Loops shadow (LOOPS_SHADOW, default OFF): mirror the applied command as
            // the durable Operator-Contract artifacts (proposal card + apply receipt).
            // Own transaction, post-commit, no-throw — can never affect this response.
            await onFeedChatActionApplied({
              firmId,
              clientId,
              action,
              actionIndex,
              messageId,
              model: message?.model || null,
              promptVersion: message?.model_version || null,
              outcome,
              // Slice H (feed leg): the mint-time facts stamp off the persisted
              // message — what the prompt actually carried; null (no stamp /
              // pre-slice message) keeps the receipt's bare [] fields.
              factsAvailable: Array.isArray(message?.payload?.facts_available)
                ? message.payload.facts_available
                : null,
              withClient: withFirmDbClient
            });
            if (!outcome.applied) {
              // Every row failed (or the rule was unusable) — the action
              // stays proposed so the firm can retry; the receipt rides
              // the response.
              return {
                respond: {
                  statusCode: 200,
                  body: {
                    applied: false,
                    action_type: action.type,
                    result: outcome.result
                  }
                }
              };
            }
            return { result: outcome.result };
          },
          stamp: {
            write: updateTransactionChatActionStatusInDb,
            scope: { firmId, clientId, transactionId: applyThreadId, messageId, actionIndex }
          }
        });
        if (exec.disposition !== 'applied') {
          res.statusCode = exec.statusCode;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(exec.body));
          return;
        }
        const updatedMessage = exec.updatedMessage;
        // ONE snapshot for the whole batch — the per-row writers ran
        // with returnSnapshot: false.
        const snapshot = await getFirmSnapshotFromDb({ firmId });
        res.statusCode = 201;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          assistant_message: updatedMessage,
          applied: true,
          result: exec.executed.result,
          snapshot: filterFirmSnapshotForAccess(snapshot, access)
        }));
      } catch (error) {
        const status = error?.statusCode || 500;
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error' }));
      }
      return;
    }

    // ── Firm-scope (Inbox) feed chat — the cross-venture mass-command lane
    // (UI slice 3). One firm thread (firm_chat_messages, migration 114); the
    // model sees every venture's workspace context and each action carries
    // the client_id it compiles to; the apply dispatches through the SAME
    // per-client writers. Firm MEMBERS only (requireMember): the thread
    // necessarily spans every venture, so a client-scoped collaborator can
    // neither read nor write it. G0.3 (build-spec PR-7): the message route
    // is rate-limited (DB-count rolling window, 429 FIRM_CHAT_RATE_LIMITED),
    // every mint audits its retrieval scope (firm_chat.retrieval_scope), and
    // sanitizer drops / scope refusals write anomaly rows — the firm lane is
    // the widest surface in the product, so its reads and refusals leave a
    // queryable trace, not just a card marker.

    // GET /feed-chat/firm
    if (requestUrl.pathname === '/feed-chat/firm' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      await assertFirmAccess({ firmId, auth: req.donnaAuth, clientIds: [], requireMember: true });
      try {
        const messages = await getFirmChatThreadFromDb({ firmId, thread: FIRM_FEED_CHAT_THREAD });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          messages,
          appliable_action_types: FEED_CHAT_ALL_APPLIABLE_ACTION_TYPES
        }));
      } catch (error) {
        const status = error?.statusCode || 500;
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error' }));
      }
      return;
    }

    // POST /feed-chat/firm/messages
    if (requestUrl.pathname === '/feed-chat/firm/messages' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const userMessage = typeof body?.message === 'string' ? body.message : '';
      if (!userMessage.trim()) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'A non-empty message is required.' }));
        return;
      }
      // G0.2 (build-spec PR-6): an optional 0-based window offset into the
      // firm's name-ordered venture list — the continuation batch is a NEW
      // bounded run over the next subset (deterministic selection order,
      // never model memory).
      const venturesOffset = Number.isInteger(body?.ventures_offset) && body.ventures_offset > 0
        ? body.ventures_offset
        : 0;
      const access = await assertFirmAccess({ firmId, auth: req.donnaAuth, clientIds: [], requireMember: true });
      const accessActorId = chatApplyActorId(access.principal);
      try {
        // G0.3 rate limit — per-firm rolling hour over USER messages, the
        // PARSE_RATE_LIMITED house pattern (DB-count, restart-proof). Env is
        // a tuning knob here, never a rollout flag. The trip writes an
        // anomaly audit row: a runaway loop hammering the widest surface in
        // the product is exactly the event worth a queryable trace.
        const rateLimitPerHour = Number(process.env.FIRM_CHAT_RATE_LIMIT_PER_HOUR || 60);
        const recentCount = await countRecentFirmChatUserMessagesInDb({
          firmId,
          thread: FIRM_FEED_CHAT_THREAD
        });
        if (recentCount >= rateLimitPerHour) {
          await auditChatApplyEvent({
            query: queryFirmDb,
            firmId,
            actorId: accessActorId,
            action: 'firm_chat.rate_limited',
            resourceType: 'firm_chat_thread',
            resourceId: FIRM_FEED_CHAT_THREAD,
            metadata: { window: '1h', limit: rateLimitPerHour, count: recentCount }
          });
          res.statusCode = 429;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            error: `Firm chat rate limit reached (${rateLimitPerHour} messages per hour). Try again shortly.`,
            code: 'FIRM_CHAT_RATE_LIMITED',
            details: { window: '1h', limit: rateLimitPerHour, count: recentCount }
          }));
          return;
        }
        // The venture universe — server-side, deterministic order, true
        // total, and assertFirmAccess's own allowedClientIds verdict
        // threaded into the SQL (null for the members this route admits
        // today; the filter is live so an admitted scoped principal could
        // never retrieve unassigned ventures — G0.3's latent-hazard close).
        const ventureUniverse = await listFirmChatVentureUniverseInDb({
          firmId: firmId || DEFAULT_FIRM_ID,
          offset: venturesOffset,
          limit: MAX_FIRM_CHAT_CLIENTS,
          allowedClientIds: access.allowedClientIds
        });
        if (venturesOffset > 0 && !ventureUniverse.rows.length) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            error: `ventures_offset ${venturesOffset} is beyond the venture list (${ventureUniverse.total} ventures).`
          }));
          return;
        }
        const userMessageRow = await appendFirmChatMessageInDb({
          firmId,
          thread: FIRM_FEED_CHAT_THREAD,
          id: newFeedChatMessageId({ kind: 'user' }),
          role: 'user',
          content: userMessage.trim(),
          actorType: 'firm'
        });
        const history = await getFirmChatThreadFromDb({ firmId, thread: FIRM_FEED_CHAT_THREAD });
        const clientRows = ventureUniverse.rows;
        // Per-venture context through the SAME channels the per-client lane
        // reads (rows, account menu, profile, principals, facts), each
        // soft-degrading alone. Deliberately absent in v1 (the prompt says
        // so): pipeline_states and agreement docs — those diagnostics stay
        // on the venture workspace.
        const ventures = [];
        for (const clientRow of clientRows) {
          const ventureClientId = clientRow.id;
          const { rows: feedRows, totalCount } = await getFeedChatRowsFromDb({ firmId, clientId: ventureClientId });
          const boundedRows = feedRows.slice(0, MAX_FIRM_FEED_ROWS_PER_CLIENT);
          const accountOptions = await getClientAccountOptionsFromDb({ firmId, clientId: ventureClientId }).catch((err) => {
            if (isCodingPolicyError(err)) throw err;
            console.warn('[firm-feed-chat] account options lookup failed', err?.message || err);
            return [];
          });
          const clientProfile = await getClientChatProfileFromDb({ firmId, clientId: ventureClientId }).catch((err) => {
            if (isCodingPolicyError(err)) throw err;
            console.warn('[firm-feed-chat] client profile lookup failed', err?.message || err);
            return null;
          });
          const principals = await withFirmDbClient(async (dbClient) => {
            const result = await dbClient.query(
              'select profile from clients where firm_id = $1 and id = $2',
              [firmId || DEFAULT_FIRM_ID, ventureClientId]
            );
            return knownPrincipalsForClientProfile(result.rows[0]?.profile || {});
          }).catch((err) => {
            console.warn('[firm-feed-chat] principals lookup failed', err?.message || err);
            return [];
          });
          const firmFacts = await withFirmDbClient((dbClient) =>
            getFirmFactsForSubjects({
              client: dbClient,
              firmId: firmId || DEFAULT_FIRM_ID,
              chatAdmission: true, // FIK-0b: no jurisdiction-scope rule grounds a chat answer
              subjects: [
                { scope: 'client', value: clientProfile?.registration_number || clientProfile?.name || '' },
                { scope: 'jurisdiction', value: clientProfile?.jurisdiction || '' },
                { scope: 'firm', value: firmId || DEFAULT_FIRM_ID }
              ]
            })
          ).catch((err) => {
            console.warn('[firm-feed-chat] firm facts lookup failed', err?.message || err);
            return [];
          });
          const ventureContext = buildFeedChatContext({
            clientProfile,
            principals,
            feedRows: boundedRows,
            totalRowCount: totalCount,
            accountOptions,
            firmFacts
          });
          if (clientProfile?.codingPolicy?.nativeMenu) Object.assign(ventureContext, await withFirmDbClient(client =>
            captureNativeChatCodingContextWithClient({ client, firmId, clientId: ventureClientId, transactionIds: ventureContext.feed_rows.map(row => row.id) })));
          const latestFinancialPeriod = await getLatestPostedLedgerPeriodFromDb({
            firmId: firmId || DEFAULT_FIRM_ID,
            clientId: ventureClientId
          }).catch((err) => {
            console.warn('[firm-feed-chat] latest financial period lookup failed', err?.message || err);
            return null;
          });
          ventures.push({
            clientId: ventureClientId,
            clientName: clientRow.company_name,
            latestFinancialPeriod,
            context: ventureContext,
            validTransactionIds: boundedRows.map((row) => row.id),
            knownFacts: ventureContext.known_facts,
            feedRows: ventureContext.feed_rows
          });
        }
        const coveragePartial = ventureUniverse.total > ventures.length;
        const venturesWindow = {
          shown: ventures.length,
          total: ventureUniverse.total,
          offset: venturesOffset
        };
        const context = buildFirmFeedChatContext({ ventures, venturesWindow });
        const reply = await generateFirmFeedChatReply({
          context,
          history: history.slice(0, -1),
          userMessage: userMessage.trim(),
          ventures
        });
        if (reply.kind !== 'ok') {
          const diagnostic = reply.diagnostic || null;
          const failureContent = diagnostic
            ? `Chat unavailable: ${reply.reason || reply.code || 'unknown'} (model=${diagnostic.model || 'unknown'}, stop_reason=${diagnostic.stop_reason || 'unknown'}).`
            : `Chat unavailable: ${reply.reason || reply.code || 'unknown'}.`;
          const failureMessage = await appendFirmChatMessageInDb({
            firmId,
            thread: FIRM_FEED_CHAT_THREAD,
            id: newFeedChatMessageId({ kind: 'system' }),
            role: 'system',
            content: failureContent,
            payload: { failure_code: reply.code || 'unknown', ...(diagnostic ? { diagnostic } : {}) },
            actorType: 'system'
          });
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            error: reply.reason || 'Chat unavailable.',
            failure_code: reply.code || 'unknown',
            ...(diagnostic ? { diagnostic } : {}),
            user_message: userMessageRow,
            system_message: failureMessage
          }));
          return;
        }
        for (const venture of ventures) await withFirmDbClient(client => revalidateNativeChatCodingContextWithClient({
          client, firmId, clientId: venture.clientId, context: venture.context, actions: reply.actions.filter(action => action.client_id === venture.clientId) }));
        const latestPeriodByClient = new Map(
          ventures.map((venture) => [venture.clientId, venture.latestFinancialPeriod || null])
        );
        const hydratedActions = await hydrateFinancialReportActions({
          actions: reply.actions,
          firmId: firmId || DEFAULT_FIRM_ID,
          resolveLatestPeriod: ({ clientId: actionClientId }) => latestPeriodByClient.get(actionClientId) || null,
          loadReport: getFinancialReportFromDb
        });
        // The mint-time facts stamp — PER-VENTURE bundles (G0.1, build-spec
        // PR-5): each venture's prompt block carried ITS OWN known_facts, so
        // the record-at-mint stamp keeps that granularity instead of one
        // cross-venture union — a venture-B apply must never receipt a
        // venture-A fact. Legacy messages (pre-PR-5) carry only the union
        // `facts_available`; the apply path falls back to it with a
        // legacy_union_receipt warning on the receipt's checks.
        const factsAvailableByClient = buildFirmFactsAvailableByClient(ventures);
        const assistantMessage = await appendFirmChatMessageInDb({
          firmId,
          thread: FIRM_FEED_CHAT_THREAD,
          id: newFeedChatMessageId({ kind: 'assistant' }),
          role: 'assistant',
          content: reply.text,
          payload: {
            actions: hydratedActions,
            ...(reply.triage ? { triage: reply.triage } : {}),
            ...(Object.keys(factsAvailableByClient).length
              ? { facts_available_by_client: factsAvailableByClient }
              : {}),
            // G0.2: partial coverage is DECLARED on the persisted message —
            // the UI banner and the continuation batch read this, never a
            // model-noticed flag. An 8-or-fewer firm at offset 0 stays
            // byte-identical (no coverage keys).
            ...(coveragePartial
              ? { coverage: 'partial', ventures_window: venturesWindow }
              : {})
          },
          model: reply.model,
          actorType: 'llm'
        });
        // G0.3 retrieval-scope receipt: WHICH ventures this mint read, as a
        // queryable audit row — {shown, total, offset} plus the venture ids,
        // attributed to the requesting principal. Best-effort (the mint is
        // already persisted; a scope row must not take down a live reply).
        await auditChatApplyEvent({
          query: queryFirmDb,
          firmId,
          actorId: accessActorId,
          action: 'firm_chat.retrieval_scope',
          resourceType: 'firm_chat_message',
          resourceId: assistantMessage.id,
          metadata: {
            thread: FIRM_FEED_CHAT_THREAD,
            ventures_shown: ventures.map((venture) => venture.clientId),
            window: venturesWindow,
            coverage: coveragePartial ? 'partial' : 'full'
          }
        });
        // G0.3 anomaly trace: the model proposed an unknown venture or
        // reached across one — the sanitizer already dropped it from the
        // cards; this row makes the drop findable after the thread scrolls.
        const actionAnomalies = reply.action_anomalies || {};
        if (actionAnomalies.dropped_unknown_venture_actions > 0 || actionAnomalies.dropped_transaction_ids > 0) {
          await auditChatApplyEvent({
            query: queryFirmDb,
            firmId,
            actorId: accessActorId,
            action: 'firm_chat.action_anomaly',
            resourceType: 'firm_chat_message',
            resourceId: assistantMessage.id,
            metadata: { thread: FIRM_FEED_CHAT_THREAD, ...actionAnomalies }
          });
        }
        res.statusCode = 201;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          user_message: userMessageRow,
          assistant_message: assistantMessage,
          appliable_action_types: FEED_CHAT_ALL_APPLIABLE_ACTION_TYPES
        }));
      } catch (error) {
        const status = error?.statusCode || 500;
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error' }));
      }
      return;
    }

    // POST /feed-chat/firm/messages/:messageId/actions/:index/apply
    const firmFeedChatApplyMatch = requestUrl.pathname.match(/^\/feed-chat\/firm\/messages\/([^/]+)\/actions\/(\d+)\/apply$/);
    if (firmFeedChatApplyMatch && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const messageId = decodeURIComponent(firmFeedChatApplyMatch[1]);
      const actionIndex = Number(firmFeedChatApplyMatch[2]);
      const body = await readBody();
      const firmId = body?.firm_id || DEFAULT_FIRM_ID;
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: [],
        requireMember: true
      });
      try {
        const message = await getFirmChatMessageFromDb({
          firmId,
          thread: FIRM_FEED_CHAT_THREAD,
          messageId
        });
        // The venture this action compiles to — read from the PERSISTED
        // action, never the request body (anti-self-licensing).
        const rawAction = Array.isArray(message?.payload?.actions)
          ? message.payload.actions[actionIndex]
          : null;
        const applyClientId = rawAction?.client_id || '';
        if (message && rawAction && !applyClientId) {
          // G0.3 anomaly trace: a persisted firm action with no venture
          // should be impossible (the firm schema requires client_id) — if
          // one surfaces, that is a fact worth a queryable row, not just a
          // 422 the caller may swallow.
          await auditChatApplyEvent({
            query: queryFirmDb,
            firmId,
            actorId: chatApplyActorId(access.principal),
            action: 'firm_chat.apply_anomaly',
            resourceType: 'firm_chat_message',
            resourceId: messageId,
            metadata: { reason: 'missing_client_id', action_index: actionIndex }
          });
          res.statusCode = 422;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Action carries no client_id; it cannot be applied.' }));
          return;
        }
        if (applyClientId) {
          // Same chokepoint discipline as every client write, with the
          // action's own venture in scope. A refusal here is the leakage
          // event PR-7's tests pin — audit it (best-effort) before it
          // propagates (G0.3 anomaly logging).
          try {
            await assertFirmAccess({
              firmId,
              auth: req.donnaAuth,
              clientIds: collectClientIds(applyClientId)
            });
          } catch (scopeError) {
            if (scopeError?.statusCode === 403) {
              await auditChatApplyEvent({
                query: queryFirmDb,
                firmId,
                clientId: applyClientId,
                actorId: chatApplyActorId(access.principal),
                action: 'firm_chat.apply_anomaly',
                resourceType: 'firm_chat_message',
                resourceId: messageId,
                metadata: { reason: 'venture_access_refused', client_id: applyClientId, action_index: actionIndex }
              });
            }
            throw scopeError;
          }
        }
        const gate = await gateChatApplyAction({
          surface: 'firm_feed_chat',
          firmId,
          clientId: applyClientId,
          principal: access.principal,
          message,
          actionIndex,
          appliableActionTypes: FEED_CHAT_ALL_APPLIABLE_ACTION_TYPES,
          assertCapability: assertActionCapability
        });
        if (gate.disposition === 'replay') {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            assistant_message: message,
            applied: true,
            idempotent_replay: true
          }));
          return;
        }
        if (gate.disposition !== 'proceed') {
          res.statusCode = gate.statusCode;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(gate.body));
          return;
        }
        const action = gate.action;
        const actorId = gate.actorId;
        const exec = await executeChatApplyAction({
          action,
          fallbackErrorMessage: 'Apply failed.',
          execute: async () => {
            // The SAME per-client apply core — the firm lane is a router,
            // never a second backend.
            const outcome = await applyFeedChatAction({
              ...(action.native_choice ? { nativeMemberId: (await resolveDesktopClientCreationPrincipal({ firmId, principal: access.principal })).principalId } : {}),
              firmId,
              clientId: applyClientId,
              surface: 'firm_feed_chat',
              action,
              actorId,
              messageId,
              actionIndex
            });
            // G0.1 (build-spec PR-5): the receipt's memory packet comes from
            // the action's OWN venture bundle — never the cross-venture
            // union. Selection semantics live in selectFirmApplyFacts
            // (feedChat.js), pinned by feedChatFirm.test.js.
            const applyFacts = selectFirmApplyFacts({
              payload: message?.payload,
              clientId: applyClientId
            });
            await onFeedChatActionApplied({
              firmId,
              clientId: applyClientId,
              action,
              actionIndex,
              messageId,
              model: message?.model || null,
              promptVersion: message?.model_version || null,
              outcome,
              factsAvailable: applyFacts.factsAvailable,
              legacyUnionReceipt: applyFacts.legacyUnionReceipt,
              withClient: withFirmDbClient
            });
            if (!outcome.applied) {
              return {
                respond: {
                  statusCode: 200,
                  body: {
                    applied: false,
                    action_type: action.type,
                    result: outcome.result
                  }
                }
              };
            }
            return { result: outcome.result };
          },
          stamp: {
            write: updateFirmChatActionStatusInDb,
            scope: { firmId, thread: FIRM_FEED_CHAT_THREAD, messageId, actionIndex }
          }
        });
        if (exec.disposition !== 'applied') {
          res.statusCode = exec.statusCode;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(exec.body));
          return;
        }
        const updatedMessage = exec.updatedMessage;
        const snapshot = await getFirmSnapshotFromDb({ firmId });
        res.statusCode = 201;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          assistant_message: updatedMessage,
          applied: true,
          result: exec.executed.result,
          snapshot: filterFirmSnapshotForAccess(snapshot, access)
        }));
      } catch (error) {
        const status = error?.statusCode || 500;
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error' }));
      }
      return;
    }

    // POST /feedback — the in-app Feedback modal (sidebar entry). Meta-product
    // lane: a note ABOUT Donna (bug / idea / thought) landing in user_feedback
    // (migration 115), resting state 'new' = on Kari. Any authenticated firm
    // principal may submit — member or client-scoped collaborator alike, so
    // requireMember stays false; feedback about the product is never
    // books-scoped.
    if (requestUrl.pathname === '/feedback' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readBody();
      const firmId = body?.firm_id || DEFAULT_FIRM_ID;
      const access = await assertFirmAccess({ firmId, auth: req.donnaAuth, clientIds: [] });
      try {
        const result = await recordUserFeedbackInDb({
          firmId,
          kind: body?.kind,
          message: body?.message,
          context: body?.context,
          submittedBy: access.principal?.email || access.principal?.principalType || null
        });
        res.statusCode = 201;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
      } catch (error) {
        const status = error?.statusCode || 500;
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error', code: error?.code }));
      }
      return;
    }

    // POST /whatsapp/connect-token — authenticated portal owner mints a one-time wa.me binding token.
    if (requestUrl.pathname === '/whatsapp/binding-state' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) { whatsappJson(res, 503, { error: 'Firm database is not configured.' }); return; }
      const firmId = resolveRequestFirmId({ query: requestUrl.searchParams, auth: req.donnaAuth });
      const clientId = requestUrl.searchParams.get('client_id') || '';
      if (!clientId) { whatsappJson(res, 400, { error: 'client_id is required.' }); return; }
      await assertFirmAccess({ firmId, auth: req.donnaAuth, clientIds: collectClientIds(clientId) });
      const binding = await getActiveWhatsAppBindingForClientInDb({ firmId, clientId });
      const gateContext = await prefetchOwnerChannelGateContext({
        bindings: [{ client_id: clientId }], firmId,
        loadSnapshot: ({ firmId: scopedFirmId, clientId: scopedClientId }) => withFirmDbClient((client) => readClientConfigSnapshot(client, { firmId: scopedFirmId, clientId: scopedClientId }))
      });
      const acts = ownerChannelAllowsClient({ channel: 'whatsapp', clientId, gateContext, envFallback: whatsappEnvAllowsClient });
      const digits = String(binding?.phone_e164 || '').replace(/\D/g, '');
      whatsappJson(res, 200, {
        channel_acts: acts,
        binding: binding ? { id: binding.id, created_at: binding.created_at || binding.verified_at || null, masked_phone: digits ? `••••${digits.slice(-4)}` : null } : null
      });
      return;
    }

    if (requestUrl.pathname === '/whatsapp/connect-token' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) { whatsappJson(res, 503, { error: 'Firm database is not configured.' }); return; }
      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || '';
      if (!clientId) { whatsappJson(res, 400, { error: 'client_id is required.' }); return; }
      const access = await assertFirmAccess({ firmId, auth: req.donnaAuth, clientIds: collectClientIds(clientId) });
      const actorId = access?.principal?.collaborator?.id || access?.principal?.email || req.donnaAuth?.email || req.donnaAuth?.userId || 'unknown';
      const collaboratorId = access?.principal?.collaborator?.id || null;
      const token = randomBytes(24).toString('base64url');
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      await mintWhatsAppBindTokenInDb({ firmId, clientId, collaboratorId, actorId, tokenHash: hashWhatsAppToken(token), expiresAt });
      const sender = String(process.env.WHATSAPP_SENDER_NUMBER_E164 || '').replace(/^\+/, '');
      const text = `connect ${token}`;
      whatsappJson(res, 201, {
        expires_at: expiresAt,
        prefilled_text: text,
        wa_me_url: sender ? `https://wa.me/${encodeURIComponent(sender)}?text=${encodeURIComponent(text)}` : null
      });
      return;
    }

    // POST /whatsapp/bindings/revoke — authenticated portal owner disconnects WhatsApp.
    if (requestUrl.pathname === '/whatsapp/bindings/revoke' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) { whatsappJson(res, 503, { error: 'Firm database is not configured.' }); return; }
      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || '';
      const bindingId = body?.binding_id || '';
      if (!clientId || !bindingId) { whatsappJson(res, 400, { error: 'client_id and binding_id are required.' }); return; }
      const access = await assertFirmAccess({ firmId, auth: req.donnaAuth, clientIds: collectClientIds(clientId) });
      const actorId = access?.principal?.collaborator?.id || access?.principal?.email || req.donnaAuth?.email || req.donnaAuth?.userId || 'unknown';
      const binding = await revokeWhatsAppBindingInDb({ firmId, clientId, bindingId, actorId });
      whatsappJson(res, binding ? 200 : 404, { revoked: Boolean(binding), binding });
      return;
    }

    // ── Telegram self-serve connect (row 17's last named absence) ────────
    // The WhatsApp trio, mirrored onto the shared binding substrate: the
    // token store is channel-agnostic at mint (the deep link decides where
    // it is redeemed — the Telegram webhook already consumes "/start
    // <token>" with channel='telegram'), bindings live in the same table
    // under the channel discriminator (migration 088), and revoke is by
    // binding id. This retires the script-minted lane
    // (scripts/bind_telegram_chat_directly.js) as the only way to connect.
    if (requestUrl.pathname === '/telegram/binding-state' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) { telegramJson(res, 503, { error: 'Firm database is not configured.' }); return; }
      const firmId = resolveRequestFirmId({ query: requestUrl.searchParams, auth: req.donnaAuth });
      const clientId = requestUrl.searchParams.get('client_id') || '';
      if (!clientId) { telegramJson(res, 400, { error: 'client_id is required.' }); return; }
      await assertFirmAccess({ firmId, auth: req.donnaAuth, clientIds: collectClientIds(clientId) });
      const binding = await getActiveTelegramBindingForClientInDb({ firmId, clientId });
      const gateContext = await prefetchOwnerChannelGateContext({
        bindings: [{ client_id: clientId }], firmId,
        loadSnapshot: ({ firmId: scopedFirmId, clientId: scopedClientId }) => withFirmDbClient((client) => readClientConfigSnapshot(client, { firmId: scopedFirmId, clientId: scopedClientId }))
      });
      const acts = ownerChannelAllowsClient({ channel: 'telegram', clientId, gateContext, envFallback: telegramEnvAllowsClient });
      // phone_e164 carries the Telegram chat_id string (not a phone; see the
      // binding-store header) — mask it the same way for display parity.
      const digits = String(binding?.phone_e164 || '').replace(/\D/g, '');
      telegramJson(res, 200, {
        channel_acts: acts,
        binding: binding ? { id: binding.id, created_at: binding.created_at || binding.verified_at || null, masked_chat_id: digits ? `••••${digits.slice(-4)}` : null } : null
      });
      return;
    }

    if (requestUrl.pathname === '/telegram/connect-token' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) { telegramJson(res, 503, { error: 'Firm database is not configured.' }); return; }
      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || '';
      if (!clientId) { telegramJson(res, 400, { error: 'client_id is required.' }); return; }
      const access = await assertFirmAccess({ firmId, auth: req.donnaAuth, clientIds: collectClientIds(clientId) });
      const actorId = access?.principal?.collaborator?.id || access?.principal?.email || req.donnaAuth?.email || req.donnaAuth?.userId || 'unknown';
      const collaboratorId = access?.principal?.collaborator?.id || null;
      // base64url(24 bytes) = 32 chars — inside Telegram's 64-char start-payload
      // limit and matched by extractTelegramStartToken's [A-Za-z0-9_-]{16,}.
      const token = randomBytes(24).toString('base64url');
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      await mintWhatsAppBindTokenInDb({ firmId, clientId, collaboratorId, actorId, tokenHash: hashWhatsAppToken(token), expiresAt });
      // Same env posture as WHATSAPP_SENDER_NUMBER_E164: a config knob, not a
      // rollout flag. Without it the deep link is null and the card falls back
      // to the manual /start command.
      const botUsername = String(process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '');
      telegramJson(res, 201, {
        expires_at: expiresAt,
        start_command: `/start ${token}`,
        t_me_url: botUsername ? `https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(token)}` : null
      });
      return;
    }

    if (requestUrl.pathname === '/telegram/bindings/revoke' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) { telegramJson(res, 503, { error: 'Firm database is not configured.' }); return; }
      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || '';
      const bindingId = body?.binding_id || '';
      if (!clientId || !bindingId) { telegramJson(res, 400, { error: 'client_id and binding_id are required.' }); return; }
      const access = await assertFirmAccess({ firmId, auth: req.donnaAuth, clientIds: collectClientIds(clientId) });
      const actorId = access?.principal?.collaborator?.id || access?.principal?.email || req.donnaAuth?.email || req.donnaAuth?.userId || 'unknown';
      const binding = await revokeWhatsAppBindingInDb({ firmId, clientId, bindingId, actorId });
      telegramJson(res, binding ? 200 : 404, { revoked: Boolean(binding), binding });
      return;
    }

    // ── Client-portal chat (owner ↔ Donna, Slice 1: read-only Q&A) ──────
    // The owner-facing sibling of the feed chat. Same auth chokepoint as
    // every portal surface (assertFirmAccess scopes a client-scoped
    // collaborator to their own client; a firm member passes for any of
    // their clients) + the billing backstop on the POST. No apply route
    // exists on this surface: the response schema admits no actions and
    // the reply sanitizer drops any the model invents
    // (docs/design-donna-client-portal-chat.md).


    const projectOpenEvidenceTopicsForOwner = (requests = []) => (Array.isArray(requests) ? requests : [])
      // W1 (INV-14): a `draft` is a live question on the owner (never sent yet) —
      // the portal is the one channel it can already reach the owner on.
      .filter((request) => request?.status === 'open' || request?.status === 'draft')
      // 122 — the owner portal shows the owner's OWN questions only: a
      // seat/agent-audience ask is internal and never serialized to the client.
      .filter((request) => (request?.audience || 'client') === 'client')
      .map((request) => {
        const payload = request.request_payload && typeof request.request_payload === 'object' ? request.request_payload : {};
        const topic = payload.evidence_topic && typeof payload.evidence_topic === 'object' ? payload.evidence_topic : null;
        if (!topic || topic.status !== 'open') return null;
        return {
          evidence_request_id: request.id,
          question: request.question || null,
          evidence_type: request.evidence_type || null,
          status: topic.status,
          channel: topic.channel || null,
          current_need: topic.current_need || request.question || null,
          last_owner_message_at: topic.last_owner_message_at || null,
          last_donna_message_at: topic.last_donna_message_at || null,
          last_assessment: topic.last_assessment || null,
          recent_turns: Array.isArray(topic.turns) ? topic.turns.slice(-3) : []
        };
      })
      .filter(Boolean);

    // GET /client-chat?client_id=...
    if (requestUrl.pathname === '/client-chat' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const clientId = requestUrl.searchParams.get('client_id') || '';
      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      if (!clientId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id is required.' }));
        return;
      }
      await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      try {
        const [messages, ownerIntentCandidates, openEvidenceRequests] = await Promise.all([
          getClientPortalChatThreadFromDb({ firmId, clientId }),
          withFirmDbClient((dbClient) => listOwnerIntentProposalCards({
            client: dbClient,
            firmId: firmId || DEFAULT_FIRM_ID,
            clientId,
            status: 'proposed',
            limit: 20
          })).catch((err) => {
            console.warn('[client-chat] owner intent proposal lookup failed', err?.message || err);
            return [];
          }),
          getClientEvidenceRequestsFromDb({ firmId, clientId, status: 'open' })
            .then((result) => (Array.isArray(result?.requests) ? result.requests : []))
            .catch((err) => {
              console.warn('[client-chat] evidence topic lookup failed', err?.message || err);
              return [];
            })
        ]);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          // Internal shadow-analysis stamps (memory_retrieval_shadow, intent_compile)
          // are server-side telemetry on the message payload — stripped before the
          // thread reaches the owner (2c-ii §22: no internal stamp customer-serialized).
          messages: projectClientChatThreadForOwner(messages),
          // Read-only staged owner-intent inbox. These are proposal cards only:
          // no memory promotion, authority materialization, or accounting mutation
          // happens on this GET.
          owner_intent_candidates: ownerIntentCandidates,
          evidence_topics: projectOpenEvidenceTopicsForOwner(openEvidenceRequests),
          appliable_action_types: CLIENT_PORTAL_CHAT_APPLIABLE_ACTION_TYPES
        }));
      } catch (error) {
        const status = error?.statusCode || 500;
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error' }));
      }
      return;
    }

    // POST /client-chat/messages
    if (requestUrl.pathname === '/client-chat/messages' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || '';
      const userMessage = typeof body?.message === 'string' ? body.message : '';
      if (!clientId || !userMessage.trim()) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id and a non-empty message are required.' }));
        return;
      }
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      // Same billing backstop as the portal's other value endpoints
      // (documents/register): a client-scoped owner on an inactive plan
      // gets a 402, a firm member is exempt, and it is a no-op until
      // billing is enabled.
      await assertClientEntitled({
        firmId,
        clientId,
        principal: access.principal,
        billingEnabled: isBillingEnabled()
      });
      // Actor attribution from day one: WHO typed this turn rides the
      // row (actor_type) and its payload (actor_id) — the owner is a
      // client-scoped collaborator ('client'); a firm member reading the
      // owner's thread from the console stamps 'firm'.
      const actorType = access.principal?.principalType === 'firm_collaborator' ? 'client' : 'firm';
      const actorAttribution = ownerActorAttribution({ principal: access.principal, auth: req.donnaAuth });
      const actorId = actorAttribution.actor_id;
      try {
        const userMessageRow = await appendClientPortalChatMessageInDb({
          firmId,
          clientId,
          id: newClientPortalChatMessageId({ clientId, kind: 'user' }),
          role: 'user',
          content: userMessage.trim(),
          payload: { actor_id: actorId },
          actorType
        });
        const {
          context,
          history,
          validAskIds,
          assistantName,
          ownerMemory,
          memoryRetrievalSnapshot,
          selfKnowledge,
          knowledgeGrounding,
          firmFacts,
          effectiveFirmId
        } = await assembleClientPortalTurn({
          firmId,
          clientId,
          userMessageRow,
          ownerPrincipal: access.principal,
          now: new Date()
        });
        // A `blocked` memory status (integrity / identity) → a controlled
        // memory-unavailable response, WITHOUT calling the model (§D). No legacy
        // fallback, no memory-dependent answer.
        if (ownerMemory?.shortCircuit) {
          const controlledMessage = await appendClientPortalChatMessageInDb({
            firmId,
            clientId,
            id: newClientPortalChatMessageId({ clientId, kind: 'assistant' }),
            role: 'assistant',
            content: controlledMemoryUnavailableText(),
            payload: { actions: [], memory_status: 'blocked' },
            actorType: 'system'
          });
          res.statusCode = 201;
          res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          user_message: userMessageRow,
          assistant_message: controlledMessage,
          owner_intent_candidates: await withFirmDbClient((dbClient) => listOwnerIntentProposalCards({
            client: dbClient,
            firmId: firmId || DEFAULT_FIRM_ID,
            clientId,
            status: 'proposed',
            limit: 20
          })).catch(() => []),
          appliable_action_types: CLIENT_PORTAL_CHAT_APPLIABLE_ACTION_TYPES
        }));
          return;
        }
        const reply = await generateClientPortalChatReply({
          context: ownerMemory?.promptContext || context,
          history: ownerMemory?.promptHistory || history.slice(0, -1),
          userMessage: userMessage.trim(),
          // The anti-self-licensing gate: a proposed answer may target
          // ONLY an ask that was actually in this turn's context.
          validAskIds,
          // D-PA-3: the owner's chosen name for their assistant (profile
          // jsonb; resolved + sanitized in clientPortalChat, 'Donna' default).
          assistantName,
          // BizOS 2c-iii — the governed v2 memory block (system-prompt appendix)
          // for a canaried client, composed with the flag-gated operational
          // self-knowledge block (selfKnowledge.js); null/null (every un-staged
          // client) keeps the prompt byte-identical. share_portal_link stays
          // sanitized out here (allowPortalLink defaults false): the owner is
          // already in the portal.
          // Audit L4 — the K1 sourced-knowledge grounding block. The seam
          // computed it and the turn returned it, but nothing consumed it: a
          // grounded answer never reached a prompt. null (flag off / no
          // question / seam failure) keeps the prompt byte-identical.
          memoryExtra: [ownerMemory?.systemPromptExtra, selfKnowledge?.systemPromptExtra, knowledgeGrounding?.answer?.grounding_block]
            .filter(Boolean).join('\n\n') || null
        });
        if (reply.kind !== 'ok') {
          const diagnostic = reply.diagnostic || null;
          const failureContent = diagnostic
            ? `Chat unavailable: ${reply.reason || reply.code || 'unknown'} (model=${diagnostic.model || 'unknown'}, stop_reason=${diagnostic.stop_reason || 'unknown'}).`
            : `Chat unavailable: ${reply.reason || reply.code || 'unknown'}.`;
          const failureMessage = await appendClientPortalChatMessageInDb({
            firmId,
            clientId,
            id: newClientPortalChatMessageId({ clientId, kind: 'system' }),
            role: 'system',
            content: failureContent,
            payload: { failure_code: reply.code || 'unknown', ...(diagnostic ? { diagnostic } : {}) },
            actorType: 'system'
          });
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            error: reply.reason || 'Chat unavailable.',
            failure_code: reply.code || 'unknown',
            ...(diagnostic ? { diagnostic } : {}),
            user_message: userMessageRow,
            system_message: failureMessage
          }));
          return;
        }
        // `today` = the anchor the model saw this turn; stamped onto the
        // persisted report_request receipt (requested_today) so period-vs-now
        // drift is queryable from data (the "this year → 2025" incident class).
        const reportRequest = findClientPortalReportRequest(reply, {
          today: (ownerMemory?.promptContext || context)?.today
        });
        let finalReply = reply;
        let reportResult = null;
        if (reportRequest) {
          try {
            reportResult = await getFinancialReportFromDb({
              firmId,
              clientId,
              periodStart: reportRequest.period_start,
              periodEnd: reportRequest.period_end,
              basis: reportRequest.basis
            });
          } catch (error) {
            console.warn('[client-chat] report read failed', error?.message || error);
            const failureMessage = await appendClientPortalChatMessageInDb({
              firmId,
              clientId,
              id: newClientPortalChatMessageId({ clientId, kind: 'system' }),
              role: 'system',
              content: 'Report unavailable: couldn\'t run that report.',
              payload: { failure_code: 'report_read_failed', report_request: reportRequest },
              actorType: 'system'
            });
            res.statusCode = 502;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              error: 'Report unavailable: couldn\'t run that report.',
              failure_code: 'report_read_failed',
              user_message: userMessageRow,
              system_message: failureMessage
            }));
            return;
          }
          const narration = await generateClientPortalReportNarration({
            context: ownerMemory?.promptContext || context,
            report: reportResult,
            request: reportRequest,
            userMessage: userMessage.trim(),
            assistantName
          });
          if (narration.kind !== 'ok') {
            const failureMessage = await appendClientPortalChatMessageInDb({
              firmId,
              clientId,
              id: newClientPortalChatMessageId({ clientId, kind: 'system' }),
              role: 'system',
              content: `Report unavailable: ${narration.reason || narration.code || 'unknown'}.`,
              payload: { failure_code: narration.code || 'report_narration_failed', report_request: reportRequest },
              actorType: 'system'
            });
            res.statusCode = 502;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              error: narration.reason || 'Report unavailable.',
              failure_code: narration.code || 'report_narration_failed',
              user_message: userMessageRow,
              system_message: failureMessage
            }));
            return;
          }
          finalReply = narration;
        }
        const assistantMessage = await appendClientPortalChatMessageInDb({
          firmId,
          clientId,
          id: newClientPortalChatMessageId({ clientId, kind: 'assistant' }),
          role: 'assistant',
          content: finalReply.text,
          payload: {
            actions: finalReply.actions,
            ...(reportRequest ? { report_request: reportRequest, report_result: { period_start: reportResult?.period_start || null, period_end: reportResult?.period_end || null, draft: reportResult?.draft || null } } : {}),
            // The capability-context version is part of the receipt (like the
            // model id): which self-knowledge pack the model answered from.
            ...(selfKnowledge ? { self_knowledge: selfKnowledge.receipt } : {}),
            // K1 grounding receipt — which sources (if any) grounded this
            // answer, and the outcome floor the corpus permitted.
            ...(knowledgeGrounding?.receipt ? { knowledge_grounding: knowledgeGrounding.receipt } : {})
          },
          model: finalReply.model || reply.model,
          actorType: 'llm'
        });
        res.statusCode = 201;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          user_message: userMessageRow,
          assistant_message: assistantMessage,
          owner_intent_candidates: await withFirmDbClient((dbClient) => listOwnerIntentProposalCards({
            client: dbClient,
            firmId: firmId || DEFAULT_FIRM_ID,
            clientId,
            status: 'proposed',
            limit: 20
          })).catch(() => []),
          appliable_action_types: CLIENT_PORTAL_CHAT_APPLIABLE_ACTION_TYPES
        }));
        // BizOS Slice 1c — the intent-compiler shadow SIDECAR, at the normalized
        // owner-message seam (portal is the first ingress; WhatsApp calls this SAME
        // function when its activation follows). Observational only: fires AFTER the
        // response (owner latency untouched), post-commit, own connection, no-throw by
        // contract; fully dormant unless INTENT_COMPILER_SHADOW is staged for this
        // client on the config plane. Live routing/execution of compiled objects is a
        // different, born-dark flag (INTENT_OBJECT_ROUTING) in a later slice.
        await onOwnerMessagePersisted({
          firmId,
          clientId,
          channel: 'client_chat',
          sourceMessageId: userMessageRow.id,
          ownerText: userMessage.trim(),
          ownerActorId: actorId,
          sourceMessageCreatedAt: userMessageRow.created_at || null,
          history: history.slice(0, -1),
          deps: { withFirmDbClient }
        });
        // BizOS 2c-ii — the governed-memory-retrieval SHADOW sidecar, on the
        // snapshot captured above. Observational only: fires AFTER the response
        // (owner latency untouched), post-commit, own connection, no-throw; fully
        // dormant unless MEMORY_RETRIEVAL_V2 is staged for this client on the
        // config plane. Stamps metadata-only telemetry beside the untouched legacy
        // prompt — nothing the model saw changes. Live prompt replacement is a
        // separately-approved 2c-iii wiring (clientFlagActs), NOT here.
        await onOwnerTurnMemoryShadow({
          firmId: effectiveFirmId,
          clientId,
          snapshot: memoryRetrievalSnapshot,
          channel: 'client_chat',
          // BizOS 2c-iii Slice A — the assistant answer this turn produced (linkage
          // only; the answer text lives on the immutable assistant row) and the real
          // firm_facts rows, for the immutable replay-evidence capture (§16).
          answer: { messageId: assistantMessage.id, content: finalReply.text, modelId: finalReply.model || reply.model || null },
          firmFacts,
          deps: { withFirmDbClient }
        });
      } catch (error) {
        const status = error?.statusCode || 500;
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error' }));
      }
      return;
    }

    // POST /client-chat/owner-intent-proposals/:proposalId/preflight — read-only
    // accept-time preparation for staged owner-intent cards. The route re-reads the
    // proposal from durable storage and appends a visible check report; it does not
    // execute accounting mutations, materialize authority, or promote memory.
    const ownerIntentPreflightMatch = requestUrl.pathname.match(/^\/client-chat\/owner-intent-proposals\/([^/]+)\/preflight$/);
    if (ownerIntentPreflightMatch && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const proposalId = decodeURIComponent(ownerIntentPreflightMatch[1]);
      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || '';
      if (!clientId || !proposalId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id and proposal_id are required.' }));
        return;
      }
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      await assertClientEntitled({
        firmId,
        clientId,
        principal: access.principal,
        billingEnabled: isBillingEnabled()
      });
      try {
        const actor = ownerActorAttribution({ principal: access.principal, auth: req.donnaAuth });
        const result = await withFirmDbClient((dbClient) => prepareOwnerIntentProposalPreflight({
          client: dbClient,
          firmId: firmId || DEFAULT_FIRM_ID,
          clientId,
          proposalId,
          actor,
          now: new Date().toISOString()
        }));
        if (result.status === 'refused') {
          res.statusCode = result.statusCode || 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: result.reason || 'Owner-intent proposal refused.', preflight: result.preflight || null }));
          return;
        }
        const ownerIntentCandidates = await withFirmDbClient((dbClient) => listOwnerIntentProposalCards({
          client: dbClient,
          firmId: firmId || DEFAULT_FIRM_ID,
          clientId,
          status: 'proposed',
          limit: 20
        })).catch((err) => {
          console.warn('[client-chat] owner intent proposal lookup after preflight failed', err?.message || err);
          return [];
        });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          prepared: true,
          preflight: result.preflight,
          owner_intent_candidates: ownerIntentCandidates
        }));
      } catch (error) {
        const status = error?.statusCode || 500;
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error' }));
      }
      return;
    }

    // POST /client-chat/owner-intent-proposals/:proposalId/accept — owner
    // attempts to accept a staged card. This re-runs fresh preflight and
    // persists a visible refusal/check report while the apply executor is not
    // attached; it never executes writers or materializes authority.
    const ownerIntentAcceptMatch = requestUrl.pathname.match(/^\/client-chat\/owner-intent-proposals\/([^/]+)\/accept$/);
    if (ownerIntentAcceptMatch && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const proposalId = decodeURIComponent(ownerIntentAcceptMatch[1]);
      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || '';
      if (!clientId || !proposalId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id and proposal_id are required.' }));
        return;
      }
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      await assertClientEntitled({
        firmId,
        clientId,
        principal: access.principal,
        billingEnabled: isBillingEnabled()
      });
      try {
        const actor = ownerActorAttribution({ principal: access.principal, auth: req.donnaAuth });
        const result = await withFirmDbClient((dbClient) => attemptOwnerIntentProposalAccept({
          client: dbClient,
          firmId: firmId || DEFAULT_FIRM_ID,
          clientId,
          proposalId,
          actor,
          now: new Date().toISOString()
        }));
        if (result.status === 'refused' && result.reason === 'proposal_not_found') {
          res.statusCode = result.statusCode || 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: result.reason, preflight: result.preflight || null }));
          return;
        }
        const ownerIntentCandidates = await withFirmDbClient((dbClient) => listOwnerIntentProposalCards({
          client: dbClient,
          firmId: firmId || DEFAULT_FIRM_ID,
          clientId,
          status: 'proposed',
          limit: 20
        })).catch((err) => {
          console.warn('[client-chat] owner intent proposal lookup after accept attempt failed', err?.message || err);
          return [];
        });
        res.statusCode = result.statusCode || 409;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          applied: false,
          status: result.status,
          reason: result.reason,
          preflight: result.preflight,
          owner_intent_candidates: ownerIntentCandidates
        }));
      } catch (error) {
        const status = error?.statusCode || 500;
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error' }));
      }
      return;
    }

    // POST /client-chat/owner-intent-proposals/:proposalId/withdraw — explicit
    // owner skip for a staged owner-intent card. This is a terminal proposal-card
    // transition only: no accounting writer, authority grant, or memory promotion.
    const ownerIntentWithdrawMatch = requestUrl.pathname.match(/^\/client-chat\/owner-intent-proposals\/([^/]+)\/withdraw$/);
    if (ownerIntentWithdrawMatch && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const proposalId = decodeURIComponent(ownerIntentWithdrawMatch[1]);
      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || '';
      const reason = typeof body?.reason === 'string' ? body.reason : 'owner_skipped';
      if (!clientId || !proposalId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id and proposal_id are required.' }));
        return;
      }
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      await assertClientEntitled({
        firmId,
        clientId,
        principal: access.principal,
        billingEnabled: isBillingEnabled()
      });
      try {
        const actor = ownerActorAttribution({ principal: access.principal, auth: req.donnaAuth });
        const result = await withFirmDbClient((dbClient) => withdrawOwnerIntentProposalCard({
          client: dbClient,
          firmId: firmId || DEFAULT_FIRM_ID,
          clientId,
          proposalId,
          actor,
          reason
        }));
        if (result.status === 'refused') {
          res.statusCode = result.statusCode || 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: result.reason || 'Owner-intent proposal refused.' }));
          return;
        }
        const ownerIntentCandidates = await withFirmDbClient((dbClient) => listOwnerIntentProposalCards({
          client: dbClient,
          firmId: firmId || DEFAULT_FIRM_ID,
          clientId,
          status: 'proposed',
          limit: 20
        })).catch((err) => {
          console.warn('[client-chat] owner intent proposal lookup after withdraw failed', err?.message || err);
          return [];
        });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          withdrawn: true,
          proposal_id: result.proposal_id,
          owner_intent_candidates: ownerIntentCandidates
        }));
      } catch (error) {
        const status = error?.statusCode || 500;
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error' }));
      }
      return;
    }

    // POST /client-chat/messages/:messageId/actions/:index/apply — the
    // owner CONFIRMS a proposed answer card. Fourth consumer of the
    // chat-apply spine: compile from the PERSISTED message, authorize
    // against the OWNER grammar (assertClientChatActionCapability — the
    // operator viewer/reviewer/founder ladder deliberately does not
    // apply here), execute through the SAME resolve → recode writer an
    // upload reply uses, stamp + audit through the spine. The body lives
    // in clientChatApply.js (applyClientChatAction) since slice 3 of the
    // hosted chat surface, because the confirm_action MCP tool is the same
    // owner confirming the same proposal through another door — one apply
    // path, two doors. chatApplySpine.test.js lints that file as it lints
    // this route.
    const clientChatApplyMatch = requestUrl.pathname.match(/^\/client-chat\/messages\/([^/]+)\/actions\/(\d+)\/apply$/);
    if (clientChatApplyMatch && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const messageId = decodeURIComponent(clientChatApplyMatch[1]);
      const actionIndex = Number(clientChatApplyMatch[2]);
      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || '';
      if (!clientId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'client_id is required.' }));
        return;
      }
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      await assertClientEntitled({
        firmId,
        clientId,
        principal: access.principal,
        billingEnabled: isBillingEnabled()
      });
      try {
        // The apply body is ONE function shared with the hosted chat surface's
        // confirm_action tool (clientChatApply.js — the same gate, writers,
        // stamp and audit; only `surface` names the door). The response
        // bodies are unchanged.
        const outcome = await applyClientChatAction({
          firmId,
          clientId,
          messageId,
          actionIndex,
          principal: access.principal,
          surface: 'client_chat'
        });
        res.statusCode = outcome.statusCode;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(outcome.body));
      } catch (error) {
        const status = error?.statusCode || 500;
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error' }));
      }
      return;
    }

    // POST /transaction-chat/ask-client
    //   — Direct send. The firm has drafted a question for the client
    //     and wants to ship it without an LLM round-trip ("Ask client
    //     about this" pill in the artifact). This handler:
    //       1. creates the actual evidence request (the same writer
    //          used by the standalone /evidence/requests POST)
    //       2. persists the firm's question as a user message in
    //          transaction_chat_messages so the case-file thread
    //          reflects what was sent
    //       3. persists a system confirmation message so the chat
    //          renders "Question sent to client" inline
    //
    //     Skips the LLM entirely — no proposed action card, no Apply
    //     gate. The user message's payload carries the evidence
    //     request id so a follow-up reply can be threaded back into
    //     the same chat.
    if (requestUrl.pathname === '/transaction-chat/ask-client' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || '';
      const transactionId = body?.transaction_id || '';
      const question = typeof body?.question === 'string' ? body.question.trim() : '';
      const evidenceType = body?.evidence_type || 'business_purpose';
      if (!clientId || !transactionId || !question) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          error: 'client_id, transaction_id, and a non-empty question are required.'
        }));
        return;
      }
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      const actorId = access.principal?.email
        || access.principal?.userId
        || access.principal?.principalId
        || 'system';
      try {
        const evidenceResult = await createClientEvidenceRequestInDb({
          firmId,
          clientId,
          transactionId,
          question,
          evidenceType,
          actorId
        });
        const evidenceRequest = evidenceResult.evidence_request || null;
        const evidenceRequestId = evidenceRequest?.id || null;
        // Persist the firm's question as a user message. The payload
        // marks it as a client-bound send so the FE can render a
        // small "→ client" indicator and so a follow-up client reply
        // can later be threaded back into the same chat by the
        // evidence_request_id link.
        const userMessage = await appendTransactionChatMessageInDb({
          firmId,
          clientId,
          transactionId,
          id: newTransactionChatMessageId({ transactionId, kind: 'user' }),
          role: 'user',
          content: question,
          payload: {
            kind: 'client_question_sent',
            evidence_request_id: evidenceRequestId,
            evidence_type: evidenceType
          },
          actorType: 'firm'
        });
        // No system confirmation message: the firm's user_message
        // already carries `payload.kind='client_question_sent'`,
        // which the FE renders as a purple bubble with a
        // "→ Sent to client" eyebrow. A second "Question sent. Awaiting
        // reply." chip below it was redundant chrome.
        //
        // Channel fan-out — the SAME deliverers the ask-batch send runs, each
        // self-gating (binding / env / config-plane flag). Before this the
        // verb stopped at the DB and the ask reached the owner only on their
        // next portal visit (audit §4). Fail-soft: a fan-out failure never
        // unwinds the ask; the receipt says what left.
        let channelFanout = null;
        if (evidenceRequestId) {
          channelFanout = await withFirmDbClient((dbClient) =>
            deliverEvidenceAsksOnAllChannels({
              client: dbClient,
              firmId: evidenceRequest?.firm_id || firmId || DEFAULT_FIRM_ID,
              clientId,
              evidenceRequestIds: [evidenceRequestId]
            })
          ).catch((error) => ({ error: error?.message || 'fanout_failed' }));
        }
        res.statusCode = 201;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          user_message: userMessage,
          evidence_request: evidenceRequest,
          channel_fanout: channelFanout,
          snapshot: filterFirmSnapshotForAccess(evidenceResult.snapshot, access)
        }));
      } catch (error) {
        const status = error?.statusCode || 500;
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error' }));
      }
      return;
    }

    const reconciliationMatch = requestUrl.pathname.match(/^\/reconciliation-matches\/([^/]+)$/);
    if (reconciliationMatch && req.method === 'PATCH') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const matchId = decodeURIComponent(reconciliationMatch[1]);
      const currentSnapshot = await getFirmSnapshotFromDb({ firmId });
      const match = (currentSnapshot.reconciliationMatches || []).find((item) => item.id === matchId);
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(match?.client_id)
      });
      const snapshot = await updateReconciliationMatchInDb({
        firmId,
        matchId,
        patch: body?.patch && typeof body.patch === 'object' ? body.patch : {}
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(filterFirmSnapshotForAccess(snapshot, access)));
      return;
    }

    // Reconciliation PR 5 — firm commit/discard for proposed learned
    // rules. Accepts only proposed→active or proposed→retired; the
    // writer returns 409 on any other prior status so the FE surfaces
    // a clear error rather than corrupting state.
    const clientRuleMatch = requestUrl.pathname.match(/^\/client-rules\/([^/]+)$/);
    if (clientRuleMatch && req.method === 'PATCH') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const ruleId = decodeURIComponent(clientRuleMatch[1]);
      const currentSnapshot = await getFirmSnapshotFromDb({ firmId });
      const rule = (currentSnapshot.clientRules || []).find((item) => item.id === ruleId);
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(rule?.client_id)
      });

      const patch = body?.patch && typeof body.patch === 'object' ? body.patch : {};
      const nextStatus = String(patch.status || '').trim();
      try {
        const result = await updateClientRuleStatusInDb({
          firmId,
          ruleId,
          nextStatus
        });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(filterFirmSnapshotForAccess(result.snapshot, access)));
      } catch (error) {
        const status = error?.statusCode || 500;
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error' }));
      }
      return;
    }

    const transactionReviewMatch = requestUrl.pathname.match(/^\/transaction-review\/([^/]+)$/);
    if (transactionReviewMatch && req.method === 'PATCH') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const reviewItemId = decodeURIComponent(transactionReviewMatch[1]);
      const reviewItem = (await queryFirmDb('select client_id from transaction_review_queue where firm_id=$1 and id=$2',
        [firmId || DEFAULT_FIRM_ID,reviewItemId])).rows[0];
      if (!reviewItem) throw Object.assign(new Error('Review item not found.'), {statusCode:404});
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(reviewItem?.client_id),
        requireMember: Boolean(body?.patch?.tax_posting_facts)
      });
      const reviewPrincipal = await resolveDesktopClientCreationPrincipal({ firmId, principal: access.principal });
      if (body?.patch?.tax_posting_facts) await assertActionCapability({ firmId, clientId: reviewItem?.client_id,
        principal: reviewPrincipal, actionType: 'recode_decided' });
      const snapshot = await updateTransactionReviewItemInDb({
        firmId,
        reviewItemId,
        actorId: reviewPrincipal.principalId,
        reviewAuthority: {clientId:reviewItem.client_id,principal:reviewPrincipal},
        patch: body?.patch && typeof body.patch === 'object' ? body.patch : {}
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(filterFirmSnapshotForAccess(snapshot, access)));
      return;
    }

    // ── Ask-pipeline batches ─────────────────────────────────────────
    //
    // GET  /ask-batches                 — list batches for a client
    // POST /ask-batches/draft           — draft ONE client message per
    //      period from the persisted coding verdicts (strong-LLM call;
    //      503 when the provider is unavailable — no fallback drafter)
    // POST /ask-batches/{id}/send       — turn the draft's 'ask' items
    //      and statement requests into client_evidence_requests rows
    //      and mark the batch sent

    if (requestUrl.pathname === '/ask-batches' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = requestUrl.searchParams.get('client_id') || requestUrl.searchParams.get('clientId') || '';
      await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      try {
        const payload = await getClientAskBatchesFromDb({
          firmId,
          clientId,
          status: requestUrl.searchParams.get('status') || undefined
        });
        payload.provider_failures = await getProviderFailuresFromDb({
          firmId: firmId || DEFAULT_FIRM_ID, clientId: payload.client_id
        });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(payload));
      } catch (error) {
        res.statusCode = error?.statusCode || 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error', code: error?.code }));
      }
      return;
    }

    if (requestUrl.pathname === '/ask-batches/draft' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || body?.clientId || '';
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      const actorId = access.principal?.email
        || access.principal?.userId
        || access.principal?.principalId
        || 'system';
      try {
        const result = await draftClientAskBatchInDb({
          firmId,
          clientId,
          periodStart: body?.period_start || body?.periodStart || null,
          periodEnd: body?.period_end || body?.periodEnd || null,
          actorId
        });
        res.statusCode = result.batch ? 201 : 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
      } catch (error) {
        res.statusCode = error?.statusCode || 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error?.message || 'Unknown error', code: error?.code }));
      }
      return;
    }

    const askBatchSendMatch = requestUrl.pathname.match(/^\/ask-batches\/([^/]+)\/send$/);
    if (askBatchSendMatch && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || body?.clientId || '';
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      const actorId = access.principal?.email
        || access.principal?.userId
        || access.principal?.principalId
        || 'system';
      try {
        // External chase fence (build spec §4.6): the batch SEND is the
        // release door — an external seat needs the firm's
        // EXTERNAL_SEAT_CHASE_RELEASE toggle on; otherwise 403 + receipt,
        // and an internal seat releases the draft.
        await assertExternalChaseReleaseAllowed({ firmId, clientId, principal: access.principal });
        const batch = await sendClientAskBatchInDb({
          firmId,
          batchId: decodeURIComponent(askBatchSendMatch[1]),
          clientId,
          actorId
        });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ batch }));
      } catch (error) {
        // ASK_BATCH_STALE: the send writer already committed the supersede, so
        // the firm's live draft is GONE by the time we get here. The auto-send
        // producer heals this by asking for one fresh draft (askAutoSendProducer
        // -> requestRedraftFn); the manual route did not, which left the user
        // with no draft and no pending work -- a row resting on nobody.
        //
        // Request the re-draft through the SAME seam the auto path uses: the
        // durable ask_draft.requested outbox, which re-gates per firm, coalesces
        // with any in-flight request, and heals with no surface mounted. That is
        // the recorded "server-side re-draft on verdict movement" open, closed at
        // the point where the staleness is actually detected rather than by a
        // third parallel mechanism.
        //
        // Best-effort by construction: the producer is no-throw (runShadow) and
        // this catch must never turn the honest 409 into a 500. It reports
        // whether a request was actually enqueued -- the gate can decline
        // (tier below canary, parse quiescence) -- so the surface can say the
        // true thing instead of promising a draft that is not coming.
        let redraftRequested = false;
        if (error?.code === 'ASK_BATCH_STALE') {
          try {
            const requested = await withFirmDbClient((client) =>
              onReconcileCompleteRequestAskDraft({
                client, firmId, clientId, source: 'stale_manual_send'
              })
            );
            redraftRequested = Number(requested?.enqueued || 0) > 0;
          } catch (redraftError) {
            try {
              console.warn(`[askBatchSend] stale batch redraft request failed: ${redraftError?.message || redraftError}`);
            } catch { /* never throw from the logger */ }
          }
        }
        res.statusCode = error?.statusCode || 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          error: error?.message || 'Unknown error',
          code: error?.code,
          ...(error?.code === 'ASK_BATCH_STALE' ? { redraft_requested: redraftRequested } : {})
        }));
      }
      return;
    }

    if (requestUrl.pathname === '/evidence/requests' && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const clientId = requestUrl.searchParams.get('client_id') || requestUrl.searchParams.get('clientId') || '';
      await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      const payload = await getClientEvidenceRequestsFromDb({
        firmId,
        clientId,
        status: requestUrl.searchParams.get('status') || undefined,
        periodStart: requestUrl.searchParams.get('period_start') || requestUrl.searchParams.get('periodStart') || undefined,
        periodEnd: requestUrl.searchParams.get('period_end') || requestUrl.searchParams.get('periodEnd') || undefined
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(payload));
      return;
    }

    if (requestUrl.pathname === '/evidence/requests' && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const clientId = body?.client_id || body?.clientId || '';
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(clientId)
      });
      const actorId = access.principal?.email || access.principal?.userId || access.principal?.principalId || 'system';
      const result = await createClientEvidenceRequestInDb({
        firmId,
        clientId,
        transactionId: body?.transaction_id || body?.transactionId || undefined,
        reviewItemId: body?.review_item_id || body?.reviewItemId || undefined,
        question: body?.question || body?.client_question || body?.clientQuestion || '',
        evidenceType: body?.evidence_type || body?.evidenceType || undefined,
        dueAt: body?.due_at || body?.dueAt || undefined,
        actorId
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        ...filterFirmSnapshotForAccess(result.snapshot, access),
        evidence_request: result.evidence_request
      }));
      return;
    }

    const evidenceResolveMatch = requestUrl.pathname.match(/^\/evidence\/requests\/([^/]+)\/resolve$/);
    if (evidenceResolveMatch && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const body = await readBody();
      const firmId = body?.firm_id || DEFAULT_FIRM_ID;
      const evidenceRequestId = decodeURIComponent(evidenceResolveMatch[1]);
      const currentSnapshot = await getFirmSnapshotFromDb({ firmId });
      const evidenceRequest = (currentSnapshot.clientEvidenceRequests || []).find((item) => item.id === evidenceRequestId);
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(evidenceRequest?.client_id)
      });
      await assertClientEntitled({
        firmId,
        clientId: evidenceRequest?.client_id,
        principal: access.principal,
        billingEnabled: isBillingEnabled()
      });
      const structuredReply = supportsStructuredOwnerReply(evidenceRequest);
      const replyPrincipal = await resolveDesktopClientCreationPrincipal({ firmId, principal: access.principal });
      // The appliance token authenticates transport; the persisted answering
      // human is the same current member resolved by setup/review intake.
      const actorId = replyPrincipal?.authenticatedVia === 'desktop_access_token'
        ? replyPrincipal.principalId
        : replyPrincipal?.email || replyPrincipal?.userId || replyPrincipal?.principalId || 'system';
      if (structuredReply) await withFirmDbClient(async client => {
        const source = (await client.query('select jurisdiction, profile from clients where firm_id=$1 and id=$2', [firmId, evidenceRequest?.client_id])).rows[0];
        const adapter = resolveStructuredOwnerReplyAdapter({ jurisdiction: source?.jurisdiction, evidenceType: evidenceRequest?.evidence_type, request: evidenceRequest });
        if (adapter?.authorize) await adapter.authorize({ client, firmId, request: evidenceRequest, actorId });
      });
      const replyText = String(body?.reply || body?.client_reply || body?.clientReply || '').trim();
      const documentIds = Array.isArray(body?.document_ids)
        ? body.document_ids
        : (Array.isArray(body?.documentIds) ? body.documentIds : []);
      // A1 (asks design Phase 0) — "Record client's answer". A firm principal
      // relaying an answer the client gave out-of-band (phone / the firm's own
      // email / in person). Presence of a valid answer_source IS the lane
      // switch: it bypasses the portal topic-turn branch below (the firm is
      // recording a COMPLETE answer, not chatting) and resolves with firm
      // attribution — actor_type 'firm', actor_id = the authenticated
      // principal, source on the response payload and the audit row.
      const answerSource = __normalizeAnswerSource(
        body?.answer_source || body?.answerSource || ''
      );
      if (evidenceRequest?.evidence_type === 'ae_opening_balance') {
        const openingPrincipal = await resolveDesktopClientCreationPrincipal({ firmId, principal: access.principal });
        const result = await actAeOpeningFromDb({ firmId, clientId: evidenceRequest.client_id,
          actorId: openingPrincipal?.principalId, authorityBasis: { source: 'owner_portal_intake' },
          action: 'reply', askId: evidenceRequestId, reply: replyText });
        const updatedSnapshot = await getFirmSnapshotFromDb({ firmId });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ...filterFirmSnapshotForAccess(updatedSnapshot, access), opening_balance: result }));
        return;
      }

      const portalTurn = assessEvidenceTopicTurn({
        ask: evidenceRequest,
        text: replyText,
        descriptor: documentIds.length > 0 ? { kind: 'document', id: documentIds[0] } : null
      });

      if (!answerSource && (evidenceRequest?.status === 'open' || evidenceRequest?.status === 'draft')
        && !(replyText && supportsStructuredOwnerReply(evidenceRequest)) && !portalTurn.terminal) {
        const topicState = buildEvidenceTopicState({
          ask: evidenceRequest,
          turn: { ...portalTurn, text: replyText },
          now: new Date().toISOString(),
          channel: 'portal',
          actorId,
          inboundMessageId: body?.message_id || body?.messageId || null,
          documentIds
        });
        const recorded = await recordEvidenceTopicTurnInDb({
          firmId,
        replyAuthority: { principal: replyPrincipal, source: 'authenticated_evidence_route' },
          evidenceRequestId,
          topicState,
          actorId,
          actorType: 'client'
        });
        const updatedSnapshot = await getFirmSnapshotFromDb({ firmId });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          ...filterFirmSnapshotForAccess(updatedSnapshot, access),
          evidence_request: recorded.evidence_request,
          evidence_topic: recorded.evidence_topic,
          status: 'topic_open'
        }));
        return;
      }

      const result = await resolveClientEvidenceRequestInDb({
        firmId,
        replyAuthority: { principal: replyPrincipal, source: 'authenticated_evidence_route' },
        evidenceRequestId,
        reply: replyText,
        documentIds,
        nextReviewState: body?.review_state || body?.reviewState || undefined,
        resolutionNote: body?.resolution_note || body?.resolutionNote || '',
        actorId,
        actorType: answerSource ? 'firm' : 'client',
        ...(answerSource ? { answerSource } : {})
      });

      // Bridge the reply back into the transaction chat. When the
      // resolved evidence request carries a transaction_id, append a
      // `client_reply_received` system message to
      // transaction_chat_messages so the firm sees the reply in the
      // same case-file thread where they originally drafted the
      // question. Best-effort: a failed append here doesn't fail the
      // resolve (reply is already saved on the evidence_request row).
      const resolvedRequest = result.evidence_request || null;
      if (resolvedRequest?.transaction_id && resolvedRequest?.client_id) {
        try {
          const docIds = documentIds;
          let content = replyText;
          if (!content) {
            if (docIds.length > 0) {
              content = `Client uploaded ${docIds.length} document${docIds.length === 1 ? '' : 's'} in response.`;
            } else {
              content = 'Client marked this resolved.';
            }
          }
          if (answerSource) {
            const sourceLabel = answerSource.replace(/_/g, ' ');
            content = `Client's answer, recorded by the firm (${sourceLabel}): ${replyText || '(no text)'}`;
          }
          await appendTransactionChatMessageInDb({
            firmId,
            clientId: resolvedRequest.client_id,
            transactionId: resolvedRequest.transaction_id,
            id: newTransactionChatMessageId({
              transactionId: resolvedRequest.transaction_id,
              kind: 'system'
            }),
            role: 'system',
            content,
            payload: {
              kind: 'client_reply_received',
              evidence_request_id: resolvedRequest.id,
              document_ids: docIds,
              has_reply_text: replyText.length > 0,
              ...(answerSource ? { answer_source: answerSource, recorded_by: actorId } : {})
            },
            actorType: 'system'
          });
        } catch (chatErr) {
          // Threading is best-effort. The reply is already persisted
          // on the evidence_request; the firm can still see it via
          // the evidence queue. Log so we notice repeated failures.
          console.warn('Failed to thread client reply into transaction chat.', chatErr);
        }
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        ...filterFirmSnapshotForAccess(result.snapshot, access),
        evidence_request: result.evidence_request,
        recode: result.recode || null
      }));
      return;
    }

    const evidenceAcceptMatch = requestUrl.pathname.match(/^\/evidence\/requests\/([^/]+)\/accept$/);
    if (evidenceAcceptMatch && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const evidenceRequestId = decodeURIComponent(evidenceAcceptMatch[1]);
      const currentSnapshot = await getFirmSnapshotFromDb({ firmId });
      const evidenceRequest = (currentSnapshot.clientEvidenceRequests || []).find((item) => item.id === evidenceRequestId);
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(evidenceRequest?.client_id)
      });
      const replyPrincipal = await resolveDesktopClientCreationPrincipal({ firmId, principal: access.principal });
      const actorId = replyPrincipal?.authenticatedVia === 'desktop_access_token' ? replyPrincipal.principalId
        : replyPrincipal?.email || replyPrincipal?.userId || replyPrincipal?.principalId || 'system';
      const result = await acceptClientEvidenceRequestInDb({
        firmId,
        replyAuthority: { principal: replyPrincipal, source: 'authenticated_evidence_route' },
        evidenceRequestId,
        nextReviewState: body?.review_state || body?.reviewState || 'accepted',
        resolutionNote: body?.resolution_note || body?.resolutionNote || '',
        actorId
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        ...filterFirmSnapshotForAccess(result.snapshot, access),
        evidence_request: result.evidence_request
      }));
      return;
    }

    const evidenceRejectMatch = requestUrl.pathname.match(/^\/evidence\/requests\/([^/]+)\/reject$/);
    if (evidenceRejectMatch && req.method === 'POST') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const evidenceRequestId = decodeURIComponent(evidenceRejectMatch[1]);
      const currentSnapshot = await getFirmSnapshotFromDb({ firmId });
      const evidenceRequest = (currentSnapshot.clientEvidenceRequests || []).find((item) => item.id === evidenceRequestId);
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(evidenceRequest?.client_id)
      });
      const actorId = access.principal?.email || access.principal?.userId || access.principal?.principalId || 'system';
      const result = await rejectClientEvidenceRequestInDb({
        firmId,
        evidenceRequestId,
        rejectionReason: body?.rejection_reason || body?.rejectionReason || body?.reason || '',
        followUpQuestion: body?.follow_up_question || body?.followUpQuestion || body?.question || '',
        dueAt: body?.due_at || body?.dueAt || undefined,
        actorId
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        ...filterFirmSnapshotForAccess(result.snapshot, access),
        evidence_request: result.evidence_request
      }));
      return;
    }

    const documentDownloadMatch = requestUrl.pathname.match(/^\/documents\/([^/]+)\/download$/);
    if (documentDownloadMatch && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const documentId = decodeURIComponent(documentDownloadMatch[1]);
      const access = await assertDocumentRouteAccess({ firmId, documentId, auth: req.donnaAuth });
      if (!access) {
        sendDocumentNotFound(res);
        return;
      }
      const snapshot = await getFirmSnapshotFromDb({ firmId });
      const document = (snapshot.documents || []).find((item) => item.id === documentId);
      if (!document) {
        sendDocumentNotFound(res);
        return;
      }
      // The persisted columns are the only reference this route signs: the
      // snapshot DTO is payload-derived and payload is caller-writable review
      // data. The reference must also sit inside this firm/client.
      const scopedFirmId = firmId || DEFAULT_FIRM_ID;
      const persisted = (await queryFirmDb(
        'select storage_bucket, storage_object_key from documents where firm_id = $1 and id = $2',
        [scopedFirmId, documentId]
      )).rows[0] || {};
      const bucket = persisted.storage_bucket;
      const key = persisted.storage_object_key;
      if (!bucket || !key) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Document object storage metadata is missing.', code: 'DOCUMENT_STORAGE_MISSING' }));
        return;
      }
      assertEvidenceDownloadReference({ firmId: scopedFirmId, clientId: document.client_id, bucket, key });
      const signed_url = await createEvidenceSignedUrl({ bucket, key, expiresIn: 300 });
      const actorId = signedUrlActorFromAccess(access);
      await recordDocumentSignedUrlCreatedInDb({ firmId, document, actorId }).catch(() => null);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        source: 'document_download',
        document: filterFirmSnapshotForAccess({ documents: [document] }, access).documents?.[0] || document,
        signed_url,
        expires_in: 300
      }));
      return;
    }

    // PR 2 of docs/invoice-receipt-parsing-plan.md — firm-side line read.
    // Returns the document header subset + every document_lines row for
    // the document, ordered by line_no. PR 3 will start populating
    // `review_items` once `transaction_review_queue` rows of
    // `item_type='document_line'` exist.
    const documentLinesMatch = requestUrl.pathname.match(/^\/documents\/([^/]+)\/lines$/);
    if (documentLinesMatch && req.method === 'GET') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      const documentId = decodeURIComponent(documentLinesMatch[1]);

      // Cross-firm reads 404 via the firm_id predicate inside
      // getDocumentForParseInDb. assertFirmAccess then enforces the
      // collaborator vs firm-member scoping by the doc's client_id.
      const docMeta = await getDocumentForParseInDb({ firmId, documentId });
      if (!docMeta) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Document was not found.', code: 'DOCUMENT_NOT_FOUND' }));
        return;
      }
      await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(docMeta.client_id)
      });

      const { document, lines, review_items } = await getDocumentLinesForFirmInDb({ firmId, documentId });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        document,
        lines,
        // PR 3 populates this from `transaction_review_queue` where
        // item_type='document_line'. Only rows scoped to the doc's
        // lines surface — cross-firm reads are gated above by
        // assertFirmAccess + getDocumentForParseInDb.
        review_items: review_items || []
      }));
      return;
    }

    // PR 3 of docs/invoice-receipt-parsing-plan.md — per-line PATCH.
    // Mirrors the /resolve-duplicate handler for the doc-scoped match +
    // assertFirmAccess flow. The DB helper repeats the (firm_id,
    // document_id, id) predicate inside its FOR UPDATE transaction.
    const documentLinePatchMatch = requestUrl.pathname.match(/^\/documents\/([^/]+)\/lines\/([^/]+)$/);
    if (documentLinePatchMatch && req.method === 'PATCH') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const documentId = decodeURIComponent(documentLinePatchMatch[1]);
      const lineId = decodeURIComponent(documentLinePatchMatch[2]);
      const body = await readBody();
      const firmId = body?.firm_id || undefined;

      const docMeta = await getDocumentForParseInDb({ firmId, documentId });
      if (!docMeta) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Document was not found.', code: 'DOCUMENT_NOT_FOUND' }));
        return;
      }
      await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(docMeta.client_id)
      });

      const patch = body?.patch && typeof body.patch === 'object'
        ? body.patch
        : (body && typeof body === 'object' ? body : {});

      try {
        const result = await patchDocumentLineInDb({ firmId, documentId, lineId, patch });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          line: result.line,
          closed_review_item_ids: result.closed_review_item_ids,
          created_rule_id: result.created_rule_id,
          rule_existed_before: result.rule_existed_before
        }));
        return;
      } catch (patchErr) {
        const statusCode = patchErr?.statusCode || 500;
        res.statusCode = statusCode;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          error: patchErr?.message || 'Unable to update line.',
          ...(patchErr?.code ? { code: patchErr.code } : {}),
          ...(patchErr?.details ? { details: patchErr.details } : {})
        }));
        return;
      }
    }

    // Slice C — `/documents/<id>/corrections` POST records one
    // human edit on a rendered field; GET lists the per-document
    // history. The POST handler:
    //   - validates field_path is on
    //     documentCorrections.ALLOWED_CORRECTION_FIELDS;
    //   - opens the same assertFirmAccess gate as the document
    //     itself uses, scoped to the document's client_id;
    //   - delegates to recordDocumentCorrectionInDb which writes
    //     the correction row, optionally writes back the
    //     `documents` column, and emits a `document.correction`
    //     audit_event — all in one transaction.
    // The GET handler returns the per-document history (DESC by
    // corrected_at) so the artifact panel can render an "edited"
    // badge with the edit history on hover.
    // See docs/donna-llm-trust-strategy.md §3 Slice C.
    const documentCorrectionsMatch = requestUrl.pathname.match(/^\/documents\/([^/]+)\/corrections$/);
    if (documentCorrectionsMatch && (req.method === 'POST' || req.method === 'GET')) {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const documentId = decodeURIComponent(documentCorrectionsMatch[1]);
      const body = req.method === 'POST' ? await readBody() : null;
      const firmId = (body?.firm_id)
        || requestUrl.searchParams.get('firm_id')
        || undefined;

      const docMeta = await getDocumentForParseInDb({ firmId, documentId });
      if (!docMeta) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Document was not found.', code: 'DOCUMENT_NOT_FOUND' }));
        return;
      }
      const correctionAccess = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(docMeta.client_id)
      });

      if (req.method === 'GET') {
        const corrections = await getDocumentCorrectionsFromDb({ firmId, documentId });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ corrections }));
        return;
      }

      const fieldPath = body?.field_path || '';
      const correctedValue = Object.prototype.hasOwnProperty.call(body || {}, 'corrected_value')
        ? body.corrected_value
        : undefined;
      // The attributed actor is the authenticated principal, never a body field.
      const correctedBy = chatApplyActorId(correctionAccess.principal);

      try {
        // /documents/:id/corrections — the new currency write carries the
        // same capability and seat amount checks as its document-chat action.
        if (fieldPath === 'currency') {
          await assertActionCapability({
            firmId, clientId: docMeta.client_id, principal: correctionAccess.principal,
            actionType: 'correct_document_field',
            action: { type: 'correct_document_field', document_id: documentId }
          });
        }
        const correction = await recordDocumentCorrectionInDb({
          firmId,
          documentId,
          fieldPath,
          correctedValue,
          correctedBy
        });
        res.statusCode = 201;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          correction,
          allowed_fields: ALLOWED_CORRECTION_FIELDS
        }));
      } catch (correctionErr) {
        const statusCode = correctionErr?.statusCode || 500;
        res.statusCode = statusCode;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          error: correctionErr?.message || 'Unable to record correction.',
          ...(correctionErr?.code ? { code: correctionErr.code } : {}),
          ...(correctionErr?.details ? { details: correctionErr.details } : {})
        }));
      }
      return;
    }

    const documentPatchMatch = requestUrl.pathname.match(/^\/documents\/([^/]+)$/);
    if (documentPatchMatch && req.method === 'PATCH') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const documentId = decodeURIComponent(documentPatchMatch[1]);
      // Access BEFORE any snapshot (F-10): a cheap one-row lookup, and a uniform
      // 404 for "missing" and "not yours" so the route is no existence oracle.
      const access = await assertDocumentRouteAccess({ firmId, documentId, auth: req.donnaAuth });
      if (!access) {
        sendDocumentNotFound(res);
        return;
      }
      const snapshot = await updateDocumentInDb({
        firmId,
        documentId,
        patch: body?.patch && typeof body.patch === 'object' ? body.patch : {},
        actor: { actorType: access.principal?.principalType || 'firm', actorId: chatApplyActorId(access.principal) }
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(filterFirmSnapshotForAccess(snapshot, access)));
      return;
    }

    if (documentPatchMatch && req.method === 'DELETE') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }
      const documentId = decodeURIComponent(documentPatchMatch[1]);
      const firmId = requestUrl.searchParams.get('firm_id') || undefined;
      // One-row lookup, NOT a full snapshot build (the 2026-07-21 multi-delete
      // slowness); missing and not-yours are one uniform 404 (F-10). A caller
      // who can see the document but is not a firm member still gets the 403.
      const access = await assertDocumentRouteAccess({ firmId, documentId, auth: req.donnaAuth, requireMember: true });
      if (!access) {
        sendDocumentNotFound(res);
        return;
      }
      try {
        const snapshot = await deleteDocumentInDb({ firmId, documentId });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(filterFirmSnapshotForAccess(snapshot, access)));
      } catch (error) {
        const status = error?.statusCode || 500;
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          error: error?.message || 'Delete failed.',
          ...(error?.code ? { code: error.code } : {}),
          ...(error?.details ? { details: error.details } : {})
        }));
      }
      return;
    }

    const transactionPatchMatch = requestUrl.pathname.match(/^\/transactions\/([^/]+)$/);
    if (transactionPatchMatch && req.method === 'PATCH') {
      if (!isFirmDatabaseConfigured()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Firm database is not configured.' }));
        return;
      }

      const body = await readBody();
      const firmId = body?.firm_id || undefined;
      const transactionId = decodeURIComponent(transactionPatchMatch[1]);
      const currentSnapshot = await getFirmSnapshotFromDb({ firmId });
      const access = await assertFirmAccess({
        firmId,
        auth: req.donnaAuth,
        clientIds: collectClientIds(getFirmItemClientId(currentSnapshot.transactions, transactionId))
      });
      const snapshot = await updateTransactionInDb({
        firmId,
        transactionId,
        patch: body?.patch && typeof body.patch === 'object' ? body.patch : {}
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(filterFirmSnapshotForAccess(snapshot, access)));
      return;
    }

    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
  } catch (error) {
    res.statusCode = error?.statusCode || 500;
    // Preserve the existing response. Diagnostic failure must never replace it.
    try {
      const diagnostic = buildFirmReadFailureDiagnostic({ method: req.method, pathname: diagnosticPath,
        status: res.statusCode, error, elapsedMs: performance.now() - readStartedAt, pool: readFirmDbPoolCounts() });
      if (diagnostic) console.error('[firm-read] failed', diagnostic);
    } catch { /* No secondary I/O or error serialization on a failed read. */ }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error: error.message || 'Server error while loading firm data.',
        ...(error?.code ? { code: error.code } : {}),
        ...(error?.details ? { details: error.details } : {})
      })
    );
  }
};

// Marketing waitlist — public (unauthenticated) capture from the purchase-flow
// qualification gate's unfit path. Not in isProtectedDonnaPath, so the visitor
// (a signed-out marketing lead) passes the access gate. POST { email, reason }.
const handleWaitlist = async (req, res) => {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed.' }));
    return;
  }
  if (!isFirmDatabaseConfigured()) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ code: 'FIRM_DB_NOT_CONFIGURED', error: 'Waitlist storage is not configured.' }));
    return;
  }
  try {
    const body = await readJsonBody(req);
    await addToWaitlist({ email: body.email, reason: body.reason });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  } catch (error) {
    res.statusCode = error.statusCode || 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ code: error.code || 'WAITLIST_ERROR', error: error.message || 'Could not save your email.' }));
  }
};

// ── Stripe billing ───────────────────────────────────────────────────────────
// The subscription gates client-portal access. Three authenticated endpoints
// (status / checkout / portal) plus one UNauthenticated, signature-verified
// webhook. The webhook is dispatched BEFORE requireDonnaAccess (Stripe can't
// present our access token) and reads the RAW body itself (readJsonBody would
// JSON-parse it and break signature verification).

const handleWhatsAppWebhook = async (req, res, requestUrl) => {
  if (req.method === 'GET') {
    const mode = requestUrl.searchParams.get('hub.mode');
    const token = requestUrl.searchParams.get('hub.verify_token');
    const challenge = requestUrl.searchParams.get('hub.challenge') || '';
    if (mode === 'subscribe' && token && token === String(process.env.WHATSAPP_VERIFY_TOKEN || '')) {
      res.statusCode = 200; res.end(challenge); return;
    }
    whatsappJson(res, 403, { error: 'Webhook verification failed.' }); return;
  }
  if (req.method !== 'POST') { whatsappJson(res, 405, { error: 'Method not allowed.' }); return; }
  let rawBody;
  try { rawBody = await readRawRequestBody(req); } catch { whatsappJson(res, 400, { error: 'Could not read request body.' }); return; }
  if (!verifyMetaWebhookSignature({ rawBody, signature: req.headers['x-hub-signature-256'] })) {
    whatsappJson(res, 401, { code: 'WHATSAPP_SIGNATURE_INVALID', error: 'Webhook signature verification failed.' }); return;
  }
  let payload;
  try { payload = JSON.parse(rawBody || '{}'); } catch { whatsappJson(res, 400, { error: 'Invalid JSON.' }); return; }
  // A throw below must never leave the request unanswered: the dispatcher calls
  // this handler unawaited, so an escaped rejection means NO response at all —
  // Meta read-times-out, redelivers, and the redelivery burns the idempotency
  // claim and exits silently (the Telegram F-1 black-hole class, #1053; the
  // shared `void`-dispatch hole was queued in
  // docs/donna-telegram-receipt-silence-diagnostic.md §7). Catch, log with the
  // message identity, and 200 — redelivery cannot repair a deterministic
  // failure, it only destroys the evidence.
  try {
    const changes = (payload?.entry || []).flatMap((entry) => entry.changes || []).map((change) => change.value || {});
    for (const value of changes) {
      for (const status of value.statuses || []) {
        const ts = status.timestamp ? new Date(Number(status.timestamp) * 1000).toISOString() : new Date().toISOString();
        await recordMessageDeliveryLedgerInDb({ entry: {
          message_id: status.id, channel: 'whatsapp', provider: 'meta',
          delivered_at: status.status === 'delivered' ? ts : null,
          read_at: status.status === 'read' ? ts : null,
          failed_at: status.status === 'failed' ? ts : null,
          failure_reason: status.errors?.[0]?.title || status.errors?.[0]?.message || null,
          provider_payload: { status }
        } });
      }
      for (const message of value.messages || []) {
        const from = message.from ? `+${String(message.from).replace(/^\+/, '')}` : '';
        const text = message.text?.body || '';
        const token = extractBindingToken(text);
        if (token) {
          await redeemWhatsAppBindTokenInDb({ tokenHash: hashWhatsAppToken(token), phoneE164: from, actorId: 'whatsapp:webhook' }).catch(() => null);
          await sendWhatsAppText({ to: from, text: 'Got it. WhatsApp is connected.' });
          continue;
        }
        const phoneHash = hashPhoneE164(from);
        const bindings = await getActiveWhatsAppBindingsByPhoneHashInDb({ phoneHash });
        if (!bindings.length) { await sendWhatsAppText({ to: from, text: 'Please connect WhatsApp from your Donna portal first.' }); continue; }
        // G-9 (D-G9-5): the SMS compliance slot's WhatsApp mirror — LOPETA/STOP
        // and APUA/HELP resolve here, before anchored processing.
        const compliance = await handleWhatsAppComplianceCommand({ body: text, from, firmId: DEFAULT_FIRM_ID, bindings });
        if (compliance.handled) continue;
        const outcome = await processWhatsAppInboundMessage({ message, from, firmId: DEFAULT_FIRM_ID });
        console.log('[whatsapp-webhook] processed', {
          message_id: message.id ?? null,
          message_type: message.type ?? null,
          status: outcome?.status || null,
          reason: outcome?.reason || null
        });
      }
    }
    whatsappJson(res, 200, { received: true });
  } catch (error) {
    // This catch must never itself throw (that would recreate the very
    // no-response hole it closes), so the identity walk is fully optional.
    let firstMessage = null;
    try {
      firstMessage = (payload?.entry || []).flatMap((entry) => entry?.changes || []).map((change) => change?.value || {}).flatMap((value) => value?.messages || [])[0] || null;
    } catch {
      firstMessage = null;
    }
    console.error('[whatsapp-webhook] processing failed', {
      message_id: firstMessage?.id ?? null,
      message_type: firstMessage?.type ?? null,
      error_name: error?.name || 'Error',
      error_message: error?.message || '',
      stack: error?.stack || null
    });
    if (!res.writableEnded) whatsappJson(res, 200, { received: true });
  }
};


const handleSmsWebhook = async (req, res, requestUrl) => {
  if (req.method !== 'POST') { smsJson(res, 405, { error: 'Method not allowed.' }); return; }
  let rawBody;
  try { rawBody = await readRawRequestBody(req); } catch { smsJson(res, 400, { error: 'Could not read request body.' }); return; }
  const params = parseTwilioForm(rawBody);
  const publicUrl = twilioRequestUrl(req, requestUrl);
  if (!verifyTwilioWebhookSignature({ url: publicUrl, params, signature: req.headers['x-twilio-signature'] })) {
    smsJson(res, 401, { code: 'SMS_SIGNATURE_INVALID', error: 'Webhook signature verification failed.' }); return;
  }

  const messageSid = params.MessageSid || params.SmsSid || params.SmsMessageSid;
  // A throw below must never leave the request unanswered: the dispatcher calls
  // this handler unawaited, so an escaped rejection means NO response at all —
  // Twilio times out, retries, and the retry burns the idempotency claim and
  // exits silently (the Telegram F-1 black-hole class, #1053; the shared
  // `void`-dispatch hole was queued in
  // docs/donna-telegram-receipt-silence-diagnostic.md §7). Catch, log with the
  // message identity (the Sid, never the phone number), and 200.
  try {
    const status = params.MessageStatus || params.SmsStatus;
    if (messageSid && status && !params.Body && !params.NumMedia) {
      const ts = new Date().toISOString();
      await recordMessageDeliveryLedgerInDb({ entry: {
        message_id: messageSid,
        channel: 'sms',
        provider: 'twilio',
        sent_at: ['queued', 'sent'].includes(String(status).toLowerCase()) ? ts : null,
        delivered_at: status === 'delivered' ? ts : null,
        failed_at: ['failed', 'undelivered'].includes(String(status).toLowerCase()) ? ts : null,
        failure_reason: ['failed', 'undelivered'].includes(String(status).toLowerCase()) ? (params.ErrorMessage || params.ErrorCode || status) : null,
        provider_payload: { status: params }
      } });
      smsJson(res, 200, { received: true }); return;
    }

    const from = params.From || '';
    const body = params.Body || '';
    const token = extractBindingToken(body);
    if (token) {
      await redeemWhatsAppBindTokenInDb({ tokenHash: hashWhatsAppToken(token), phoneE164: from, actorId: 'sms:webhook', channel: 'sms' }).catch(() => null);
      await sendSmsText({ to: from, text: 'Got it. SMS is connected.' });
      smsJson(res, 200, { received: true }); return;
    }

    const phoneHash = hashPhoneE164(from);
    const bindings = await getActiveSmsBindingsByPhoneHashInDb({ phoneHash });
    if (!bindings.length) { await sendSmsText({ to: from, text: SMS_INBOUND_COPY.unbound }); smsJson(res, 200, { received: true }); return; }

    const compliance = await handleSmsComplianceCommand({ body, from, firmId: DEFAULT_FIRM_ID, bindings });
    if (compliance.handled) { smsJson(res, 200, { received: true }); return; }

    const outcome = await processSmsInboundMessage({ message: params, from, firmId: DEFAULT_FIRM_ID });
    console.log('[sms-webhook] processed', {
      message_sid: messageSid ?? null,
      has_media: Number(params.NumMedia || 0) > 0,
      status: outcome?.status || null,
      reason: outcome?.reason || null
    });
    smsJson(res, 200, { received: true });
  } catch (error) {
    console.error('[sms-webhook] processing failed', {
      message_sid: messageSid ?? null,
      has_media: Number(params.NumMedia || 0) > 0,
      error_name: error?.name || 'Error',
      error_message: error?.message || '',
      stack: error?.stack || null
    });
    if (!res.writableEnded) smsJson(res, 200, { received: true });
  }
};

// Telegram owner channel (docs/session-handoff-2026-07-15-telegram-channel.md).
// Auth is a shared secret echoed in a header (NOT an HMAC over the body), so we
// verify header equality — no template review, no business verification, no
// allowlist on Telegram's side. Routes into the SAME reconcile core as WhatsApp
// and SMS (processTelegramInboundMessage → processAnchoredInboundMessage), never
// a parallel reconciler. Always 200s (after processing) so Telegram stops
// re-delivering an accepted update.
const handleTelegramWebhook = async (req, res) => {
  if (req.method !== 'POST') { telegramJson(res, 405, { error: 'Method not allowed.' }); return; }
  if (!verifyTelegramWebhookSecret({ header: req.headers['x-telegram-bot-api-secret-token'] })) {
    telegramJson(res, 401, { code: 'TELEGRAM_SECRET_INVALID', error: 'Webhook secret verification failed.' }); return;
  }
  let rawBody;
  try { rawBody = await readRawRequestBody(req); } catch { telegramJson(res, 400, { error: 'Could not read request body.' }); return; }
  let update;
  try { update = JSON.parse(rawBody || '{}'); } catch { telegramJson(res, 400, { error: 'Invalid JSON.' }); return; }

  // Text messages only carry the owner loop; edits reuse the same shape. Ignore
  // channel posts, inline queries, and other update kinds.
  const message = update.message || update.edited_message;
  if (!message || message.chat?.id == null) { telegramJson(res, 200, { received: true }); return; }

  // Audit L5 — the owner-loop identity guard (telegramSenderVerdict): only a
  // private chat whose sender IS the chat may reach the loop; group members
  // and bots can no longer speak as the bound owner. Ignored updates still
  // 200 so Telegram stops re-delivering.
  const senderVerdict = telegramSenderVerdict(message);
  if (!senderVerdict.ok) {
    console.log('[telegram-webhook] sender guard refused update', {
      reason: senderVerdict.reason,
      chat_id: message.chat.id,
      chat_type: message.chat?.type || 'unknown',
      from_id: message.from?.id ?? null,
      is_bot: message.from?.is_bot === true
    });
    await recordMessageDeliveryLedgerInDb({ entry: {
      message_id: telegramInboundMessageId({ chatId: message.chat.id, messageId: message.message_id ?? update.update_id ?? 'unknown' }),
      provider: 'telegram', channel: 'telegram', failed_at: new Date().toISOString(),
      failure_reason: senderVerdict.reason,
      provider_payload: { inbound: { refusal: senderVerdict.reason, chat_type: message.chat?.type || 'unknown', from_id: message.from?.id ?? null } }
    } }).catch((error) => console.warn('[telegram-webhook] refusal ledger failed', error?.message || error));
    telegramJson(res, 200, { received: true });
    return;
  }

  const from = telegramChatKey(message.chat.id);
  const text = message.text || message.caption || '';

  // A throw below must never leave the request unanswered: the dispatcher calls
  // this handler unawaited, so an escaped rejection means NO response at all —
  // Telegram read-times-out, redelivers, and the redelivery burns the
  // idempotency claim and exits silently. The owner then sees nothing and the
  // logs hold nothing (the 2026-07-16 silent-receipt incident;
  // docs/donna-telegram-receipt-silence-diagnostic.md). Catch, log the stage
  // with the update identity, and 200 — redelivery cannot repair a
  // deterministic failure, it only destroys the evidence.
  try {
    // Deep-link binding hop: t.me/<bot>?start=<token> → "/start <token>".
    const startToken = extractTelegramStartToken(text);
    if (startToken) {
      await redeemWhatsAppBindTokenInDb({ tokenHash: hashWhatsAppToken(startToken), phoneE164: from, actorId: 'telegram:webhook', channel: 'telegram' }).catch(() => null);
      await sendTelegramText({ to: from, text: 'Got it. Telegram is connected.' });
      telegramJson(res, 200, { received: true }); return;
    }
    if (isBareTelegramStart(text)) {
      await sendTelegramText({ to: from, text: TELEGRAM_INBOUND_COPY.started });
      telegramJson(res, 200, { received: true }); return;
    }

    const phoneHash = hashPhoneE164(from);
    const bindings = await getActiveTelegramBindingsByPhoneHashInDb({ phoneHash });
    if (!bindings.length) { await sendTelegramText({ to: from, text: TELEGRAM_INBOUND_COPY.unbound }); telegramJson(res, 200, { received: true }); return; }

    const compliance = await handleTelegramComplianceCommand({ body: text, from, firmId: DEFAULT_FIRM_ID, bindings });
    if (compliance.handled) { telegramJson(res, 200, { received: true }); return; }

    const outcome = await processTelegramInboundMessage({ message, from, firmId: DEFAULT_FIRM_ID });
    console.log('[telegram-webhook] processed', {
      update_id: update.update_id ?? null,
      message_id: message.message_id ?? null,
      has_media: Boolean(message.photo || message.document || message.voice || message.audio),
      status: outcome?.status || null,
      reason: outcome?.reason || null
    });
    telegramJson(res, 200, { received: true });
  } catch (error) {
    console.error('[telegram-webhook] processing failed', {
      update_id: update.update_id ?? null,
      message_id: message.message_id ?? null,
      has_media: Boolean(message.photo || message.document || message.voice || message.audio),
      error_name: error?.name || 'Error',
      error_message: error?.message || '',
      stack: error?.stack || null
    });
    // F-2 (burned-claim ack, half 1): a caught throw 200s so Telegram never
    // redelivers — without this reply the owner's photo vanishes silently (the
    // claim is burned, no retry is coming). Tell them to re-send; a re-send of
    // a photo that DID save just dedups into the already-on-file reply.
    // Best-effort: a failure to send the failure notice must not escape.
    if (message.photo || message.document) {
      try {
        await sendTelegramText({ to: from, text: TELEGRAM_INBOUND_COPY.mediaFailed });
      } catch {
        // the error log above already carries the update identity
      }
    }
    if (!res.writableEnded) telegramJson(res, 200, { received: true });
  }
};

const sendBillingJson = (res, statusCode, payload) => {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
};

const readRawRequestBody = async (req, maxBytes = MAX_REQUEST_BYTES) => {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    if (totalBytes > maxBytes) {
      const error = new Error('Request body too large.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
};

// Deployment origin for Checkout success/cancel + portal return URLs. Prefer an
// explicit env (PUBLIC_APP_URL) so the redirect target is deterministic; fall
// back to the forwarded host Vercel sets.
const resolvePublicOrigin = (req) => {
  const envBase = String(process.env.PUBLIC_APP_URL || process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '');
  if (envBase) return envBase;
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
};

const handleStripeWebhook = async (req, res) => {
  if (req.method !== 'POST') {
    sendBillingJson(res, 405, { error: 'Method not allowed.' });
    return;
  }
  if (!isWebhookConfigured()) {
    sendBillingJson(res, 503, { code: 'BILLING_WEBHOOK_NOT_CONFIGURED', error: 'Stripe webhook is not configured.' });
    return;
  }
  const signature = req.headers['stripe-signature'];
  let rawBody;
  try {
    rawBody = await readRawRequestBody(req);
  } catch (error) {
    sendBillingJson(res, error.statusCode || 400, { error: 'Could not read request body.' });
    return;
  }
  let event;
  try {
    event = constructWebhookEvent(rawBody, signature);
  } catch (error) {
    // Bad/absent signature — never trust the payload. 400 (not retryable).
    sendBillingJson(res, 400, { code: 'WEBHOOK_SIGNATURE_INVALID', error: 'Webhook signature verification failed.' });
    return;
  }
  try {
    const result = await applyWebhookEvent(event);
    // 200 once verified so Stripe stops re-delivering a received event.
    sendBillingJson(res, 200, { received: true, type: result.type, handled: result.handled, matched: result.matched });
  } catch (error) {
    // A processing/DB failure: 5xx so Stripe retries the delivery.
    sendBillingJson(res, 500, { received: true, error: 'Webhook processing failed.' });
  }
};

// Supabase Send-Email Auth Hook. Like the Stripe webhook this runs BEFORE the
// access-token gate: Supabase authenticates via the Standard-Webhooks signature,
// not our bearer, and needs the raw (unparsed) body to verify it.
const handleAuthEmailHook = async (req, res) => {
  if (req.method !== 'POST') {
    sendBillingJson(res, 405, { error: 'Method not allowed.' });
    return;
  }
  if (!isAuthEmailHookEnabled()) {
    // Hook not configured (no secret / no Resend key) — it should not be wired
    // in the dashboard then. 503 makes the misconfiguration legible.
    sendBillingJson(res, 503, { code: 'AUTH_EMAIL_HOOK_NOT_CONFIGURED', error: 'Auth email hook is not configured.' });
    return;
  }
  let rawBody;
  try {
    rawBody = await readRawRequestBody(req);
  } catch (error) {
    sendBillingJson(res, error.statusCode || 400, { error: 'Could not read request body.' });
    return;
  }
  try {
    verifyHookSignature({ rawBody, headers: req.headers });
  } catch (error) {
    // Bad/absent signature — never trust the payload.
    sendBillingJson(res, 401, { code: 'HOOK_SIGNATURE_INVALID', error: 'Webhook signature verification failed.' });
    return;
  }
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (error) {
    sendBillingJson(res, 400, { error: 'Invalid JSON payload.' });
    return;
  }
  const result = await handleAuthEmailHookPayload({
    payload,
    supabaseUrl: getSupabaseAuthConfig().url
  });
  if (!result.ok) {
    // 500 so Supabase surfaces the failure rather than silently "succeeding"
    // with no email delivered. Break-glass is to disable the hook in the
    // dashboard (reverts to GoTrue + SMTP).
    sendBillingJson(res, 500, { error: result.error || result.sendResult?.error || 'Email send failed.' });
    return;
  }
  sendBillingJson(res, 200, { delivered: true });
};

const loadBillingClientForAuth = async (req, res, clientId) => {
  if (!clientId) {
    sendBillingJson(res, 400, { code: 'CLIENT_ID_REQUIRED', error: 'client_id is required.' });
    return null;
  }
  const client = await getClientBillingContext({ firmId: req.donnaAuth?.firmId || undefined, clientId });
  if (!client) {
    sendBillingJson(res, 404, { code: 'CLIENT_NOT_FOUND', error: 'Client not found.' });
    return null;
  }
  // Per-client authorization on the existing firm-access model — closes the
  // hole where any authenticated caller could act on another client's billing.
  await assertFirmAccess({ firmId: client.firmId, auth: req.donnaAuth, clientIds: [clientId] });
  return client;
};

// Routed here after auth with req.url stripped to /status, /checkout, /portal.
const donnaBillingApiHandler = async (req, res) => {
  try {
    const requestUrl = new URL(req.url || '/', 'http://localhost');

    if (!isFirmDatabaseConfigured()) {
      sendBillingJson(res, 503, { code: 'FIRM_DB_NOT_CONFIGURED', error: 'Billing requires the firm database.' });
      return;
    }

    // GET /status?client_id=... — the portal gate reads this. Fails OPEN
    // (entitled=true) when billing is disabled so nothing is walled off until
    // the env is set.
    if (requestUrl.pathname === '/status' && req.method === 'GET') {
      const clientId = requestUrl.searchParams.get('client_id');
      const client = await loadBillingClientForAuth(req, res, clientId);
      if (!client) return;
      const enabled = isBillingEnabled();
      // A firm member / access token (unrestricted) viewing a client's portal is
      // never paywalled — the firm services unpaid clients (mirrors the
      // assertClientEntitled exemption). The UI gate reads this to fail open for
      // an admin instead of bouncing them to the funnel.
      const viewer = await getFirmPrincipalForAuth({ firmId: client.firmId, auth: req.donnaAuth });
      sendBillingJson(res, 200, {
        billing_enabled: enabled,
        jurisdiction: client.jurisdiction,
        company_name: client.companyName,
        owner_email: req.donnaAuth?.email || null,
        company_setup_required: !client.entitled && (!client.jurisdiction || (client.jurisdiction === 'FI' && !client.entityType)),
        pilot_pending: client.jurisdiction === 'FI' && !client.entitled,
        status: client.status,
        entitled: enabled ? client.entitled : true,
        // Honest basis for the entitlement: a Stripe mirror status, or an
        // explicit config-plane grant (internal_pilot / complimentary). Never
        // a fake "active plan".
        entitlement_basis: client.entitlementBasis || (client.entitled ? 'subscription' : null),
        viewer_unrestricted: Boolean(viewer?.unrestricted),
        current_period_end: client.currentPeriodEnd,
        has_customer: Boolean(client.stripeCustomerId),
        // Per-close band the client bought, so the gate renders the right price
        // (the recurring "keep me current" offer) instead of a flat tier.
        billing_kind: client.billingKind,
        band_id: client.bandId,
        price: client.price,
        access_paid_through: client.accessPaidThrough
      });
      return;
    }

    // POST /checkout is retired (Kari, 2026-10-21: "take the owner checkout
    // down"). Donna sells only to accounting firms, so no business buys closes
    // here; a firm's client reaches the portal through its firm. Refused before
    // the billing-enabled check so no configuration can bring it back. /status,
    // /portal (an existing customer can still manage or cancel) and the
    // webhook stay.
    if (requestUrl.pathname === '/checkout') {
      sendBillingJson(res, 410, {
        code: 'OWNER_CHECKOUT_RETIRED',
        error: 'Checkout is not available. Ask whoever runs this deployment for access.'
      });
      return;
    }

    if (!isBillingEnabled()) {
      sendBillingJson(res, 503, { code: 'BILLING_NOT_ENABLED', error: 'Billing is not enabled.' });
      return;
    }

    // POST /portal { client_id } → Stripe Billing Portal URL (manage/cancel).
    if (requestUrl.pathname === '/portal' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const client = await loadBillingClientForAuth(req, res, body.client_id);
      if (!client) return;
      if (!client.stripeCustomerId) {
        sendBillingJson(res, 409, { code: 'NO_STRIPE_CUSTOMER', error: 'No subscription started for this client yet.' });
        return;
      }
      const origin = resolvePublicOrigin(req);
      const { url } = await createBillingPortalSession({
        stripeCustomerId: client.stripeCustomerId,
        returnUrl: `${origin}/client/${encodeURIComponent(client.clientId)}`
      });
      sendBillingJson(res, 200, { url });
      return;
    }

    sendBillingJson(res, 404, { error: 'Not found.' });
  } catch (error) {
    const statusCode = error.statusCode || error.status || 500;
    sendBillingJson(res, statusCode, {
      code: error.code || 'BILLING_ERROR',
      error: error.message || 'Billing request failed.'
    });
  }
};

// Local evidence blobs (desktop host only): GET serves bytes, PUT accepts
// them. The HMAC token minted by evidenceStorage's local mode is the
// control — the signed-callback posture — so this mounts BEFORE the
// access-token gate (a browser <img>/<a> fetch cannot send headers, and the
// uploading SPA PUTs to signed_url exactly as it does against Supabase).
// On cloud hosts local mode is off and the route 404s.
const handleLocalEvidenceBlob = async (req, res, requestUrl) => {
  const sendJson = (statusCode, payload) => {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(payload));
  };
  try {
    if (req.method !== 'GET' && req.method !== 'PUT') {
      sendJson(405, { error: 'Method not allowed.', code: 'EVIDENCE_LOCAL_METHOD' });
      return;
    }
    const token = requestUrl.searchParams.get('token') || '';
    if (req.method === 'PUT') {
      // Body first, connection second: the pool connection must never be
      // held across network time. The token check, the admission on the
      // token's generation claim and the store run in putLocalEvidenceForToken
      // (localEvidencePut.js) on exactly ONE connection end to end — the
      // same function the runtime's Node-side callers use in-process, since
      // the appliance has no TCP listener for them to fetch. Concurrent PUTs
      // each needing two connections from a two-connection pool deadlocked
      // the whole runtime (every row frozen at "Uploading 0%", 2026-08-31).
      const bytes = await readRawBodyBytes(req, { maxBytes: DOCUMENT_EXTRACTION_REQUEST_BYTES });
      const result = await putLocalEvidenceForToken({
        token,
        bytes,
        contentType: req.headers['content-type'] || null
      });
      sendJson(result.statusCode, result.payload);
      return;
    }
    const { enabled, claim } = verifyLocalEvidenceAccess({ token, method: req.method });
    if (!enabled) {
      sendJson(404, { error: 'Local evidence storage is not enabled on this host.', code: 'EVIDENCE_LOCAL_MODE_OFF' });
      return;
    }
    if (!claim) {
      sendJson(403, { error: 'Invalid or expired evidence token.', code: 'EVIDENCE_LOCAL_TOKEN_INVALID' });
      return;
    }
    const object = await loadLocalEvidenceObject({ bucket: claim.bucket, key: claim.key });
    res.statusCode = 200;
    res.setHeader('Content-Type', object.content_type);
    res.setHeader('Content-Length', String(object.byte_length));
    const filename = (object.original_filename || claim.key.split('/').pop() || 'evidence')
      .replace(/[^\w.\- ]+/g, '_');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.end(object.bytes);
  } catch (error) {
    sendJson(error.statusCode || 500, {
      error: error.message || 'Local evidence request failed.',
      code: error.code || 'EVIDENCE_LOCAL_FAILED'
    });
  }
};

export const handleDonnaApiRequest = async (req, res) => {
  const requestUrl = new URL(req.url || '/', 'http://localhost');

  // Task cookies are accepted only by this narrow adapter. Manager/exchange
  // operations still resolve identity through the existing bearer owner.
  if (requestUrl.pathname === CAPTURE_API_PATH || requestUrl.pathname.startsWith(`${CAPTURE_API_PATH}/`)) {
    void handleCaptureAccessRequest({ req, res, requestUrl,
      readBody: options => readJsonBody(req, options),
      resolveAuth: request => resolveSubmittedDonnaAuth(request, { pathname: requestUrl.pathname }),
      publicOrigin: resolvePublicOrigin(req) });
    return;
  }

  // The host-class fence (RT-14): on the desktop host the cloud-only routes
  // are not mounted — answered here, before the signature-authenticated
  // webhooks and before requireDonnaAccess, so a cloud-shaped call never
  // reaches a handler that assumes Supabase, Stripe or a public URL.
  if (isDesktopHostEnv() && isCloudOnlyDonnaPath(requestUrl.pathname)) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Not mounted on the desktop host.', code: 'CLOUD_ONLY_ROUTE' }));
    return;
  }

  if (requestUrl.pathname === LOCAL_EVIDENCE_PATH) {
    void handleLocalEvidenceBlob(req, res, requestUrl);
    return;
  }

  // Webhook BEFORE auth: Stripe authenticates via payload signature, not our
  // access token, and needs the raw (unparsed) body.
  if (requestUrl.pathname === '/api/donna/whatsapp/webhook') {
    void handleWhatsAppWebhook(req, res, requestUrl);
    return;
  }

  if (requestUrl.pathname === '/api/donna/sms/webhook') {
    void handleSmsWebhook(req, res, requestUrl);
    return;
  }

  // Telegram authenticates via the secret-token header (checked inside), not our
  // access token, so it lands before requireDonnaAccess like the other channels.
  if (requestUrl.pathname === '/api/donna/telegram/webhook') {
    void handleTelegramWebhook(req, res);
    return;
  }

  if (requestUrl.pathname === '/api/donna/billing/webhook') {
    void handleStripeWebhook(req, res);
    return;
  }

  // Auth-email hook BEFORE auth: Supabase authenticates via the Standard-Webhooks
  // signature, not our access token, and needs the raw body.
  if (requestUrl.pathname === '/api/donna/auth-email-hook') {
    void handleAuthEmailHook(req, res);
    return;
  }

  // Hosted MCP endpoint (docs/design-donna-chatgpt-app-build-brief.md): the
  // ChatGPT app / Claude remote connector transport, its anonymous demo mode
  // and its RFC 9728 metadata. Dispatched BEFORE requireDonnaAccess because
  // (a) the demo and the metadata are public by design and (b) a live call
  // without a principal must answer 401 WITH the resource_metadata challenge
  // the chat hosts key their sign-in flow on — the plain gate cannot say
  // that. Auth is still resolved by resolveSubmittedDonnaAuth (the same chain
  // as every firm route) and decided by the MCP funnel.
  if (isMcpRemotePath(requestUrl.pathname)) {
    void handleMcpRemoteRequest(req, res, requestUrl, {
      resolveAuth: (request) => resolveSubmittedDonnaAuth(request, { pathname: requestUrl.pathname }),
      publicOrigin: resolvePublicOrigin
    });
    return;
  }

  if (!(await requireDonnaAccess(req, res, requestUrl))) return;

  if (requestUrl.pathname === '/api/donna/waitlist') {
    void handleWaitlist(req, res);
    return;
  }

  // Marketing outbound (slice 1 of docs/design-donna-sales-marketing.md):
  // public unsubscribe (token-authenticated by its own random token), then the
  // staff-only admin surface (covered by isProtectedDonnaPath above).
  if (requestUrl.pathname === '/api/donna/marketing/unsubscribe') {
    void handleMarketingUnsubscribe(req, res, requestUrl);
    return;
  }
  // Inbound email webhook (M3): public by necessity (Resend's servers call
  // it); the Svix signature over the raw body IS the auth, and the handler
  // fails closed without its configured secret.
  if (requestUrl.pathname === '/api/donna/marketing/inbound-webhook') {
    void handleMarketingInboundWebhook(req, res);
    return;
  }
  if (requestUrl.pathname.startsWith('/api/donna/marketing/admin')) {
    void handleMarketingAdminApi(req, res, requestUrl);
    return;
  }

  // Outbound actions (M1, G8/G9 of the outbound-actions plan): two PUBLIC
  // token-authenticated handlers — the counterparty's one-click unsubscribe
  // (suppression, must never require auth) and the owner's approve/decline
  // tap from the pending-actions digest email (bearer token in the owner's
  // own inbox — the magic-link trust model).
  if (requestUrl.pathname === '/api/donna/outbound/unsubscribe') {
    void handleOutboundUnsubscribe(req, res, requestUrl);
    return;
  }
  if (requestUrl.pathname === '/api/donna/outbound/approval') {
    void handleOutboundApproval(req, res, requestUrl);
    return;
  }
  // D4 (M2): the pay-link settlement webhook — Stripe's signature is the only
  // authentication (the billing-webhook discipline), so it mounts with the
  // public handlers, before any access-token gate.
  if (requestUrl.pathname === '/api/donna/outbound/paylink-webhook') {
    void handleOutboundPayLinkWebhook(req, res, requestUrl);
    return;
  }
  // reply_if_wrong v2: the owner-reply inbound webhook (Resend calls it; the
  // Svix signature over the raw body is the auth, marketing-inbound shape).
  if (requestUrl.pathname === '/api/donna/outbound/reply-webhook') {
    void handleOutboundReplyWebhook(req, res, requestUrl);
    return;
  }

  if (requestUrl.pathname.startsWith('/api/donna/sms')) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Donna SMS route not found.' }));
    return;
  }

  if (requestUrl.pathname.startsWith('/api/donna/whatsapp')) {
    // Webhook handled before auth; no authenticated WhatsApp admin API yet.
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Donna WhatsApp route not found.' }));
    return;
  }

  if (requestUrl.pathname.startsWith('/api/donna/telegram')) {
    // Webhook handled before auth; no authenticated Telegram admin API yet.
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Donna Telegram route not found.' }));
    return;
  }

  if (requestUrl.pathname.startsWith('/api/donna/billing')) {
    const originalUrl = req.url || '/';
    req.url = originalUrl.replace('/api/donna/billing', '') || '/';
    void donnaBillingApiHandler(req, res);
    return;
  }

  if (requestUrl.pathname.startsWith('/api/donna/bizfile')) {
    const originalUrl = req.url || '/';
    req.url = originalUrl.replace('/api/donna/bizfile', '') || '/';
    void donnaBizfileApiHandler(req, res);
    return;
  }

  if (requestUrl.pathname.startsWith('/api/donna/firms')) {
    const originalUrl = req.url || '/';
    req.url = originalUrl.replace('/api/donna/firms', '') || '/';
    void donnaFirmsApiHandler(req, res);
    return;
  }

  // MCP read surface (docs/design-donna-mcp-surface.md): the local endpoint
  // the Claude Desktop MCPB shim calls. Read-only tools, per-entity consent,
  // receipt per call — all enforced inside the handler.
  if (requestUrl.pathname.startsWith('/api/donna/mcp')) {
    void handleMcpApiRequest(req, res, requestUrl);
    return;
  }

  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'Donna API route not found.' }));
};

export const createDonnaApiPlugin = () => ({
  name: 'donna-api-route',
  configureServer(server) {
    const route = (prefix) => (req, res) => {
      const originalUrl = req.url || '/';
      req.url = `${prefix}${originalUrl === '/' ? '' : originalUrl}`;
      handleDonnaApiRequest(req, res);
    };

    server.middlewares.use('/api/donna/bizfile', route('/api/donna/bizfile'));
    server.middlewares.use('/api/donna/whatsapp', route('/api/donna/whatsapp'));
    server.middlewares.use('/api/donna/sms', route('/api/donna/sms'));
    server.middlewares.use('/api/donna/telegram', route('/api/donna/telegram'));
    server.middlewares.use('/api/donna/firms', route('/api/donna/firms'));
  },
  configurePreviewServer(server) {
    const route = (prefix) => (req, res) => {
      const originalUrl = req.url || '/';
      req.url = `${prefix}${originalUrl === '/' ? '' : originalUrl}`;
      handleDonnaApiRequest(req, res);
    };

    server.middlewares.use('/api/donna/bizfile', route('/api/donna/bizfile'));
    server.middlewares.use('/api/donna/whatsapp', route('/api/donna/whatsapp'));
    server.middlewares.use('/api/donna/sms', route('/api/donna/sms'));
    server.middlewares.use('/api/donna/telegram', route('/api/donna/telegram'));
    server.middlewares.use('/api/donna/firms', route('/api/donna/firms'));
  }
});

// ── Parse drain tick (RT-02) ─────────────────────────────────────────────
//
// One tick of the desktop/fallback parse drain over rows already fetched by
// fetchDrainablePendingRowsInDb. Pure over its injected writers so the
// decision table below is machine-checked (parseDrainTruthfulness.test.js,
// parseDrainTruthfulnessPgLifecycle.test.js):
//
//   runParse result                        → count            → write
//   handled:true  outcome!=='failed'       → succeeded        → none (worker wrote)
//   handled:true  outcome==='failed'       → worker_failed    → none (worker wrote)
//   handled:false reason admission_refused → admission_refused→ none (claim wrote parse_hold)
//   handled:false stale_run / not_pending  → not_claimed      → none
//   throw, retryable, attempts < max       → retry_pending    → failed ONLY IF still processing
//                                                                (release did not happen), owner manual
//   throw, retryable, attempts >= max      → exhausted        → failed, retryable:false, owner null
//   throw, non-retryable                   → failed           → failed, owner null
//
// The worker releases a retryable run back to `pending` before throwing
// (parseDocument.js), so on the desktop the next tick IS the retry owner while
// attempts remain — the row rests `pending`, never `failed` with a promise.
// Decision D7: PARSE_MAX_ATTEMPTS (default 4; env is a tuning knob) bounds
// the automatic budget; the spent budget rests terminal with copy that says
// so, on the human, with the retry button (never a queue promise).
// One number for the appliance's automatic budget (D7): the `parse-document`
// job's max_attempts and this backstop's ceiling read the same knob.
export const PARSE_MAX_ATTEMPTS_DEFAULT = PARSE_DOCUMENT_MAX_ATTEMPTS_DEFAULT;

export const runParseDrainTick = async ({
  drainable = [],
  runParse,
  markParseFailed,
  maxAttempts = parseDocumentMaxAttempts(),
  deadlineMs = Number.POSITIVE_INFINITY,
  startedAt = Date.now(),
  log = console
} = {}) => {
  const budget = Math.max(1, Number.isFinite(Number(maxAttempts)) ? Number(maxAttempts) : PARSE_MAX_ATTEMPTS_DEFAULT);
  const counts = {
    picked: drainable.length,
    processed: 0,
    succeeded: 0,
    worker_failed: 0,
    failed: 0,
    retry_pending: 0,
    exhausted: 0,
    admission_refused: 0,
    held: 0,
    not_claimed: 0
  };
  const errors = [];
  const holds = [];
  // One admission check per entity per tick: a refused entity's sibling rows
  // are counted refused without another claim (and without another audit).
  const refusedEntities = new Map();
  let deadlineHit = false;

  for (const row of drainable) {
    if (Date.now() - startedAt > deadlineMs) { deadlineHit = true; break; }
    const entityKey = `${row.firm_id}:${row.client_id}`;
    if (row.hold_fresh) {
      counts.held += 1;
      continue;
    }
    if (refusedEntities.has(entityKey)) {
      counts.admission_refused += 1;
      continue;
    }
    counts.processed += 1;
    try {
      const result = await runParse(row);
      if (result?.handled === false) {
        if (result.reason === 'admission_refused' || result.claim_outcome === 'admission_refused') {
          const reasonCode = result.reason_code || result.hold?.reason_code || null;
          refusedEntities.set(entityKey, reasonCode);
          counts.admission_refused += 1;
          if (holds.length < 10) {
            holds.push({
              document_id: row.id,
              client_id: row.client_id,
              reason_code: reasonCode,
              receipt_id: result.hold?.receipt_id ?? null
            });
          }
          log.warn?.('[parse-cron drain] admission refused; entity held', {
            document_id: row.id,
            firm_id: row.firm_id,
            client_id: row.client_id,
            parse_run_id: row.parse_run_id,
            reason_code: reasonCode,
            receipt_id: result.hold?.receipt_id ?? null
          });
          continue;
        }
        // stale_run / not_pending: another owner has this run. Not ours.
        counts.not_claimed += 1;
        continue;
      }
      if (result?.outcome === 'failed') counts.worker_failed += 1;
      else counts.succeeded += 1;
    } catch (drainErr) {
      const message = drainErr?.message || String(drainErr);
      const categorized = categorizeError(drainErr);
      // The claim incremented parse_attempts before the worker ran; the
      // drainable row carries the pre-claim count.
      const attempts = Number(row.parse_attempts ?? 0) + 1;
      errors.push({
        document_id: row.id,
        parse_run_id: row.parse_run_id,
        code: categorized.code,
        attempts,
        error: message.slice(0, 200)
      });
      const baseArgs = { firmId: row.firm_id, documentId: row.id, parseRunId: row.parse_run_id };
      const markOrLog = async (args, label) => {
        try {
          return await markParseFailed(args);
        } catch (markErr) {
          log.error?.(`[parse-cron drain] failed to mark run failed (${label})`, {
            document_id: row.id,
            parse_run_id: row.parse_run_id,
            error: markErr?.message || String(markErr)
          });
          return null;
        }
      };
      if (categorized.retryable && attempts < budget) {
        // The worker released this run to `pending`; the next tick retries it.
        // Only if the release itself failed (row still `processing`) do we
        // write — and then with a MANUAL owner, since no queue will pick a
        // failed row up. The status fence makes the released case a no-op.
        const marked = await markOrLog({
          ...baseArgs,
          parseError: withRetryOwner(categorized, 'manual'),
          allowedStatuses: ['processing']
        }, 'release-missing guard');
        if (marked) {
          counts.failed += 1;
          log.error?.('[parse-cron drain] worker threw and the run was not released; marked failed (manual)', {
            document_id: row.id,
            parse_run_id: row.parse_run_id,
            code: categorized.code,
            attempts,
            error: message
          });
        } else {
          counts.retry_pending += 1;
          log.warn?.('[parse-cron drain] retryable error; row rests pending for the next tick', {
            document_id: row.id,
            parse_run_id: row.parse_run_id,
            code: categorized.code,
            attempts,
            max_attempts: budget,
            error: message
          });
        }
      } else if (categorized.retryable) {
        await markOrLog({
          ...baseArgs,
          parseError: parseRetriesExhaustedEnvelope(categorized, { attempts, maxAttempts: budget }),
          allowedStatuses: ['processing', 'pending']
        }, 'retries exhausted');
        counts.exhausted += 1;
        log.error?.('[parse-cron drain] automatic retries exhausted; row rests terminal', {
          document_id: row.id,
          parse_run_id: row.parse_run_id,
          code: categorized.code,
          attempts,
          max_attempts: budget,
          error: message
        });
      } else {
        await markOrLog({
          ...baseArgs,
          parseError: withRetryOwner(categorized, null)
        }, 'terminal');
        counts.failed += 1;
        log.error?.('[parse-cron drain] worker threw a terminal error', {
          document_id: row.id,
          parse_run_id: row.parse_run_id,
          code: categorized.code,
          error: message
        });
      }
    }
  }

  return {
    ...counts,
    max_attempts: budget,
    deadline_hit: deadlineHit || Date.now() - startedAt > deadlineMs,
    holds,
    errors: errors.slice(0, 10)
  };
};
