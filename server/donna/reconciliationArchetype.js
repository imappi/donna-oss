// Archetype gating for delegated authority — Slice 4 of the #5 design:
// docs/proposal-2026-06-23-delegated-authority-material-matches.md (§7, §9).
//
// This module decides, for a single materiality-held reconciliation match,
// WHETHER that already-made match is eligible for unattended authority, and
// under WHAT canonical scope key a covering grant would have to be written. It
// is the keystone that activates the feature: Slices 1–3 wired the grant store,
// the accept-path seam, and the bounded authorization ask, but all three were
// passed archetype = scope_key = null by the orchestrators, so the grant lookup
// and the pattern-level cooldown were inert. This is what supplies the real
// values.
//
// ── What this is NOT (trust-the-strong-LLM, CLAUDE.md + spec §7) ──────────────
// This is an authority PRECONDITION, NOT match re-scoring. The strong model
// already decided WHICH bank line settles WHAT document (the A–D judgment, reused
// verbatim via delegationGateProof); the A–E gate stack already authorized that
// judgment on everything except the materiality ceiling. This classifier NEVER
// re-ranks candidates, rescues a rejected match, or re-decides a gate. It only
// reads the already-matched (proposal, bankLine, document, firmContext) and
// answers a governance question: "is this match the kind of low-risk, recurring,
// fully-evidenced pattern a firm could safely pre-authorize?" If yes, it names
// the archetype + the scope key; if there is ANY doubt it returns archetype:null
// — which means no grant can match (findActiveAuthorityGrant requires a non-null
// archetype) and the held line falls through to a plain per-line authorization
// ask (Slice 3). Failing closed to null is always safe.
//
// ── Deterministic + pure ─────────────────────────────────────────────────────
// No LLM call, no DB, no I/O. Reaching for an LLM classification here would be
// the exact intelligence-substituting drift the trust-LLM principle forbids, and
// a re-scoring risk besides. The same inputs always yield the same verdict, so
// the value used at grant-LOOKUP time and the value a future grant-MINT path
// (Slice 3b) writes are guaranteed identical — which is the whole reason scope
// keys ever match.
//
// ── The V1-safe set (spec §7) ────────────────────────────────────────────────
// Only genuinely low-risk archetypes ship in V1, and each must clear its
// required-evidence predicates fail-closed:
//   - recurring_rent_lease  — the live V1 path. A recurring, rent/lease-natured
//     bill we pay (money_out) to a vendor we have matched before, coded to an
//     established ledger account, with no excluded subtype (deposit, CAM, repair,
//     late fee, insurance/tax pass-through, first payment under a new lease).
//   - verified_card_payment — requires a PRE-LINKED & VERIFIED card-liability
//     account id + counter-account id (spec §7). That linkage is not exposed in
//     the V1 reconciliation data surface, so this archetype cannot satisfy its
//     evidence predicate and ALWAYS fails closed to null here. The shape is
//     detected only so the exclusion is explicit and testable.
//   - internal_transfer     — the riskiest V1 candidate. "Same legal entity" must
//     be PROVEN, never assumed from client_id (spec §7). entity_id is not
//     available in V1 and a client may hold multiple legal entities, so this
//     archetype is EXCLUDED entirely (always null). It is also unreachable
//     through these document-driven orchestrators, which match a document, not a
//     bank-line-to-bank-line transfer.
// Everything else — IRS/tax authority, owner/related-party, processor payout,
// payroll, loans, cash deposits — is excluded and fails closed.

import { canonicalMerchantPattern } from './transactionIntel.js';

export const ARCHETYPE_RECURRING_RENT_LEASE = 'recurring_rent_lease';
export const ARCHETYPE_VERIFIED_CARD_PAYMENT = 'verified_card_payment';
export const ARCHETYPE_INTERNAL_TRANSFER = 'internal_transfer';

// The scope_kind each archetype mints under — the single source the classifier
// AND the Slice-3b grant minter share. `classifyReconciliationArchetype` returns
// `scopeKind` inline with the live verdict; the grant minter (api.js confirm/grant
// handler) reads the persisted classifier output (archetype + scope_key) off the
// open authorization request — which carries scope_key but NOT scope_kind — and
// derives scope_kind here so it can never drift from what the classifier emitted.
// findActiveAuthorityGrant keys its lookup on (archetype, scope_key) ONLY, so this
// only feeds the mint validity (GRANT_SCOPE_KINDS) + the deterministic grant id;
// it is intentionally limited to V1-grantable archetypes (rent/lease → merchant).
const ARCHETYPE_SCOPE_KIND = Object.freeze({
  [ARCHETYPE_RECURRING_RENT_LEASE]: 'merchant'
});
export const scopeKindForArchetype = (archetype) => ARCHETYPE_SCOPE_KIND[archetype] || null;

