// server/donna/firmDb.js — the firm-database facade.
//
// RT-17 (2026-09-02): the monolith is decomposed into
// server/donna/db/<plane>.js. Every public symbol keeps this import path: the re-export lists
// below ARE the symbol → file map (one name per line, grouped by plane). Helpers a plane exports
// for its siblings are deliberately NOT re-exported here — the public surface of this module is
// exactly what it was before the split.

// RT-16 — the ONE coding state (transactions.coding_state, migration 138):
// the machine, the legacy-input mapping, the DTO projection, the writer.
import { deriveTransactionReviewState, normalizeTransactionReviewState } from './codingState.js';
// Jurisdiction-neutral explicit fiscal-period intake (pure half). FI's statutory
// bound is injected into it below; the module itself imports no `finland/`.
import { FISCAL_PERIOD_INTAKE_FLAG_KEY } from './fiscalPeriodIntake.js';

// db/pool.js — the PostgreSQL pool and client checkout (RT-13's convergence settle hook is installed here, with the pool), the database-url and production-isolation helpers
export {
  __endFirmDbPoolForTests,
  __resetFirmDbPoolForTests,
  __setFirmDbPoolForTests,
  assertSeedTargetAllowed,
  closeFirmDbPool,
  getFirmDatabaseUrl,
  isFirmDatabaseConfigured,
  isLocalDatabaseUrl,
  isProductionRuntime,
  isSeedFallbackAllowed,
  listFirmIdsInDb,
  queryFirmDb,
  withFirmDbClient
} from './db/pool.js';

// db/clients.js — plane S — firm and legal-entity identity (the live default-firm binding), client lifecycle (create / profile / jurisdiction / delete), the EAW isolated-firm lifecycle and its read-only observers
export {
  adoptResolvedDefaultFirmId,
  assertEawFirmLifecycleAllowed,
  assertFirmScopeAllowed,
  buildClientCreationAuditContext,
  ClientIdFirmConflictError,
  countFirmResidueInDb,
  countPersistedJournalsInDb,
  createClientInDb,
  createFirmInDb,
  DEFAULT_FIRM_ID,
  deleteClientInDb,
  deleteFirmInDb,
  DEMO_FIRM_ID,
  deriveAccountingConnectionByClient,
  deriveClientIdentityColumns,
  EAW_CLOSE_COMPOSITION_BOUNDARY,
  EAW_FIRM_ID_PREFIX,
  EAW_FIRM_LIFECYCLE_VERSION,
  EAW_OBSERVER_OPS_VERSION,
  EawFirmLifecycleError,
  FirmScopeError,
  getClientAccountingSystemFromDb,
  getClientChatProfileFromDb,
  getClientDisplayNameInDb,
  getClientEntityAxisFromDb,
  getClientIdentityInDb,
  getClientJurisdictionInDb,
  getClientOwnBankAccountsFromDb,
  getDefaultFirmId,
  getFirmJurisdictionInDb,
  isDemoFirmScopeAllowed,
  loadClientOwnBankAccounts,
  readClientConfigSnapshotInDb,
  readTerminalInventoryInDb,
  recordJurisdictionSignalInDb,
  resolveClientCreateFirmIdInDb,
  resolveConfiguredDefaultFirmId,
  resolveCreateAccountingSystemPatch,
  stampProfileProvenance,
  updateClientProfileInDb,
  updateFirmLoopSettingsInDb
} from './db/clients.js';

// db/authority.js — plane A — principals, seats, entity access, the action-capability gate, the snapshot access filter, and the operator reverse spine (its memory leg routes to plane M's governed retire writers)
export {
  assertActionCapability,
  assertFirmAccess,
  filterFirmSnapshotForAccess,
  getAllowedClientIdsForPrincipal,
  getAssignmentRoleForPrincipal,
  getAuthorizedFirmSnapshotFromDb,
  getFirmPrincipalForAuth,
  getSpecialistRoleForPrincipal,
  isFirmMemberPrincipal,
  resolveDesktopClientCreationPrincipal,
  reverseAppliesInDb
} from './db/authority.js';

