// DMEM W3a: reviewed static statement inventory; NOT runtime write authority.
// Every tuple binds a named owner, normalized statement digest, exact site count,
// and target operations. No path-level allowance and no regeneration command.
// SQL comments are previews for review; the full statement (including literal
// values) is hashed. Unresolved SQL also binds its current enclosing function.
// Dynamic debt is explicit uncertainty, not proof of a fixed target. See map move5.
export const MEMORY_WRITE_TABLES = Object.freeze([
  'memories', 'memory_relations', 'memory_candidates', 'memory_candidate_events',
  'memory_evidence_links', 'memory_dependencies', 'memory_projections', 'firm_facts', 'client_rules',
]);
export const MEMORY_WRITER_REGISTRY_VERSION = 1;

const group = (file, context, entries) => entries.map(([owner, kind, digest, count, targetCodes]) => {
  const dynamic = kind !== 'mutation';
  const gateway = /\/(?:memoriesDb|memoryCandidates)\.js$/.test(file);
  const maintenance = file.startsWith('scripts/');
  return Object.freeze({
    file, owner, kind, digest, count,
    targets: Object.freeze(targetCodes.map((code) => {
      const [operation, table] = code.split(':');
      return Object.freeze({ operation, table });
    })),
    disposition: dynamic ? 'dynamic_debt' : gateway ? 'gateway' : maintenance ? 'maintenance_debt' : 'legacy_debt',
    rationale: `${context} Owner: ${owner}. ${dynamic
      ? 'Computed SQL or an opaque query argument; the target set is not statically proven, even when the visible query reads only.'
      : gateway ? 'Existing lifecycle gateway statement; registration does not certify full governed-writer conformance.'
      : 'Existing direct compatibility-store mutation retained as explicit W3 debt.'}`,
    exitCriterion: dynamic
      ? 'Replace this exact dynamic boundary with statically enumerable statements, or remove it during the governed-writer migration; any changed body/statement needs explicit review.'
      : gateway ? 'Retain only reviewed lifecycle statements as W3 centralizes acquisition and projection; remove this entry with its statement.'
      : maintenance ? 'Route this maintenance mutation through the governed purge/projection lifecycle or retire the command.'
      : 'Replace this exact legacy write with the canonical governed writer and one-way compatibility projection in W3.',
  });
});

