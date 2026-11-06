// FI-13 slice 13.2 — the osakeyhtiö CUTOVER document set (D-FI13-22). Pure DATA +
// pure evaluation, plus a thin StatutoryBlocker mint helper (injectable client).
//
// D-FI13-22: an Oy cutover intake is a DOCUMENT SET, not a trial balance. A
// balanced-but-legally-incomplete opening position is REFUSED — the avaava tase
// footing (Dr==Cr) is necessary but not sufficient. This module names the required
// document set, groups it into a STAGED four-phase intake so onboarding is phased
// (essential → reconciliation → tax foundation → governance) rather than a
// fifteen-document wall, and computes a completeness verdict whose missing-material
// case is an opening-balance StatutoryBlocker.
//
// Doctrine (CLAUDE.md):
//   • Two-terminal-states (FIRST principle). A missing material document is not a
//     transient warning — it MINTS durable work that rests on a named party (the
//     accountant, who confirms the cutover and chases the owner for what's missing)
//     until resolved. The evaluator is pure; the blocker mint is how the verdict
//     comes to rest on a human (mirrors statutoryBlocker.js).
//   • Render-the-persisted-verdict. The evaluator reads a persisted intake state
//     (which documents are provided / marked not-applicable) and returns the
//     verdict; it never re-infers per open.
//   • The catalog is CLOSED and the not-applicable path is EXPLICIT — a document is
//     dropped from the material requirement only by a recorded not-applicable mark
//     (e.g. "no shareholder loans exist"), never by silent absence.
//
// This module does NOT persist the intake state or post anything. The intake state
// (provided / not-applicable document keys) rides the client profile like the
// FI-15 toiminimi cutover pack (cutover.js) does; wiring that persistence + the FE
// intake surface is a downstream slice (wire-UI-into-the-mounted-surface applies
// when it lands). Here we ship the pure evaluator + the mint helper.
//
// Design: docs/design-donna-finland-fi13-osakeyhtio.md (D-FI13-22, D-FI13-2).

import {
  mintStatutoryBlocker
} from '../statutoryBlocker.js';

// The four staged intake phases, in the order the owner is asked to supply them.
// essential first (the opening position cannot be seeded without these), then the
// itemizations that RECONCILE the opening balances, then the TAX-side carry-over,
// then GOVERNANCE. Ordered so onboarding is phased.
export const OY_CUTOVER_PHASES = Object.freeze([
  'essential',
  'reconciliation',
  'tax_foundation',
  'governance'
]);