// db/memory.js — plane M — the merchant-rule mint (`client_rule.merchant_rule_saved`) and its cascade, the client-rule status writer, the review-recode distillation input and the confirmation-bump helpers
export {
  __buildReviewRecodeDistillation,
  __ruleConfirmationBumpPatch,
  __shouldBumpRuleConfirmation,
  __shouldDistillReviewRecode,
  buildClientRuleId,
  saveMerchantRuleForPayload,
  updateClientRuleStatusInDb
} from './db/memory.js';

// db/documents.js — plane S — document rows: the statement/document import writer, document update/delete, payment status after a match
export {
  applyDocumentPaymentStatusAfterMatch,
  deleteDocumentInDb,
  getDocumentClientIdInDb,
  syncDocumentsAndTransactionsInDb,
  updateDocumentInDb
} from './db/documents.js';

// db/transactions.js — plane S — transaction rows: the DTO projection, the accounting-mutability guard, the transaction-intel refresh, the transaction update writer
export {
  __refreshTransactionIntelForClientWithClient,
  refreshTransactionIntelInDb,
  setTransactionAiEvidenceRequiredInDb,
  TRANSACTION_INTEL_STEPPED_ASIDE_ACTION,
  updateTransactionInDb
} from './db/transactions.js';

// db/coding.js — plane S — coding: the review case file DTO, account options and coding markers, the single/batch strong-coder writers, the review-item writers (every transition through codingState.js)
export {
  __acceptExplainsSupport,
  __attachReplyContextToBatchPool,
  __counterpartyClusterTotals,
  __descriptionOnlyAutoApplyCeiling,
  __isOwnMoneyMovementAccount,
  __isTerminalCodingState,
  __loadDirectUncodedNeedsReviewPool,
  __namedPayeeForTransaction,
  __payeeMatchesKnownPrincipal,
  __relationshipAutoApplyCeiling,
  __resolveClientCodingPolicyWithClientForTests,
  __reversePatchFromBeforeAfter,
  __reviewItemBeforeAfter,
  __roundCounterpartyKey,
  __shouldAutoApplyBatchSuggestion,
  batchSuggestTransactionCodingInDb,
  DECIDED_TRANSACTION_REVIEW_STATES,
  DIRECT_UNCODED_NEEDS_REVIEW_SQL,
  ensureTransactionReviewItemInDb,
  getClientAccountOptionsFromDb,
  suggestTransactionCodingInDb,
  updateTransactionReviewItemInDb
} from './db/coding.js';

// db/reconcile.js — plane S — reconciliation matches: matched-document loads, the manual match writer, the match update (confirm / reject) writer
export {
  __createManualReconciliationMatchInDbWithClient,
  __linkReplyEvidenceMatchesInDb,
  __matchBeforeAfter,
  createManualReconciliationMatchInDb,
  updateReconciliationMatchInDb
} from './db/reconcile.js';

// db/asks.js — plane C — the ask primitive: client evidence requests (create / resolve / accept / reject / cancel / amend / resend) and the ask-batch region (draft / send)
export {
  __createClientEvidenceRequestWithClient,
  __draftClientAskBatchWithClient,
  __findStaleAskDraftAnchors,
  __normalizeAnswerSource,
  __recodeTransactionAfterClientReplyWithClient,
  __resumeEvidenceRecodeAfterParseWithClient,
  __sendClientAskBatchWithClient,
  __shouldApplyReplyRecode,
  __shouldResumeFromClientReply,
  acceptClientEvidenceRequestInDb,
  AMENDABLE_EVIDENCE_REQUEST_STATUSES,
  amendClientEvidenceRequestInDb,
  ANSWER_SOURCES,
  cancelClientEvidenceRequestInDb,
  CANCELLABLE_EVIDENCE_REQUEST_STATUSES,
  createClientEvidenceRequestInDb,
  deliverEvidenceAsksOnAllChannels,
  DISPOSITION_DRIVEN_ASK_FLAG_KEY,
  draftClientAskBatchInDb,
  getAskBatchDraftsForFirmFromDb,
  getClientAskBatchesFromDb,
  getClientEvidenceRequestByIdInDb,
  getClientEvidenceRequestForClientFromDb,
  getClientEvidenceRequestsFromDb,
  getOpenClientEvidenceRequestsForChatFromDb,
  listOpenEvidenceTopicsForReminderInDb,
  markCodingAutoPostFyiPendingInDb,
  MAX_EVIDENCE_REQUEST_AMENDMENTS,
  recordDocumentSignedUrlCreatedInDb,
  recordEvidenceTopicTurnInDb,
  rejectClientEvidenceRequestInDb,
  RESEND_MIN_INTERVAL_MS,
  resendClientEvidenceRequestInDb,
  resolveClientEvidenceRequestInDb,
  resumeEvidenceRecodeAfterParseInDb,
  sendClientAskBatchInDb,
  stampEvidenceTopicReminderInDb
} from './db/asks.js';