// The fail-closed verdict every excluded / doubtful case returns. archetype:null
// means findActiveAuthorityGrant short-circuits (no grant) and the producer opens
// a plain per-line ask (no pattern scope). firstUseAccountInvolved is irrelevant
// when archetype is null (the lookup fails closed on the null archetype anyway),
// so we report the honest best-effort value without it changing behaviour.
const NO_ARCHETYPE = Object.freeze({
  archetype: null,
  scopeKind: null,
  scopeKey: null,
  firstUseAccountInvolved: false,
  evidenceOk: false
});

// document_type families that can carry a recurring rent/lease bill we PAY. Only
// AP/expense document types — a sales invoice (money_in) is never rent we owe.
const BILL_DOC_TYPES = new Set(['supplier_bill', 'recurring_bill', 'bill']);

// Positive rent/lease nature signal. Intentionally narrow: a real rent/lease bill
// names itself. A miss costs only a plain per-line ask (safe); a false positive on
// a non-rent bill cannot auto-accept anyway (its vendor/scope_key would not match
// any rent grant), but we keep the gate tight as defence in depth.
const RENT_LEASE_RE = /\b(rent|rental|lease|leasing|tenancy|tenant|landlord|letting|premises)\b/i;

// Excluded rent SUBTYPES (spec §7): these ride on the same vendor but are NOT the
// recurring base rent a firm would pre-authorize, so they fail closed to a per-line
// ask. A deposit / first month is one-off; CAM, repairs, late fees, and
// tax/insurance pass-throughs vary and need a human eye.
const RENT_EXCLUDED_SUBTYPE_RE =
  /\b(deposit|security deposit|cam|common area|repair|maintenance|late fee|penalty|arrears|insurance|property tax|rates|first month|first payment|move[\s-]?in|new lease|holding fee)\b/i;

// High-risk counterparties / natures that are excluded at EVERY archetype (spec
// §1, §7) — a rent keyword must never rescue one of these into auto-acceptance.
const EXCLUDED_NATURE_RE =
  /\b(irs|hmrc|inland revenue|tax authority|tax office|revenue service|owner|director|shareholder|related party|payroll|salary|wages|loan|repayment|dividend|stripe|paypal|adyen|gocardless|wise|payout|settlement|cash deposit|atm)\b/i;

// Internal-transfer shape: a movement between the firm's own accounts. Detected
// only so the V1 exclusion is explicit + testable — it always fails closed (no
// same-entity proof available, spec §7).
const INTERNAL_TRANSFER_RE = /\b(transfer|xfer|own account|internal|sweep|between accounts|book transfer)\b/i;

// Card-payment shape: a card settlement / card-liability movement. Detected only
// so the V1 exclusion is explicit + testable — it always fails closed (the
// pre-linked, verified card-liability account id is not in the V1 data surface).
const CARD_PAYMENT_RE = /\b(card payment|credit card|cardholder|card settlement|statement balance|minimum payment|amex|visa|mastercard)\b/i;

// Canonical scope-key component slug. Lowercase; non-alphanumerics collapse to a
// single hyphen; trimmed. Stable for a given input, so lookup and mint agree.
const slugComponent = (value) =>
  String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// The vendor identity component of the scope key: the firm-wide canonical
// merchant pattern (the same normaliser firm_facts and the coding stack use), then
// slugged. Empty when no usable vendor name — which fails the rent path closed.
const vendorScopeComponent = (vendorName) => {
  const canonical = canonicalMerchantPattern(vendorName || '');
  return slugComponent(canonical);
};

// The established ledger account the line is coded to. We prefer the explicit
// account_code, then the category. ABSENT → no approved ledger account → the rent
// path fails closed (spec §7 requires an approved ledger account; we never invent
// one). This is also the established-account evidence: a coded account on a line
// whose vendor we have matched before is, in V1, our proof the account is not
// first-use.
const ledgerScopeComponent = (bankLine) => {
  const raw = bankLine?.account_code ?? bankLine?.category ?? null;
  return slugComponent(raw);
};

// Concatenated free-text the nature regexes scan: the vendor name + the line's
// descriptions + the document's reference/filename/parse summary. Kept to fields
// present across all four orchestrators' loaded shapes; missing fields are simply
// empty.
const natureText = ({ bankLine, document }) => {
  const parseSummary = document?.parse_summary;
  const parseText =
    parseSummary && typeof parseSummary === 'object'
      ? JSON.stringify(parseSummary)
      : String(parseSummary || '');
  return [
    document?.vendor_name,
    document?.reference_number,
    document?.filename,
    parseText,
    bankLine?.description,
    bankLine?.raw_description,
    bankLine?.contact
  ]
    .filter(Boolean)
    .join(' ');
};