// Jev-first rollout (2026-09-19): reviewed 18 owner-bound digest changes.
// The underlying interpolated SELECTs and contract-obligation SQL arguments are
// unchanged, with identical target metadata and site counts. Owners now route
// through the scoped Jev decision, persist returned-model/handoff receipts, and
// suppress legacy inline decisions. No memory mutation boundary was added.
// FIK-2 (2026-09-23, re-pin approved by Kari): reviewed 2 owner-bound digest
// changes. The enclosing bodies of resolveClientCodingPolicyWithClient and
// readPostingContextWithClient now pass the config snapshot's decision-guidance
// variant to the flag-free resolver; their `select … from clients` SQL, targets
// and counts are unchanged. No memory mutation boundary was added.
// HELMIKUU S7 / H-7b (2026-09-24): reviewed 3 digest changes and 4 read-only
// SELECTs that became dynamic because they interpolate the imported fragment
// REFUSED_CROSS_WINDOW_GROUP_SQL (a resting cross-window refund group leaves
// coder admission until its case evidence changes). Firm/client binding,
// targets and counts are unchanged. No memory mutation boundary was added.
// HELMIKUU S8 (2026-09-24): reviewed 1 owner-bound digest change
// (completeOwnerConfirmedJevPlanWithClient: row-scoped statement check and the
// scope-decision receipt). Its SQL, targets and counts are unchanged. No memory
// mutation boundary was added.
// Tuples: owner, kind, SHA-256 statement identity, exact occurrences, operation:table[].
// Engine repairs: the exact boundaries below were reviewed individually;
// empty targets preserve uncertainty debt, never authorize memory mutation.
export const MEMORY_WRITER_REGISTRY = Object.freeze([
  ...group("server/donna/testSupport/physicalQualificationFixture.js", "Reviewed qualification-only disposable local database fixture: random internally generated database creation/drop and the complete checked-in migration reader. The helper refuses non-local PostgreSQL, is called only by the synthetic qualification tests/browser command, and never opens an enrolled customer book. These exact dynamic boundaries grant no production writer authority.", [
    ["physicalQualificationFixture","dynamic_sql","03c1dd862ef5a76857b8a2f622ac1715036ce17c9252bc045605f4a6c386b6c5",1,[]],
    ["dispose","dynamic_sql","f6baa2eb1b71a6d5661fe1c601d5860c568d8c085d305fe3e2ee8a77165aff14",1,[]],
    ["physicalQualificationFixture","dynamic_query","aef56548e617f0d68e1f5929488c3a286cb8f671981131a462801ec3903e2369",1,[]],
  ]),
  ...group("server/donna/convergenceConnection.js", "Reviewed SG C4 connection ownership transaction controls: SAVEPOINT, RELEASE and ROLLBACK TO use only an internally generated fixed-prefix sequence. These are transaction controls, not reads; no business writer or memory target is introduced.", [
    // F-28 (2026-09-29): the pre-savepoint status probe (`select 1`) and the owned-transaction fallback add no writer; the same fixed-prefix transaction controls, re-pinned.
    ["withConvergenceTransaction","dynamic_sql","9f429658d525bba8fc1d336aa355d3cb4a2dcafb2b9d2a9e200185b0204b4ee6",1,[]],
    ["withConvergenceTransaction","dynamic_sql","8de89af7b98bf52e714ea6bdbc23f919fb73e04dcf8fc20aef2e5ef4742ce432",2,[]],
    ["withConvergenceTransaction","dynamic_sql","d8dfabf11e7db8b7c33a2442a99df56cb6704abc6b4f9dccb9597d4bd4fb32bf",1,[]],
  ]),
  ...group("server/donna/db/authority.js", "Reviewed SG C4b same-connection authority SELECTs and locks; allowed-client lookup now requires active assignment status. Assignment time chooses only now() or statement_timestamp(); scope/SHARE NOWAIT fragments and member/collaborator table choice are closed literals. Firm, principal and client values stay bound. No new memory writer.", [
    ["getAllowedClientIdsForPrincipal","dynamic_sql","5e49bda90c1543d95cd2db1ada2ddc699db9a5d4f95024f06c58fdbab72feabf",1,[]],
    ["assertFirmAccess","dynamic_sql","eb3969b8dfae9747beff28ec127da05caf4142c5df9c36ec002ffff8f86f44a4",1,[]],
  ]),
  ...group("server/donna/db/coding.js", "Reviewed SG C4 owner-body rehash of two unchanged normalized candidate SELECTs. The batch now refreshes persisted evidence between generation units; these exact SQL expressions, targets and site counts are unchanged. Rehashed again 2026-11-05: a comment inside the owner body renamed a real supplier to a made-up one for the public export; the SELECTs are unchanged. Rehashed again 2026-11-06: the comment no longer names any real counterparty; the SELECTs are unchanged.", [
    ["batchSuggestTransactionCodingInDb/callback","dynamic_sql","9405e27489bc5b6152c21b5c5e50407c488c51ab0eec4ac507929dfd4994ff80",1,[]],
    ["batchSuggestTransactionCodingInDb/callback","dynamic_sql","1f8db772d9fd8bc65714966e72dd3418405afe62cab40cdf727fcd698e305934",1,[]],
  ]),
  ...group("server/donna/db/codingCorrection.js", "Reviewed SG C4 candidate SELECT excluding retained or partial native markers through retainedNativeMarkerSql with fixed alias t. Firm and limit remain bound. Discovery refuses work and grants no posting or review authority.", [
    ["candidates/callback","dynamic_sql","cb0b46a00c8ed26ebaece05502eb54dbbd099cbaf918127de4c68898299d6ebe",1,[]],
  ]),
  ...group("server/donna/db/snapshot.js", "Reviewed SG C4 owner-body rehash of the unchanged normalized review-queue SELECT. The enclosing snapshot projects retained processing scope and pairs canonical current rows with activity; this expression remains a read with unchanged targets and count.", [
    ["getFirmSnapshotFromDb","dynamic_sql","d34f51fd2a5eef65e9f0ec80db0df7a63ed2033634b1da52c559b1af30fa797a",1,[]],
  ]),
  ...group("server/donna/jevCaseBatchRead.js", "Reviewed SG C4 fixed-source bounded company evidence SELECT assembly and its opaque execution argument. Internal aliases/fragments are fixed code, including the imported convergence read; firm/client/ids/asOf are bound. No mutation was found in the assembled SELECT. SG C4b R3 adds a same-snapshot association from each referenced acceptance audit to its exact transaction or canonical queue item, bounded to the same firm/client/focals. No targets/counts or execution interpolation changed. The opaque transport is still dynamic debt, not statically certified read-only.", [
    // F-23 (2026-09-29): pending_focals also honours a client-scoped convergence mark (migration 158). Same fixed-source SELECT; no writer added.
    ["JEV_TRANSACTION_BATCH_SQL","dynamic_sql","16f5d5ea3ef311f43ac0598d8c7aee635eebd261702f09fa95fdcd78666ebefc",1,[]],
    ["readJevTransactionBatchRows","dynamic_query","27e7cfaa2c5dbb6a1fa37855b17b8739775611c844508586bfedbf35b167fb64",1,[]],
  ]),
  ...group("server/donna/jevPreview.js", "Reviewed SG C4 owner-body rehash of eight unchanged normalized firm/client-scoped evidence SELECTs after projection extraction. Exact statement text, optional locking fragments, bounded windows, targets and counts remain unchanged.", [
    // SG native fence (2026-09-28): the optional read-lock fragment is now one fixed ${lock} value (" for share" or " for share nowait"; matches use "of rm"). Statements, targets, windows and counts are unchanged.
    ["readJevCase","dynamic_sql","932700b637543bde6e56caea2890d7d4b021908be441d0cb85e0cb7068fe1488",1,[]],
    ["readJevCase","dynamic_sql","e27dd363ccc4e31c0d92eda63ed5f26682c3127aa11bb89be07884310351df32",1,[]],
    ["readJevCase","dynamic_sql","b6a8e938d2a59cdaf4161f1f51baaef4b524cb17dbfca5e2e98eb04a317b39b2",1,[]],
    ["readJevCase","dynamic_sql","1979c3e1f8cdd084e046c002905903d3542625c9415a298dd0cc42aceca27227",1,[]],
    ["readJevCase","dynamic_sql","8b3458ba11e809ff0a8c6ed6d7d650fbed2b16de9dae3313ebc7c23a752fa90c",1,[]],
    ["readJevCase","dynamic_sql","44d18d9efccbe2975ad5a2b5f7d03214575ca3d7105cc784de3f7f71c57a12bc",1,[]],
    ["readJevCase","dynamic_sql","a5d85b141e646d1258fe80562e0ba177cb419e71335b4ec833e143c21565d3cd",1,[]],
    ["readJevCase","dynamic_sql","aa5fe914e773609f81b644c5fa3a7773dc23de3d7866bfefc854c1808ade23aa",1,[]],
  ]),
  ...group("server/donna/ledgerAutoPost.js", "Reviewed SG C4 existing admission and discovery SELECTs now interpolate the shared retainedNativeMarkerSql with fixed alias t. Firm/client boundaries remain bound. These reads exclude retained scope from the existing posting consumer; they add no posting writer or authority.", [
    // SG audit_events index (2026-09-28): the retained-native marker is now evaluated once per candidate client through a scope CTE (ELIGIBLE_LINES_SQL) / distinct-client subselect (DISCOVER_LEDGER_POST_CLIENTS_SQL). Same firm/client-scoped SELECTs, targets and counts; no writer added.
    ["ELIGIBLE_LINES_SQL","dynamic_sql","27f2047a64bc6bebd1b8cc0da50779adb5a6e5b0188d231350cf667b62568719",1,[]],
    ["DISCOVER_LEDGER_POST_CLIENTS_SQL","dynamic_sql","1646b74c8bd96dd86770c1a11e6295d25dbe589a5164221dcced5e7be80be5e5",1,[]],
  ]),
  ...group("server/donna/reconcileConvergenceState.js", "Reviewed SG C4 native target discovery SELECT, scoped by bound firm and target ids and the shared retained-native marker read. No new source writer.", [
    ["nativeConvergenceTargets","dynamic_sql","ec4fd996f8324dbbcc992e77a1e05ba42c2c6082b93e91f65ac9b087b1a45efa",1,[]],
  ]),
  ...group("server/donna/reconcileConvergenceState.js", "Reviewed SG C4 bounded claim is a REAL DELETE mutation of convergence_marks. MATERIALIZED ordered selection, firm/client/xid filters, bound limit and SKIP LOCKED feed DELETE USING in the existing projection owner. Empty memory targets do not mean no mutation. No memory or ledger writer is added.", [
    // F-22/F-23 (2026-09-29): the claim RETURNs client_id/source/marked_xid so a failing or budget-deferred firm's marks can be requeued at the FIFO tail; same DELETE target and filters.
    ["settleConvergenceMarksWithClient","dynamic_sql","8a4cd1ac7118dc5e3f0a8a082f08c47910dabcd85a97d2c4e98ec63f83265ac7",1,[]],
  ]),
  ...group("server/donna/reconcileConvergenceState.js", "Reviewed SG C4 existing opaque query forwarding under explicit physical-connection ownership, including depth-based pass-through. These wrappers can forward arbitrary caller SQL and remain dynamic debt; they are not certified read-only and this registration grants no writer authority.", [
    ["rawQuery","dynamic_query","10ef3e9bea156f9611ffc8236e45e68c0c2971aa1e2460bd2f3f43a489790567",2,[]],
    ["convergenceSettlingQuery","dynamic_query","3213c8c7262df560c1a320ddb5dc50449a982af27145fe3737db23c803ab4e5d",7,[]],
    ["convergenceSettlingQuery","dynamic_query","87c9478dff4a0254e0bbf6f89fdb8bcfc041312796fa23c41b04310df23c17a4",6,[]],
  ]),
  ...group("server/donna/bankLineDispositionLlm.js", "Reviewed existing firm/client-scoped candidate and context SELECTs. The direction fragment is one of the literal money_in/money_out columns; owner changes preserve current-source settlement authority. No memory target is added.", [
    // select id, firm_id, client_id, money_in, money_out, currency, transaction_date, description, raw_description, payload->>'contact' as contact, reconciliation_status, status from transactions where firm
    ["runBankLineDispositionForClient","dynamic_sql","f48bf0b5552765ab1286705db37c3c02d21712eb740e699e6173e452f76ec816",1,[]],
    // select description, raw_description from transactions where firm_id = $1 and client_id = $2 and __DYNAMIC_SQL__ > 0 limit $3
    ["runBankLineDispositionForClient","dynamic_sql","ec3da7f6da57dcaea027f945f906e6d968c3c3ce89fe419578a9b564a88b0f91",1,[]],
    // select description, raw_description from transactions where firm_id = $1 and client_id = $2 and __DYNAMIC_SQL__ > 0 limit $3
    ["runBankLineDispositionForTransaction","dynamic_sql","665580369e872a21bfd90f53daba993f9ab55f6254a97a425b9633264506d68a",1,[]],
  ]),
  ...group("server/donna/codingConvergence.js", "Reviewed extraction of the existing firm-scoped coder eligibility SELECT for shared worker/activity use. The imported policy-failure predicate remains read-only; discovery groups the same item query under its bounded client limit. No memory mutation is added. Re-reviewed 2026-09-24 (HELMIKUU S7, H-7b): the item SELECT (and so discovery, which wraps it) also excludes a resting cross-window refund-group member through the imported read-only fragment REFUSED_CROSS_WINDOW_GROUP_SQL (fixed column paths and one fixed code literal); firm scope, targets and counts are unchanged.", [
    // select t.id, t.client_id from transactions t where t.firm_id = $1 ... imported policy-failure predicate
    ["CODING_CONVERGENCE_ITEMS_SQL","dynamic_sql","fd55a8f9a43ec7ab927b08c41d7c5b2f4f73377b8aa4a8635c2937a19a415187",1,[]],
    // select t.client_id, count(*)::int as unseen_lines from (shared item SELECT) t where not (exhausted readiness rest, readiness-owned fragment) group by t.client_id ... limit $2
    ["DISCOVER_CODER_CLIENTS_SQL","dynamic_sql","25fb57227020181ae2e843b098b5563ae55d2cb6c1d62fe2aca6710af7f27553",1,[]],
  ]),
  ...group("server/donna/hostedPilotTerminalConvergence.js", "Reviewed 2026-09-23 (exhausted readiness saga): the bounded firm-scoped hosted-pilot discovery SELECT now excludes an entity resting at failed/exhausted through the one readiness-owned fragment (entityReadinessExhaustedRestSql, fixed column names, no bound values interpolated). Read-only; no memory mutation or new writer is added. Re-reviewed 2026-10-01 (US hosted lane, docs/design-donna-us-hosted-lane.md): the FI-only jurisdiction/legal-form/version filter is replaced by a join to a bound jsonb list of the hosted accounting markets ($2, built from HOSTED_MARKET_PROFILES, no value interpolated); still one bounded firm-scoped SELECT, no memory mutation or new writer.", [
    // select c.id as client_id,f.metadata from clients c join firms f ... join jsonb_to_recordset($2) markets ... and not exists (exhausted saga with acting enrollment) ... limit $3
    ["candidates/callback","dynamic_sql","0518bed72e4fb135eb4c16f8806bb76be995b777908befd3d04b6a825f1203a2",1,[]],
  ]),
  ...group("server/donna/db/reconcileActivity.js", "Reviewed read-only worker admission and policy-failure SELECTs. Dynamic imports provide the existing reply and coding predicates; all bind firm scope. The policy fragment reads current transaction receipts. This display reader adds no mutation or worker dispatch. SG C4b R2 threads the already-verified current row set through this owner; all three SQL statements, parameter expressions, targets and counts remain unchanged. Re-reviewed 2026-09-22 (hosted loading): recovery evidence reads are batched per client; these three statements and their bound parameters remain byte-identical. Re-reviewed 2026-09-24 (HELMIKUU H-7a): the enclosing body's static firm-scoped client_evidence_requests SELECT also reads request_payload->'anchor_transaction_ids', so a reply reaches the rows its question anchors; the three dynamic statements, their bound parameters, targets and counts are unchanged. No memory mutation or worker dispatch is added.", [
    ["readReconcileActivityWithClient","dynamic_query","e5a27b16ee1117f552436117d75570d582666ff2530bf829b2eeeb94313ee0fe",1,[]],
    ["readReconcileActivityWithClient","dynamic_query","6ae262b66e283fd138074db0c93ff5037a64b548fb60cd72f75d3d070331689c",1,[]],
    ["readReconcileActivityWithClient","dynamic_sql","f97ac80a15536a3260412cd182d8675cd2b34d7be74d53f4f8a7f95e4390def6",1,[]],
  ]),
  ...group("server/donna/creditNoteApplications.js", "Reviewed existing audit-event receipt INSERT. The interpolated action suffix is the internal credit_application or reminder_settlement literal, never model content. This records the existing ask resolution and has no memory target.", [
    // insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata) values ($1, $2, 'system', 'evidence_request.superseded_by___DYNAMIC_SQL__', 'client_evidence_req
    ["resolveDocumentAsks","dynamic_sql","9f28b3ec00f5fd2dc03b913d941c3252a88f62d566818b2d67fe5f32cda3fd8c",1,[]],
  ]),
  ...group("server/donna/db/codingEvidence.js", "Reviewed transaction-scoped source-identity SELECT. The only interpolated fragment is a fixed optional FOR SHARE lock; firm, client and transaction are bound parameters. This admits no memory mutation or new accounting writer.", [
    ["readCodingSourceIdentityConflicts","dynamic_sql","803d78b90676e7a7fa1a130bbdc4f495f374623f2e9804599327a54b52fbfdc2",1,[]],
    // Reviewed 2026-09-24 (HELMIKUU S7, H-7b): the evidence clock's firm-scoped client discovery SELECT also admits a client holding a resting cross-window refund-group member, and the clock reads those members (firm/client bound, FOR UPDATE SKIP LOCKED) to compare their case revision; both interpolate only the read-only fragment REFUSED_CROSS_WINDOW_GROUP_SQL (codingPolicyRecovery.js). The clearing UPDATE and its audit INSERT are static and target transactions/audit_events only. No memory target.
    // select distinct t.client_id from transactions t where t.firm_id=$1 and (... or __DYNAMIC_SQL__) order by t.client_id
    ["candidates/callback","dynamic_sql","442f1996b1eead9c6b2e53f6fe2221601f8d0dc18677dc8c44098940eac937ff",1,[]],
    // SG C4b R3: enclosing worker now authenticates existing accepted native sources under the existing fence. This resting-group SELECT, targets and count remain unchanged.
    // SG native fence (2026-09-28): the enclosing worker compares without a fence, takes the per-client row fence (NOWAIT) only before rewriting, and skips a contended or failed client for the tick. This resting-group SELECT, targets and count remain unchanged.
    // select t.* from transactions t where t.firm_id=$1 and t.client_id=$2 and __DYNAMIC_SQL__ order by t.id for update of t skip locked
    // Re-pinned 2026-11-10 (UK VAT posting checks): the resting-group SELECT, targets and count are unchanged; the enclosing body now reads the unresolved-treatment refusal codes from UNRESOLVED_TREATMENT_REFUSALS (FI and GB) instead of one Finnish literal. No memory target.
    // Re-pinned 2026-11-10 (not-registered lines post without VAT): the resting-group SELECT, targets and count are unchanged; the enclosing body now bounds a refusal on a date the record says not registered to one coder re-run (its own count on the clock's receipt, codingPolicyRecovery.js). No memory target.
    // Re-pinned 2026-11-10 (registration change on posted lines): the resting-group SELECT, targets and count are unchanged; the enclosing body now also reads the country registration record once per client and opens the existing correction case when a posted line's registration status changed (db/taxRegistrationChange.js, read-only). No memory target.
    ["recoverChangedCodingEvidenceInDb/callback","dynamic_sql","61866f04322d94252fcb8bb6e3e7e5f665b27cae428685b7849c15dd6d9a5c50",1,[]],
  ]),
  ...group("server/donna/db/ledger.js", "Reviewed source-read fences inside the existing posting writer. Interpolation selects only fixed FOR UPDATE clauses; settlement-row and transaction reads remain firm/client scoped. Accounting mutations still use the existing journal writer, with no memory mutation added.", [
    // select m.id as match_id, m.matched_line_id, m.status, dl.line_no, dl.description as row_label, dl.amount as row_net, dl.payload->'raw_extraction'->'settlement_row' as settlement_row, d.id as document_
    // Re-pinned 2026-11-10 (ALV registration parity): the SELECT, targets and count are unchanged; the enclosing body now refuses a processor-fee VAT split when the posting policy's registration reader does not say registered. No memory target.
    ["resolveSettlementRowSplit","dynamic_sql","d55f92ec5630b5b3ce54ebe645cccda3155e4ec1d085ed9dac21faf1333dc662",1,[]],
    // select * from transactions where firm_id = $1 and client_id = $2 and id = $3__DYNAMIC_SQL__
    // Re-pinned 2026-11-10 (UK VAT posting checks): the SELECT, targets and count are unchanged; the enclosing body now passes the posting context's profile to assertPostableTaxCoding. No memory target.
    ["prepareLedgerTransactionPosting","dynamic_sql","eb68e8adda83631b22311bbe4d245ddb931dcce7cc6396e8a0cbddf0679d13aa",1,[]],
  ]),
  ...group("server/donna/jevMaterialException.js", "Reviewed evidence freshness SELECT under FOR SHARE NOWAIT. The table name comes only from the eight literal evidence table names in evidenceRows, and ids are parameters selected from the already scoped packet. No model-provided identifier or memory writer is admitted. Rehashed 2026-11-05: the owner body imports extractJson from ./extractJson.js instead of the retired ./runtime.js; the SELECT is unchanged.", [
    // select id from __DYNAMIC_SQL__ where firm_id=$1 and id=any($2::text[]) order by id for share nowait
    ["recoverJevMaterialExceptionsInDb/callback","dynamic_sql","337e175b6f7ec1cb06ed0fb1cd1b89fc80eb19bfdd365de3e81ad4843490c14f",1,[]],
  ]),
  ...group("server/donna/jevPreview.js", "Reviewed source-family projection added to the existing bounded company evidence SELECTs for company, transactions, documents, lines, matches, answers, obligations and postings. Dynamic fragments are fixed optional read locks and the existing candidate eligibility predicate. Every query is firm/client scoped; no source mutation or execution authority is introduced.", [
  ]),
  ...group("server/donna/jevReconciliation.js", "Reviewed firm/client-scoped transaction SELECT FOR UPDATE with the existing candidate eligibility predicate and parameterized bounded id set. The selected settlement still dispatches through the existing reconciliation writer; no memory writer is added.", [
    // select *, __DYNAMIC_SQL__ as eligible from transactions where firm_id=$1 and client_id=$2 and id=any($3::text[]) order by id for update
    // 2026-09-21: the enclosing owner now reserves scoped-negative disposition
    // for invoice obligations and preserves it when no new result exists.
    // This locked transaction SELECT is unchanged.
    // 2026-09-22 (FIK-0a): the owner's evaluation receipt payload also records
    // the Jev wrapper's request_sha256s and jev_basis. Receipt-only; this
    // locked transaction SELECT and every write target are unchanged.
    // 2026-09-24 (HELMIKUU S2, H-3b): the owner records a writer-held match
    // (persisted 'suggested' with a settle lane) as a proposed verdict with no
    // retry_writer. Evaluation-receipt fields only; this locked transaction
    // SELECT, the writer dispatch and every write target are unchanged.
    // 2026-09-24 (HELMIKUU S7): the owner's plan-member writes moved, unchanged
    // in SQL and target, into the shared completePlanMembers step; under the
    // JEV_HELD_PLAN_COMPLETION flag a held statement row may rest on its own
    // owner question. This locked transaction SELECT is unchanged.
    // 2026-10-15 (FI-09): re-pinned. The enclosing body now hands an accepted
    // no-settlement negative on an accrual sales invoice to the canonical
    // doc-anchored ask primitive (salesRecognitionGap.js). Client evidence
    // request only; this locked transaction SELECT and every write target are
    // unchanged. No memory target.
    // 2026-11-09: re-pinned. The same hand-off now also covers an accrual
    // supplier bill (one lane per no-settlement obligation type, the same
    // canonical ask primitive). Client evidence request only; this locked
    // transaction SELECT and every write target are unchanged. No memory target.
    ["runJevReconciliationForDocument","dynamic_sql","2b69f13418a6056d91810e50ea9c463641eaec11406dd7b92e4a645dedc3023a",1,[]],
    // 2026-09-24 (HELMIKUU S7): the owner-confirmed completion owner locks the
    // plan's bank lines with this same scoped SELECT FOR UPDATE and eligibility
    // predicate, then writes only through the existing reconciliation writer,
    // the reminder settlement writer and an owner-confirmation receipt on the
    // confirmed match; a writer refusal rolls back to its savepoint and is
    // receipted as an audit event. No memory target.
    // 2026-09-24 (HELMIKUU S8): re-pinned. The enclosing body now checks a
    // statement row against its own row only, can be pinned to a named match
    // id, and adds the answer's scope decision to the owner-confirmation
    // receipt. This locked SELECT, its binding, targets and count are
    // unchanged. No memory target.
    ["completeOwnerConfirmedJevPlanWithClient","dynamic_sql","4ca2bbd2b2459d43c26a36d6a3a64265c14a3445185bc13e946628d2ccf8ce18",1,[]],
  ]),
  ...group("server/donna/parseDocumentsDb.js", "Reviewed unchanged contract-obligation delete/insert arguments from writeObligationsForContractSql. Owner-body changes retain the existing parser writer and source-evidence recovery; no memory target or arbitrary SQL input is added.", [
    // obSql.deleteSql
    ["performWriteParsedDocumentExtraction","dynamic_query","8d204965e565cf5fa99ae8b3e23d55f11cd20095d809733d819dd158305cf546",1,[]],
    // obSql.insertSql
    ["performWriteParsedDocumentExtraction","dynamic_query","12919e2973dd85f70c230d4d34ca43f430086408f4b6a85088c1407427b94939",1,[]],
  ]),
  ...group("server/donna/reconcileConvergenceState.js", "Reviewed read-only transaction convergence gather. The existing dynamic fragment constructs the canonical loop case id; pending uncoded settlement projection and ask context remain derived from persisted rows. No mutation is admitted.", [
    // select t.id, t.client_id, t.status, t.reconciliation_status, t.account_code, t.payload, t.coding_state, t.convergence_state, t.convergence_reason, t.convergence_as_of, -- RT-25 (2026-09-09): the auto-
    // F-32 (2026-09-29): the ask objects also carry the read-only `undeliverable` delivery fact (ASK_DELIVERY_SQL fragment) — a select over client_capability_config / audit_events / client_assignments; no mutation is admitted. DOCUMENT_GATHER_SQL gains the same fragment and becomes a reviewed dynamic read.
    ["TRANSACTION_GATHER_SQL","dynamic_sql","6a9d1e5d590f72d78c187456174085bb8603e19036503d4b95c6e76ba34ae6d1",1,[]],
    ["DOCUMENT_GATHER_SQL","dynamic_sql","148dcae0acb2efde19ef660dd6559a0a7536913531af148e85fe5ab2930e1a2f",1,[]],
  ]),
  ...group("server/donna/testSupport/jurisdictionExtension/lifecycle.mjs", "Reviewed test-only disposable database name and full-migration reader. The fixture now declares unsupported source-tax posting and persists its real completed extraction before invoking the production posting guard. It never mutates an original database.", [
    // create database "donna_jn_extension___DYNAMIC_SQL_____DYNAMIC_SQL__"
    ["<callback>","dynamic_sql","7422733956487538b53ffac1552382bef23afb1f6e9a875c988c86a76ca241a8",1,[]],
    // await readFile(new URL(file, migrations), 'utf8')
    ["<callback>","dynamic_query","c5b5848f530bb968a9bf8ba8c103e02f35ca1bf560e11acbfa702c09356b26cf",1,[]],
  ]),
  ...group("server/donna/reconciliationProviderFailure.js", "Reviewed firm-scoped document recovery-pool SELECT. The interpolated fragments are fixed predicates defined in this module plus the imported Jev preparation-contract literal (documentDispositionShape.js); no memory mutation or writer authority. The pool re-drives the existing family matchers only.", [
    // select d.id as document_id, d.client_id, d.document_type, coalesce(d.payload->'reconciliation_provider_failure', ...) from documents d where d.firm_id = $1 and (...) limit $2
    // Re-pinned 2026-10-15 for FI-02: the pool gains the read-only
    // correction re-evaluation and retirement predicates (CORRECTION_*_PENDING_SQL,
    // reconciliation_evaluations / reconciliation_matches reads, firm/client
    // bound). Still a SELECT; targets and count unchanged; no memory mutation.
    ["DISCOVER_RECONCILIATION_PROVIDER_FAILURES_SQL", "dynamic_sql", "7abe455b643d5ac1377d09e51eb80a1075ec5c25064f50bf6290957c50d1c394", 1, []],
  ]),
  ...group("server/donna/jevEligibilitySnapshot.js", "Moved unchanged from the offline Jev routed protocol: executes the existing candidate eligibility predicate as a SELECT against transaction-local pg_temp snapshot tables, then rolls back. The imported predicate is opaque to the static scanner; production packet preparation never calls this helper. This exact boundary grants no memory-write or production authority.", [
    // select id from pg_temp.transactions where __DYNAMIC_SQL__ order by id
    ["eligibleSnapshot", "dynamic_sql", "bbcc62b4a0adc19b78d61a8af2a98f94005a0c6cb19e3e089ce93b171fe9ccd3", 1, []],
  ]),
  ...group("server/donna/cloudHostCertificateA.js", "Read-only physical catalog observer used to bind the signed restored-schema proof; no mutation authority.", [
    // await readFile(new URL('../../scripts/sql/cloud_schema_catalog.sql', import.meta.url), 'utf8')
    ["observeCloudDatabase","dynamic_query","df183b024d25f703611e1b6741af3e35fe28d3b39e75f45bfd64f723257eff77",1,[]],
  ]),
  ...group("scripts/jev_decision_plane_fi_run.js", "FIK-3 (2026-09-24, offline research harness; new entries for review): creates, clones and drops its own local disposable fik3_* databases (the helper refuses a non-local host), runs the migrations into the template, and seeds one synthetic book per arm. The firm_facts insert seeds fixture memory (entity-keyed, legacy firm-keyed and jurisdiction rows) into that disposable book so the FIK-0b coding admission is exercised as a real book holds it. Never a production memory writer; nothing reaches a real book.", [
    // create database "fik3_tpl___DYNAMIC_SQL_____DYNAMIC_SQL__"
    ["createTemplate","dynamic_sql","fcce3d8f20cb54c5d7c5622cb371831dea8670e75c82d0b08c73a80ef04807aa",1,[]],
    // await readFile(new URL(file, root), 'utf8')
    ["createTemplate","dynamic_query","3c18f2701e0566a0f4ebae5332f6b3a08835a53a70e59a139f93f7d04e4ce9de",1,[]],
    // create database "fik3_tpl___DYNAMIC_SQL_____DYNAMIC_SQL_____DYNAMIC_SQL__" template "fik3_tpl___DYNAMIC_SQL_____DYNAMIC_SQL__"
    ["clone","dynamic_sql","6fecb2038c76d218f48cfad7bccea74afe77a211a9ddbfeb3583ceb42d384b10",1,[]],
    // drop database if exists "fik3_tpl___DYNAMIC_SQL_____DYNAMIC_SQL_____DYNAMIC_SQL__"
    ["drop","dynamic_sql","67cbba8fedbd7e388fd5cf231e28d5b264f2fc86e1c34e84d85074c060c5ddd4",1,[]],
    // drop database if exists "fik3_tpl___DYNAMIC_SQL_____DYNAMIC_SQL__"
    ["drop","dynamic_sql","6fedd7b17a8ad3a371a688721b3cc53f243e3555ab72d4b72dab45170e61bc0b",1,[]],
    // insert into firm_facts (id, firm_id, scope, subject, fact, provenance, confidence, model, status) values ($1, $2, $3, $4, $5, $6::jsonb, 'medium', 'firm_operator', 'active')
    ["seedBook","mutation","7ad3d92e3be48c50cd6cbc7716669a075f2d1567f15b7d6e6c3b048f3b0549e4",1,["insert:firm_facts"]],
  ]),
  ...group("scripts/qualify_cloud_schema.js", "Reviewed local-only schema export/restore, default-deny storage posture and invariant proof; DDL targets newly owned disposable databases after exact catalog qualification. Not a production memory writer.", [
    // await readFile(new URL('scripts/sql/cloud_schema_catalog.sql', root), 'utf8')
    ["readCloudSchemaCatalog","dynamic_query","afd45a7fb50cb4bc78954963b9d54325570fba79f1271910e6b4c04605ac9b30",1,[]],
    // create sequence public.__DYNAMIC_SQL__ as __DYNAMIC_SQL__ increment by __DYNAMIC_SQL__ minvalue __DYNAMIC_SQL__ maxvalue __DYNAMIC_SQL__ start with __DYNAMIC_SQL__ cache __DYNAMIC_SQL__ __DYNAMIC_SQL__cycle
    ["restoreCloudPublicCatalog","dynamic_sql","c8f072e47e120ec3ce2f8e55436ddde9ee89134fcad077842a015f48786354f0",1,[]],
    // create type public.__DYNAMIC_SQL__ as enum (__DYNAMIC_SQL__)
    ["restoreCloudPublicCatalog","dynamic_sql","3771e6be68b3b6dcc2dc67c7e78476acdd5fe6441f79187127edf1e93bb4e657",1,[]],
    // create __DYNAMIC_SQL__table public.__DYNAMIC_SQL__ (__DYNAMIC_SQL__)
    ["restoreCloudPublicCatalog","dynamic_sql","ccfc7ecc6eac6e4672fbef389af4b623545e5f60ee60b372906ac0331b62b253",1,[]],
    // alter table public.__DYNAMIC_SQL__ set (__DYNAMIC_SQL__)
    ["restoreCloudPublicCatalog","dynamic_sql","0a6a39d6a5bb6dec515918ab445a537152ee5de5377bfec211ae7bb6134dca35",1,[]],
    // alter table public.__DYNAMIC_SQL__ enable row level security
    ["restoreCloudPublicCatalog","dynamic_sql","4307cc99653bf35b8140a5fd6d06f5cbd04285cf975b0b8c8fb94c2e36a4eaed",1,[]],
    // alter table public.__DYNAMIC_SQL__ force row level security
    ["restoreCloudPublicCatalog","dynamic_sql","cb9dfec0ee3afa6b1f05a8fa1824941eaa60b637566625c663fdd9ba69c98f58",1,[]],
    // o.definition.definition
    ["restoreCloudPublicCatalog","dynamic_query","e06fa60b9162beef8f4c2a805067ecbe03c2c0d10867e47dc88d88bfe1622b12",4,[]],
    // alter table public.__DYNAMIC_SQL__ add constraint __DYNAMIC_SQL__ __DYNAMIC_SQL__
    ["restoreCloudPublicCatalog","dynamic_sql","e977404dbf0ec3d6b70c374c77fad9175e770a5ea6f32f2f719077f66b44e566",1,[]],
    // create view public.__DYNAMIC_SQL____DYNAMIC_SQL__ as __DYNAMIC_SQL__
    ["restoreCloudPublicCatalog","dynamic_sql","1cfc434a07fed02f79f4711e2a63c719e60c5cec7f71fcdcd347f4f5807c0753",1,[]],
    // with (__DYNAMIC_SQL__)
    ["restoreCloudPublicCatalog","dynamic_sql","0ca48fcb9b4fdeb1265e8e9074cb59ad6e07c3a43df1c4f15c54fc0c1524dd6b",1,[]],
    // alter table public.__DYNAMIC_SQL__ __DYNAMIC_SQL__ rule __DYNAMIC_SQL__
    ["restoreCloudPublicCatalog","dynamic_sql","0a56c78b6b42787e2825c37c01387635100b050072d3d52175c950ded43c409a",1,[]],
    // alter table public.__DYNAMIC_SQL__ __DYNAMIC_SQL__ trigger __DYNAMIC_SQL__
    ["restoreCloudPublicCatalog","dynamic_sql","c8d91a07b902c7d8773b915fe7873b4874087ca4967e941ff678144100c5f3d0",1,[]],
    // create event trigger __DYNAMIC_SQL__ on __DYNAMIC_SQL____DYNAMIC_SQL__ execute function __DYNAMIC_SQL__
    ["restoreCloudPublicCatalog","dynamic_sql","7db770794a9a373ce38e6d5aed613be789250ccf62d672e2f30d4ef1482c498d",1,[]],
    // alter event trigger __DYNAMIC_SQL__ __DYNAMIC_SQL__
    ["restoreCloudPublicCatalog","dynamic_sql","90751704c4300003aa2f7ca3d88cbd2014fe6f3fa4181b36015378af9833fa77",1,[]],
    // alter table storage.__DYNAMIC_SQL__ enable row level security
    ["restoreCloudPublicCatalog","dynamic_sql","11cf01c599b14a6001dfa817eaf9ed60dc26203320772e92a34ba4dfa20de32f",1,[]],
    // alter table storage.__DYNAMIC_SQL__ force row level security
    ["restoreCloudPublicCatalog","dynamic_sql","4cc9d5cbd82f642b45465f8ba09308692b49e384ba9408cd9d799166d467e5ce",1,[]],
    // sql
    ["reject","dynamic_query","96c16de9239736a41b4746e8b37b161e6593519400e8256e3fbc86547c86ff27",1,[]],
    // create database __DYNAMIC_SQL__ template template0
    ["qualifyCloudSchema","dynamic_sql","904f6a967118c87f08cc1c39cd59e134678ebc323c20d8033cf62ab2611b113a",1,[]],
    // await readFile(new URL(file,dir),'utf8')
    ["qualifyCloudSchema","dynamic_query","6b64564248e4e3c86536561c6477f5dfef775added2b67c2aae6d097e1efa7ad",1,[]],
    // drop database __DYNAMIC_SQL__
    ["qualifyCloudSchema","dynamic_sql","2ef286c0c655bb5c0111c74330eabae4cfcbfe33e84db86484250b1787ac2f75",1,[]],
  ]),
  ...group("scripts/add_taxes_and_licenses_account.js", "Existing maintenance SQL boundary in scripts/add_taxes_and_licenses_account.js.", [
    // select id from clients where firm_id = $1 __DYNAMIC_SQL__
    ["main/callback", "dynamic_sql", "7728dace00fd545061e20f79cbed879828e2e09759ef75f8fd775b2051b2d810", 1, []],
  ]),
  ...group("scripts/audit-jurisdiction-completion.mjs", "Existing maintenance SQL boundary in scripts/audit-jurisdiction-completion.mjs.", [
    // create database "donna_jn_audit___DYNAMIC_SQL__"
    ["<module>", "dynamic_sql", "ee322fb297e00fec96f23a5bae0da59f2f89e9edfa6a46d105dc83d0b85e67d3", 1, []],
    // await readFile(new URL(file, migrations), 'utf8')
    ["<module>", "dynamic_query", "757d1f88241d6469bd7ceb413094c8329be475bfcf0e1d631a9f1a209498a0a3", 1, []],
    // drop database "donna_jn_audit___DYNAMIC_SQL__"
    ["<module>", "dynamic_sql", "196b9f535121874cc0b743c456be7bca07f6143a475ea4c65c1b85f3f2a54cb7", 1, []],
  ]),
  ...group("scripts/backfill_canonical_roles.js", "Existing maintenance SQL boundary in scripts/backfill_canonical_roles.js.", [
    // select id, name, canonical_role from ledger_accounts where firm_id = $1 __DYNAMIC_SQL__ and canonical_role is null
    ["main/callback", "dynamic_sql", "0d161327cf87c27a18484023f35b7645629ba48a46483cc080b3a9bc8519ced0", 1, []],
    // set __DYNAMIC_SQL__ on __DYNAMIC_SQL__
    ["main/callback", "dynamic_sql", "8db04860fa295ff74dac26157da667b429be05bb23b86a3aeedb95d2a59eeb3a", 1, []],
  ]),
  ...group("scripts/backfill_filename_fallback.js", "Existing maintenance SQL boundary in scripts/backfill_filename_fallback.js.", [
    // update documents set __DYNAMIC_SQL__ where firm_id = $1 and id = $2
    ["main/callback", "dynamic_sql", "66a28126b3da8839c6ee4bdba6d7c86008b78b3a8ef1413350b09c8fc1cb4e72", 1, []],
  ]),
  ...group("scripts/backfill_gb_sales_tax_roles.js", "Existing maintenance SQL boundary in scripts/backfill_gb_sales_tax_roles.js.", [
    // select la.id, la.client_id, la.name, la.canonical_role, c.jurisdiction from ledger_accounts la join clients c on c.id = la.client_id and c.firm_id = la.firm_id where la.firm_id = $1 __DYNAMIC_SQL__ and upper(c.jurisdiction) = 'GB' and la.ca …
    ["main/callback", "dynamic_sql", "7a1e02ab7ae73bcaad54ffe1490a254864ed62d35bed702338575e24ab03e393", 1, []],
    // set __DYNAMIC_SQL__ on __DYNAMIC_SQL__ client=__DYNAMIC_SQL__
    ["main/callback", "dynamic_sql", "585f9b02585810acc899e8fdf330606fba3455af37e1c066e2e3bfc9cf849dfe", 1, []],
  ]),
  ...group("scripts/backfill_orphan_client_replies.js", "Existing maintenance SQL boundary in scripts/backfill_orphan_client_replies.js.", [
    // CANDIDATE_REQUESTS_SQL
    ["main/callback", "dynamic_query", "6df73b63fd6c28c4311a9e45d6ac6c86b791baad08860bc41f8c53e003df2000", 1, []],
    // EXISTING_BRIDGE_ROW_SQL
    ["main/callback", "dynamic_query", "a0a6238c44a330e30e0e8e71764e0c76d72040a947d6f2cd984f6e2186121595", 1, []],
    // TRANSACTION_EXISTS_SQL
    ["main/callback", "dynamic_query", "c6e6129f72857c1393c0259bb66131c4a8a279064e6c685142a6182af428d7ab", 1, []],
    // INSERT_CHAT_MESSAGE_SQL
    ["main/callback", "dynamic_query", "7ea372f59be740619b6c04d92ea410b39157fd3868c0d8cdc84325cd1fd41eb6", 1, []],
  ]),
  ...group("scripts/create_demo_client_finnish_oy.js", "Existing maintenance SQL boundary in scripts/create_demo_client_finnish_oy.js.", [
    // text
    ["queryFirmDb", "dynamic_query", "f82fef8dc3f7e55228df3e6ce2ff9f38093edfe79890b66015e8fbf2867fbeb8", 1, []],
  ]),
  ...group("scripts/create_demo_client_honeybee_hills.js", "Existing maintenance SQL boundary in scripts/create_demo_client_honeybee_hills.js.", [
    // text
    ["queryFirmDb", "dynamic_query", "f82fef8dc3f7e55228df3e6ce2ff9f38093edfe79890b66015e8fbf2867fbeb8", 1, []],
  ]),
  ...group("scripts/delete_client.js", "Existing maintenance SQL boundary in scripts/delete_client.js.", [
    // sql
    ["exec", "dynamic_query", "f4e512db06d630e3f1ea5722d7aee1da0c1db296f58e45efa5a0f7e0136a741d", 1, []],
  ]),
  ...group("scripts/desktop-stage-pg.mjs", "Existing maintenance SQL boundary in scripts/desktop-stage-pg.mjs.", [
    // copy: __DYNAMIC_SQL__ → __DYNAMIC_SQL__
    ["main", "dynamic_sql", "190dbae179fe108a7230bc55a06ba4ea2c96bf451cf8bd6f5f822cad85272c5e", 1, []],
  ]),
  ...group("scripts/entity_certificate_b.js", "Disposable entity certificate fixtures and migration runner; not a production acquisition lane.", [
    // await readFile(path.join(rootDir, 'db', 'migrations', file), 'utf8')
    ["applyMigrations", "dynamic_query", "b7118765147832d8c6e72fa7211bc4798e2fbc9662f1e9595f80e542a5443643", 1, []],
    // create database "donna_cert_b___DYNAMIC_SQL__"
    ["runEntityCertificateBRealPg", "dynamic_sql", "175bfad8dfdbfa91b0d18ab880831dce86a16ae71682032d1c306bc128153366", 1, []],
    // text
    ["pending/callback", "dynamic_query", "86c3f1377ffaefb110d2ca4bbcfba17a54581e0bdc7ba50ee4c1326f97b91427", 1, []],
    // insert into firm_facts (id, firm_id, scope, subject, fact, provenance, confidence, status) values ('fact-cert-b-prior-generation', $1, 'client', 'prior generation', 'must die on reset', $2::jsonb, 'high', 'active')
    ["runEntityCertificateBRealPg", "mutation", "97fe5b050870d62d1dd04676bbd06acd5db2280d8cc77e0606b59d96257e81d5", 1, ["insert:firm_facts"]],
    // create function cert_b_refuse_plane_seed() returns trigger language plpgsql as $$ begin raise exception 'Certificate B injected plane seed failure' using errcode = 'P0001'; end; $$; create trigger cert_b_refuse_plane_seed before insert on c …
    ["runEntityCertificateBRealPg", "dynamic_sql", "4b51b6cb3b975d41a7e3367fc11bed60141103db3e4862edc29f98dbaae9a207", 1, []],
    // create function cert_b_refuse_create_seed() returns trigger language plpgsql as $$ begin if new.client_id = 'client-cert-b-seed-failure' then raise exception 'Certificate B injected create seed failure' using errcode = 'P0001'; end if; retu …
    ["runEntityCertificateBRealPg", "dynamic_sql", "e171ead064c2362178f03f65d1d2b73b6eeb33aeb5e3f72b8bd4148201da7776", 1, []],
    // drop database if exists "donna_cert_b___DYNAMIC_SQL__"
    ["runEntityCertificateBRealPg", "dynamic_sql", "e02366cfb2f3a1ef03990967b40f3b52b8eebab3228da4a70818b6316faec9e5", 1, []],
  ]),
  ...group("scripts/eval_world_ae_runtime.js", "U25-S1 reviewed diagnostic-only scratch database creation, complete current migrations and owned-database cleanup. Local target and appliance fingerprint guards run before creation; no runtime memory acquisition authority is granted.", [
    // Current migration file SQL; opaque targets remain explicit dynamic debt.
    ["migrateAeDiagnosticDatabase", "dynamic_query", "fef7b85c78039364877d45afabd8c9fd38ca24a45203f297f85b98ac2771e32c", 1, []],
    // create database "__DYNAMIC_SQL__"; create-only unique scratch identity.
    ["runAeRuntimeDiagnostic", "dynamic_sql", "13685de2687c96a5f3556b68b41dd2425cce09290246c693183078f5f975f180", 1, []],
    // drop database if exists "__DYNAMIC_SQL__"; only after this run created it.
    ["runAeRuntimeDiagnostic", "dynamic_sql", "765a6e642219bf7b56d911fc83c4ce35f56cbe306a484b33f85250ddc219647b", 1, []],
  ]),
  ...group("scripts/export_challenger_divergences.js", "Existing maintenance SQL boundary in scripts/export_challenger_divergences.js.", [
    // select id, firm_id, client_id, lane, root_execution_type, root_execution_id, deciding, challenger, outcome, failure_class, divergence_summary, created_at from model_challenger_runs where __DYNAMIC_SQL__ order by created_at asc
    ["exportChallengerDivergences", "dynamic_sql", "6365817086199ee4e94d03b86202ad2f94bf8b063669961f3235e9c0a79efda5", 1, []],
  ]),
  ...group("scripts/export_telegram_chat_corpus.js", "Existing maintenance SQL boundary in scripts/export_telegram_chat_corpus.js.", [
    // select cm.id, cm.client_id, cm.role, cm.content, cm.payload, cm.model, cm.model_version, cm.actor_type, cm.created_at, mdl.channel as ledger_channel, mdl.message_id as inbound_message_id, mdl.provider_payload->'inbound'->>'anchor' as ledger …
    ["main", "dynamic_sql", "2a2be6db00373d0f00958a90e11fd8fc6913013071338c28dc17edc232149d66", 1, []],
  ]),
  ...group("scripts/export_xero_mirror.js", "Existing maintenance SQL boundary in scripts/export_xero_mirror.js.", [
    // select id, transaction_date, description, money_in, money_out, currency, status, account_code, payload from transactions where firm_id = $1 and client_id = $2 __DYNAMIC_SQL__ order by transaction_date nulls last, created_at limit $3
  ]),
  ...group("scripts/fix_rules.js", "Existing one-off rule repair command; not a canonical writer.", [
    // delete from client_rules where firm_id = $1 and client_id = $2 and pattern_text = 'irs usataxpymt' and created_by = 'ai'
    ["main/callback", "mutation", "56f642c1bfb8b526d8cef481acca3eb4f4314669b252d0c3f60566ada6abe883", 1, ["delete:client_rules"]],
    // insert into client_rules ( id, firm_id, client_id, rule_type, pattern_text, account_code, notes, created_by, status, payload ) values ($1, $2, $3, 'merchant_category', 'check', '4000', 'Check deposits are retail honey sales for this client' …
    ["main/callback", "mutation", "48e594a974e749c08baee6faaf86eeea7c48e1d8946413afe915b5357409e490", 1, ["insert:client_rules"]],
    // delete from client_rules where firm_id = $1 and client_id = $2 and pattern_text = 'land lease' and created_by = 'ai'
    ["main/callback", "mutation", "29d173a5cf9452a38fe4ef6611c41407a601ed79d7cde9fca9d03ca156229b2e", 1, ["delete:client_rules"]],
  ]),
  ...group("scripts/initialize_ci_host_scheduler.js", "Existing maintenance SQL boundary in scripts/initialize_ci_host_scheduler.js.", [
    // text
    ["query", "dynamic_query", "2be593881a938a46e44730cbaa0d0139cbf1a443cd10d9155805516b938e4ea5", 1, []],
  ]),
  ...group("scripts/merge_duplicate_evidence_requests.js", "Existing maintenance SQL boundary in scripts/merge_duplicate_evidence_requests.js.", [
    // select id, firm_id, client_id, canonical_anchor, blocker_code, generation, status, created_at, question from client_evidence_requests where __DYNAMIC_SQL__ and status in ('draft', 'open', 'replied') order by created_at asc
    ["main/callback", "dynamic_sql", "51456aade47f36e80623bff349f387bf0dba98360914188dde241eb6ffb4b757", 1, []],
    // MERGE __DYNAMIC_SQL__ __DYNAMIC_SQL__ -> __DYNAMIC_SQL__ (Ref stays resolvable)
    ["main/callback", "dynamic_sql", "57d611ab5c08d3a2009c244f29da31c463ac41bf127b7b204946d079648afb5b", 1, []],
  ]),
  ...group("scripts/migrate_client_to_firm.js", "Existing administrative client reparenting, including legacy facts and discovered tables.", [
    // select count(*)::int as n from __DYNAMIC_SQL__ where client_id = $1 and firm_id = $2
    ["buildCountForTable", "dynamic_sql", "b893033190b8883d6ed47c9744c3587c7758bd46f2e9edd4f7968d3ff0166f5e", 1, []],
    // update __DYNAMIC_SQL__ set firm_id = $1 where client_id = $2 and firm_id = $3
    ["buildRepointForTable", "dynamic_sql", "ff53a5254a24841955d3d7d7d0a8cc11dcc33845fa16fe912346691895d8179e", 1, []],
    // update firm_facts set firm_id = $1, updated_at = now() where firm_id = $2 and provenance->>'client_id' = $3
    ["buildFirmFactsRepoint", "mutation", "0dcdc62524c57d3014845ded4012425c2c6248c18022308ccfdf934bcbcaae74", 1, ["update:firm_facts"]],
    // sql
    ["exec", "dynamic_query", "f4e512db06d630e3f1ea5722d7aee1da0c1db296f58e45efa5a0f7e0136a741d", 1, []],
    // sql
    ["discoverClientScopedTables", "dynamic_query", "4dfcccd102ba4bf2b144ed74a502ef0c44ec568911b579ec10a8b98e713f7cb3", 1, []],
  ]),
  ...group("scripts/migrate_firm_db.js", "Existing maintenance SQL boundary in scripts/migrate_firm_db.js.", [
    // sql
    ["main/callback", "dynamic_query", "6f1ad6b66f7268c5405a8a4179aee0ae37aadd9ff1c06814db9ac76e5f109579", 1, []],
  ]),
  ...group("scripts/repair_orphaned_reconciled_transactions.js", "Existing maintenance SQL boundary in scripts/repair_orphaned_reconciled_transactions.js.", [
    // select rm.id, rm.firm_id, rm.client_id, rm.bank_transaction_id, rm.matched_object_type, rm.matched_object_id, rm.status, rm.match_amount, rm.match_confidence from reconciliation_matches rm where rm.firm_id = $1__DYNAMIC_SQL__ and not exists …
    ["detectDanglingMatches", "dynamic_sql", "704272d0ba0df52ca29ccb62086ee19226cd21d0564c4cc1cff9455fceb3c41d", 1, []],
    // select t.id, t.firm_id, t.client_id, t.transaction_date, t.description, t.money_out, t.money_in, t.reconciliation_status, t.reconciled_at, t.payload from transactions t where t.firm_id = $1__DYNAMIC_SQL__ and t.reconciliation_status in ('re …
    ["detectOrphans", "dynamic_sql", "710ec84a22aa421466d4113d9757d8c91e561468b6ae217dffd05a1ab6ad1a88", 1, []],
    // update transactions set reconciliation_status = 'needs_review', reconciled_at = null, payload = payload __DYNAMIC_SQL__, updated_at = now() where firm_id = $1 and id = $2 and reconciliation_status in ('reconciled', 'auto_reconciled') return …
    ["applyRepair", "dynamic_sql", "74b1b37d965ff5d011061cda3ce5a3bf8079728d1b87c02c7e25d7596fb0bd2c", 1, []],
  ]),
  ...group("scripts/reset_firm_fresh_onboarding.js", "Existing maintenance backup/reset visits a configured table inventory.", [
    // sql
    ["optionalQuery", "dynamic_query", "7e5513c744375a3c1e253afb3434eea4988a846644d469db338628043bb39426", 1, []],
    // select * from __DYNAMIC_SQL__ where firm_id = $1 order by 1
    ["rowsForBackup", "dynamic_sql", "74a4b5dce995104d6b597ce098149593203da496f482a830c1372f66459d7616", 1, []],
    // delete from __DYNAMIC_SQL__ where firm_id = $1
    ["resetData/callback", "dynamic_sql", "95e4f3159930e2dc81a8e04534e61d206e08a3db783a9eb446c035242bbd4bac", 1, []],
  ]),
  ...group("scripts/retry_failed_parses.js", "Existing maintenance SQL boundary in scripts/retry_failed_parses.js.", [
    // SELECT d.id, d.client_id, d.document_type, d.filename, d.parse_status, d.parse_error->>'code' as error_code, d.parse_error->>'safe_user_message' as error_message, d.parse_attempts, c.company_name as client_name FROM documents d LEFT JOIN cl …
    ["main", "dynamic_sql", "65924d86af5dc5439142b7bd8412089bd1ea69f230e5fa40c2ab52318da2584a", 1, []],
  ]),
  ...group("scripts/seed_firm_db.js", "Existing maintenance SQL boundary in scripts/seed_firm_db.js.", [
    // text
    ["queryFirmDb", "dynamic_query", "f82fef8dc3f7e55228df3e6ce2ff9f38093edfe79890b66015e8fbf2867fbeb8", 1, []],
  ]),
  ...group("scripts/telegram_demo_doctor.js", "Existing maintenance SQL boundary in scripts/telegram_demo_doctor.js.", [
    // text
    ["q", "dynamic_query", "2e21f0588aa1dd89da6781427c5ab137ef3c4a9b083266797f165f9f7bb201d8", 1, []],
  ]),
  ...group("server/donna/api.js", "Existing runtime SQL boundary in server/donna/api.js.", [
    // sql
    ["queryFn", "dynamic_query", "14f8c424018b8ca1192529ac75a0f674e292783d8a129e245f3d4d8abe2474d1", 1, []],
  ]),
  ...group("server/donna/askAutoSendProducer.js", "Existing runtime SQL boundary in server/donna/askAutoSendProducer.js.", [
    // select id, firm_id, client_id, payload, status from client_ask_batches where __DYNAMIC_SQL__ order by created_at asc limit $__DYNAMIC_SQL__
    ["readDraftBatches", "dynamic_sql", "586464d6ee8c5e889a5ef673d587c6f1ea32a8344dfbef863dc40f75f6884d84", 1, []],
  ]),
  ...group("server/donna/authorityPlaneReceipt.js", "Existing runtime SQL boundary in server/donna/authorityPlaneReceipt.js.", [
    // select to_regclass('public.__DYNAMIC_SQL__') as present
    ["tablePresent", "dynamic_sql", "6b570ce602390c04fee5df85fdf0748efe43bd534e325c2a4ca09e41454398bd", 1, []],
  ]),
  ...group("server/donna/bankLineDispositionLlm.js", "Existing runtime SQL boundary in server/donna/bankLineDispositionLlm.js.", [
    // FI hosted convergence (2026-09-15): both SELECT statements and query
    // arguments are byte-identical. The enclosing owner now accepts a limit
    // that can only narrow its existing model sweep cap. The controlled
    // money_in/money_out interpolation, two exact sites and empty memory
    // target sets are unchanged; refresh only their owner-bound digests.
  ]),
  ...group("server/donna/billReconciliation.js", "Existing runtime SQL boundary in server/donna/billReconciliation.js.", [
    // select id, firm_id, client_id, money_in, money_out, currency, transaction_date as date, description, raw_description, payload->>'contact' as contact, payload->>'source_line' as source_line, __DYNAMIC_SQL__, payload->>'bank_line_disposition_ …
    ["runBillReconciliationForDocument", "dynamic_sql", "56a35f10db2595489e5bab6598cd38160edabef3ec7bd1215246c6cf41ff6d53", 1, []],
  ]),
  ...group("server/donna/caseManager.js", "Existing runtime SQL boundary in server/donna/caseManager.js.", [
    // select id, case_type, status, title, primary_object_type, primary_object_id, last_activity_at, created_at from bookkeeping_cases where __DYNAMIC_SQL__ order by last_activity_at desc limit $__DYNAMIC_SQL__
    ["listShadowCasesForClient", "dynamic_sql", "b60b2050d00afb5454931a3ad2981762e3204f46bb93c8ea26fe0ec5c2956c3f", 1, []],
  ]),
  ...group("server/donna/codingConvergence.js", "Existing runtime SQL boundary in server/donna/codingConvergence.js.", [
    // sql
    ["discoverViaDb/callback", "dynamic_query", "6e21d98bbf33ac803f431a147afeef273302a72b4410d660223fc88b04b61b01", 1, []],
  ]),
  ...group("server/donna/contractObligations.js", "Existing runtime SQL boundary in server/donna/contractObligations.js.", [
    // INSERT INTO document_obligations ( id, firm_id, client_id, document_id, obligation_type, payer, payee, payer_role, payee_role, amount, currency, frequency, start_date, end_date, due_day, escalation_clause, tax_clause, confidence, source_evi …
    ["writeObligationsForContractSql", "dynamic_sql", "4d52ea92835ecf68572510e455040d24449d23278f4210c9f3cc6f38038f6198", 1, []],
  ]),
  ...group("server/donna/db/asks.js", "Existing runtime SQL boundary in server/donna/db/asks.js.", [
    // select * from client_evidence_requests where firm_id = $1 and status = 'open' and audience = 'client' and request_payload->'evidence_topic'->>'status' = 'open' __DYNAMIC_SQL__ order by coalesce(request_payload->'evidence_topic'->>'last_owne …
    ["listOpenEvidenceTopicsForReminderInDb/callback", "dynamic_sql", "44949c5e982958f3894e6100cccb8a2789fb32f63f26985ac35dbfcdcdeb538e", 1, []],
    // select id, transaction_id, status, evidence_type, question, send_count, last_sent_at, due_at, created_at, audience from client_evidence_requests where __DYNAMIC_SQL__ and status in ('draft', 'open') order by updated_at desc limit $__DYNAMIC …
    ["getOpenClientEvidenceRequestsForChatFromDb", "dynamic_sql", "1517b6c3c959ed56bcfd8b630719378541fe864621a655edacc0d542680ff086", 1, []],
    // select * from client_evidence_requests where firm_id = $1 and client_id = $2 __DYNAMIC_SQL__ __DYNAMIC_SQL__ order by updated_at desc limit 500
    ["getClientEvidenceRequestsFromDb", "dynamic_sql", "b5a72fe5a89cf1388f5025f79117cd83de12fea9ef232bc1a9bf0d41f4997630", 1, []],
    // select t.*, -- The stale-ask law (reconciliationTwinAging.js): when the only open -- ask on the line is a supersedable sweep-minted generic evidence ask, -- the line is still gathered, tagged with that ask's identity and the -- citable rece …
    // Re-pinned 2026-11-10 (owner has no such document): the read gains one exclusion, a line whose payload records that the owner said its document does not exist (ownerDocumentUnavailable.js); targets and count are unchanged. No memory target.
    ["ASK_BATCH_CANDIDATE_SQL", "dynamic_sql", "d53dd7e1f88ec26205e2a0fbe6d45246c113b18cbbf91c7145bcac047122f50e", 1, []],
    // select d.id, d.document_type, d.vendor_name, d.customer_name, d.filename, d.total_amount, d.currency, d.document_date, latest.payload as disposition_payload from documents d join lateral ( select ev.payload from reconciliation_evaluations e …
    ["ASK_BATCH_DOC_CANDIDATE_SQL", "dynamic_sql", "3365e814065e6ac2ac3f62495bcd9d691654b5792333dd26425651425e1b6082", 1, []],
    // select * from client_ask_batches where firm_id = $1 and client_id = $2 __DYNAMIC_SQL__ order by created_at desc limit $__DYNAMIC_SQL__
    ["getClientAskBatchesFromDb", "dynamic_sql", "420fd38849f0eb62710e49906db8b393ffb76c1fd2197ebc8cd0cefa6ae36ad7", 1, []],
    // select t.id from transactions t where t.firm_id = $1 and t.client_id = $2 and t.id = any($3::text[]) and ( ( (t.payload->'ai_suggestion') is not null and (t.coding_state is null or t.coding_state not in ('applied', 'held', 'posted', 'synced …
    ["__findStaleAskDraftAnchors", "dynamic_sql", "5e26ae9a859c2fc72a9c8a0d2bc3daf9f550096574828bdb130fe77572dff64a", 1, []],
    // select d.id from documents d where d.firm_id = $1 and d.client_id = $2 and d.id = any($3::text[]) and ( select ev.payload->>'disposition' from reconciliation_evaluations ev where ev.firm_id = d.firm_id and ev.client_id = d.client_id and ev. …
    ["__findStaleAskDraftAnchors", "dynamic_sql", "a52d965cd7753e227ca761926b52764b21709f97b21412e40f78339eacf8c5b7", 1, []],
  ]),
  ...group("server/donna/db/authority.js", "Existing runtime SQL boundary in server/donna/db/authority.js.", [
    // sql
    ["runner/callback", "dynamic_query", "391ca2256009aa5111ee6110e538018951d634114a2dc20c87042a63b54af9ba", 4, []],
    // sql
    ["runner/callback", "dynamic_query", "6342aa2bd80a3f79adbbe56c984eb16d66b0246b60745d060a0ec00f68bcb9f4", 4, []],
    // sql
    ["assertActionCapability/callback", "dynamic_query", "391ca2256009aa5111ee6110e538018951d634114a2dc20c87042a63b54af9ba", 1, []],
  ]),
  ...group("server/donna/db/chat.js", "Existing runtime SQL boundary in server/donna/db/chat.js.", [
    // select id, payload from __DYNAMIC_SQL__ where firm_id = $1 and client_id = $2 and __DYNAMIC_SQL__ = $3 and id = $4 limit 1 for update
    ["redactChatCommentInDb/callback", "dynamic_sql", "1092899602b1d92f7933947575d62bf68f1ab39fde96c52a7de41abcbebabb37", 1, []],
    // update __DYNAMIC_SQL__ set content = $5, payload = payload || $6::jsonb where firm_id = $1 and client_id = $2 and __DYNAMIC_SQL__ = $3 and id = $4 returning id, firm_id, client_id, __DYNAMIC_SQL__, role, content, payload, model, model_versi …
    ["redactChatCommentInDb/callback", "dynamic_sql", "c0620bc8b35c3aabe8f31691bb72d0f6df4af2c84028f404bbc9e3727a46741f", 1, []],
  ]),
  ...group("server/donna/db/clients.js", "Existing owner erasure discovers and removes client/firm-scoped rows dynamically.", [
    // select count(*)::int as n from "__DYNAMIC_SQL__" where "__DYNAMIC_SQL__" = $1
    ["eawCountScopedRows", "dynamic_sql", "6efc8609ea81737111c84ee52ba4a66d7b56e00d625344489e1a982c667fb1db", 1, []],
    // select count(*)::int as n from "__DYNAMIC_SQL__" where "__DYNAMIC_SQL__" = any($1::text[])
    ["eawCountScopedRows", "dynamic_sql", "5a019636012b36be7a28632ee0952821471eeb674806c6f71a533efeba347ce3", 1, []],
    // delete from "__DYNAMIC_SQL__" where "__DYNAMIC_SQL__" = any($1::text[])
    ["deleteFirmInDb/callback", "dynamic_sql", "a1b60579263d1f9d56911dba433f411000c5e8b4a6e729a22ce310bc10d8f404", 1, []],
    // delete from "__DYNAMIC_SQL__" where "__DYNAMIC_SQL__" = $1
    ["deleteFirmInDb/callback", "dynamic_sql", "08e6ee077f912c3ff731f48f2a26417183a75dc1242d94c0b522acdc70abe9a1", 1, []],
    // select count(*)::int as count from ledger_journals where firm_id = $1 __DYNAMIC_SQL__ and status <> 'voided'
    ["countPersistedJournalsInDb/callback", "dynamic_sql", "f7dadcf45d2bb1c6dc6969b466df11ef5bd65a4fbd701beda7cbb861c0d927c5", 1, []],
    // select id from ledger_journals where firm_id = $1 __DYNAMIC_SQL__ and status <> 'voided' order by journal_date, created_at, id
    ["readTerminalInventoryInDb/callback", "dynamic_sql", "8587811bc4483aacf1662c7197c5913901e1f039cb8f33d498bb171da82a86e2", 1, []],
    // select id, client_id, period_start, period_end, status from close_periods where firm_id = $1 __DYNAMIC_SQL__ order by client_id, period_start
    ["readTerminalInventoryInDb/callback", "dynamic_sql", "649bb4f475e9b6ed7d39275aa70c15d996037c7876b47544044e194098fc6fc4", 1, []],
    // select id, client_id, status, audience from client_evidence_requests where firm_id = $1 __DYNAMIC_SQL__ and status = any($__DYNAMIC_SQL__1::text[]) order by updated_at desc
    ["readTerminalInventoryInDb/callback", "dynamic_sql", "598c15c7d539665b6250c48c23338fef3cff7b1882e2c4a01d26ee6391ac7733", 1, []],
  ]),
  ...group("server/donna/db/close.js", "Existing runtime SQL boundary in server/donna/db/close.js.", [
    // select q.*, t.coding_state as transaction_coding_state from __DYNAMIC_SQL__ where q.firm_id = $1 and q.client_id = $2 order by q.updated_at desc
    ["getCloseExceptionsFromDb/callback", "dynamic_sql", "c6a0bf79989b64f013018ea6ad383e11de1cc6122e066767db448b25ce169864", 1, []],
    // select q.*, t.coding_state as transaction_coding_state from __DYNAMIC_SQL__ where q.firm_id = $1 and q.client_id = $2 order by q.updated_at desc
    ["getLedgerPeriodPreviewFromDb/callback", "dynamic_sql", "fd1e80c102354bca213f80b6c711e86dd15b9a27c8bb95ed76658c9a1e552e5c", 1, []],
    // select q.*, t.coding_state as transaction_coding_state from __DYNAMIC_SQL__ where q.firm_id = $1 and q.client_id = $2 order by q.updated_at desc
    ["getCloseArchiveInputsFromDb/callback", "dynamic_sql", "250bd6e6e4cd7200384cf01a9d111e8e564e8446c8e2e07358d15ec5c2eb80df", 1, []],
    // select * from close_archives where firm_id = $1 and id = $2 __DYNAMIC_SQL__ order by generated_at desc limit 1
    ["getCloseArchiveExportFromDb/callback", "dynamic_sql", "a1847c9edeb1efebc164f14c2e634afe9fed1316fdb569da713ae12d623d318f", 1, []],
  ]),
  ...group("server/donna/db/coding.js", "Legacy review-driven client-rule payload update and coding SQL builders. Re-reviewed 2026-09-24 (HELMIKUU S7, H-7b): DIRECT_UNCODED_NEEDS_REVIEW_SQL also excludes a resting cross-window refund-group member through the imported read-only fragment REFUSED_CROSS_WINDOW_GROUP_SQL; firm/client binding, targets and counts are unchanged.", [
    // select t.* from transactions t where t.firm_id = $1 and t.client_id = $2 and ( (t.status = 'needs_review' and (t.payload->'ai_suggestion') is null) or (__DYNAMIC_SQL__) ) and coalesce(t.payload->>'auto_categorize_source', '') not in ('clien …
    ["DIRECT_UNCODED_NEEDS_REVIEW_SQL", "dynamic_sql", "e1ecd9c84239e2a4fb2084ee796bbfae430edc8ab1efc3e5c4def9e3f7016d43", 1, []],
    // Reviewed 2026-09-24 (HELMIKUU S7, H-7b): the batch coder's review-queue and matched-uncoded pool SELECTs (firm/client bound) now exclude a resting cross-window refund-group member through the imported read-only fragment REFUSED_CROSS_WINDOW_GROUP_SQL (codingPolicyRecovery.js; fixed column paths, one fixed code literal, no bound values interpolated), which made them dynamic. Read-only; no memory target.
    // update client_rules set payload = payload || $3::jsonb, updated_at = now() where id = $1 and firm_id = $2
    ["result/callback", "mutation", "6ea09582913613802b71d19a8a815428dbf784148879142051a2268a18f2bfd1", 1, ["update:client_rules"]],
  ]),
  ...group("server/donna/db/documents.js", "Existing runtime SQL boundary in server/donna/db/documents.js.", [
    // Re-pinned 2026-11-09 for the canonical upload fence (migration 164): both
    // statements are unchanged; the enclosing body now repoints duplicate chains
    // after the replacement delete through __promoteDuplicateHeirsWithClient. No
    // memory target is added.
    // insert into documents ( id, firm_id, client_id, filename, document_type, status, uploaded_at, source, file_url, vendor_name, customer_name, document_date, due_date, total_amount, currency, tax_amount, reference_number, payment_status, extra …
    ["syncDocumentsAndTransactionsInDb/callback", "dynamic_sql", "eb0223b85ed9a3476e405d2fabb64e6104a3dee686bd6288c5c30e622c6782cb", 1, []],
    // insert into transactions ( id, firm_id, client_id, document_id, transaction_date, description, money_in, money_out, currency, status, external_transaction_id, raw_description, cleaned_description, direction, category, account_code, confiden …
    ["syncDocumentsAndTransactionsInDb/callback", "dynamic_sql", "5264bb7a5fea7213e2405e6f0e1e7c50cdec821966b20baf8a909139d7cc6bb9", 1, []],
  ]),
  ...group("server/donna/db/hmrc.js", "Existing runtime SQL boundary in server/donna/db/hmrc.js.", [
    // select * from hmrc_connections where firm_id = $1 and client_id = $2 and status in ('active', 'expired', 'error') __DYNAMIC_SQL__ order by grant_created_at desc limit 1
    ["getFreshHmrcConnectionForSync", "dynamic_sql", "f9390f38b24573a158f8cfb65928626e3ada8c653790a2728b4594f8b4ac79e4", 1, []],
  ]),
  ...group("server/donna/db/ledger.js", "Existing runtime SQL boundary in server/donna/db/ledger.js.", [
    // select q.*, t.coding_state as transaction_coding_state from __DYNAMIC_SQL__ where q.firm_id = $1 and q.client_id = $2 and ( q.item_id = $3 or q.payload->>'transaction_id' = $3 ) order by q.updated_at desc limit 1
    ["getLedgerAuditTrailFromDb/callback", "dynamic_sql", "0f2cda3223261f7ba068f20afb2040b4d3f9f2b1a21e59cdb846ffa1fc0f338b", 1, []],
  ]),
  ...group("server/donna/db/memory.js", "Legacy merchant-rule acquisition, principal approval and retirement.", [
    // update client_rules set status = 'retired', payload = payload || $5::jsonb, updated_at = now() where firm_id = $1 and client_id = $2 and pattern_text = $3 and status = 'active' and id <> $4 returning id, account_code, created_by
    ["retireSupersededRulesOnPattern", "mutation", "deb1eb617d6b9c9e1b013b8dbc2e6d79e4fd176959ecc2895e510c0529a0324b", 1, ["update:client_rules"]],
    // insert into client_rules ( id, firm_id, client_id, rule_type, pattern_text, category_override, account_code, reconciliation_behavior, notes, created_by, status, payload ) values ($1, $2, $3, 'merchant_category', $4, null, $5, 'low_materiali …
    ["saveMerchantRuleForPayload", "mutation", "8cdc818ea98131e7ec9e285e06bdaf3eb5a72f22812c186742ce6962fdc641b3", 1, ["insert:client_rules"]],
    // insert into client_rules ( id, firm_id, client_id, rule_type, pattern_text, category_override, account_code, reconciliation_behavior, notes, created_by, status, payload ) values ($1, $2, $3, 'merchant_category', $4, null, $5, 'low_materiali …
    ["saveMerchantRuleForPayload", "mutation", "c64bd270a236392b4e1b70341e7d6e6801b8a2a1a0758b6f404dfac7f4b354a1", 1, ["insert:client_rules"]],
    // select * from client_rules where firm_id = $1 and client_id = $2 and status = $3 order by updated_at desc__DYNAMIC_SQL__
    ["loadActiveClientRulesForAuthority", "dynamic_sql", "c66dbad9e24a7c62dab50f1c0308d8cebc22c2e274aacbeb6f610012418970f4", 1, []],
    // update client_rules set status = $3, updated_at = now() where firm_id = $1 and id = $2
    ["run", "mutation", "5099bdf3af8de8fb91331111f1a2edc122bf0db0d09c02b25e6b1abb3b19be5c", 1, ["update:client_rules"]],
  ]),
  ...group("server/donna/db/pool.js", "Shared SQL execution adapters accept caller-supplied SQL.", [
    // text
    ["queryFirmDb", "dynamic_query", "5b0b2e03f59840ebcaa5c8e6eae1dd90022bf9f99fcce67e0208eeae53687838", 1, []],
    // text
    ["queryOptionalFirmDb", "dynamic_query", "9843749f8c7fee2923dc62376a94126d5bcf0661a33881bbf6282a3b70494f66", 1, []],
  ]),
  ...group("server/donna/db/procountor.js", "Existing runtime SQL boundary in server/donna/db/procountor.js.", [
    // insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata) values ($1, $2, 'system', '__DYNAMIC_SQL__', 'accounting_system_connection', $2, $3::jsonb)
    ["completeProcountorConnectionInDb/callback", "dynamic_sql", "fbe2d2599ab4aeeae2602234e5ac71d126ef0bdf2c4c092b6d537961bcd0657b", 1, []],
    // insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata) values ($1, $2, 'system', $3, '__DYNAMIC_SQL__', 'accounting_system_connection', $2, $4::jsonb)
    ["connectProcountorWithApiKeyInDb/callback", "dynamic_sql", "059956761d131f372b824c149f031125cd1326bd8a5c68bed8f68793489907de", 1, []],
    // select * from procountor_connections where firm_id = $1 and client_id = $2 and status in ('connected','expired','error') __DYNAMIC_SQL__ order by connected_at desc limit 1
    ["getFreshProcountorConnectionForSync", "dynamic_sql", "097aee03d955fd84c1dbc42e4291a759dbfa58e8aa4477372f21a161a51bf13d", 1, []],
    // update procountor_connections set status='disconnected', updated_at=now() where firm_id=$1 and client_id=$2 __DYNAMIC_SQL__
    ["disconnectProcountorConnectionInDb", "dynamic_sql", "c88461ba21383890a99d7069666a6567a00bf8e0590c2efcba5bf84a76dc2f4c", 1, []],
    // insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata) values ($1, $2, 'system', '__DYNAMIC_SQL__', 'accounting_system_connection', $3, $4::jsonb)
    ["syncProcountorReferenceDataInDb/callback", "dynamic_sql", "e852a9f8e91926aee91dfc39d4e8994f254294531f09c1eba4ab18f26d7fbda0", 1, []],
    // insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata) values ($1, $2, 'system', $3, '__DYNAMIC_SQL__', 'accounting_system_connection', $4, $5::jsonb)
    ["persistProcountorMirror/callback", "dynamic_sql", "e3ada95ead6155a9edcb28c1f283e1e676cabf615b6eea84252e2dc22bf125bc", 1, []],
    // select j.* from ledger_journals j left join procountor_journal_mirrors m on m.connection_id = $3 and m.journal_id = j.id and m.status = 'synced' where j.firm_id = $1 and j.client_id = $2 and j.status = 'posted' __DYNAMIC_SQL__ and m.id is n …
    ["journals/callback", "dynamic_sql", "a6d303a1289bf5188070bfe7bcf8c56a28748bdba70048b7a490d2c13335001c", 1, []],
    // query
    ["journals/callback", "dynamic_query", "701828bf633eca974b545c0d738edc4a11bc13bf17a51369ab996e509c252333", 1, []],
    // query
    ["mirrors/callback", "dynamic_query", "07ab0f0c765643283f8ecc842be017b1a23c4a0ca79f386df62f18bb71400239", 1, []],
    // insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata) values ($1, $2, 'system', '__DYNAMIC_SQL__', 'accounting_system_connection', $3, $4::jsonb)
    ["verifyProcountorMirrorInDb", "dynamic_sql", "76bf773b5d136604c5326e0be08082cadfb278aa52bc2c7fd2d1a5010d799815", 1, []],
  ]),
  ...group("server/donna/db/qbo.js", "Existing runtime SQL boundary in server/donna/db/qbo.js.", [
    // insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata) values ($1, $2, 'system', '__DYNAMIC_SQL__', 'accounting_system_connection', $2, $3::jsonb)
    ["completeQboConnectionInDb/callback", "dynamic_sql", "db7f6f920185ad000ec34ebb4993e1abff0369dcd55ef0fd81173aa76ecff704", 1, []],
    // select * from qbo_connections where firm_id = $1 and client_id = $2 and status in ('connected', 'expired', 'error') __DYNAMIC_SQL__ order by connected_at desc limit 1
    ["getFreshQboConnectionForSync", "dynamic_sql", "4aa76a6f822ed8bb026d5c2936615cba86f39b5f4ea7a80dad9237da46dd66b3", 1, []],
    // update qbo_connections set status = 'disconnected', updated_at = now() where firm_id = $1 and client_id = $2 __DYNAMIC_SQL__
    ["disconnectQboConnectionInDb/callback", "dynamic_sql", "5e56236165169130a4131360ebf3923c94bf699b4e0ed0950c6556cab6df61ed", 1, []],
    // insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata) values ($1, $2, 'system', '__DYNAMIC_SQL__', 'accounting_system_connection', $2, $3::jsonb)
    ["disconnectQboConnectionInDb/callback", "dynamic_sql", "4ff68decf256dece8920c70749600cc2ee7b0ececda133ac1ef1654b3eb7d44e", 1, []],
    // insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata) values ($1, $2, 'system', '__DYNAMIC_SQL__', 'accounting_system_connection', $3, $4::jsonb)
    ["syncQboReferenceDataInDb/callback", "dynamic_sql", "c9efe44f90c5a3d83645b0874f272a897b2b14d2b0a0684b174bc991dfaf16d1", 1, []],
    // insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata) values ($1, $2, 'system', $3, '__DYNAMIC_SQL__', 'accounting_system_connection', $4, $5::jsonb)
    ["persistQboMirror/callback", "dynamic_sql", "8808568950ac6258cb0a4468dcd4a937bb532eaa52fc50c0c327910e7449f4a0", 1, []],
    // select j.* from ledger_journals j left join qbo_journal_mirrors m on m.connection_id = $3 and m.journal_id = j.id and m.status = 'synced' where j.firm_id = $1 and j.client_id = $2 and j.status = 'posted' __DYNAMIC_SQL__ and m.id is null ord …
    ["journals/callback", "dynamic_sql", "02aca7005ef3f5877eef75ad25bfb7565b8c070dd153d49f7a7f70317011dc0a", 1, []],
    // query
    ["journals/callback", "dynamic_query", "f0be6623588ef6139cc2067dfa5fbbb7d7afd4b9252d5814c44c478364169765", 1, []],
    // query
    ["mirrors/callback", "dynamic_query", "3782d8b6db0ae64ffd18883b961b7807eaa327982d44c5d61a1d19107d416ab9", 1, []],
    // insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata) values ($1, $2, 'system', '__DYNAMIC_SQL__', 'accounting_system_connection', $3, $4::jsonb)
    ["verifyQboMirrorInDb", "dynamic_sql", "8216b71429f747cef4123f081234b38fa2fcc13d67a3fbcd78757213f5dbb79c", 1, []],
  ]),
  ...group("server/donna/db/snapshot.js", "Existing runtime SQL boundary in server/donna/db/snapshot.js.", [
    // select q.*, t.coding_state as transaction_coding_state from __DYNAMIC_SQL__ where q.firm_id = $1 and q.status = $2 order by q.created_at desc
    // 2026-09-21: reviewed enclosing-body change attaches shared batch activity.
    // This SELECT and its imported review-queue fragment are unchanged; no
  ]),
  // FI pilot: the reviewed residue-only branch precedes the unchanged four
  // dynamic legacy refresh statements; their enclosing-function identities move.
  ...group("server/donna/db/transactions.js", "Existing runtime SQL boundary in server/donna/db/transactions.js.", [
    // update transactions as t set raw_description = v.raw_description, cleaned_description = v.cleaned_description, direction = v.direction, category = v.category, account_code = v.account_code, confidence_score = v.confidence_score, payload = t …
    ["refreshTransactionIntelForClient", "dynamic_sql", "287b1f61922826d958fa46c702606f152ea44f66d7eb3cb533677bd567d63839", 1, []],
    // update transactions as t set raw_description = v.raw_description, cleaned_description = v.cleaned_description, direction = v.direction, category = v.category, account_code = v.account_code, confidence_score = v.confidence_score, reconciliat …
    ["refreshTransactionIntelForClient", "dynamic_sql", "da2467009f7b10db5d11c973289184b463bf30b60f65346a17865abc127e3557", 1, []],
    // insert into reconciliation_matches ( id, firm_id, client_id, bank_transaction_id, matched_object_type, matched_object_id, match_amount, match_confidence, match_reason, status, created_by, payload ) values __DYNAMIC_SQL__ on conflict (bank_t …
    ["refreshTransactionIntelForClient", "dynamic_sql", "ddd8fd5603a7d3c04ee2dc4417cedc5861ce89eed9d74f2c0175970bf13b6a2a", 1, []],
    // insert into transaction_review_queue ( id, firm_id, client_id, item_type, item_id, reason, priority, status, payload ) values __DYNAMIC_SQL__ on conflict (firm_id, client_id, item_type, item_id, reason) do update set priority = excluded.pri …
    ["refreshTransactionIntelForClient", "dynamic_sql", "ffd059da7c99d03b7ee25eb7a208d5f94beefe64ac7b95887870c7484bc75d23", 1, []],
  ]),
  ...group("server/donna/db/xero.js", "Existing runtime SQL boundary in server/donna/db/xero.js.", [
    // insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata) values ($1, $2, 'system', '__DYNAMIC_SQL__', 'accounting_system_connection', $2, $3::jsonb)
    ["completeXeroConnectionInDb/callback", "dynamic_sql", "df3f54637c17f67bb19a9397029fd539e2871f9c5d2f843dc3b8cb6328796fc1", 1, []],
    // select * from xero_connections where firm_id = $1 and client_id = $2 and status in ('connected', 'expired', 'error') __DYNAMIC_SQL__ order by connected_at desc limit 1
    ["getFreshXeroConnectionForSync", "dynamic_sql", "1d4564d7a49b955580537aedb6693b9ab4aa36552a70ee7110224ba584a701ef", 1, []],
    // select * from xero_connections where firm_id = $1 and client_id = $2 __DYNAMIC_SQL__
    ["revokeXeroGrantsForClientBestEffort", "dynamic_sql", "741af3d056a3b1754c02963eb7541c52dd9070a6e588565c43346171b093ee14", 1, []],
    // update xero_connections set status = 'disconnected', updated_at = now() where firm_id = $1 and client_id = $2 __DYNAMIC_SQL__
    ["disconnectXeroConnectionInDb/callback", "dynamic_sql", "3edd51432d2eb877fac33f8b0f7818e4f10cbdc77810b0f01213f24b556b12f6", 1, []],
    // insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata) values ($1, $2, 'system', '__DYNAMIC_SQL__', 'accounting_system_connection', $2, $3::jsonb)
    ["disconnectXeroConnectionInDb/callback", "dynamic_sql", "19682c22d94ac3637c747f15eb7a148aefe43e9ac79f9dd27d7491a186a80a7e", 1, []],
    // select * from xero_connections where firm_id = $1 and client_id = $2 __DYNAMIC_SQL__ order by (status = 'connected') desc, connected_at desc nulls last
    ["defaultLoadXeroMirrorContext", "dynamic_sql", "b23f5722df2419205093b35a5df1b59f8ec5c085600940455bc7343fa81ff378", 1, []],
    // select * from transactions where firm_id = $1 and client_id = $2 __DYNAMIC_SQL__ and coalesce(payload->>'xero_sync_status', '') <> 'synced' and coalesce(payload->>'xero_writeback_status', '') <> 'synced' and coalesce(payload->>'xero_bank_tr …
    ["transactionWritebackCandidateQuery", "dynamic_sql", "6f9515c70b9f4f03a73548e2eb70773578176cb0c46b7c056707a6e51da3cb8d", 1, []],
    // insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata) values ($1, $2, 'system', $3, '__DYNAMIC_SQL__', 'transaction', $4, $5::jsonb)
    ["exportXeroMirrorRetryTransactionInDb/callback", "dynamic_sql", "5d5c5a79d58831d4d6884f9e3d2052435261dfeb31e244cb6f9d137f6ed643e8", 1, []],
    // insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata) values ($1, $2, 'system', $3, '__DYNAMIC_SQL__', 'transaction', $4, $5::jsonb)
    ["snapshot/callback", "dynamic_sql", "7f3864ea108473ee5f8c2feeb6d8621f61b5de1e6dbac958d2dc9e77219a4408", 1, []],
    // transactionWritebackCandidateQuery({ explicitIds: true })
    ["candidates/callback", "dynamic_query", "bf00e2f5b8016e3802ada669a4cf055fc455f03661523c08c9c81eef2ca10975", 1, []],
    // transactionWritebackCandidateQuery({ includeAll })
    ["candidates/callback", "dynamic_query", "5cea8090d820c3a43e699c7b8bdfbcf182ec59c74a6b2241b712bd32903c08a7", 1, []],
    // select * from transactions where firm_id = $1 and client_id = $2 and transaction_date >= $3 and transaction_date <= $4 __DYNAMIC_SQL__ order by transaction_date, created_at __DYNAMIC_SQL__
    ["transactions/callback", "dynamic_sql", "593cbd008e00cff7b953e1ce9ae16d5bf0aa69f2a54a49a59be76fe06f8585d1", 1, []],
    // select * from transactions where firm_id = $1 and client_id = $2 and transaction_date >= $3 and transaction_date <= $4 __DYNAMIC_SQL__ order by transaction_date, created_at __DYNAMIC_SQL__
    ["prepared/callback", "dynamic_sql", "e42e1e0b3646999829901a85f7f1d5c334b59ec09fd8fb7ae74ad4a25afc6d0f", 1, []],
    // insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata) values ($1, $2, 'system', '__DYNAMIC_SQL__', 'accounting_system_connection', $3, $4::jsonb)
    ["provisionXeroChartOfAccountsInDb", "dynamic_sql", "a7b06934d09c13185ef53d880ce1bb1d67229e9440d03d328ec5636b9251d153", 1, []],
    // insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata) values ($1, $2, 'system', '__DYNAMIC_SQL__', 'accounting_system_connection', $3, $4::jsonb)
    ["syncXeroReferenceDataInDb/callback", "dynamic_sql", "1305cb5c39fd6b505e64a7ef1ac8e71c1b27f0b082f713caf29d30f007ceb3bb", 1, []],
  ]),
  ...group("server/donna/desktop/localJobQueue.js", "Existing runtime SQL boundary in server/donna/desktop/localJobQueue.js.", [
    // update local_jobs set status = 'running', locked_by = $1, locked_at = now(), lease_expires_at = now() + make_interval(secs => $2::numeric / 1000), attempt_count = attempt_count + 1 where id = ( select id from local_jobs where status = 'pend …
    ["claimNextLocalJob", "dynamic_sql", "b567757f057e178595256953804868f21fd4e3ff4741dbf2478b47fa585b9527", 1, []],
  ]),
  ...group("server/donna/desktop/parseDocumentJob.js", "Existing runtime SQL boundary in server/donna/desktop/parseDocumentJob.js.", [
    // text
    ["query", "dynamic_query", "2be593881a938a46e44730cbaa0d0139cbf1a443cd10d9155805516b938e4ea5", 1, []],
  ]),
  ...group("server/donna/desktop/pgSupervisor.js", "Existing runtime SQL boundary in server/donna/desktop/pgSupervisor.js.", [
    // select 1 from pg_database where datname = '__DYNAMIC_SQL__'
    ["ensureLocalPostgres", "dynamic_sql", "1feffc0bbef2c1758fc14cdddafb2043239bf190fbbed9e73324fc907cd1ff3f", 1, []],
  ]),
  ...group("server/donna/desktop/runtimeServer.js", "Existing runtime SQL boundary in server/donna/desktop/runtimeServer.js.", [
    // text
    ["query", "dynamic_query", "2be593881a938a46e44730cbaa0d0139cbf1a443cd10d9155805516b938e4ea5", 2, []],
  ]),
  ...group("server/donna/documentCorrections.js", "Existing runtime SQL boundary in server/donna/documentCorrections.js.", [
    // Re-pinned 2026-10-15 for FI-02: both statements are unchanged; the
    // enclosing writer now also calls the reconciliation invalidation
    // (loopsShadowProducers.invalidateReconciliationForCorrectedDocument —
    // reconciliation_matches / reconciliation_evaluations / audit_events)
    // before its commit and returns that receipt. No memory mutation boundary added.
    // Scoped source read: currency corrections add NOWAIT; other corrections retain FOR UPDATE.
    ["__recordDocumentCorrectionWithClient", "dynamic_sql", "6ec870f9622ad04cfd083f7db00a4b7811bd66a64cc3d24f47282ba9c7ffb39d", 1, []],
    // update documents set __DYNAMIC_SQL__ = $3, updated_at = now() where firm_id=$1 and id=$2
    ["__recordDocumentCorrectionWithClient", "dynamic_sql", "b33082283b1344939af06d79dbd346754e2bb0fb05d991e48cb09b03e73a0d58", 1, []],
  ]),
  ...group("server/donna/documentLinePatch.js", "Document-line correction currently inserts an active human client rule directly.", [
    // insert into client_rules ( id, firm_id, client_id, rule_type, pattern_text, category_override, account_code, reconciliation_behavior, notes, created_by, status, payload ) values ($1, $2, $3, 'merchant_category', $4, null, $5, null, $6, 'hum …
    ["__patchDocumentLineWithClient", "mutation", "5fd46ec4d65b0b0d63f3912e2e3ac6271fc81e34209db79553eaaa425693ded2", 1, ["insert:client_rules"]],
  ]),
  ...group("server/donna/entityCertificateB.js", "Reviewed catalog-bounded read-only residue counts batched with UNION ALL; safeIdentifier validates each table before interpolation, and every branch retains client and optional firm scope. No mutation target or authority.", [
    // select '__DYNAMIC_SQL__'::text as table_name, count(*)::integer as count from __DYNAMIC_SQL__ where client_id = $1__DYNAMIC_SQL__
    ["countsSql/callback", "dynamic_sql", "25d18ccb4cd216233c4ba1a7026541848122d8f566a82621d50ea2d0d4d1842b", 1, []],
    // countsSql: the exact reviewed UNION ALL builder and its enclosing reader body
    // (re-pinned 2026-09-23: the body's three receipt reads are scoped to the
    // current life — read-only filters; the count builder is unchanged).
    // Re-pinned 2026-09-27 for C2a: enclosing reader adds explicit native
    // chart observation/currency. Count SQL, parameters, targets and count
    // are byte-identical; no new dynamic site or mutation authority.
    // C4b: the reader also inventories native-only assignment and human windows.
    // This catalog-bounded count builder, targets, bindings and site count stay unchanged.
    ["readEntityCertificateSnapshot", "dynamic_query", "802663a496bbff7c31d34b56ec2fb84b767e921d1e0eb1c29458959fe6a5fdf0", 1, []],
  ]),
  ...group("server/donna/evidenceStorage.js", "Existing runtime SQL boundary in server/donna/evidenceStorage.js.", [
    // text
    ["query", "dynamic_query", "2be593881a938a46e44730cbaa0d0139cbf1a443cd10d9155805516b938e4ea5", 1, []],
  ]),
  ...group("server/donna/finland/closePolicy.js", "Existing runtime SQL boundary in server/donna/finland/closePolicy.js.", [
    // select label, starts_on::text as starts_on, ends_on::text as ends_on, status from fiscal_years where __DYNAMIC_SQL__ order by starts_on
    ["heldFiscalYearsForRetention", "dynamic_sql", "dc5f4969da884218b0d520dd82399aed326ea938452ae7f218117052ea1c1c51", 1, []],
  ]),
  ...group("server/donna/finland/issuanceDb.js", "Existing runtime SQL boundary in server/donna/finland/issuanceDb.js.", [
    // select id, description, raw_description__DYNAMIC_SQL__, money_in, transaction_date from transactions where firm_id = $1 and client_id = $2 and money_in > 0 and (transaction_date is null or transaction_date >= $3) order by transaction_date n …
    ["settlementTxSelect", "dynamic_sql", "de888f2ee7b84f175203eeb7f666c78c6802b557eac7d020a7feaba05c6df878", 1, []],
    // settlementTxSelect(true)
    ["getFinlandIssuedInvoicesFromDb/callback", "dynamic_query", "06261beb9a47be8f181b8377c62c97d661267f4c865efba436a5c7222ee787d4", 1, []],
    // settlementTxSelect(false)
    ["txResult/callback", "dynamic_query", "3d05a2aeeb70870c1c8d346e09d8de6aa226774410832ddc270bad036ba09517", 1, []],
  ]),
  ...group("server/donna/firmFacts.js", "Legacy firm-fact acquisition, status/erasure and owner purge; canonical projection is not active.", [
    // with prior as ( select provenance from firm_facts where id = $1 ) insert into firm_facts (id, firm_id, scope, subject, fact, provenance, confidence, model, status) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'active') on conflict (id) do …
    ["saveFirmFact", "dynamic_sql", "a16b0cb38c377a352124152b0260b380891e3c4f7071a8cc9bc30c51332dd5fb", 1, ["insert:firm_facts"]],
    // update firm_facts set status = 'dismissed', updated_at = now() where firm_id = $1 and id = $2 and status = 'active' and ($3::text is null or (provenance->>'client_id' = $3 and (provenance->>'entity_client_id' is null or provenance->>'entity …
    ["dismissFirmFact", "mutation", "2a0d12b37a7f6de543cb1422f00315f82a5cd75e29fda4862db2ca7608ba01cf", 1, ["update:firm_facts"]],
    // update firm_facts set id = $3, subject = '[erased]', fact = '[erased]', confidence = 'low', model = null, status = 'erased', provenance = $4::jsonb, updated_at = now() where firm_id = $1 and id = $2
    ["eraseFirmFact", "mutation", "2569f01fe64390ff5478050d222d32050d7a00aba4e91716fc2bfc4edfb79c08", 1, ["update:firm_facts"]],
    // delete from firm_facts where firm_id = $1 and __DYNAMIC_SQL__ = jsonb_build_array($2::text) returning id
    ["purgeFirmFactsForDeletedClient", "dynamic_sql", "e14f767ea1f731848b2ff1269a12c575470ff041c4b914563c3cedec85e255de", 1, ["delete:firm_facts"]],
    // update firm_facts set provenance = provenance || ( select jsonb_build_object( 'asserted_by_clients', coalesce(jsonb_agg(t.value order by t.ord), '[]'::jsonb), 'client_id', (array_agg(t.value order by t.ord))[1] ) from jsonb_array_elements_t …
    ["purgeFirmFactsForDeletedClient", "mutation", "d844e956687ecb75da318d130ebfdf9bb77b848745193d34641bcb5d7cff65ab", 1, ["update:firm_facts"]],
    // delete from firm_facts f where f.firm_id = $1 and __DYNAMIC_SQL__ <> '[]'::jsonb and not exists ( select 1 from jsonb_array_elements_text(__DYNAMIC_SQL__) as v(value) join clients c on c.firm_id = f.firm_id and c.id = v.value )
    ["sweepDeletedClientFacts", "dynamic_sql", "91ccc6c55f2018e47c3bbf5306db21df74ece8a24b63a12d8200d23beb263412", 1, ["delete:firm_facts"]],
    // update firm_facts f set provenance = f.provenance || ( select jsonb_build_object( 'asserted_by_clients', coalesce(jsonb_agg(t.value order by t.ord), '[]'::jsonb), 'client_id', (array_agg(t.value order by t.ord))[1] ) from jsonb_array_elemen …
    ["sweepDeletedClientFacts", "mutation", "308305d4df4d888c68fee86ebd07ec4f624ef53de06f1457963987604bd16dc8", 1, ["update:firm_facts"]],
    // select id, scope, subject, fact, confidence, status, provenance, model, created_at, updated_at from firm_facts where __DYNAMIC_SQL__ order by status asc, updated_at desc limit $__DYNAMIC_SQL__
    ["listFirmFacts", "dynamic_sql", "14910a234786ff7bb023adb74837d06900ff08a42379c8e813c303bac62b4457", 1, []],
  ]),
  ...group("server/donna/inventory/db.js", "Existing runtime SQL boundary in server/donna/inventory/db.js.", [
    // select id, quantity from __DYNAMIC_SQL__ where client_id = $1 and sales_order_line_id = $2 and location_id = $3 and state = 'active' order by created_at, id for update
    ["consumeLineCommitments", "dynamic_sql", "f5a1ca651d7f6d0a7c90c1af9250a9cdc6f2c83df19b0fe2a6d556b35dc923a1", 1, []],
    // update __DYNAMIC_SQL__ set state = $1 where id = $2
    ["consumeLineCommitments", "dynamic_sql", "e7e5d365bae318d399f62c39a1e403abfad9504b6db3ecc194b087ed9eea5bb1", 1, []],
    // update __DYNAMIC_SQL__ set quantity = quantity - $1 where id = $2
    ["consumeLineCommitments", "dynamic_sql", "81d480607bd0750b321fc68daa2f2a7bbe5d9c92e9870e9acec99d7949b28f0a", 1, []],
  ]),
  ...group("server/donna/inventory/postingAuthorityDb.js", "Existing runtime SQL boundary in server/donna/inventory/postingAuthorityDb.js.", [
    // select a.authority_grant_id as grant_id, coalesce(sum(journal_totals.amount), 0) as total from inventory_posting_attempts a join inventory_posting_journals j on j.posting_attempt_id = a.id join ledger_journals lj on lj.id = j.ledger_journal …
    ["sumBy", "dynamic_sql", "e8eb5514705132b64142586b6ca4d11923ef1b932fb98d99bddacf2180f01cf6", 1, []],
  ]),
  ...group("server/donna/inventory/postingDb.js", "Existing runtime SQL boundary in server/donna/inventory/postingDb.js.", [
    // select id, scope_item_id, scope_group, allowance_amount, consumed_amount, remaining_quantity, currency, valuation_date from inventory_valuation_allowances where firm_id = $1 and client_id = $2 and status = 'active' and (__DYNAMIC_SQL__) and …
    ["consumeInventoryAllowanceWithinTransaction", "dynamic_sql", "f8150804b6862750fb51102bfd62c43548f2c5ad24d3ce084ba6e2b87cb5920f", 1, []],
  ]),
  ...group("server/donna/knowledgeBaseDb.js", "Generic knowledge-base insert builder accepts a computed table and column list.", [
    // insert into __DYNAMIC_SQL__ (__DYNAMIC_SQL__) values (__DYNAMIC_SQL__)
    ["insertRow", "dynamic_sql", "66dbfe49291aa8d9177a549d11b511c9ea596ce9caf4ed732c041be3a2101a47", 1, []],
  ]),
  ...group("server/donna/llmDecisionRetention.js", "Existing runtime SQL boundary in server/donna/llmDecisionRetention.js.", [
    // update llm_decisions set __DYNAMIC_SQL__ = null, __DYNAMIC_SQL__ = now() where id in ( select id from llm_decisions where firm_id = $1 and __DYNAMIC_SQL__ is not null and created_at is not null and created_at < $2 order by created_at limit  …
    ["sweepTier", "dynamic_sql", "6346ffff5c1442f769e7f0cc6afd04846ea3e28f3635755bd7ae7c295dc3a275", 1, []],
    // select count(*)::int as undated from llm_decisions where firm_id = $1 and __DYNAMIC_SQL__ is not null and created_at is null
    ["sweepTier", "dynamic_sql", "f564cdf2cba6edd2355f870df51e75a68f1dc8ca490cec5ca233eb066dba4621", 1, []],
    // update llm_decisions set __DYNAMIC_SQL__ = null, __DYNAMIC_SQL__ = now() where firm_id = $1 and client_id = $2 and __DYNAMIC_SQL__ is not null returning id
    ["archiveLlmDecisionsForDeletedClient", "dynamic_sql", "c7844ca8b27c52216a895ce88b4a3e0835ac6f40545578104d5ccb6b38b78fce", 1, []],
  ]),
  ...group("server/donna/loopEventOutbox.js", "Existing runtime SQL boundary in server/donna/loopEventOutbox.js.", [
    // select id, firm_id, client_id, event_type, object_type, object_id, payload, status, created_at from loop_event_outbox where __DYNAMIC_SQL__ order by created_at asc limit $__DYNAMIC_SQL__
    ["listPendingOutboxForDebug", "dynamic_sql", "4de7372c75e7848e408bad9d909128ad811121cb353b4c057e4001ea68b770a9", 1, []],
    // select id, firm_id, client_id, event_type, object_type, object_id, payload, status, attempts, last_error, created_at, dispatched_at from loop_event_outbox where __DYNAMIC_SQL__ order by created_at asc limit $__DYNAMIC_SQL__
    ["readDispatchableOutbox", "dynamic_sql", "1d396550d3b2419edef0d19f9a800dc3bb02f81127501099e11e39ffaae9b175", 1, []],
    // update loop_event_outbox set status = 'cancelled', last_error = jsonb_strip_nulls(jsonb_build_object( 'at', $3::text, 'reason', $2::text, 'previous_error', last_error )) where __DYNAMIC_SQL__ returning id
    ["dropOutboxRow", "dynamic_sql", "6300168b401d34f7c982da29f4938c12df40a3d4dc0d21add85698283673f2a4", 1, []],
  ]),
  ...group("server/donna/loopsShadowProducers.js", "Existing runtime SQL boundary in server/donna/loopsShadowProducers.js.", [
    // select e.verdict, e.unmatchable_reason, e.model from reconciliation_evaluations e where e.firm_id = $1 and e.client_id = $2 and e.target_type = $3 and e.target_id = $4 and e.verdict = 'no_match' and not exists ( select 1 from reconciliation …
    ["openReconciliationGapForUnmatchedTarget", "dynamic_sql", "e11ff39fefd4c4dde65d02f72dfd84739e57142a5c4461df6f82c79e4c02bfc0", 1, []],
    // select coalesce(bool_or(m.status in ('confirmed', 'auto_matched')), false) as has_sticky_match, coalesce(bool_or(m.status = 'suggested'), false) as has_suggested_match, coalesce(array_remove(array_agg(distinct m.bank_transaction_id) filter  …
    ["readTargetMatchState", "dynamic_sql", "ef7279e59a953e3b281997d17643853884dff84e257ae8878cf888eca02b6cea", 1, []],
    // select e.target_type, e.target_id, e.verdict, e.unmatchable_reason, e.model from reconciliation_evaluations e where e.firm_id = $1 and e.client_id = $2 and e.verdict in ('no_match', 'no_candidates') and not exists ( select 1 from reconcilia …
    ["backfillLoopsShadow", "dynamic_sql", "fd2f3bfde6725dc77935941e04eea87c2a369ba1bffdb448473701c8fd234353", 1, []],
  ]),
  ...group("server/donna/memoriesDb.js", "Canonical memory lifecycle and evidence/relation persistence under the existing MEMORY_MODEL_V2 posture.", [
    // insert into memories (__DYNAMIC_SQL__) values (__DYNAMIC_SQL__)
    ["insertMemoryRow", "dynamic_sql", "5081d9acbcba6f2d93025c3aa4785dd97fd75d2a03db752d15d757e67a09cfd1", 1, ["insert:memories"]],
    // insert into memory_evidence_links (tenant_id, memory_id, evidence_id, evidence_kind, source_object_type, source_object_id, source_object_version, dependence_group, corroboration_class, observed_at, recorded_by_principal_id) values ($1, $2,  …
    ["insertEvidenceLinks", "mutation", "2c4cd94720b0f49cde64b0c1fbc47d86699b80079ce8824e70d4207ba383d1e9", 1, ["insert:memory_evidence_links"]],
    // update memories set last_confirmed_at = now(), updated_at = now() where memory_id = $1
    ["saveMemory/callback", "mutation", "0e98dd612efc7d865aaeec26d43ec9b4bc7e2d422dd7767368697474ac1980f3", 1, ["update:memories"]],
    // update memories set record_state = 'superseded', updated_at = now() where memory_id = $1 and record_state = 'active'
    ["supersedeMemory/callback", "mutation", "dc79ee0be9b7b7d7e62b0c900ea6a2ff3777f6513457614c214b2ab8124da7f2", 1, ["update:memories"]],
    // insert into memory_relations (tenant_id, source_memory_id, relation, target_memory_id, created_by) values ($1, $2, 'supersedes', $3, $4) on conflict do nothing
    ["supersedeMemory/callback", "mutation", "e696d57a2053b76f2cafa541f8cc8eb62467722e3c0600550b398a3678952f44", 1, ["insert:memory_relations"]],
    // update memories set record_state = 'dismissed', updated_at = now() where memory_id = $1
    ["dismissMemory/callback", "mutation", "9f27edede26f0a55d3c77e00f5e08985bbf8c5c9c69aca1923bf270122d38588", 1, ["update:memories"]],
    // select memory_id, memory_key, revision, content_hash from memories where tenant_id = $1 and lifecycle_owner_type = $2 and lifecycle_owner_id = $3 and record_state <> 'erased'__DYNAMIC_SQL__
    ["eraseUserMemories/callback", "dynamic_sql", "9489c826006325e7c7880d772e6c51e29f06021d5612d4a750bd8b9bec9a8b6b", 1, []],
    // update memories set structured_value = null, source_text = null, source_refs = null, observed_alias = null, record_state = 'erased', erased_at = now(), updated_at = now() where tenant_id = $1 and lifecycle_owner_type = $2 and lifecycle_owne …
    ["eraseUserMemories/callback", "dynamic_sql", "dff6e03c2c2ecf6ae0cf3ec8ab64869986f66a3c089464506a5f848e30adffe0", 1, ["update:memories"]],
    // insert into memory_relations (tenant_id, source_memory_id, relation, target_memory_id, created_by) values ($1, $2, $3, $4, $5) on conflict do nothing returning source_memory_id
    ["linkMemoryRelation/callback", "mutation", "1be24a017e290c5b81965cf1758e7e1b5abbc8bd48b3a2812cfec5a016114415", 1, ["insert:memory_relations"]],
    // update memories set epistemic_state = 'contradicted', updated_at = now() where tenant_id = $1 and memory_id = any($2) and record_state <> 'erased'
    ["linkMemoryRelation/callback", "mutation", "93d197a2cf7fd20e90eb9765f395f3e8552ca63f05cb9f75f3ae477755bc6e4d", 1, ["update:memories"]],
    // select count(*)::int as remaining from memories where tenant_id = $1 and lifecycle_owner_type = $2 and lifecycle_owner_id = $3__DYNAMIC_SQL__ and (record_state <> 'erased' or structured_value is not null or source_text is not null or source …
    ["verifyMemoryErased", "dynamic_sql", "3e58da1aba537ee59320f8affcdad616faf1a8599b19f07f6784921cc3b062f7", 1, []],
    // delete from memories where tenant_id = $1 and lifecycle_owner_type = 'legal_entity' and lifecycle_owner_id = $2
    ["purgeMemoriesForDeletedLegalEntity", "mutation", "ec1093391229dec3882e931f7c305198cd992d5b4905ff71f5222f92e3d56d60", 1, ["delete:memories"]],
  ]),
  ...group("server/donna/memoryCandidates.js", "W1/G1 candidate staging, principal governance, lifecycle events and client purge.", [
    // with existing as ( select id from memory_candidates where firm_id = $2 and client_id = $3 and (scoped_identity = $17 or (id = $1 and scoped_identity is null)) order by (scoped_identity is not null) desc limit 1 ), updated as ( update memory …
    ["stageMemoryCandidate", "mutation", "b7ddc6aded7e7c527896da20e5bd968af61c526d55a80149e14b50a4fc4a98b9", 1, ["update:memory_candidates", "insert:memory_candidates", "insert:memory_candidate_events"]],
    // insert into memory_candidate_events (firm_id, client_id, candidate_id, event_seq, event_type, from_status, to_status, candidate_version, actor_type, actor_id, payload) values ($1, $2, $3, $4, $5, $6, $5, $4, 'principal', $7, '{}'::jsonb)
    ["recordCandidateTransition", "mutation", "f6ec9fb0bb0070e9cc5ca041fb7a218b44b5ba2445fdf763b54af31c82ca7037", 1, ["insert:memory_candidate_events"]],
    // update memory_candidates set status = 'promoted', minted_memory_id = coalesce($3, minted_memory_id), decided_at = now(), decided_by = $4, candidate_version = candidate_version + 1, updated_at = now() where firm_id = $1 and id = $2 and clien …
    ["promoteMemoryCandidate", "mutation", "cb10ae3a2aaea1a5d7e58cbeee2b4aac7d260901e88b04625af95cad359b01c3", 1, ["update:memory_candidates"]],
    // update memory_candidates set status = 'promoted', minted_fact_id = coalesce($3, minted_fact_id), decided_at = now(), decided_by = $4, candidate_version = candidate_version + 1, updated_at = now() where firm_id = $1 and id = $2 and client_id …
    ["promoteMemoryCandidate", "mutation", "11a232e3fb05a325432f3ae4e27b57b4b634bbe8a3121b12bf5a688af62cd019", 1, ["update:memory_candidates"]],
    // update memory_candidates set status = 'dismissed', decided_at = now(), decided_by = $3, candidate_version = candidate_version + 1, updated_at = now() where firm_id = $1 and id = $2 and client_id = $4 and status <> 'dismissed' and candidate_ …
    ["dismissMemoryCandidate", "mutation", "9de5ef36d6efa0250835ca4f36da373451c087400515c11283bca7fb6d3adc60", 1, ["update:memory_candidates"]],
    // select id, client_id, candidate_type, status, source, scope, subject, fact, confidence, minted_fact_id, case_id, created_at, updated_at, candidate_version from memory_candidates where __DYNAMIC_SQL__ order by created_at desc limit $__DYNAMI …
    ["listMemoryCandidatesForClient", "dynamic_sql", "db1e43b3f4dcb928d11eb993d767cf01b4e5622b515c7460c8f0e4eed0bfc864", 1, []],
    // delete from memory_candidates where firm_id = $1 and client_id = $2
    ["purgeMemoryCandidatesForDeletedClient", "mutation", "70ae45a483681ba41108ad26209de57d8b6a70611699ac48833a508640b44983", 1, ["delete:memory_candidates"]],
  ]),
  ...group("server/donna/mentions/mentionRosterDb.js", "Existing runtime SQL boundary in server/donna/mentions/mentionRosterDb.js.", [
    // sql
    ["run/callback", "dynamic_query", "391ca2256009aa5111ee6110e538018951d634114a2dc20c87042a63b54af9ba", 1, []],
    // sql
    ["run/callback", "dynamic_query", "6342aa2bd80a3f79adbbe56c984eb16d66b0246b60745d060a0ec00f68bcb9f4", 1, []],
    // sql
    ["query", "dynamic_query", "6342aa2bd80a3f79adbbe56c984eb16d66b0246b60745d060a0ec00f68bcb9f4", 1, []],
  ]),
  ...group("server/donna/mentions/notificationsDb.js", "Existing runtime SQL boundary in server/donna/mentions/notificationsDb.js.", [
    // select id, firm_id, client_id, principal_type, principal_id, kind, artifact_type, artifact_id, actor_id, actor_display, excerpt, message_id, ask_id, read_at, created_at from mention_notifications where firm_id = $1 and principal_type = $2 a …
    ["listMentionNotifications", "dynamic_sql", "5554d503e58dcd257bac6dee13a7ab9152bee8e0b90f083d8681bd1833948e46", 1, []],
    // update mention_notifications set read_at = now() where firm_id = $1 and principal_type = $2 and principal_id = $3 and read_at is null __DYNAMIC_SQL__ returning id
    ["markMentionNotificationsRead", "dynamic_sql", "2a1e5c575d8797fe7924b6522cea3bf5976522c0bdc8934a19f93e8463a2f14e", 1, []],
  ]),
  ...group("server/donna/outbound/actionExecutor.js", "Existing runtime SQL boundary in server/donna/outbound/actionExecutor.js.", [
    // sql
    ["query", "dynamic_query", "fcd5ef333091255d6fbd4b4e598065a10ec4412f8468e6d02012ccb02080490a", 1, []],
  ]),
  ...group("server/donna/outbound/actionStore.js", "Existing runtime SQL boundary in server/donna/outbound/actionStore.js.", [
    // select draft from __DYNAMIC_SQL__ where firm_id = $1 and client_id = $2 and id = $3
    ["approvedConsequenceFingerprintFor", "dynamic_sql", "ac03b03ffe16909a87cdc31b896ad5b4e4e8533d4d503c6a275cc942b4f64ced", 1, []],
  ]),
  ...group("server/donna/outbound/earnedAutoLadder.js", "Existing runtime SQL boundary in server/donna/outbound/earnedAutoLadder.js.", [
    // savepoint __DYNAMIC_SQL__
    ["guarded", "dynamic_sql", "d6b540c4e5dd6415196259cb03c2ffd8d3561549c734e26eebdade78970fbff5", 1, []],
    // release savepoint __DYNAMIC_SQL__
    ["guarded", "dynamic_sql", "99e033b200316f66c1f5e8dd6fb9be0a02ea962a87cc166fd7dd3219d916a1e5", 1, []],
    // rollback to savepoint __DYNAMIC_SQL__
    ["guarded", "dynamic_sql", "48d587014887f269a32ba9002035901e6809da2f6627b62366ce722dd68f992d", 1, []],
    // sql
    ["query", "dynamic_query", "fcd5ef333091255d6fbd4b4e598065a10ec4412f8468e6d02012ccb02080490a", 1, []],
  ]),
  ...group("server/donna/outbound/paidTruthGuard.js", "Existing runtime SQL boundary in server/donna/outbound/paidTruthGuard.js.", [
    // select id, description, raw_description__DYNAMIC_SQL__, money_in, transaction_date from transactions where firm_id = $1 and client_id = $2 and money_in > 0 and (transaction_date is null or transaction_date >= $3) order by transaction_date n …
    ["txSelect", "dynamic_sql", "60366e5d08e73c3ec54326942e7430099c5ff3e07fe96e79471a5c9f3a834bc9", 1, []],
    // txSelect(true)
    ["evaluateIssuedLane", "dynamic_query", "5cd0d15fce17b893b8aeefe2710cfea8f43d9532ae89256454a2405fd22c96e1", 1, []],
    // txSelect(false)
    ["txRows/callback", "dynamic_query", "1c3c9a0f4385390ac705749dc334dcf46e2415e20a7cf789138fd5e584890a60", 1, []],
  ]),
  ...group("server/donna/outbound/partyStore.js", "Existing runtime SQL boundary in server/donna/outbound/partyStore.js.", [
    // update client_parties set __DYNAMIC_SQL__ = $4, updated_at = now() where id = $1 and firm_id = $2 and client_id = $3
    ["setPartyAttribute", "dynamic_sql", "b174099461aefc1c75dc09e269d3c5a7ad9d7b5ea238b7f9d78fe699a3e0a0fb", 1, []], // U15-S1: same closed ATTRIBUTE_COLUMNS update; enclosing writer now records attributed tax_registration history and its scoped detail projection. No memory-table target or new dynamic site.
  ]),
  ...group("server/donna/outbound/payLinks.js", "Existing runtime SQL boundary in server/donna/outbound/payLinks.js.", [
    // sql
    ["query", "dynamic_query", "fcd5ef333091255d6fbd4b4e598065a10ec4412f8468e6d02012ccb02080490a", 1, []],
  ]),
  ...group("server/donna/outbound/receivableCases.js", "Existing runtime SQL boundary in server/donna/outbound/receivableCases.js.", [
    // select d.id, d.customer_name, d.due_date, d.total_amount, d.currency, d.reference_number, __DYNAMIC_SQL__ from documents d where d.firm_id = $1 and d.client_id = $2 and d.document_type = 'sales_invoice' and coalesce(d.parse_status, 'complet …
    ["docCandidateSql", "dynamic_sql", "25fc55e24dd99bf9765ae93c8ac39f9aede0527fc3aa59c098dee93e3056b127", 1, []],
    // docCandidateSql(true)
    ["detectOverdueReceivables", "dynamic_query", "a422eb72c6d2bde57817a1158101b0512dae22fc95542d6d1a3c77d3626d5a7c", 1, []],
    // docCandidateSql(false)
    ["detectOverdueReceivables/callback", "dynamic_query", "98844108da3a625f9c3ffc008f7ab1a47a14ca2c74bafec7ed483d9d81b8b568", 1, []],
    // select rc.id as case_id, rc.anchor_type, rc.anchor_id, rc.status_reason, d.customer_name as doc_customer_name, d.reference_number as doc_reference_number, __DYNAMIC_SQL__, d.total_amount as doc_total_amount, d.currency as doc_currency, d.du …
    ["gapCaseSql", "dynamic_sql", "2b7473d5a9e1b7308884bbff9635be550176ee14970b058a902fe334e38db0df", 1, []],
    // gapCaseSql(true)
    ["detectOverdueReceivables", "dynamic_query", "6d4d64f4e5e10309202772fcac78a540a4991c2b78b94c6f465160f91af099e7", 1, []],
    // gapCaseSql(false)
    ["detectOverdueReceivables/callback", "dynamic_query", "908d741077714ea6a2fb0572f22539d96328e7c94bd81dda86a69c907d05687e", 1, []],
  ]),
  ...group("server/donna/outbound/referenceCapture.js", "Existing runtime SQL boundary in server/donna/outbound/referenceCapture.js.", [
    // sql
    ["query", "dynamic_query", "fcd5ef333091255d6fbd4b4e598065a10ec4412f8468e6d02012ccb02080490a", 2, []],
  ]),
  ...group("server/donna/outbound/replyIngestion.js", "Existing runtime SQL boundary in server/donna/outbound/replyIngestion.js.", [
    // sql
    ["query", "dynamic_query", "fcd5ef333091255d6fbd4b4e598065a10ec4412f8468e6d02012ccb02080490a", 1, []],
  ]),
  ...group("server/donna/parseDocumentsDb.js", "Parsing retains direct AI active-rule acquisition plus document and match SQL helpers.", [
    // select id, client_id, parse_status, parse_stage, parse_progress_current, parse_progress_total, parse_summary, parse_error, duplicate_of, parse_completed_at, payload->'parse_hold' as parse_hold from documents where firm_id=$1 and id = any($2 …
    ["getParseStatusForDocumentsInDb", "dynamic_sql", "cfc23524124bfef128dbdeb40f0f9a35c7a675ed7ae6255ae9667eb9fd24d6a9", 1, []],
    // select q.id as review_id, q.payload as review_payload, q.item_id as transaction_id, t.description, t.raw_description, t.payload as transaction_payload, t.money_in, t.money_out, t.currency from transaction_review_queue q left join transactio …
    ["autoCategorizeUnmatchedTransactionsInDb/callback", "dynamic_sql", "a311d954a800cb4fd7920a8fd9bb694db2fea24dcbe65c78a89b1941e423ab91", 1, []],
    // insert into client_rules ( id, firm_id, client_id, rule_type, pattern_text, category_override, account_code, notes, created_by, status, payload ) values ($1, $2, $3, 'merchant_category', $4, null, $5, $6, 'ai', 'active', $7::jsonb) on confl …
    ["autoCategorizeUnmatchedTransactionsInDb/callback", "mutation", "957a881730c0818ae0b2a33185f22e24f21323ebdc336c12ff5b6bfbeed6b254", 1, ["insert:client_rules"]],
    // insert into transactions ( id, firm_id, client_id, document_id, transaction_date, description, money_in, money_out, currency, status, external_transaction_id, raw_description, cleaned_description, direction, confidence_score, payload ) valu …
    ["upsertParsedTransactionsChunkWithClient", "dynamic_sql", "8f9648908ca4750996b89b74eaa202cf1881d61a7e81603687cf2018028376c0", 1, []],
  ]),
  ...group("server/donna/paymentAccountStatementReconciliation.js", "Existing runtime SQL boundary in server/donna/paymentAccountStatementReconciliation.js.", [
    // select id, firm_id, client_id, money_in, money_out, currency, transaction_date as date, description, raw_description, payload->>'contact' as contact, payload->>'source_line' as source_line, __DYNAMIC_SQL__, payload->>'bank_line_disposition_ …
    ["runPaymentAccountStatementReconciliationForDocument", "dynamic_sql", "92e18917c8bbcace83ec701e1a930c3c68047e5b56f40336ef316e48123da2b6", 1, []],
  ]),
  ...group("server/donna/paymentAccountStatementReconciliationLlm.js", "Existing runtime SQL boundary in server/donna/paymentAccountStatementReconciliationLlm.js.", [
    // select id, firm_id, client_id, money_in, money_out, currency, transaction_date as date, description, raw_description, payload->>'contact' as contact, payload->>'source_line' as source_line, __DYNAMIC_SQL__, reconciliation_status, account_co …
    ["runPaymentAccountStatementReconciliationLlmForDocument", "dynamic_sql", "b4bbef70026675f931325e96766ccda0108acec1219637928b6e2cb41e4e7ace", 1, []],
  ]),
  ...group("server/donna/paymentConfirmationReconciliation.js", "Existing runtime SQL boundary in server/donna/paymentConfirmationReconciliation.js.", [
    // select id, firm_id, client_id, money_in, money_out, currency, transaction_date as date, description, raw_description, payload->>'contact' as contact, payload->>'source_line' as source_line, __DYNAMIC_SQL__, payload->>'bank_line_disposition_ …
    ["runPaymentConfirmationReconciliationForDocument", "dynamic_sql", "0e88d86feb979e0c89c1c6f9137fe63a3e7a97625067b216aa83892cb7a3fe58", 1, []],
  ]),
  ...group("server/donna/paymentConfirmationReconciliationLlm.js", "Existing runtime SQL boundary in server/donna/paymentConfirmationReconciliationLlm.js.", [
    // select id, firm_id, client_id, money_in, money_out, currency, transaction_date as date, description, raw_description, payload->>'contact' as contact, payload->>'source_line' as source_line, __DYNAMIC_SQL__, reconciliation_status, account_co …
    ["runPaymentConfirmationReconciliationLlmForDocument", "dynamic_sql", "9b44c69623b89a2808a491611ce74cdd6d7196ddd446dff280893e3bf9cb9159", 1, []],
  ]),
  ...group("server/donna/payoutReconciliationLlm.js", "Existing runtime SQL boundary in server/donna/payoutReconciliationLlm.js.", [
    // select id, firm_id, client_id, money_in, money_out, currency, transaction_date as date, description, raw_description, payload->>'contact' as contact, payload->>'source_line' as source_line, __DYNAMIC_SQL__, reconciliation_status, account_co …
    ["runPayoutReconciliationLlmForDocument", "dynamic_sql", "3b6875f9baa4b07fb3f86b5c9acc5559faeecd135803273e39610afe72f19f81", 1, []], // RT-21c (2026-09-08): the statement gained the matched row (matched_line_id / document_lines join); reads reconciliation_matches + document_lines, no memory table. Re-registered by the runtime orchestrator.
  ]),
  ...group("server/donna/proposalStore.js", "Existing runtime SQL boundary in server/donna/proposalStore.js.", [
    // select id, status, proposal_type, triage_source, review_mode, check_status, detail, warnings, created_at, updated_at from proposal_cards where firm_id = $1 and client_id = $2 and proposal_type = 'owner_intent_candidate'__DYNAMIC_SQL__ order …
    ["listOwnerIntentProposalCards", "dynamic_sql", "17413c1d49a7c9bbc9b2cc24e5c0cf03501a5a40f2bf2b9f6c14733797dba08a", 1, []],
    // select id, proposal_type, status, writer, before_after, before_after_total, created_at from proposal_cards where firm_id = $1 and client_id = $2 and before_after_total > 0__DYNAMIC_SQL__ order by created_at desc, id desc limit $__DYNAMIC_SQ …
    ["loadReversibleProposalCards", "dynamic_sql", "8c0d23377840c42fed5bfc6d375291802807bdb6d432049808a87acf570f4955", 1, []],
  ]),
  ...group("server/donna/qboClient.js", "Provider query-language builder is conservatively included in computed SQL debt.", [
    // select * from __DYNAMIC_SQL__ startposition __DYNAMIC_SQL__ maxresults 1000
    ["fetchQboEntity", "dynamic_sql", "0bd18ca01660b474b909eb8988a7a5595c25833b496c5643235354b6e965a011", 1, []],
  ]),
  ...group("server/donna/receiptReconciliation.js", "Existing runtime SQL boundary in server/donna/receiptReconciliation.js. Existing SELECT unchanged; enclosing owner re-reviewed for the client-configured Jev dispatch and explicit legacy-backstop exclusion. No new memory mutation.", [
    // select id, firm_id, client_id, money_out, currency, transaction_date as date, description, raw_description, payload->>'contact' as contact, payload->>'source_line' as source_line, __DYNAMIC_SQL__, payload->>'bank_line_disposition_explained' …
    ["runReceiptReconciliationForDocument", "dynamic_sql", "a68f53aeb42bd3bd42366d59d7c03ba8f31be06be193b9e9792108acac0dc7fb", 1, []],
  ]),
  ...group("server/donna/receiptReconciliationLlm.js", "Existing runtime SQL boundary in server/donna/receiptReconciliationLlm.js. Existing SELECT unchanged; enclosing owner re-reviewed for the client-configured Jev dispatch and explicit legacy-backstop exclusion. No new memory mutation.", [
    // select id, firm_id, client_id, money_in, money_out, currency, transaction_date as date, description, raw_description, payload->>'contact' as contact, payload->>'source_line' as source_line, __DYNAMIC_SQL__, reconciliation_status, account_co …
    ["runReceiptReconciliationLlmForDocument", "dynamic_sql", "13b5dc9ae8e08859fe93913a774a8c305efebce355d93eb15d2876d67ccac237", 1, []],
  ]),
  ...group("server/donna/reconcileConvergenceState.js", "Existing runtime SQL boundary in server/donna/reconcileConvergenceState.js.", [
    // WRITE_SQL[targetType]
    ["writeDerived", "dynamic_query", "5bc7e0a452d4e93449310bdca25b14d2ad55f174ae530be4fa57d0da63ddce73", 1, []],
    // ...args
    ["convergenceSettlingPoolQuery", "dynamic_query", "70abd3e70ed1debb8793d0a4584fe6e902fc40af0acdd3202b4966b7f82e1b09", 2, []],
    // client
    ["hookPooledClient/callback", "dynamic_query", "f2e536051cf69480248d6317a0659e481f5bc639d36ca047a2b45f56d57d096e", 1, []],
    // client
    ["withConvergenceSettle/callback", "dynamic_query", "f2e536051cf69480248d6317a0659e481f5bc639d36ca047a2b45f56d57d096e", 1, []],
  ]),
  ...group("server/donna/reconciliationDelegatedAuthorityMetrics.js", "Existing runtime SQL boundary in server/donna/reconciliationDelegatedAuthorityMetrics.js.", [
    // select count(*)::int as total, count(*) filter (where status = 'active')::int as active, count(*) filter (where status = 'revoked')::int as revoked, count(*) filter (where status = 'suspended')::int as suspended, count(*) filter (where use_ …
    ["queryGrants", "dynamic_sql", "4bc9b9c66769aa0be2b070de8d5321b0b08a6fe9e9f7cd4c90fb23ccd2a2ad6f", 1, []], // "used" now reads the accept receipts on reconciliation_matches (one owner for grant usage); still a read, no memory table.
    // select count(*)::int as total, count(*) filter (where status = 'suggested')::int as open, … from reconciliation_matches where … band = 'suggested' and reasons = ["above_materiality_ceiling"] …
    ["queryHeldMatches", "dynamic_sql", "b9fb5ffc731d8a2af657a938f42b3c619cc6b92a9e6c46a48669ae0f05965d08", 1, []],
    // select count(*)::int as count, coalesce(avg(match_amount), 0)::float as avg_amount, coalesce(array_agg(distinct payload->'authorization'->>'model') filter (where payload->'authorization'->>'model' is not null), '{}') as models from reconcil …
    ["queryDelegatedAccepts", "dynamic_sql", "5501f2af4477d439e74ec18d996ebc3c6fb70a7dc3279b6433cd5229f1269d1d", 1, []],
  ]),
  ...group("server/donna/reconciliationLlmCore.js", "Reviewed deadline transaction adapter forwards the existing match/evaluation statements; no memory writer is introduced.", [
    // client.query(...args), before and inside the ambient-budget transaction fence.
    ["queryReconciliationVerdict", "dynamic_query", "77f0519b01980350001ec465305feefc261290f7d884849e246d6e975a2ef689", 2, []],
  ]),
  ...group("server/donna/reconciliationTwinAging.js", "Existing runtime SQL boundary in server/donna/reconciliationTwinAging.js.", [
    // select m.id as match_id, m.bank_transaction_id, m.matched_object_type, m.matched_object_id, m.match_amount, m.match_confidence, m.payload->'match_reason'->>'reasoning' as matcher_reasoning, m.payload->'authorization'->'reasons' as authoriza …
    ["AGED_TWIN_SQL", "dynamic_sql", "e2a87b3a32fc9a53f6c84eace5785fe9c0a5d38e4a7bf4df5ebd8566644509fc", 1, []], // RT-21c (2026-09-08): the statement gained the matched row (matched_line_id / document_lines join); reads reconciliation_matches + document_lines, no memory table. Re-registered by the runtime orchestrator.
    // select m.id as match_id, m.bank_transaction_id, m.matched_object_type, m.matched_object_id, m.match_amount, m.match_confidence, m.payload->'match_reason'->>'reasoning' as matcher_reasoning, m.payload->'authorization'->'reasons' as authoriza …
    ["HELD_MATERIAL_SQL", "dynamic_sql", "d24cc128d5ada60ef80f9f6797a3a5e8f32370d664d3093b233b5c4de51ec346", 1, []], // FI hosted ask refresh (2026-09-15): opt-in reads rotate this producer's unsent drafts; the locked recheck scopes the same SELECT to the selected transaction and detects group overflow. Same single SELECT site and no memory targets; ordinary gathers keep the existing blocker law.
  ]),
  ...group("server/donna/reconciliationWakeEvaluator.js", "Existing runtime SQL boundary in server/donna/reconciliationWakeEvaluator.js.", [
    // sql
    ["firstRow", "dynamic_query", "cdadd89304a7a67dfbb6aba67a0e53c0e389311dad4086b378d9aec78b7fa383", 1, []],
  ]),
  ...group("server/donna/roles/roleActionSurface.js", "Existing runtime SQL boundary in server/donna/roles/roleActionSurface.js.", [
    // execute issue_invoice
    ["R1_AUTONOMOUS_SURFACE", "dynamic_sql", "6b3d2871fbb6c4d15f7ddf4fc6c91bfccd234f6b8de5b6cc66153f1c190ac52e", 1, []],
    // execute send_quote
    ["R1_AUTONOMOUS_SURFACE", "dynamic_sql", "dd73f8c5072a020e5fdcee0ffd0129949f394c4a8651aa5bd2f030adbc0e1d89", 1, []],
    // execute send_receivable_reminder
    ["R1_AUTONOMOUS_SURFACE", "dynamic_sql", "eb40c1973b475c77d4810aed8511c859bad8fae60181ad758774af9d6c55d4b4", 1, []],
    // execute send_payable_notice
    ["R1_AUTONOMOUS_SURFACE", "dynamic_sql", "e9f6814e0f3c85cb512f659cfc6ce9628c2adb39138c9162847cbdc8b36d46f6", 1, []],
  ]),
  ...group("server/donna/roles/roleEvents.js", "Existing runtime SQL boundary in server/donna/roles/roleEvents.js.", [
    // savepoint __DYNAMIC_SQL__
    ["guarded", "dynamic_sql", "963bd169aa9d02571a6f4110845f97072eed0afc709d24bab1c1934f97191b76", 1, []],
    // release savepoint __DYNAMIC_SQL__
    ["guarded", "dynamic_sql", "294b79b37d11c924dc5be72b85aa865d41948cac696d5642b8556d68afdd5235", 1, []],
    // rollback to savepoint __DYNAMIC_SQL__
    ["guarded", "dynamic_sql", "8681d3e5a7f23f7ce0bd77b177cb336a578b735627eedc096dcccb96302c66ec", 1, []],
  ]),
  ...group("server/donna/runtimeReadiness.js", "Existing runtime SQL boundary in server/donna/runtimeReadiness.js.", [
    // text
    ["result/callback", "dynamic_query", "ab9a020195626135fa21a4c764079091b1a6cf7134bdddf817911db066701c66", 1, []],
  ]),
  ...group("server/donna/runtimeReadinessAdmission.js", "Existing runtime SQL boundary in server/donna/runtimeReadinessAdmission.js.", [
    // select flag_key, stage, source, reason, client_id from client_capability_config where firm_id = $1 and client_id = $2 and flag_key = $3 and valid_to is null order by valid_from desc, id desc limit 1__DYNAMIC_SQL__
    ["readExplicitFlagRow", "dynamic_sql", "73949aae6b8b0d1cba097ae20627a7cdaabb035939ea84a58fe430385d57cefb", 1, []],
    // select * from entity_readiness_sagas where firm_id = $1 and client_id = $2__DYNAMIC_SQL__
    ["readSaga", "dynamic_sql", "356bc72c1f3bb78a5f202a6e924f640cc45d4c6666c0aff8348b1bd6d2af2470", 1, []],
  ]),
  ...group("server/donna/salesInvoiceReconciliation.js", "Existing runtime SQL boundary in server/donna/salesInvoiceReconciliation.js.", [
    // select id, firm_id, client_id, money_in, money_out, currency, transaction_date as date, description, raw_description, payload->>'contact' as contact, payload->>'source_line' as source_line, __DYNAMIC_SQL__, payload->>'bank_line_disposition_ …
    ["runSalesInvoiceReconciliationForDocument", "dynamic_sql", "fb605a275e9ab3fb7bc7bda3582ca82f16f9d83f43bb05b2e0aa57bacb1e8bec", 1, []],
  ]),
  ...group("server/donna/salesInvoiceReconciliationLlm.js", "Existing runtime SQL boundary in server/donna/salesInvoiceReconciliationLlm.js. Existing SELECT unchanged; enclosing owner re-reviewed for the client-configured Jev dispatch and explicit legacy-backstop exclusion. No new memory mutation.", [
    // select id, firm_id, client_id, money_in, money_out, currency, transaction_date as date, description, raw_description, payload->>'contact' as contact, payload->>'source_line' as source_line, __DYNAMIC_SQL__, reconciliation_status, account_co …
    ["runSalesInvoiceReconciliationLlmForDocument", "dynamic_sql", "f28857589074a01e79ab3a82200f8e8e6bcbb9a10db5c1c3295c9d948cc25760", 1, []],
  ]),
  ...group("server/donna/statutoryBlocker.js", "Existing runtime SQL boundary in server/donna/statutoryBlocker.js.", [
    // sql
    ["loadOpenStatutoryBlockers", "dynamic_query", "840d1fc3b7cd1a869a96482ca1fe04650d1ae5c993ec22e1774db34f54e6a0da", 1, []],
  ]),
  ...group("server/donna/supplierBillReconciliationLlm.js", "Existing runtime SQL boundary in server/donna/supplierBillReconciliationLlm.js. Existing SELECT unchanged; enclosing owner re-reviewed for the client-configured Jev dispatch and explicit legacy-backstop exclusion. No new memory mutation.", [
    // select id, firm_id, client_id, money_in, money_out, currency, transaction_date as date, description, raw_description, payload->>'contact' as contact, payload->>'source_line' as source_line, __DYNAMIC_SQL__, reconciliation_status, account_co …
    ["runSupplierBillReconciliationLlmForDocument", "dynamic_sql", "dca1168297e2a61181d83713eb8053f2835bffc3c682ea49cd22b5afed4e68f9", 1, []],
  ]),
  ...group("server/donna/testSupport/applianceHarness.js", "Existing runtime SQL boundary in server/donna/testSupport/applianceHarness.js.", [
    // create database "__DYNAMIC_SQL__"
    ["provisionScratchDatabase", "dynamic_sql", "abff4348c9296cf6b0c7f577ba904fd6e6ddc128a32135ad6547fbcd8164b741", 1, []],
    // await readFile(path.join(MIGRATIONS_DIR, file), 'utf8')
    ["provisionScratchDatabase", "dynamic_query", "561c76635b973eb7ded52a7295211fc965655f257289d3cf808b72cff86db0c9", 1, []],
    // drop database if exists "donna_appliance___DYNAMIC_SQL__"
    ["stop", "dynamic_sql", "dc5c7cce2fd5f380ec6270c1ff25e18936aa1ea444e5650b33f6b14679ba37a8", 1, []],
    // text
    ["query", "dynamic_query", "dd2c2524438b4454b6e7799834f4af09443bac40670675a62706f6b824277317", 1, []],
    // text
    ["rows", "dynamic_query", "6a6d510359dc9c46c8db03c2c3e7dfbcf985953b1ba38bdb50676f34b9eb7976", 1, []],
    // text
    ["query", "dynamic_query", "2be593881a938a46e44730cbaa0d0139cbf1a443cd10d9155805516b938e4ea5", 1, []],
  ]),
  ...group("server/donna/testSupport/dmemFixtureSupport.js", "Existing runtime SQL boundary in server/donna/testSupport/dmemFixtureSupport.js.", [
    // select count(*)::int as n from __DYNAMIC_SQL__ where __DYNAMIC_SQL__ = $1
    ["memoryPlaneRowCounts", "dynamic_sql", "e0159a1c039805b2d58c15a4a822da203a725fc984d5b4eb2de041da5733fbc2", 1, []],
    // sql
    ["rows", "dynamic_query", "017c835ac1f85df2b5f559a4f6b2189a8f3e0cc63e36b826e08fec2190929bb4", 1, []],
  ]),
  ...group("server/donna/testSupport/jurisdictionExtension/lifecycle.mjs", "Existing runtime SQL boundary in server/donna/testSupport/jurisdictionExtension/lifecycle.mjs.", [
    // drop database "donna_jn_extension___DYNAMIC_SQL_____DYNAMIC_SQL__"
    ["<callback>", "dynamic_sql", "4a7e3477981b68e2d0ca29943a6e0cfaa6f7bbceb60ffd7cf3a4ea07f783a579", 1, []],
  ]),
  ...group("server/donna/transactionChat.js", "Existing runtime SQL boundary in server/donna/transactionChat.js.", [
    // select id, description, raw_description, coalesce(payload->>'contact', payload->>'counterparty_guess') as contact, money_in, money_out, currency, reconciliation_status, status, to_char(transaction_date, 'YYYY-MM-DD') as transaction_date fro …
    ["fetchTransactionChatCollisionGroup", "dynamic_sql", "64f9d5444af55b3652095f8277b5c34fd91e0f9a56b6881a9fea6802a8bd993f", 1, []],
  ]),
]);