// db/ledger.js — plane S — Donna's own ledger: settlement plans, transaction and period posting, ledger accounts, journals, opening balances, invoice / bill / credit-note journals, corrections and adjustments, the ledger audit trail
export {
  __canonicalRoleForAccount,
  __commitPreparedLedgerPosting,
  __insertLedgerCorrectionJournal,
  __ledgerAccountMintShape,
  __normalBalanceForAccountClass,
  __prepareLedgerTransactionPosting,
  __resolveMissingAccountSuggestion,
  __reverseLedgerLine,
  __reverseOutboundArJournalWithClient,
  __donnaChartMenuAccounts,
  __writeLedgerJournalRows,
  assertCorrectionLinesBalance,
  assertJournalDateNotLocked,
  createGbOpeningBalanceEvidenceRequestInDb,
  createOpeningBalanceEvidenceRequestInDb,
  DOCUMENT_SETTLEMENT_OWNER_FUNDS_ACCOUNT,
  ensureLedgerAccountFromVerdict,
  GB_OPENING_BALANCES_FLAG_KEY,
  gbOpeningBalanceFlagActsInDb,
  getLedgerAuditTrailFromDb,
  ledgerRecordId,
  openingBalanceWhatsAppFlagActsInDb,
  PACK_PALETTE_CHART_SEED_ACTION,
  postCreditNoteJournalFromDb,
  postCreditNoteJournalWithClient,
  postDocumentSettlementJournalWithClient,
  postGbOpeningBalanceJournalFromDb,
  postGbOpeningBalanceJournalWithClient,
  postAeOpeningBalanceJournalWithClient,
  postLedgerAdjustmentInDb,
  postLedgerPeriodInDb,
  postLedgerTransactionInDb,
  postOpeningBalanceJournalFromDb,
  postOpeningBalanceJournalWithClient,
  postOutboundArJournalWithClient,
  postSalesInvoiceJournalFromDb,
  postSalesInvoiceJournalWithClient,
  postSupplierBillJournalFromDb,
  postSupplierBillJournalWithClient,
  seedPackPaletteChartWithClient,
  upsertLedgerAccountForJournal
} from './db/ledger.js';

// db/close.js — plane S — close: diagnostics, exceptions, the period preview, financial reports, the close archive, fiscal years and periods, close checks and the period lock
export {
  createCloseArchiveInDb,
  getCloseArchiveExportFromDb,
  getCloseArchivePreviewFromDb,
  getCloseDiagnosticsFromDb,
  getCloseExceptionsFromDb,
  getFinancialReportFromDb,
  getLatestPostedLedgerPeriodFromDb,
  getLedgerPeriodPreviewFromDb,
  getProcountorExportPackageFromDb,
  listFiscalPeriodsFromDb,
  lockClosePeriodInDb,
  registerFiscalPeriodFromDb,
  registerFiscalPeriodWithClient,
  resolveClientFiscalYearTx,
  runCloseChecksInDb
} from './db/close.js';