// The required document set (D-FI13-22), each keyed to a phase and a materiality.
//   materiality 'material'    — its absence makes the opening position legally
//                               incomplete or unverifiable ⇒ blocks opening balances
//                               (unless explicitly marked not-applicable).
//   materiality 'recommended' — strengthens the cutover but does not block.
//   applicability 'always'    — every Oy cutover needs it; cannot be marked N/A.
//   applicability 'conditional' — material ONLY when the underlying position exists;
//                               the caller may record a not-applicable mark (e.g.
//                               "no shareholder loans") to drop it from the material
//                               requirement. A silent absence never drops it.
export const OY_CUTOVER_DOCUMENTS = Object.freeze([
  // --- essential: the opening position cannot be seeded without these ---
  { key: 'prior_approved_financial_statements', phase: 'essential', materiality: 'material', applicability: 'always', name_fi: 'Edellinen vahvistettu tilinpäätös', name_en: 'Prior approved financial statements' },
  { key: 'gl_balance_specifications', phase: 'essential', materiality: 'material', applicability: 'always', name_fi: 'Pääkirjan saldoerittelyt', name_en: 'General-ledger balance specifications' },
  { key: 'articles_of_association', phase: 'essential', materiality: 'material', applicability: 'always', name_fi: 'Yhtiöjärjestys', name_en: 'Articles of association' },
  { key: 'share_register', phase: 'essential', materiality: 'material', applicability: 'always', name_fi: 'Osakasluettelo / osakerekisteri', name_en: 'Share register / cap table' },
  // --- reconciliation: the itemizations behind the opening balances ---
  { key: 'open_receivables_payables', phase: 'reconciliation', materiality: 'material', applicability: 'conditional', name_fi: 'Avoimet myynti- ja ostosaamiset/-velat', name_en: 'Open AR / AP' },
  { key: 'fixed_asset_register', phase: 'reconciliation', materiality: 'material', applicability: 'conditional', name_fi: 'Käyttöomaisuuskirjanpito', name_en: 'Fixed-asset register' },
  { key: 'loan_schedules', phase: 'reconciliation', materiality: 'material', applicability: 'conditional', name_fi: 'Lainojen maksuaikataulut', name_en: 'Loan schedules' },
  { key: 'alv_balances', phase: 'reconciliation', materiality: 'material', applicability: 'conditional', name_fi: 'ALV-saldot', name_en: 'ALV (VAT) balances' },
  { key: 'payroll_employer_liabilities', phase: 'reconciliation', materiality: 'material', applicability: 'conditional', name_fi: 'Palkka- ja työnantajavelat', name_en: 'Payroll / employer liabilities' },
  { key: 'related_party_balances', phase: 'reconciliation', materiality: 'material', applicability: 'conditional', name_fi: 'Lähipiirisaldot', name_en: 'Related-party balances' },
  { key: 'prepayments', phase: 'reconciliation', materiality: 'recommended', applicability: 'conditional', name_fi: 'Siirtosaamiset ja -velat', name_en: 'Prepayments and accruals' },
  // --- tax_foundation: the tax-side carry-over ---
  { key: 'latest_6b_and_annexes', phase: 'tax_foundation', materiality: 'material', applicability: 'always', name_fi: 'Viimeisin veroilmoitus 6B liitteineen', name_en: 'Latest 6B return and annexes' },
  { key: 'latest_tax_assessment', phase: 'tax_foundation', materiality: 'material', applicability: 'always', name_fi: 'Viimeisin verotuspäätös', name_en: 'Latest tax assessment' },
  { key: 'carried_loss_position', phase: 'tax_foundation', materiality: 'material', applicability: 'always', name_fi: 'Vahvistetut tappiot', name_en: 'Authoritative carried-loss position' },
  // --- governance ---
  { key: 'board_representation_details', phase: 'governance', materiality: 'material', applicability: 'always', name_fi: 'Hallitus- ja edustamistiedot', name_en: 'Board / representation details' },
  { key: 'audit_status', phase: 'governance', materiality: 'material', applicability: 'always', name_fi: 'Tilintarkastustilanne', name_en: 'Audit status' },
  { key: 'prior_distribution_decisions', phase: 'governance', materiality: 'recommended', applicability: 'conditional', name_fi: 'Aiemmat voitonjakopäätökset', name_en: 'Prior distribution decisions' }
]);

const DOC_BY_KEY = new Map(OY_CUTOVER_DOCUMENTS.map((d) => [d.key, d]));

// The surface + reason a missing-material cutover set rests on. Shared so the
// evaluator directive and the mint helper agree (one deterministic blocker id).
export const OY_CUTOVER_BLOCKER_SURFACE = 'finland_oy_opening_balance';
export const OY_CUTOVER_BLOCKER_REASON_CODE = 'incomplete_oy_cutover_document_set';
export const OY_CUTOVER_RESOLUTION_PATH =
  'An osakeyhtiö opening position requires the full cutover document set (D-FI13-22), ' +
  'not just a balanced trial balance. Attach the missing material documents, or record ' +
  'a not-applicable mark where a position genuinely does not exist, before seeding the ' +
  'opening balances.';

const toSet = (value) => new Set(
  Array.isArray(value)
    ? value.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim())
    : value && typeof value === 'object'
      ? Object.keys(value).filter((k) => value[k])
      : []
);