// money_out (we are paying) — the only direction a rent/lease bill we owe can
// settle. money_in lines (AR) are never recurring rent we pre-authorize.
const isMoneyOut = (bankLine) =>
  Number(bankLine?.money_out) > 0 && !(Number(bankLine?.money_in) > 0);

// Recurring evidence: at least one PRIOR confirmed/auto-matched line for the SAME
// canonical vendor (spec §7 "a real matched lease/rent document or recurring
// bill"). firmContext.recentConfirmedMatches is the few-shot roster of this
// client's recent confirmed matches; the field is `vendor_name` on the three
// money_out orchestrators (`customer_name` on sales invoices, which never reach
// the rent path). A vendor we have settled before is an established relationship,
// not a first-use one.
const hasRecurringVendorEvidence = (vendorCanonical, firmContext) => {
  if (!vendorCanonical) return false;
  const roster = Array.isArray(firmContext?.recentConfirmedMatches)
    ? firmContext.recentConfirmedMatches
    : [];
  return roster.some((entry) => {
    const name = entry?.vendor_name ?? entry?.customer_name ?? entry?.counterparty_name ?? entry?.name;
    return !!name && canonicalMerchantPattern(name) === canonicalMerchantPattern(vendorCanonical);
  });
};

// Classify a single materiality-held match. Pure + fail-closed: any doubt →
// NO_ARCHETYPE. The caller (the orchestrator loop) threads the result into
// applyDelegatedAuthority (the grant lookup), so a covering grant auto-accepts
// the held line. (It also fed the firm-ask producer's pattern-scoped cooldown,
// retired in E2 — the 2026-06-24 no-gate decision.)
export const classifyReconciliationArchetype = ({
  proposal = null,
  bankLine = null,
  document = null,
  firmContext = null
} = {}) => {
  void proposal; // the match identity is already decided; we do not re-score it.
  if (!bankLine || !document) return NO_ARCHETYPE;

  const text = natureText({ bankLine, document });

  // Hard exclusions first — a high-risk nature is never rescued by any later
  // positive signal (spec §1: a grant may bypass Gate E ONLY, never evidence /
  // entity / policy preconditions).
  if (EXCLUDED_NATURE_RE.test(text)) return NO_ARCHETYPE;

  // internal_transfer — EXCLUDED in V1: same-entity cannot be proven (no
  // entity_id; a client may hold multiple legal entities) and a transfer is not a
  // document-driven match in the first place. Fail closed.
  if (INTERNAL_TRANSFER_RE.test(text)) return NO_ARCHETYPE;

  // verified_card_payment — EXCLUDED in V1: the pre-linked, verified
  // card-liability account id required by spec §7 is not in the reconciliation
  // data surface, so the evidence predicate can never pass. Fail closed.
  if (CARD_PAYMENT_RE.test(text)) return NO_ARCHETYPE;

  // recurring_rent_lease — the live V1 path.
  if (
    isMoneyOut(bankLine) &&
    BILL_DOC_TYPES.has(document?.document_type) &&
    RENT_LEASE_RE.test(text) &&
    !RENT_EXCLUDED_SUBTYPE_RE.test(text)
  ) {
    const vendorComponent = vendorScopeComponent(document?.vendor_name);
    const ledgerComponent = ledgerScopeComponent(bankLine);
    const docComponent = slugComponent(document?.document_type);
    const recurring = hasRecurringVendorEvidence(document?.vendor_name, firmContext);

    // ALL mandatory §7 components must be present AND the recurring evidence must
    // hold. A missing vendor, an uncoded (no approved ledger account) line, or no
    // prior matched bill for this vendor each fails the archetype closed — never
    // an assumed grant.
    if (vendorComponent && ledgerComponent && recurring) {
      return {
        archetype: ARCHETYPE_RECURRING_RENT_LEASE,
        scopeKind: 'merchant',
        scopeKey: `merchant:${vendorComponent}|doc:${docComponent}|acct:${ledgerComponent}`,
        // Established account by construction: we only get here with a coded
        // ledger account AND prior confirmed matches for this vendor, so the
        // account is not first-use. (V1 cannot detect a brand-new account
        // directly; we proceed only on positive established-relationship
        // evidence rather than assuming.)
        firstUseAccountInvolved: false,
        evidenceOk: true
      };
    }
  }

  return NO_ARCHETYPE;
};

export const __test__ = {
  NO_ARCHETYPE,
  BILL_DOC_TYPES,
  slugComponent,
  vendorScopeComponent,
  ledgerScopeComponent,
  hasRecurringVendorEvidence,
  isMoneyOut,
  RENT_LEASE_RE,
  RENT_EXCLUDED_SUBTYPE_RE,
  EXCLUDED_NATURE_RE
};