// Stable public statutory API. The registry owns country composition;
// preserve these named writers until the public API contract is explicitly retired.
export {
  __cancelAlvReturnWithClient,
  __cancelGstReturnWithClient,
  __createAlvReturnDraftWithClient,
  __createGstReturnDraftWithClient,
  __markAlvReturnFiledWithClient,
  __markGstReturnFiledWithClient,
  __recordCorpPassMandateWithClient,
  __recordPrepaymentRegisterCheckWithClient,
  __recordSuomifiMandateWithClient,
  __revokeCorpPassMandateWithClient,
  __revokeSuomifiMandateWithClient,
  cancelAlvReturnInDb,
  cancelGstReturnInDb,
  createAlvReturnDraftInDb,
  createAlvReturnEvidenceRequestInDb,
  createGstReturnDraftInDb,
  createGstReturnEvidenceRequestInDb,
  deliverPendingFinlandScopeDriftAsks,
  drainAeCtRegistrationEscalations,
  drainAeVatRegistrationEscalations,
  drainAeVatReturnDeadlineEscalations,
  drainAeVatThresholdEscalations,
  drainFinlandAlvThresholdEscalations,
  drainGbVatThresholdEscalations,
  finlandAlvFilingWhatsAppFlagActsInDb,
  getActiveCorpPassMandateInDb,
  getActiveSuomifiMandateInDb,
  getAlvReturnByIdInDb,
  getAlvReturnForPeriodInDb,
  getCorpPassMandateStatusInDb,
  getFinlandAlvReturnFromDb,
  getFinlandAlvThresholdWatchFromDb,
  getFinlandAnnualReturnFromDb,
  getFinlandCutoverPackFromDb,
  getFinlandEnnakkoveroStatusFromDb,
  getFinlandOyBalanceSheetWatchesFromDb,
  getFinlandOyMonthlyCloseFromDb,
  getFinlandOyOnboardingStateFromDb,
  getFinlandOyYelApplicabilityFromDb,
  getFinlandPrepaymentRegisterFromDb,
  getFinlandScopeDriftFilingGateFromDb,
  getFinlandScopeDriftFromDb,
  getFinlandYelStatusFromDb,
  getGbLtdMonthlyCloseFromDb,
  getGstReturnByIdInDb,
  getGstReturnForPeriodInDb,
  getSingaporeFilerContextInDb,
  getSingaporeGstReturnFromDb,
  getSuomifiMandateStatusInDb,
  markAlvReturnFiledInDb,
  markGstReturnFiledInDb,
  recordCorpPassMandateInDb,
  recordPrepaymentRegisterCheckInDb,
  recordSuomifiMandateInDb,
  revokeCorpPassMandateInDb,
  revokeSuomifiMandateInDb,
  singaporeGstFilingFlagActsInDb,
  startFinlandAlvReturnFilingInDb,
  startSingaporeGstReturnFilingInDb
} from './statutoryRegistry.js';

// db/issuance.js — plane S — outbound issuance: issued invoices and quotes, the owner invoice command, seller context
export {
  __cancelIssuedInvoiceWithClient,
  __cancelIssuedQuoteWithClient,
  __createIssuedInvoiceDraftWithClient,
  __createIssuedQuoteDraftWithClient,
  __declineIssuedQuoteWithClient,
  __markIssuedInvoiceIssuedWithClient,
  __markIssuedQuoteSentWithClient,
  __supersedeIssuedInvoiceDraftWithClient,
  __supersedeIssuedQuoteDraftWithClient,
  cancelIssuedInvoiceInDb,
  cancelIssuedQuoteInDb,
  createInvoiceIssuanceEvidenceRequestInDb,
  createIssuedInvoiceDraftInDb,
  createIssuedQuoteDraftInDb,
  declineIssuedQuoteInDb,
  finlandAlvInvoicingWhatsAppFlagActsInDb,
  finlandEInvoiceReceiveWhatsAppFlagActsInDb,
  finlandInvoicingWhatsAppFlagActsInDb,
  finlandQuotesWhatsAppFlagActsInDb,
  getFinlandIssuedInvoicesFromDb,
  getFinlandQuotesFromDb,
  getInvoiceSellerContextInDb,
  getIssuedInvoiceByIdInDb,
  getIssuedInvoiceCreditContextInDb,
  getIssuedQuoteByIdInDb,
  getIssuedQuoteContextInDb,
  markIssuedInvoiceIssuedInDb,
  markIssuedQuoteSentInDb,
  persistFinlandSellerIdentityInDb,
  supersedeIssuedInvoiceDraftInDb,
  supersedeIssuedQuoteDraftInDb
} from './issuanceRegistry.js';
export { getOwnerInvoiceSellerContextInDb, runOwnerInvoiceCommandInDb } from './db/issuance.js';