// evaluateOyCutoverIntake({ provided, notApplicable }) — the completeness verdict.
//
//   provided       — document keys the client has supplied (array or truthy-key object)
//   notApplicable  — document keys explicitly marked not-applicable (only honoured
//                    for 'conditional' documents; an 'always' document can never be
//                    N/A)
//
// Returns:
//   { phases: [{ phase, documents:[{key,name_fi,name_en,materiality,applicability,status}],
//                material_total, provided_count, missing_material, missing_recommended,
//                not_applicable, complete }],
//     missing_material: [keys], missing_recommended: [keys], not_applicable: [keys],
//     opening_balance_ready: bool,
//     blocker: null | { should_mint, surface, reason_code, severity, assigned_to,
//                       resolution_path, missing_material, detail },
//     summary_fi, summary_en }
//
// opening_balance_ready is TRUE iff no material document is missing. Pure; never throws.
export const evaluateOyCutoverIntake = ({ provided = [], notApplicable = [] } = {}) => {
  const providedSet = toSet(provided);
  const naSet = toSet(notApplicable);

  const statusOf = (doc) => {
    if (providedSet.has(doc.key)) return 'provided';
    // A not-applicable mark only counts for a conditional document.
    if (doc.applicability === 'conditional' && naSet.has(doc.key)) return 'not_applicable';
    return 'missing';
  };

  const missingMaterial = [];
  const missingRecommended = [];
  const notApplicableOut = [];

  const phases = OY_CUTOVER_PHASES.map((phase) => {
    const docs = OY_CUTOVER_DOCUMENTS.filter((d) => d.phase === phase);
    const rendered = docs.map((d) => ({ ...d, status: statusOf(d) }));
    const phaseMissingMaterial = [];
    const phaseMissingRecommended = [];
    const phaseNotApplicable = [];
    let providedCount = 0;
    let materialTotal = 0;
    for (const d of rendered) {
      if (d.materiality === 'material') materialTotal += 1;
      if (d.status === 'provided') { providedCount += 1; continue; }
      if (d.status === 'not_applicable') { phaseNotApplicable.push(d.key); notApplicableOut.push(d.key); continue; }
      // status === 'missing'
      if (d.materiality === 'material') { phaseMissingMaterial.push(d.key); missingMaterial.push(d.key); }
      else { phaseMissingRecommended.push(d.key); missingRecommended.push(d.key); }
    }
    return {
      phase,
      documents: rendered,
      material_total: materialTotal,
      provided_count: providedCount,
      missing_material: phaseMissingMaterial,
      missing_recommended: phaseMissingRecommended,
      not_applicable: phaseNotApplicable,
      // A phase is complete when no material document in it is missing.
      complete: phaseMissingMaterial.length === 0
    };
  });

  const openingBalanceReady = missingMaterial.length === 0;
  const blocker = openingBalanceReady
    ? null
    : {
        should_mint: true,
        surface: OY_CUTOVER_BLOCKER_SURFACE,
        reason_code: OY_CUTOVER_BLOCKER_REASON_CODE,
        severity: 'review_required',
        assigned_to: 'accountant',
        resolution_path: OY_CUTOVER_RESOLUTION_PATH,
        missing_material: [...missingMaterial],
        detail: { missing_material: [...missingMaterial], missing_recommended: [...missingRecommended] }
      };

  return {
    phases,
    missing_material: missingMaterial,
    missing_recommended: missingRecommended,
    not_applicable: notApplicableOut,
    opening_balance_ready: openingBalanceReady,
    blocker,
    summary_fi: openingBalanceReady
      ? 'Osakeyhtiön cutover-aineisto on täydellinen — avaava tase voidaan kirjata.'
      : `Osakeyhtiön cutover-aineistosta puuttuu olennaisia asiakirjoja (${missingMaterial.length}) — avaavaa tasetta ei kirjata ennen kuin ne toimitetaan tai merkitään ei koske.`,
    summary_en: openingBalanceReady
      ? 'The Oy cutover document set is complete — opening balances can be seeded.'
      : `The Oy cutover document set is missing material documents (${missingMaterial.length}) — opening balances are refused until they are supplied or marked not-applicable.`
  };
};

// labelForCutoverDocument(key) — the { name_fi, name_en } for a document key, or
// null. For rendering the missing-material list to a human.
export const labelForCutoverDocument = (key) => {
  const doc = DOC_BY_KEY.get(key);
  return doc ? { name_fi: doc.name_fi, name_en: doc.name_en } : null;
};

// mintOyCutoverBlocker — mint (or idempotently re-raise) the opening-balance
// StatutoryBlocker for an incomplete Oy cutover set. Thin wrapper over
// mintStatutoryBlocker (inherits its pre-migration soft-fail and its "the mint
// never masks the load-bearing refusal" posture). Returns the mint result, or null
// when the verdict has no blocker (the set is complete) or the store predates
// migration 076. Callers wire this on the opening-balance seed path: the seed
// refuses when opening_balance_ready is false, and this mints the durable work.
export const mintOyCutoverBlocker = async ({
  client, firmId, clientId, verdict, actorType = 'system', actorId = null, reason = null
} = {}) => {
  if (!verdict || !verdict.blocker || !verdict.blocker.should_mint) return null;
  const { blocker } = verdict;
  return mintStatutoryBlocker({
    client,
    firmId,
    clientId,
    surface: blocker.surface,
    reasonCode: blocker.reason_code,
    severity: blocker.severity,
    assignedTo: blocker.assigned_to,
    entityType: 'oy',
    resolutionPath: blocker.resolution_path,
    detail: blocker.detail || {},
    actorType,
    actorId,
    reason
  });
};