// db/xero.js — plane S mirror — the Xero connection, bank-transaction writeback, mirror retry / verify / clear, chart provisioning and reference sync
export {
  __isXeroExportCandidateTransaction,
  __transactionWritebackCandidateQuery,
  appendXeroHistoryNoteForTransactionInDb,
  classifyXeroMirrorRetryTransaction,
  clearXeroMirrorForClientBestEffort,
  completeXeroConnectionInDb,
  disconnectXeroConnectionInDb,
  getFreshXeroConnectionForSync,
  matchingXeroBankTransactions,
  mergeReviewRowIntoTransaction,
  provisionXeroChartOfAccountsInDb,
  retryXeroMirrorInDb,
  shouldVoidXeroMirrorRow,
  startXeroConnectionInDb,
  syncXeroReferenceDataInDb,
  verifyXeroMirrorInDb,
  writebackXeroTransactionInDb,
  writebackXeroTransactionsBatchInDb,
  xeroMirrorClearColumnsPatch
} from './db/xero.js';

// db/qbo.js — plane S mirror — the QuickBooks Online connection, reference sync and journal-entry writeback
export {
  completeQboConnectionInDb,
  disconnectQboConnectionInDb,
  getFreshQboConnectionForSync,
  retryQboMirrorInDb,
  startQboConnectionInDb,
  syncQboReferenceDataInDb,
  verifyQboMirrorInDb,
  writebackQboTransactionInDb,
  writebackQboTransactionsBatchInDb
} from './db/qbo.js';

// db/procountor.js — plane S mirror — the Procountor connection, reference sync and ledger-receipt writeback
export {
  __persistProcountorMirrorFailure,
  __procountorMirrorFailureAnnotation,
  completeProcountorConnectionInDb,
  connectProcountorWithApiKeyInDb,
  disconnectProcountorConnectionInDb,
  getFreshProcountorConnectionForSync,
  procountorRecordId,
  retryProcountorMirrorInDb,
  startProcountorConnectionInDb,
  syncProcountorReferenceDataInDb,
  verifyProcountorMirrorInDb,
  writebackProcountorTransactionInDb,
  writebackProcountorTransactionsBatchInDb
} from './db/procountor.js';

// db/hmrc.js — plane S — the HMRC MTD VAT connection
export {
  completeHmrcConnectionInDb,
  getFreshHmrcConnectionForSync,
  HMRC_MTD_VAT_FLAG_KEY,
  hmrcConnectionIdForClient,
  startHmrcConnectionInDb
} from './db/hmrc.js';

// db/chat.js — plane S — chat threads: document, transaction, firm and client-portal chat writers and readers (the proposal mint audit)
export {
  __chatProposalAuditEvent,
  __supersedePriorChatProposals,
  __supersedePriorClientChatProposals,
  __supersedePriorFirmChatProposals,
  appendClientPortalChatMessageInDb,
  appendDocumentChatMessageInDb,
  appendFirmChatMessageInDb,
  appendTransactionChatMessageInDb,
  countRecentFirmChatUserMessagesInDb,
  getClientPortalChatDocsFromDb,
  getClientPortalChatMessageFromDb,
  getClientPortalChatThreadFromDb,
  getDocumentChatMessageFromDb,
  getDocumentChatThreadFromDb,
  getFirmChatMessageFromDb,
  getFirmChatThreadFromDb,
  getTransactionChatMessageFromDb,
  getTransactionChatThreadFromDb,
  getTransactionChatUnreadSummaryFromDb,
  isVirtualChatThreadId,
  listFirmChatVentureUniverseInDb,
  redactChatCommentInDb,
  updateClientPortalChatActionStatusInDb,
  updateDocumentChatActionStatusInDb,
  updateFirmChatActionStatusInDb,
  updateTransactionChatActionStatusInDb,
  VIRTUAL_CHAT_THREAD_IDS
} from './db/chat.js';

// db/channels.js — plane S delivery state — WhatsApp / SMS / Telegram bindings, inbound claims, the delivery ledger, owner-media summaries and the per-channel ask deliveries
export {
  __bumpEvidenceRequestSendCountWithClient,
  __claimInboundSmsMessageWithClient,
  __claimInboundTelegramMessageWithClient,
  __claimInboundWhatsAppMessageWithClient,
  __getActiveSmsBindingForClientWithClient,
  __getActiveSmsBindingsByPhoneHashWithClient,
  __getActiveTelegramBindingForClientWithClient,
  __getActiveTelegramBindingsByPhoneHashWithClient,
  __getActiveWhatsAppBindingForClientWithClient,
  __getActiveWhatsAppBindingsByPhoneHashWithClient,
  __getOpenWhatsAppEvidenceRequestByRefWithClient,
  __getOpenWhatsAppEvidenceRequestsForClientWithClient,
  __getTelegramDeliveryByMessageIdWithClient,
  __getWhatsAppDeliveryByMessageIdWithClient,
  __mintWhatsAppBindTokenWithClient,
  __recordMessageDeliveryLedgerWithClient,
  __redeemWhatsAppBindTokenWithClient,
  __revokeWhatsAppBindingWithClient,
  claimInboundSmsMessageInDb,
  claimInboundTelegramMessageInDb,
  claimInboundWhatsAppMessageInDb,
  claimOwnerMediaGroupSendInDb,
  claimOwnerMediaSummarySendInDb,
  deliverEmailEvidenceAsksAfterSend,
  deliverSensitiveAskPortalNotice,
  deliverSmsEvidenceAsksAfterSend,
  deliverTelegramEvidenceAsksAfterSend,
  deliverWhatsAppEvidenceAsksAfterSend,
  getActiveSmsBindingForClientInDb,
  getActiveSmsBindingsByPhoneHashInDb,
  getActiveTelegramBindingForClientInDb,
  getActiveTelegramBindingsByPhoneHashInDb,
  getActiveWhatsAppBindingForClientInDb,
  getActiveWhatsAppBindingsByPhoneHashInDb,
  getOpenWhatsAppEvidenceRequestByRefInDb,
  getOpenWhatsAppEvidenceRequestsForClientInDb,
  getOwnerMediaDocForSummaryInDb,
  getTelegramDeliveryByMessageIdInDb,
  getWhatsAppDeliveryByMessageIdInDb,
  listOwnerMediaDocsNeedingTerminalSummaryInDb,
  listOwnerMediaGroupDocsInDb,
  listOwnerMediaSummaryClaimedDocIdsInDb,
  mintWhatsAppBindTokenInDb,
  OWNER_EMAIL_ASKS_FLAG_KEY,
  OWNER_TEMPLATE_FALLBACK_LANGUAGE,
  preferredOwnerTemplateLanguage,
  recordMessageDeliveryLedgerInDb,
  redeemWhatsAppBindTokenInDb,
  revokeWhatsAppBindingInDb
} from './db/channels.js';

// db/snapshot.js — plane S compressed reads — the firm snapshot and the feed rows (the in-memory two-terminal projection sites)
export {
  getFeedChatAgreementDocsFromDb,
  getFeedChatPipelineDocsFromDb,
  getFeedChatRowsFromDb,
  getFirmSnapshotFromDb
} from './db/snapshot.js';

// The legacy-input helpers keep their firmDb.js export (transactionReviewStates.test.js,
// api.js); their home is codingState.js.
export { normalizeTransactionReviewState, deriveTransactionReviewState } from './codingState.js';

export { FISCAL_PERIOD_INTAKE_FLAG_KEY } from './fiscalPeriodIntake.js';

