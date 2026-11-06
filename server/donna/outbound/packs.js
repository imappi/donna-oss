// Outbound country packs — the M0.1 substrate of the outbound-actions plan
// (docs/design-donna-outbound-actions-execution-plan.md A6/A7, G7).
//
// A pack is a VERSIONED DATA MODULE under packs/<cc>/manifest.json. The action
// pipeline consumes packs through this one interface and never imports core
// defaults (gap 12's debt classes stay quarantined behind this boundary —
// enforced by noCoreLiterals.test.js from this first commit).
//
// THE SCHEMA IS DERIVED FROM FINLAND'S FULL SHAPE (Kari, 2026-07-24: the pack
// abstraction is real from day one; the US pack is merely the first CONSUMER
// of a schema designed against the harder market). Every pack MUST declare
// every FI-derived section explicitly — a reference scheme (FI: viitenumero;
// US: none), an e-invoice lane (FI: finvoice_email + operator planned; US:
// none), multi-language correspondence (FI: fi/sv/en; US: en), statutory
// correspondence data with provenance (FI: korkolaki/perintälaki entries; US:
// null), payment rails (FI: IBAN; US: ACH + check). Absence of a section
// refuses the pack — 'none' is a declared value, never a missing key.
//
// Localization is data (A7): templates + language catalogs live in the pack;
// per-entity preferred_language (G1) picks among the pack's supported
// languages at render time. No hardcoded language strings in pipeline code.
//
// Keep-layer posture: this module is deterministic validation + rendering
// plumbing. No LLM anywhere. Statutory numbers require provenance before they
// may render (D5 — "no confident fabrication" applies to interest rates too).

import { readFileSync } from 'node:fs';
import { validateNativeChart } from './nativeChart.js';

// The canonical account-role registry — Donna's machine-facing account
// identity (docs/donna-coa-architecture.md). A pack's fallback chart names
// display strings; the ROLE is what core reasons about, so every declared
// account must carry one. accountRoles.js is a pure-data leaf (it is NOT
// transactionLlm.js, whose SG core defaults the noCoreLiterals lint refuses).
import { isAccountRole } from '../accountRoles.js';
import { normalizeJurisdictionKey } from '../taxCodeJurisdiction.js';

// packs/ lives at the repo root, three levels up from server/donna/outbound/.
import { COUNTRY_PACKS_ROOT as PACKS_ROOT, CountryCapabilityError, discoverCountryCapabilities, resolveCountryCapability } from '../countryCapabilities.js';

// ── Closed vocabularies the manifest validates against ──────────────────────

// Reference-number schemes. The NAME is validated here; the implementation is
// bound by the pack's country module at pipeline level (M3 binds
// 'fi_viitenumero' to finland/verkkolasku.js's mint/validate — zero core
// edits, per the M3 abstraction proof). 'none' is the declared absence (US).
export const KNOWN_REFERENCE_SCHEMES = Object.freeze(['none', 'fi_viitenumero']);

// E-invoice lanes (A5/D3). 'finvoice_email' = XML + PDF attached to email
// (exists today for FI); 'operator' = operator-network delivery (deferred but
// schedulable — a pack may declare operator: 'planned' to keep its shape
// honest before the lane ships).
export const KNOWN_EINVOICE_LANES = Object.freeze(['none', 'finvoice_email', 'operator']);
export const KNOWN_EINVOICE_OPERATOR_STATES = Object.freeze(['none', 'planned', 'live']);

// Payment-rail kinds (A6 payment_rails). FI/UK: iban (UK adds
// sort_code_account); US: ach + check; remit_instructions = "whatever the
// invoice states" (the US M1 payment block before D4 pay-links land).
export const KNOWN_PAYMENT_RAIL_KINDS = Object.freeze([
  'iban', 'ach', 'check', 'sort_code_account', 'remit_instructions', 'payment_link'
]);

// Dunning escalation terminal. Two-terminal-states, self-service re-amendment
// (2026-07-23): when a cadence exhausts, the ONLY human it may escalate to is
// the OWNER. There is no third value to add here.
export const KNOWN_ESCALATION_TARGETS = Object.freeze(['owner']);

// Template placeholder tokens the renderer will resolve. A template using an
// unknown token refuses at LOAD time (not at send time, and never by leaking
// '{{token}}' into a counterparty's inbox). CLOSED vocabulary — widen it HERE
// together with the FI-shaped fixture in packs.test.js, never by forking the
// schema (M2 additions: the issuance tokens + the D4 pay-link URL; M4
// addition: days_until_due for the owner-directed payable notice).
export const KNOWN_TEMPLATE_TOKENS = Object.freeze([
  'counterparty_name', 'owner_business_name', 'invoice_number', 'invoice_total',
  'amount_due', 'currency', 'issue_date', 'due_date', 'days_overdue',
  'days_until_due',
  'payment_instructions', 'reference_number', 'step_number', 'unsubscribe_url',
  'lines_block', 'quote_number', 'quote_total', 'valid_until', 'payment_link_url',
  // gap 11 (2026-08-30, the AE pack): the statutory document title, resolved at
  // MINT time from documents.statutory_titles + the seller's registration limb
  // (a UAE tax invoice must carry the words 'Tax Invoice'; an unregistered
  // seller's invoice must not). Allowed ONLY in the invoice templates — see
  // DOCUMENT_TITLE_TEMPLATES below.
  'document_title',
  'seller_address', 'buyer_address', 'supply_date',
  'seller_tax_registration_block', 'buyer_tax_registration_block', 'invoice_tax_totals_block',
  // AR-4B3: optional, send-inert CreditNote artifact vocabulary. These
  // values are legal only in credit_note_pdf; the validator below pins that
  // closed scope so adding the artifact seam cannot widen Invoice/Quote mail.
  'credit_note_number', 'original_invoice_reference', 'adjustment_reason',
  'credit_note_subtotal_amount', 'credit_note_tax_amount',
  'credit_note_total_amount', 'seller_tax_registration_number',
  'buyer_tax_registration_number', 'seller_iban'
]);

// The templates {{document_title}} may appear in. Invoice issuance and the
// standalone CreditNote renderer each resolve their own title contract; the
// token anywhere else would fail-closed at render time — refuse it at LOAD.
export const DOCUMENT_TITLE_TEMPLATES = Object.freeze([
  'invoice_pdf', 'invoice_issue', 'credit_note_pdf'
]);

export const INVOICE_STATUTORY_TOKENS = Object.freeze([
  'seller_address', 'buyer_address', 'supply_date',
  'seller_tax_registration_block', 'buyer_tax_registration_block', 'invoice_tax_totals_block'
]);
export const INVOICE_OPTIONAL_BLOCK_TOKENS = Object.freeze([
  'seller_tax_registration_block', 'buyer_tax_registration_block', 'invoice_tax_totals_block'
]);
const INVOICE_STATUTORY_LABEL_KEYS = Object.freeze([
  'seller_tax_registration', 'buyer_tax_registration', 'subtotal', 'tax_total', 'line_tax', 'line_payable'
]);
const INVOICE_DISPLAY_TEMPLATES = new Set(['invoice_pdf', 'invoice_issue']);

export const CREDIT_NOTE_PDF_REQUIRED_TOKENS = Object.freeze([
  'document_title', 'credit_note_number', 'original_invoice_reference',
  'adjustment_reason', 'owner_business_name', 'counterparty_name', 'issue_date',
  'currency', 'lines_block', 'credit_note_subtotal_amount',
  'credit_note_tax_amount', 'credit_note_total_amount'
]);

export const CREDIT_NOTE_PDF_OPTIONAL_TOKENS = Object.freeze([
  'seller_tax_registration_number', 'buyer_tax_registration_number', 'seller_iban'
]);

export const CREDIT_NOTE_PDF_ALLOWED_TOKENS = Object.freeze([
  ...CREDIT_NOTE_PDF_REQUIRED_TOKENS,
  ...CREDIT_NOTE_PDF_OPTIONAL_TOKENS
]);

const CREDIT_NOTE_PDF_SUBJECT_REQUIRED_TOKENS = Object.freeze([
  'document_title', 'credit_note_number'
]);

const CREDIT_NOTE_PDF_ONLY_TOKENS = new Set([
  'credit_note_number', 'original_invoice_reference', 'adjustment_reason',
  'credit_note_subtotal_amount', 'credit_note_tax_amount',
  'credit_note_total_amount', ...CREDIT_NOTE_PDF_OPTIONAL_TOKENS
]);

// Invoice fields a pack may declare as its statutory floor
// (documents.mandatory_fields.invoice). CLOSED vocabulary, for the same reason
// KNOWN_TEMPLATE_TOKENS is closed: a pack declaring a field core cannot resolve
// must refuse at LOAD time, not silently refuse every invoice at BUILD time.
//
// Discovered by building the GB pack (2026-07-27): the field list validated,
// then every GB invoice refused, because `issuance.js` resolved only the nine
// keys FI and US happened to need. That is the country-corner shape — the
// contract accepted a declaration the engine could not satisfy.
//
// The names are deliberately JURISDICTION-NEUTRAL. 'tax point', 'VAT number'
// and 'time of supply' are GB/EU vocabulary; putting them in core would be the
// same corner facing the other way. A pack maps its local concept onto the
// neutral name: GB's tax point and FI's toimituspäivä are both `supply_date`;
// a GB VAT registration number and an FI ALV number are both
// `seller_tax_registration_id`, which is distinct from `seller_business_id`
// (company registration — Companies House number, Y-tunnus).
//
// Widen this HERE, together with `fieldValues` in issuance.js and a fixture in
// packs.test.js — never by forking the schema.
export const KNOWN_INVOICE_MANDATORY_FIELDS = Object.freeze([
  'invoice_number', 'issue_date', 'supply_date', 'due_date',
  'total', 'total_excluding_tax', 'tax_amount', 'currency',
  'seller_name', 'seller_address', 'seller_business_id', 'seller_tax_registration_id',
  'buyer_name', 'buyer_address', 'buyer_business_id', 'buyer_tax_registration_id',
  // gap 13 (2026-08-30, surfaced by the AE pack, statutory in GB too): the
  // quantity and unit price a tax invoice must show against each line (AE
  // Art. 59; GB VAT Notice 700 §16). The builder has always validated and
  // rendered both — these names exist so a pack can DECLARE the statutory
  // requirement rather than rely on an invariant it cannot see (the
  // line_description precedent).
  'line_description', 'line_quantity', 'line_unit_price',
  'line_tax_rate', 'reference_number', 'payment_instructions'
]);

// ── gap 9 — the floor is CONDITIONAL on the seller's tax-registration status ──
//
// `mandatory_fields.invoice` alone is a flat, unconditional list, and a VAT
// regime is not flat. A UK business below the registration threshold issues an
// ordinary invoice: it has NO VAT number and must NOT show a VAT rate. A
// registered business must issue a full VAT invoice carrying both. Declaring
// only the VAT-invoice floor made core refuse to build ANY invoice for a
// non-registered GB seller; declaring only the ordinary floor would let a
// registered seller issue an invalid VAT invoice. Neither is trimmable — the
// contract had to learn the condition.
//
// Two OPTIONAL sibling lists express it. A pack that declares neither behaves
// EXACTLY as before (FI and US are byte-identical), which is why this is an
// additive key rather than a reshaped `invoice` value:
//
//   invoice_when_tax_registered              additionally required when the
//                                            seller IS tax-registered.
//   invoice_forbidden_when_not_tax_registered  must be ABSENT when the seller
//                                            is NOT tax-registered.
//
// The FORBIDDEN half is the part a "required-only" design cannot express, and
// it is the half that keeps the invoice honest: a non-registered business
// showing `line_tax_rate: 0` satisfies a required-check while misrepresenting
// its VAT status. Absence is the statutory requirement, so absence is checked.
export const KNOWN_CONDITIONAL_INVOICE_FIELD_KEYS = Object.freeze([
  'invoice_when_tax_registered',
  'invoice_forbidden_when_not_tax_registered',
  // Full tax-invoice overlay: applies when seller AND buyer are registered.
  'invoice_when_buyer_tax_registered'
]);

// ── Statutory obligations (gap 3 — the leg that generates WORK) ─────────────
//
// Everything above this point is data a pack supplies to a motion someone else
// starts. An OBLIGATION is different in kind: it is a statutory duty that
// generates work on its own clock (a VAT return falls due whether or not the
// owner did anything). Before this leg existed a pack could not express one, so
// Finland's obligations became hardcoded modules plus a country-named cron
// (`vercel.json` literally scheduled `?task=finland_watches`). Adding a
// `uk_watches` sibling would have forked the motion a second time — the
// country corner this parallel FI/GB build exists to prevent.
//
// The shape is the referenceSchemes template, applied to obligations: the
// NAMES live here as a closed vocabulary, the IMPLEMENTATIONS are bound by
// function identity in statutoryObligations.js, and a test pins the two lists
// equal. A new market's obligation is pack data + one binding, never an
// engine edit.
//
// NOT a generic due-scan (an explicit anti-goal). Core never computes whether
// an obligation is due: each bound implementation owns its own due-ness, its
// own thresholds and its own asks. Core owns enumeration, provenance and
// dispatch.

// Whether a pack's statutory obligations have been ENUMERATED. This exists so
// an empty list cannot lie. `[]` under 'surveyed' means "this market imposes
// none we must watch"; `[]` under 'not_surveyed' means "nobody has looked
// yet" — a materially different claim, and the sweep reports the difference
// on every run rather than letting an unsurveyed market read as a clean one.
export const KNOWN_OBLIGATION_SURVEY_STATES = Object.freeze(['surveyed', 'not_surveyed']);

// Per-obligation build state. 'declared_unbuilt' is the honest half: the pack
// declares what the market actually REQUIRES even where core cannot serve it
// yet, and the sweep surfaces it every run. Trimming the declaration to what
// the engine happens to support is how the corner gets built — if a manifest
// declares what a market requires and the engine cannot satisfy it, the ENGINE
// is the bug.
export const KNOWN_OBLIGATION_STATUSES = Object.freeze(['bound', 'declared_unbuilt']);

// Obligation binding NAMES core can dispatch. CLOSED, for the same reason
// KNOWN_REFERENCE_SCHEMES is closed: a pack naming a binding core cannot
// resolve must refuse at LOAD time, not silently skip a statutory duty at
// sweep time. Widen this HERE together with STATUTORY_OBLIGATION_BINDINGS in
// statutoryObligations.js — a test pins the two lists equal in both
// directions, so widening one alone fails CI.
export const KNOWN_OBLIGATION_BINDINGS = Object.freeze([
  'fi_alv_threshold_escalation',
  'fi_scope_drift_ask_delivery',
  'gb_vat_threshold_escalation',
  'ae_vat_threshold_escalation',
  'ae_vat_return_deadline_escalation',
  'ae_ct_registration_escalation',
  'ae_vat_registration_escalation'
]);

// ── Chart of accounts (gap 7 — the fallback coding vocabulary) ──────────────
//
// A client with no synced chart of accounts still has to be coded against
// SOMETHING. Until this leg existed that something was XERO_ACCOUNT_OPTIONS —
// a Singapore-flavoured list carrying 'CPF payable' and no VAT/PAYE/ALV
// account — for EVERY client in EVERY market. It is the same wrongness the
// tax vocabularies fixed one layer over, and it is fixed the same way: the
// pack declares the vocabulary as DATA and core routes to it by marker
// (taxTreatmentOptionsForClient is the pattern).
//
// Every declared account carries an explicit CANONICAL ROLE. The display name
// is a view; the role is the identity core reasons about (the AR post path
// resolves `asset.accounts_receivable` and `revenue.operating` by role, not by
// name), so a pack whose accounts had no roles would be a menu with no
// meaning. Requiring the role in the manifest also means a new market's
// palette needs no additions to accountRoles.js's seed-name table.
//
// The role vocabulary is CLOSED at load: an unknown role refuses the pack,
// same discipline as template tokens and mandatory fields.

// A pack's fallback chart must offer the unknown-line terminal, or a coder
// with nothing to say has nowhere to put the line. Required exactly once.
export const SUSPENSE_ACCOUNT_ROLE = 'control.suspense';

// The consumption-tax control account (gap 10). AT MOST once — a market with no
// consumption tax declares none (the US), but two would make the role
// unresolvable exactly where a VAT/ALV/GST split leg needs to resolve it.
export const SALES_TAX_ACCOUNT_ROLE = 'liability.sales_tax_payable';

// The config-plane flag that routes a client's fallback coding menu to its own
// market's palette (migration 042 pattern, read via clientFlagActs with
// envFallback () => false — born on the control plane, never as an env pair,
// per the rollout-flags rail). One flag, not one per country: the client's
// fixed onboarding jurisdiction picks WHICH pack; the flag only decides
// WHETHER routing acts. Mirrors JURISDICTION_TAX_CODING exactly, and is
// deliberately SEPARATE from it: the account palette and the tax vocabulary
// change different things for a client and must be able to graduate on their
// own evidence.
export const JURISDICTION_ACCOUNT_PALETTE_FLAG_KEY = 'JURISDICTION_ACCOUNT_PALETTE';

// ── platforms[] (gap 4 — bind it or stop requiring it) ──────────────────────
//
// The accounting systems a pack's market can connect to. Until now NOTHING
// read this field: the only reference to `manifest.platforms` anywhere in
// server/ was its own validator, and adapter selection never consulted the
// pack. A required field nobody reads is a contract that lies about what it
// governs, so it is bound rather than dropped — the market genuinely differs
// (Procountor is a Finnish system; a GB client connecting to it is a mistake
// worth naming, and a US-only connector reaching an FI client likewise).
//
// The vocabulary mirrors accountingSystems/index.js ADAPTERS. Inlined rather
// than imported so packs.js stays a data leaf the noCoreLiterals lint is happy
// with and so pack validation cannot drag the connector layer in; a drift test
// pins the two lists equal.
//
// 'none' is deliberately absent: it is the client-level "no connector" value,
// not a platform a market offers.
export const KNOWN_PACK_PLATFORMS = Object.freeze(['xero', 'qbo', 'procountor']);

// ── correspondence.statutory.late_interest shapes (gap 5) ───────────────────
//
// The block was modelled on Finland's rule — one reference rate plus a margin.
// The UK's Late Payment of Commercial Debts (Interest) Act 1998 carries BOTH
// an interest rate (BoE base + 8pp) AND a fixed per-invoice compensation sum
// banded by debt size, so the GB pack had to add a `fixed_compensation` key the
// validator did not know about and therefore did not check.
//
// Fixed by naming the SHAPE explicitly. `basis` is a closed vocabulary, and the
// basis decides which numeric slots must be PRESENT (they may still be null —
// D5's posture is that the RULE is provenanced and the NUMBERS wait for a
// primary-source reading, so a missing key is a schema error while a null value
// is an honest "not recorded yet").
export const KNOWN_LATE_INTEREST_BASES = Object.freeze([
  'reference_rate_plus_margin',
  'reference_rate_plus_margin_plus_fixed_compensation'
]);

// basis → the numeric slots the shape requires (present; null permitted).
const LATE_INTEREST_REQUIRED_SLOTS = Object.freeze({
  reference_rate_plus_margin: ['rate_percent'],
  reference_rate_plus_margin_plus_fixed_compensation: ['rate_percent', 'fixed_compensation']
});

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Templates every pack MUST provide in every correspondence language (M2: the
// issuance flow is pack-consuming from day one — a pack that cannot express an
// invoice or quote email cannot serve the pipeline). 'invoice_pdf' joined the
// set with the PDF artifact slice: its subject is the document title line and
// its body the document-toned invoice content the artifact typesets — the
// same closed token vocabulary, the same fail-closed render; document-toned
// means NO conversational prose (no greeting, no "reply to this email").
// 'quote_pdf' is the quote-side sibling (same motion, same discipline): the
// printable form of the quote the send attaches — and it carries NO
// reference_number and NO payment_instructions (a quote is not payable yet).
export const REQUIRED_ISSUANCE_TEMPLATES = Object.freeze(['invoice_issue', 'quote_send', 'invoice_pdf', 'quote_pdf']);

// Physical page sizes the invoice-PDF artifact may typeset onto. CLOSED
// vocabulary; WHICH size applies is pack data (documents.invoice_pdf.page) —
// a page-size default in core would be exactly the US-first (or A4-first)
// shape creep risk #9 names.
export const KNOWN_PDF_PAGE_SIZES = Object.freeze(['a4', 'letter']);

// M4: the owner-directed payable notice ("supplier bill due in N days —
// schedule payment?"). Required in every correspondence language like the
// issuance set — a pack that cannot speak to its owner about a due bill
// cannot serve the payables lane. NOTE for template authors: this mail goes
// to the OWNER (Donna's own operational channel) — no {{unsubscribe_url}},
// and it must render without a public base URL.
export const REQUIRED_PAYABLE_TEMPLATES = Object.freeze(['payable_notice']);

const TOKEN_RE = /\{\{([a-z0-9_]+)\}\}/g;

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isBcp47LocaleTag = (value) => {
  if (!isNonEmptyString(value)) return false;
  try {
    return Intl.getCanonicalLocales(value.trim()).length === 1;
  } catch {
    return false;
  }
};

const extractTokens = (text) => {
  const tokens = new Set();
  for (const match of String(text ?? '').matchAll(TOKEN_RE)) tokens.add(match[1]);
  return [...tokens];
};

const creditNoteContractError = (code, reason) => {
  const error = new Error(`CreditNote PDF contract refused: ${reason}`);
  error.code = code;
  return error;
};

const creditNotePdfContractVerdict = (manifest) => {
  const documents = manifest?.documents;
  const declaration = documents?.credit_note_pdf;
  const template = documents?.templates?.credit_note_pdf;
  const hasDeclaration = declaration !== undefined;
  const hasTemplate = template !== undefined;
  if (!hasDeclaration && !hasTemplate) {
    return { state: 'absent', errors: [] };
  }

  const errors = [];
  const fail = (message) => errors.push(message);
  if (!hasDeclaration || !hasTemplate) {
    fail('documents.credit_note_pdf and documents.templates.credit_note_pdf must be declared together');
  }

  const languages = Array.isArray(manifest?.correspondence?.languages)
    ? manifest.correspondence.languages.filter(isNonEmptyString)
    : [];
  if (languages.length === 0) {
    fail('a CreditNote PDF contract requires at least one correspondence language');
  }

  if (hasDeclaration) {
    if (!isPlainObject(declaration)) {
      fail('documents.credit_note_pdf must be an object');
    } else {
      for (const key of Object.keys(declaration)) {
        if (!['page', 'titles_by_language'].includes(key)) {
          fail(`documents.credit_note_pdf declares unknown key '${key}'`);
        }
      }
      if (!KNOWN_PDF_PAGE_SIZES.includes(declaration.page)) {
        fail(`documents.credit_note_pdf.page must be one of ${KNOWN_PDF_PAGE_SIZES.join('|')}`);
      }
      const titles = declaration.titles_by_language;
      if (!isPlainObject(titles)) {
        fail('documents.credit_note_pdf.titles_by_language must be an object keyed by correspondence language');
      } else {
        for (const language of languages) {
          if (!isNonEmptyString(titles[language])) {
            fail(`documents.credit_note_pdf.titles_by_language.${language} required`);
          }
        }
        for (const language of Object.keys(titles)) {
          if (!languages.includes(language)) {
            fail(`documents.credit_note_pdf.titles_by_language declares unknown correspondence language '${language}'`);
          }
        }
      }
    }
  }

  if (hasTemplate) {
    if (!isPlainObject(template)) {
      fail('documents.templates.credit_note_pdf must be an object keyed by correspondence language');
    } else {
      for (const language of languages) {
        const variant = template[language];
        if (!isPlainObject(variant)
          || !isNonEmptyString(variant.subject)
          || !isNonEmptyString(variant.body)) {
          fail(`documents.templates.credit_note_pdf.${language} must provide non-empty { subject, body }`);
          continue;
        }
        for (const key of Object.keys(variant)) {
          if (!['subject', 'body'].includes(key)) {
            fail(`documents.templates.credit_note_pdf.${language} declares unknown key '${key}'`);
          }
        }
        const subjectTokens = new Set(extractTokens(variant.subject));
        const allTokens = new Set([
          ...subjectTokens,
          ...extractTokens(variant.body)
        ]);
        for (const token of CREDIT_NOTE_PDF_SUBJECT_REQUIRED_TOKENS) {
          if (!subjectTokens.has(token)) {
            fail(`documents.templates.credit_note_pdf.${language}.subject must use {{${token}}}`);
          }
        }
        for (const token of CREDIT_NOTE_PDF_REQUIRED_TOKENS) {
          if (!allTokens.has(token)) {
            fail(`documents.templates.credit_note_pdf.${language} must use required token {{${token}}}`);
          }
        }
        for (const token of allTokens) {
          if (!CREDIT_NOTE_PDF_ALLOWED_TOKENS.includes(token)) {
            fail(`documents.templates.credit_note_pdf.${language} may not use {{${token}}}`);
          }
        }
      }
      for (const language of Object.keys(template)) {
        if (!languages.includes(language)) {
          fail(`documents.templates.credit_note_pdf declares unknown correspondence language '${language}'`);
        }
      }
    }
  }

  return { state: errors.length ? 'invalid' : 'valid', errors };
};

// ── Manifest validation ──────────────────────────────────────────────────────
// Returns { ok, errors: [string] }. Every FI-derived section is REQUIRED; the
// error strings name the missing shape so authoring pack #2 is mechanical.

export const validateOutboundPackManifest = (manifest) => {
  const errors = [];
  const fail = (msg) => errors.push(msg);

  if (!isPlainObject(manifest)) {
    return { ok: false, errors: ['manifest must be an object'] };
  }

  // pack — identity + version.
  const pack = manifest.pack;
  if (!isPlainObject(pack)) fail('pack section required ({ id, country, version })');
  else {
    if (!isNonEmptyString(pack.id) || !/^[a-z]{2}$/.test(pack.id)) {
      fail('pack.id must be a two-letter lowercase pack id');
    }
    if (!isNonEmptyString(pack.country) || !/^[A-Z]{2}$/.test(pack.country)) {
      fail('pack.country must be an ISO-3166-1 alpha-2 code');
    }
    if (!Number.isInteger(pack.version) || pack.version < 1) {
      fail('pack.version must be an integer >= 1');
    }
  }

  // currency — the pack's home currency. The pipeline never defaults one.
  if (!isPlainObject(manifest.currency) || !/^[A-Z]{3}$/.test(manifest.currency.home || '')) {
    fail('currency.home must be an ISO-4217 code (the pipeline has no currency default)');
  }

  // locale — number/date rendering locale. Data, never an Intl literal in code.
  const locale = manifest.locale;
  if (!isPlainObject(locale) || !isNonEmptyString(locale.number_locale)) {
    fail('locale.number_locale required (a BCP-47 locale tag)');
  } else if (!isBcp47LocaleTag(locale.number_locale)) {
    fail('locale.number_locale must be a valid BCP-47 locale tag');
  }
  if (!isPlainObject(locale) || !['dmy', 'mdy', 'ymd'].includes(locale.date_format)) {
    fail('locale.date_format must be one of dmy|mdy|ymd');
  }

  // languages — FI needs fi/sv/en; the schema requires the structure of many.
  const languages = manifest.languages;
  if (!isPlainObject(languages) || !isNonEmptyString(languages.default)
    || !Array.isArray(languages.supported) || languages.supported.length === 0
    || !languages.supported.every(isNonEmptyString)) {
    fail('languages.{default, supported[]} required');
  } else if (!languages.supported.includes(languages.default)) {
    fail('languages.default must be in languages.supported');
  }

  // reference — the reference-number scheme (FI: viitenumero mint+validate).
  const reference = manifest.reference;
  if (!isPlainObject(reference) || !KNOWN_REFERENCE_SCHEMES.includes(reference.scheme)) {
    fail(`reference.scheme must be one of ${KNOWN_REFERENCE_SCHEMES.join('|')} ('none' is declared, never omitted)`);
  }

  // einvoice — lane + operator state (FI: finvoice_email now, operator planned).
  const einvoice = manifest.einvoice;
  if (!isPlainObject(einvoice) || !KNOWN_EINVOICE_LANES.includes(einvoice.lane)) {
    fail(`einvoice.lane must be one of ${KNOWN_EINVOICE_LANES.join('|')}`);
  }
  if (!isPlainObject(einvoice) || !KNOWN_EINVOICE_OPERATOR_STATES.includes(einvoice.operator)) {
    fail(`einvoice.operator must be one of ${KNOWN_EINVOICE_OPERATOR_STATES.join('|')}`);
  }

  // tax — the vocabulary marker (consumed from taxVocabularies.js as-is; the
  // pack names it, core resolves it). null is allowed (a market whose
  // vocabulary predates the registry) but the KEY must be present.
  if (!isPlainObject(manifest.tax) || !('vocabulary' in manifest.tax)) {
    fail('tax.vocabulary required (a taxVocabularies.js marker string, or null)');
  } else if (manifest.tax.vocabulary !== null && !isNonEmptyString(manifest.tax.vocabulary)) {
    fail('tax.vocabulary must be null or a non-empty marker string');
  }

  // reconciliation — Donna's own materiality ceilings, in the pack's HOME
  // currency (currency.home). RT-11 / decision D2: the engine follows the pack;
  // env is the only override. Declared, never omitted — a market with no
  // ceiling would refuse every auto-match ('materiality_ceiling_unset') and
  // every unprompted auto_explain (the disposition guard fails closed on the
  // unset marker), which is a decision to write down, not a default to fall
  // into. Donna policy numbers (Kari, 2026-07-06: 500 on both sides), not
  // statutory ones — tune per market from the close.
  //   materiality_ceiling  — the auto-match Gate E line
  //                          (reconciliationLlmCore.getAutoMatchPolicy;
  //                          RECONCILIATION_AUTO_MATCH_MATERIALITY_CEILING overrides).
  //   disposition_ceiling  — the auto_explain line for the unprompted
  //                          disposition sweeps (dispositionMateriality.js;
  //                          DISPOSITION_MATERIALITY_CEILING overrides). RT-11b.
  const reconciliation = manifest.reconciliation;
  if (!isPlainObject(reconciliation)) {
    fail('reconciliation section required ({ materiality_ceiling, disposition_ceiling } in currency.home)');
  } else {
    if (!(Number.isFinite(reconciliation.materiality_ceiling) && reconciliation.materiality_ceiling > 0)) {
      fail('reconciliation.materiality_ceiling must be a positive number in currency.home');
    }
    if (!(Number.isFinite(reconciliation.disposition_ceiling) && reconciliation.disposition_ceiling > 0)) {
      fail('reconciliation.disposition_ceiling must be a positive number in currency.home');
    }
  }

  // payment_rails — at least one declared rail.
  const rails = manifest.payment_rails;
  if (!Array.isArray(rails) || rails.length === 0) {
    fail('payment_rails must declare at least one rail');
  } else {
    for (const rail of rails) {
      if (!isPlainObject(rail) || !KNOWN_PAYMENT_RAIL_KINDS.includes(rail.kind)) {
        fail(`payment_rails[].kind must be one of ${KNOWN_PAYMENT_RAIL_KINDS.join('|')}`);
        break;
      }
      // D4: a payment_link rail carries the localized payment-block fragment
      // the renderer substitutes for payment_instructions when a link exists.
      // Localization is data (A7) — the phrase never lives in pipeline code.
      if (rail.kind === 'payment_link') {
        const tmpl = rail.instructions_template;
        const corrLangs = isPlainObject(manifest.correspondence)
          && Array.isArray(manifest.correspondence.languages)
          ? manifest.correspondence.languages : [];
        if (!isPlainObject(tmpl)) {
          fail('payment_rails[kind=payment_link].instructions_template required ({ <language>: text } for every correspondence language)');
        } else {
          for (const lang of corrLangs) {
            if (!isNonEmptyString(tmpl[lang])) {
              fail(`payment_rails[kind=payment_link].instructions_template.${lang} required`);
            } else {
              for (const token of extractTokens(tmpl[lang])) {
                if (!KNOWN_TEMPLATE_TOKENS.includes(token)) {
                  fail(`payment_rails[kind=payment_link].instructions_template.${lang} uses unknown token {{${token}}}`);
                }
              }
            }
          }
        }
      }
    }
  }

  // correspondence — languages, tone, dunning cadence, escalation terminal,
  // statutory data with provenance.
  const corr = manifest.correspondence;
  if (!isPlainObject(corr)) {
    fail('correspondence section required');
  } else {
    if (!Array.isArray(corr.languages) || corr.languages.length === 0
      || !corr.languages.every(isNonEmptyString)) {
      fail('correspondence.languages[] required');
    } else if (isPlainObject(languages) && Array.isArray(languages.supported)
      && !corr.languages.every((l) => languages.supported.includes(l))) {
      fail('correspondence.languages must be a subset of languages.supported');
    }

    // AR-4D: a multilingual correspondence pack must say which locale each
    // template language uses. Book-wide `number_locale` remains the compact
    // contract for a single-language pack; silently reusing it for a second
    // language would make the template and its amounts/dates disagree.
    const correspondenceLanguages = Array.isArray(corr.languages)
      ? corr.languages.filter(isNonEmptyString) : [];
    const localeByLanguage = locale?.correspondence_locales;
    if (correspondenceLanguages.length > 1 && !isPlainObject(localeByLanguage)) {
      fail('locale.correspondence_locales required for a multilingual correspondence pack');
    }
    if (localeByLanguage !== undefined) {
      if (!isPlainObject(localeByLanguage)) {
        fail('locale.correspondence_locales must be an object keyed by correspondence language');
      } else {
        for (const language of correspondenceLanguages) {
          if (!isBcp47LocaleTag(localeByLanguage[language])) {
            fail(`locale.correspondence_locales.${language} must be a valid BCP-47 locale tag`);
          }
        }
        for (const language of Object.keys(localeByLanguage)) {
          if (!correspondenceLanguages.includes(language)) {
            fail(`locale.correspondence_locales.${language} has no matching correspondence language`);
          }
        }
      }
    }
    if (!isNonEmptyString(corr.tone)) fail('correspondence.tone required');

    // Dunning cadence: contiguous steps, strictly increasing day offsets, each
    // step naming a template that exists in every correspondence language.
    const cadence = corr.dunning_cadence;
    if (!Array.isArray(cadence) || cadence.length === 0) {
      fail('correspondence.dunning_cadence[] required');
    } else {
      let prevDays = -Infinity;
      cadence.forEach((entry, i) => {
        if (!isPlainObject(entry)) { fail(`dunning_cadence[${i}] must be an object`); return; }
        if (entry.step !== i + 1) fail(`dunning_cadence[${i}].step must be ${i + 1} (contiguous from 1)`);
        if (!Number.isInteger(entry.days_after_due) || entry.days_after_due < 0) {
          fail(`dunning_cadence[${i}].days_after_due must be a non-negative integer`);
        } else if (entry.days_after_due <= prevDays) {
          fail(`dunning_cadence[${i}].days_after_due must increase over the prior step`);
        } else {
          prevDays = entry.days_after_due;
        }
        if (!isNonEmptyString(entry.tone)) fail(`dunning_cadence[${i}].tone required`);
        if (!isNonEmptyString(entry.template)) fail(`dunning_cadence[${i}].template required`);
      });
    }

    // Escalation terminal: cadence exhaustion must land on the owner
    // (two-terminal-states; the enum is closed at 'owner' by doctrine).
    const esc = corr.escalation;
    if (!isPlainObject(esc) || !KNOWN_ESCALATION_TARGETS.includes(esc.to)) {
      fail(`correspondence.escalation.to must be one of ${KNOWN_ESCALATION_TARGETS.join('|')}`);
    } else if (Array.isArray(corr.dunning_cadence)
      && esc.after_step !== corr.dunning_cadence.length) {
      fail('correspondence.escalation.after_step must equal the final cadence step');
    }

    // Quote follow-up cadence (M2): declared absence is an EMPTY ARRAY, never
    // a missing key. Entries mirror dunning_cadence, offset from the quote's
    // send date. Follow-up N rides the send_quote action at cadence step N+1.
    const quoteCadence = corr.quote_follow_up_cadence;
    if (!Array.isArray(quoteCadence)) {
      fail('correspondence.quote_follow_up_cadence[] required (may be empty — declared absence, never a missing key)');
    } else {
      let prevDays = -Infinity;
      quoteCadence.forEach((entry, i) => {
        if (!isPlainObject(entry)) { fail(`quote_follow_up_cadence[${i}] must be an object`); return; }
        if (entry.step !== i + 1) fail(`quote_follow_up_cadence[${i}].step must be ${i + 1} (contiguous from 1)`);
        if (!Number.isInteger(entry.days_after_sent) || entry.days_after_sent <= 0) {
          fail(`quote_follow_up_cadence[${i}].days_after_sent must be a positive integer`);
        } else if (entry.days_after_sent <= prevDays) {
          fail(`quote_follow_up_cadence[${i}].days_after_sent must increase over the prior step`);
        } else {
          prevDays = entry.days_after_sent;
        }
        if (!isNonEmptyString(entry.tone)) fail(`quote_follow_up_cadence[${i}].tone required`);
        if (!isNonEmptyString(entry.template)) fail(`quote_follow_up_cadence[${i}].template required`);
      });
    }

    // Statutory correspondence data (D5): null is honest absence; a non-null
    // entry REQUIRES provenance (source + jurisdiction + as_of) before any
    // reminder may state an interest amount.
    const statutory = corr.statutory;
    if (!isPlainObject(statutory) || !('late_interest' in statutory)) {
      fail('correspondence.statutory.late_interest required (null, or a provenanced entry)');
    } else if (statutory.late_interest !== null) {
      const li = statutory.late_interest;
      if (!isPlainObject(li) || !isNonEmptyString(li.source)
        || !isNonEmptyString(li.jurisdiction) || !isNonEmptyString(li.as_of)) {
        fail('statutory.late_interest requires provenance: { source, jurisdiction, as_of, ... } (D5 — statutory numbers need provenance)');
      } else if (!KNOWN_LATE_INTEREST_BASES.includes(li.basis)) {
        // gap 5: the schema models the shape it accepts. Without this the GB
        // pack's fixed_compensation was an unchecked key the validator never
        // knew about.
        fail(`statutory.late_interest.basis must be one of ${KNOWN_LATE_INTEREST_BASES.join('|')}`);
      } else {
        for (const slot of LATE_INTEREST_REQUIRED_SLOTS[li.basis]) {
          if (!(slot in li)) {
            fail(`statutory.late_interest.${slot} required by basis '${li.basis}' (null is the honest "not recorded from primary source yet"; a MISSING key is a schema error)`);
          } else if (li[slot] !== null && !(typeof li[slot] === 'number' && Number.isFinite(li[slot]))) {
            fail(`statutory.late_interest.${slot} must be a number or null (D5 — never a remembered or computed value)`);
          }
        }
      }
    }
    if (isPlainObject(statutory) && !Array.isArray(statutory.constraints)) {
      fail('correspondence.statutory.constraints[] required (may be empty)');
    }
  }

  // documents — mandatory-field lists + templates keyed template → language.
  const documents = manifest.documents;
  if (!isPlainObject(documents) || !isPlainObject(documents.mandatory_fields)
    || !Array.isArray(documents.mandatory_fields.invoice)
    || documents.mandatory_fields.invoice.length === 0) {
    fail('documents.mandatory_fields.invoice[] required');
  } else {
    // Refuse an unresolvable field HERE, at load — the same discipline the
    // template tokens get. Otherwise the pack loads clean and every invoice
    // refuses at build time with no pointer back to the manifest.
    for (const field of documents.mandatory_fields.invoice) {
      if (!KNOWN_INVOICE_MANDATORY_FIELDS.includes(field)) {
        fail(`documents.mandatory_fields.invoice declares unknown field '${field}' (core cannot resolve it; widen KNOWN_INVOICE_MANDATORY_FIELDS and issuance.js's fieldValues together)`);
      }
    }

    // gap 9 — the two optional conditional lists. Same closed vocabulary, same
    // refuse-at-LOAD discipline.
    const base = documents.mandatory_fields.invoice;
    for (const key of KNOWN_CONDITIONAL_INVOICE_FIELD_KEYS) {
      const list = documents.mandatory_fields[key];
      if (list === undefined) continue;
      if (!Array.isArray(list)) {
        fail(`documents.mandatory_fields.${key} must be an array when present`);
        continue;
      }
      for (const field of list) {
        if (!KNOWN_INVOICE_MANDATORY_FIELDS.includes(field)) {
          fail(`documents.mandatory_fields.${key} declares unknown field '${field}' (core cannot resolve it; widen KNOWN_INVOICE_MANDATORY_FIELDS and issuance.js's fieldValues together)`);
        }
      }
    }

    // A field that is unconditionally required cannot ALSO be conditional —
    // both combinations are declaration errors, and the second is the exact
    // mistake this leg exists to catch (leaving seller_tax_registration_id in
    // the base floor while forbidding it for a non-registered seller is a
    // contract that can never be satisfied).
    for (const field of documents.mandatory_fields.invoice_when_tax_registered || []) {
      if (base.includes(field)) {
        fail(`documents.mandatory_fields.invoice_when_tax_registered declares '${field}', which is already unconditionally required in invoice[] — a field cannot be both`);
      }
    }
    for (const field of documents.mandatory_fields.invoice_forbidden_when_not_tax_registered || []) {
      if (base.includes(field)) {
        fail(`documents.mandatory_fields.invoice_forbidden_when_not_tax_registered declares '${field}', which is unconditionally required in invoice[] — that contract can never be satisfied`);
      }
    }
    const buyerFields = documents.mandatory_fields.invoice_when_buyer_tax_registered;
    if (buyerFields !== undefined) {
      const contract = documents.buyer_tax_registration;
      if (!isPlainObject(contract) || !/^[a-z]{2}$/.test(contract.jurisdiction || '')
        || contract.jurisdiction !== String(manifest.pack?.country || '').toLowerCase()
        || !isNonEmptyString(contract.registration_id_pattern)
        || !contract.registration_id_pattern.startsWith('^') || !contract.registration_id_pattern.endsWith('$')) {
        fail('documents.buyer_tax_registration requires the pack jurisdiction and an anchored registration_id_pattern');
      } else {
        try { new RegExp(contract.registration_id_pattern); } catch { fail('invalid buyer registration_id_pattern'); }
      }
      if (!(documents.mandatory_fields.invoice_when_tax_registered || []).length) {
        fail('buyer conditional floor requires a seller tax-registration floor');
      }
      if (Array.isArray(buyerFields)) for (const field of buyerFields) {
        if (base.includes(field) || (documents.mandatory_fields.invoice_forbidden_when_not_tax_registered || []).includes(field)) {
          fail(`buyer conditional field '${field}' conflicts with another invoice floor`);
        }
      }
    } else if (documents.buyer_tax_registration !== undefined) {
      fail('buyer_tax_registration requires invoice_when_buyer_tax_registered');
    }
  }
  // Quote numbering is pack DATA (FI: the 'T' tarjous prefix; US: 'Q') — the
  // pipeline never invents a display convention.
  if (!isPlainObject(documents) || !isNonEmptyString(documents.quote_number_prefix)) {
    fail('documents.quote_number_prefix required (the display prefix that keeps a quote number unmistakably not an invoice number)');
  }
  // The invoice-PDF artifact's physical page is pack data (never a core
  // default — either size literal in core would be shape creep).
  if (!isPlainObject(documents) || !isPlainObject(documents.invoice_pdf)
    || !KNOWN_PDF_PAGE_SIZES.includes(documents.invoice_pdf.page)) {
    fail(`documents.invoice_pdf.page must be one of ${KNOWN_PDF_PAGE_SIZES.join('|')}`);
  }
  // The quote-PDF artifact's page is its own declaration (a quote is not an
  // invoice; sharing the invoice_pdf key would smuggle a default).
  if (!isPlainObject(documents) || !isPlainObject(documents.quote_pdf)
    || !KNOWN_PDF_PAGE_SIZES.includes(documents.quote_pdf.page)) {
    fail(`documents.quote_pdf.page must be one of ${KNOWN_PDF_PAGE_SIZES.join('|')}`);
  }
  if (!isPlainObject(documents) || !isPlainObject(documents.templates)) {
    fail('documents.templates required');
  } else {
    const corrLangs = isPlainObject(manifest.correspondence)
      && Array.isArray(manifest.correspondence.languages)
      ? manifest.correspondence.languages : [];
    const creditNoteContract = creditNotePdfContractVerdict(manifest);
    for (const error of creditNoteContract.errors) fail(error);
    if (documents.invoice_statutory_labels !== undefined) {
      const labels = documents.invoice_statutory_labels;
      if (!isPlainObject(labels)) fail('documents.invoice_statutory_labels must be a language catalog');
      for (const lang of corrLangs) {
        for (const key of INVOICE_STATUTORY_LABEL_KEYS) {
          if (!isNonEmptyString(labels?.[lang]?.[key]) || extractTokens(labels?.[lang]?.[key]).length) {
            fail(`documents.invoice_statutory_labels.${lang}.${key} must be a non-empty literal label`);
          }
        }
      }
      if (!(documents.mandatory_fields?.invoice_when_buyer_tax_registered || []).length) {
        fail('invoice_statutory_labels requires the buyer registration floor');
      }
    }
    // Every referenced/required template must exist with { subject, body } in
    // every correspondence language, written natively — never a fallback
    // translation. Required set = the dunning cadence's templates + the quote
    // follow-up cadence's templates + the issuance templates (M2).
    const required = new Map();
    if (isPlainObject(manifest.correspondence)) {
      for (const entry of Array.isArray(manifest.correspondence.dunning_cadence)
        ? manifest.correspondence.dunning_cadence : []) {
        if (isPlainObject(entry) && isNonEmptyString(entry.template)) {
          required.set(entry.template, `dunning_cadence step ${entry.step}`);
        }
      }
      for (const entry of Array.isArray(manifest.correspondence.quote_follow_up_cadence)
        ? manifest.correspondence.quote_follow_up_cadence : []) {
        if (isPlainObject(entry) && isNonEmptyString(entry.template)) {
          required.set(entry.template, `quote_follow_up_cadence step ${entry.step}`);
        }
      }
    }
    for (const name of REQUIRED_ISSUANCE_TEMPLATES) required.set(name, 'issuance (M2)');
    for (const name of REQUIRED_PAYABLE_TEMPLATES) required.set(name, 'payables (M4)');
    for (const [name, referencedBy] of required) {
      const template = documents.templates[name];
      if (!isPlainObject(template)) {
        fail(`documents.templates.${name} missing (required by ${referencedBy})`);
        continue;
      }
      for (const lang of corrLangs) {
        const variant = template[lang];
        if (!isPlainObject(variant) || !isNonEmptyString(variant.subject) || !isNonEmptyString(variant.body)) {
          fail(`documents.templates.${name}.${lang} must provide { subject, body } (every correspondence language, written natively — never a fallback translation)`);
        }
      }
    }
    // Token discipline covers EVERY template variant present (not only the
    // referenced ones): an unknown token refuses at load, never at send.
    const templatesUsingDocumentTitle = new Set();
    for (const [name, template] of Object.entries(documents.templates)) {
      if (!isPlainObject(template)) continue;
      for (const [lang, variant] of Object.entries(template)) {
        if (!isPlainObject(variant)) continue;
        for (const token of [...extractTokens(variant.subject), ...extractTokens(variant.body)]) {
          if (!KNOWN_TEMPLATE_TOKENS.includes(token)) {
            fail(`documents.templates.${name}.${lang} uses unknown token {{${token}}}`);
          }
          if (CREDIT_NOTE_PDF_ONLY_TOKENS.has(token) && name !== 'credit_note_pdf') {
            fail(`documents.templates.${name}.${lang} uses CreditNote-only token {{${token}}}`);
          }
          if (INVOICE_STATUTORY_TOKENS.includes(token)) {
            if (!INVOICE_DISPLAY_TEMPLATES.has(name)) {
              fail(`documents.templates.${name}.${lang} uses invoice-only token {{${token}}}`);
            }
            if (!documents.invoice_statutory_labels) {
              fail(`documents.templates.${name}.${lang} uses {{${token}}} without invoice_statutory_labels`);
            }
          }
          if (token === 'document_title') {
            if (name !== 'credit_note_pdf') templatesUsingDocumentTitle.add(name);
            // The mint supplies the value only on the invoice issuance path;
            // anywhere else the fail-closed renderer would block every send.
            if (!DOCUMENT_TITLE_TEMPLATES.includes(name)) {
              fail(`documents.templates.${name}.${lang} uses {{document_title}}, which is allowed only in ${DOCUMENT_TITLE_TEMPLATES.join('/')}`);
            }
          }
        }
      }
    }

    // gap 11 / AR-4C — the statutory document title ('Tax Invoice' on a UAE
    // tax invoice), conditional on the seller's registration limb like the
    // gap-9 floor it rides on. Optional; a market with no such requirement
    // (FI, GB, US) never declares it.
    //
    // `statutory_titles` is the original single-language contract and stays
    // valid only while the pack has exactly one correspondence language. The
    // parallel `statutory_titles_by_language` table is the additive AR-4C
    // contract: every correspondence language owns BOTH registration limbs.
    // Keeping the old one-language declaration valid preserves the shipping
    // AE manifest byte-for-byte until `ar` is deliberately declared; a future
    // multilingual pack cannot accidentally reuse its English title.
    const titles = documents.statutory_titles;
    const titlesByLanguage = documents.statutory_titles_by_language;
    const hasLegacyTitles = titles !== undefined;
    const hasLanguageTitles = titlesByLanguage !== undefined;
    if (hasLegacyTitles || hasLanguageTitles) {
      if (hasLegacyTitles && hasLanguageTitles) {
        fail('documents must declare exactly one of statutory_titles or statutory_titles_by_language');
      }
      if (hasLegacyTitles) {
        if (!isPlainObject(titles)) {
          fail('documents.statutory_titles must be an object when present ({ invoice_when_tax_registered, invoice_otherwise })');
        } else {
          for (const key of ['invoice_when_tax_registered', 'invoice_otherwise']) {
            if (!isNonEmptyString(titles[key])) {
              fail(`documents.statutory_titles.${key} required (both limbs — the renderer needs a title whichever limb applies)`);
            }
          }
          for (const key of Object.keys(titles)) {
            if (!['invoice_when_tax_registered', 'invoice_otherwise', 'note'].includes(key)) {
              fail(`documents.statutory_titles declares unknown key '${key}'`);
            }
          }
          if (corrLangs.length > 1) {
            fail('documents.statutory_titles is single-language; multilingual correspondence requires statutory_titles_by_language');
          }
        }
      } else if (!isPlainObject(titlesByLanguage)) {
        fail('documents.statutory_titles_by_language must be an object keyed by correspondence language');
      } else {
        for (const lang of corrLangs) {
          const languageTitles = titlesByLanguage[lang];
          if (!isPlainObject(languageTitles)) {
            fail(`documents.statutory_titles_by_language.${lang} required (every correspondence language needs both title limbs)`);
            continue;
          }
          for (const key of ['invoice_when_tax_registered', 'invoice_otherwise']) {
            if (!isNonEmptyString(languageTitles[key])) {
              fail(`documents.statutory_titles_by_language.${lang}.${key} required`);
            }
          }
          for (const key of Object.keys(languageTitles)) {
            if (!['invoice_when_tax_registered', 'invoice_otherwise'].includes(key)) {
              fail(`documents.statutory_titles_by_language.${lang} declares unknown key '${key}'`);
            }
          }
        }
        for (const lang of Object.keys(titlesByLanguage)) {
          if (!corrLangs.includes(lang)) {
            fail(`documents.statutory_titles_by_language declares unknown correspondence language '${lang}'`);
          }
        }
      }
      if ((hasLegacyTitles && isPlainObject(titles))
        || (hasLanguageTitles && isPlainObject(titlesByLanguage))) {
        // Selecting a limb requires seller.taxRegistered resolved true/false,
        // which only a conditional-floor pack guarantees at build (gap 9's
        // fail-closed refusal on unknown). A title with no floor would resolve
        // against a status nothing established.
        const mandatoryFields = isPlainObject(documents.mandatory_fields) ? documents.mandatory_fields : {};
        const hasConditionalFloor = (mandatoryFields.invoice_when_tax_registered || []).length > 0
          || (mandatoryFields.invoice_forbidden_when_not_tax_registered || []).length > 0;
        if (!hasConditionalFloor) {
          fail('a statutory title declaration requires a tax-registration-conditional invoice floor (gap 9) — the title limb is selected by the same resolved status');
        }
        // A declared title nothing renders is a lie: the statutory document
        // (the invoice PDF) must carry the token in every correspondence
        // language.
        const corrLangsForTitle = isPlainObject(manifest.correspondence)
          && Array.isArray(manifest.correspondence.languages)
          ? manifest.correspondence.languages : [];
        for (const lang of corrLangsForTitle) {
          const variant = documents.templates?.invoice_pdf?.[lang];
          const tokens = isPlainObject(variant)
            ? [...extractTokens(variant.subject), ...extractTokens(variant.body)] : [];
          if (!tokens.includes('document_title')) {
            fail(`a statutory title is declared but documents.templates.invoice_pdf.${lang} does not use {{document_title}} — a declared statutory title must actually render on the document`);
          }
        }
      }
    } else if (templatesUsingDocumentTitle.size > 0) {
      // The inverse lie: a template consuming a value no declaration supplies
      // would fail-closed at send on every invoice. Refuse at LOAD.
      fail(`documents.templates.${[...templatesUsingDocumentTitle].join('/')} uses {{document_title}} but no statutory title declaration exists — the mint would never supply the value`);
    }
  }

  // chart_of_accounts — the fallback coding vocabulary for a client with no
  // synced chart. REQUIRED: a pack that cannot say what its market's accounts
  // are leaves its clients on another market's list, which is the live
  // wrongness this leg exists to end.
  const coa = manifest.chart_of_accounts;
  if (!isPlainObject(coa) || !Array.isArray(coa.fallback_accounts) || coa.fallback_accounts.length === 0) {
    fail('chart_of_accounts.fallback_accounts[] required (the coding menu for a client with no synced chart — never another market\'s list)');
  } else {
    const seenNames = new Set();
    let suspenseCount = 0;
    let salesTaxCount = 0;
    for (const [i, account] of coa.fallback_accounts.entries()) {
      if (!isPlainObject(account)) { fail(`chart_of_accounts.fallback_accounts[${i}] must be an object`); continue; }
      if (!isNonEmptyString(account.name)) {
        fail(`chart_of_accounts.fallback_accounts[${i}].name required`);
      } else {
        const key = account.name.trim().toLowerCase();
        if (seenNames.has(key)) {
          fail(`chart_of_accounts.fallback_accounts[${i}].name '${account.name}' is declared twice`);
        }
        seenNames.add(key);
      }
      // The role is the identity; refuse an unknown one at LOAD rather than
      // let a role-less account reach a posting path that resolves by role.
      if (!isAccountRole(account.role)) {
        fail(`chart_of_accounts.fallback_accounts[${i}].role '${account.role}' is not a canonical account role (accountRoles.js ACCOUNT_ROLES)`);
      } else if (account.role === SUSPENSE_ACCOUNT_ROLE) {
        suspenseCount += 1;
      } else if (account.role === SALES_TAX_ACCOUNT_ROLE) {
        salesTaxCount += 1;
      }
    }
    if (suspenseCount !== 1) {
      fail(`chart_of_accounts.fallback_accounts must declare exactly one ${SUSPENSE_ACCOUNT_ROLE} account (the unknown-line terminal), found ${suspenseCount}`);
    }
    // AT MOST one (gap 10) — not exactly one, because a market with no
    // consumption tax legitimately declares none (the US: sales tax is
    // state-level and never a recoverable control account). The refusal that
    // matters is the SECOND: the sales-tax control leg resolves by this role at
    // post time, and two candidates would surface as a runtime AMBIGUOUS
    // refusal on a real invoice instead of a load-time one on a manifest.
    if (salesTaxCount > 1) {
      fail(`chart_of_accounts.fallback_accounts may declare at most one ${SALES_TAX_ACCOUNT_ROLE} account (the consumption-tax control leg resolves by this role), found ${salesTaxCount}`);
    }
  }

  if (isPlainObject(coa) && Object.hasOwn(coa, 'native_chart')) {
    for (const error of validateNativeChart(coa.native_chart).errors) fail(error);
  }

  // obligations — the statutory duties that generate work on their own clock.
  // REQUIRED as a section; `items: []` is a declared value, never a missing
  // key, and `survey` says whether that emptiness was established or merely
  // never looked at.
  const obligations = manifest.obligations;
  if (!isPlainObject(obligations)) {
    fail('obligations section required ({ survey, as_of, items[] } — an unsurveyed market declares survey: not_surveyed, never omits the section)');
  } else {
    if (!KNOWN_OBLIGATION_SURVEY_STATES.includes(obligations.survey)) {
      fail(`obligations.survey must be one of ${KNOWN_OBLIGATION_SURVEY_STATES.join('|')}`);
    }
    if (!Array.isArray(obligations.items)) {
      fail('obligations.items[] required (may be empty — declared absence, never a missing key)');
    }
    // A surveyed pack states WHEN it was surveyed; an unsurveyed one has
    // nothing to date and must not carry items (an item is evidence somebody
    // looked, which contradicts the claim).
    if (obligations.survey === 'surveyed' && !ISO_DATE_RE.test(String(obligations.as_of || ''))) {
      fail('obligations.as_of required as YYYY-MM-DD when survey is surveyed (when the enumeration was made)');
    }
    if (obligations.survey === 'not_surveyed'
      && Array.isArray(obligations.items) && obligations.items.length > 0) {
      fail('obligations.survey is not_surveyed but items[] is non-empty — declare survey: surveyed and date it');
    }
    const seenIds = new Set();
    for (const [i, item] of (Array.isArray(obligations.items) ? obligations.items : []).entries()) {
      if (!isPlainObject(item)) { fail(`obligations.items[${i}] must be an object`); continue; }
      if (!isNonEmptyString(item.id) || !/^[a-z][a-z0-9_]*$/.test(item.id)) {
        fail(`obligations.items[${i}].id must be a lower_snake_case identifier`);
      } else if (seenIds.has(item.id)) {
        fail(`obligations.items[${i}].id '${item.id}' is declared twice`);
      } else {
        seenIds.add(item.id);
      }
      if (!isNonEmptyString(item.name)) fail(`obligations.items[${i}].name required`);
      // Provenance is required on the same D5 footing as a statutory interest
      // rate: a duty Donna acts on must name the authority that imposes it,
      // the instrument, and the date that reading was taken.
      if (!isNonEmptyString(item.authority)) {
        fail(`obligations.items[${i}].authority required (the body that imposes the duty)`);
      }
      if (!isNonEmptyString(item.source)) {
        fail(`obligations.items[${i}].source required (the instrument imposing the duty)`);
      }
      if (!ISO_DATE_RE.test(String(item.as_of || ''))) {
        fail(`obligations.items[${i}].as_of required as YYYY-MM-DD (D5 — a statutory rule carries the date it was read)`);
      }
      if (!KNOWN_OBLIGATION_STATUSES.includes(item.status)) {
        fail(`obligations.items[${i}].status must be one of ${KNOWN_OBLIGATION_STATUSES.join('|')}`);
      }
      if (!('binding' in item)) {
        fail(`obligations.items[${i}].binding required (a KNOWN_OBLIGATION_BINDINGS name, or null when status is declared_unbuilt)`);
      } else if (item.status === 'bound') {
        // Refuse at LOAD, not at sweep — the KNOWN_INVOICE_MANDATORY_FIELDS
        // lesson: a pack that loads clean and then silently skips a statutory
        // duty is worse than one that refuses to load.
        if (!KNOWN_OBLIGATION_BINDINGS.includes(item.binding)) {
          fail(`obligations.items[${i}].binding '${item.binding}' is not a known binding (widen KNOWN_OBLIGATION_BINDINGS and STATUTORY_OBLIGATION_BINDINGS together)`);
        }
      } else if (item.status === 'declared_unbuilt' && item.binding !== null) {
        fail(`obligations.items[${i}].binding must be null when status is declared_unbuilt (an unbuilt duty binds to nothing, explicitly)`);
      }
    }
  }

  // platforms — the accounting systems this market's clients can be connected
  // to. Validated against the adapter registry's ids so a typo or an
  // unimplemented connector refuses at LOAD rather than resolving silently to
  // the default adapter (gap 4: this field used to be read by nothing at all).
  if (!Array.isArray(manifest.platforms) || !manifest.platforms.every(isNonEmptyString)) {
    fail('platforms[] required (may be empty of live bindings, never absent)');
  } else {
    for (const platform of manifest.platforms) {
      if (!KNOWN_PACK_PLATFORMS.includes(platform)) {
        fail(`platforms[] declares '${platform}', which is not an accounting-system adapter id (${KNOWN_PACK_PLATFORMS.join('|')})`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
};

// ── Loader ───────────────────────────────────────────────────────────────────

const packCache = new Map();

export const discoverOutboundPacks = ({ packsRoot = PACKS_ROOT } = {}) => {
  const { registrations, unavailable } = discoverCountryCapabilities('outbound', { packsRoot });
  return {
    packIds: registrations.map((entry) => entry.jurisdiction),
    unloadable: unavailable.map((error) => ({ packId: error.jurisdiction, code: error.code, error: error.message }))
  };
};

export const listAvailablePackIds = ({ packsRoot = PACKS_ROOT } = {}) => {
  const { registrations, unavailable } = discoverCountryCapabilities('outbound', { packsRoot });
  if (unavailable.length) throw unavailable[0];
  return registrations.map((entry) => entry.jurisdiction);
};

// Load + validate a pack. Throws on a missing or invalid manifest — a pack
// that fails its schema must never reach the pipeline half-formed.
export const loadOutboundPack = (packId, { packsRoot = PACKS_ROOT, bypassCache = false } = {}) => {
  const id = String(packId || '').toLowerCase();
  if (!/^[a-z]{2}$/.test(id)) throw new Error(`invalid pack id '${packId}'`);
  const registration = resolveCountryCapability({ jurisdiction: id, operation: 'outbound' }, { packsRoot });
  if (!registration) throw new CountryCapabilityError('country_capability_unsupported', {
    operation: 'outbound', jurisdiction: id, reason: 'outbound_not_registered'
  });
  const cacheKey = `${packsRoot}:${id}`;
  if (!bypassCache && packCache.has(cacheKey)) return packCache.get(cacheKey);

  const manifestPath = registration.manifestPath;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`outbound pack '${id}' unreadable at ${manifestPath}: ${error?.message || error}`);
  }
  const verdict = validateOutboundPackManifest(manifest);
  if (!verdict.ok) {
    throw new Error(`outbound pack '${id}' invalid: ${verdict.errors.join('; ')}`);
  }
  if (manifest.pack.id !== id) {
    throw new Error(`outbound pack '${id}' manifest declares pack.id '${manifest.pack.id}'`);
  }
  packCache.set(cacheKey, manifest);
  return manifest;
};

// Client jurisdiction → pack id, resolved against the packs actually present.
// No default: a jurisdiction without an authored pack returns null and the
// caller refuses (fail-closed — the pipeline never invents a country's norms).
export const resolvePackIdForJurisdiction = (jurisdiction, { packsRoot = PACKS_ROOT } = {}) => {
  const id = String(jurisdiction || '').trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(id)) return null;
  return resolveCountryCapability({ jurisdiction: id, operation: 'outbound' }, { packsRoot })?.jurisdiction || null;
};

// ── Pack readers the pipeline consumes ───────────────────────────────────────

// The pack's home (book/ledger) currency for a jurisdiction, or null when no
// pack is authored — the caller keeps its legacy default rather than this
// module inventing a country's currency (fail-closed, same posture as pack
// resolution). Accepts raw stored values ('UK', 'gb') via the canonical
// jurisdiction alias.
export const homeCurrencyForJurisdiction = (jurisdiction, { packsRoot } = {}) => {
  const loadOpts = packsRoot === undefined ? {} : { packsRoot };
  const key = normalizeJurisdictionKey(jurisdiction);
  try {
    const packId = resolvePackIdForJurisdiction(key || jurisdiction, loadOpts);
    if (!packId) return null;
    return loadOutboundPack(packId, loadOpts)?.currency?.home || null;
  } catch {
    return null;
  }
};

// RT-11 / D2 — the pack's materiality ceiling for the auto-match Gate E, in
// its home currency. Null when no pack is authored for the jurisdiction (the
// caller — getAutoMatchPolicy — then has no ceiling and Gate E fails closed
// with 'materiality_ceiling_unset', the F1 semantics), never an invented
// number. Accepts raw stored values ('UK', 'gb') via the canonical alias.
export const materialityCeilingForPack = (pack) => {
  const n = Number(pack?.reconciliation?.materiality_ceiling);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// One resolver for both reconciliation ceilings: jurisdiction → pack →
// { pack_id, ceiling, currency }, or null when no pack is authored / the pack
// declares nothing usable (the caller's guard then fails closed, F1).
const reconciliationCeilingForJurisdiction = (jurisdiction, readCeiling, { packsRoot } = {}) => {
  const loadOpts = packsRoot === undefined ? {} : { packsRoot };
  const key = normalizeJurisdictionKey(jurisdiction);
  try {
    const packId = resolvePackIdForJurisdiction(key || jurisdiction, loadOpts);
    if (!packId) return null;
    const pack = loadOutboundPack(packId, loadOpts);
    const ceiling = readCeiling(pack);
    if (ceiling == null) return null;
    return { pack_id: packId, ceiling, currency: pack?.currency?.home || null };
  } catch {
    return null;
  }
};

export const materialityCeilingForJurisdiction = (jurisdiction, opts = {}) =>
  reconciliationCeilingForJurisdiction(jurisdiction, materialityCeilingForPack, opts);

// RT-11b — the pack's disposition ceiling (the unprompted auto_explain line,
// dispositionMateriality.js), in its home currency. Same posture as the
// materiality ceiling: null when nothing is declared, never an invented number.
export const dispositionCeilingForPack = (pack) => {
  const n = Number(pack?.reconciliation?.disposition_ceiling);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export const dispositionCeilingForJurisdiction = (jurisdiction, opts = {}) =>
  reconciliationCeilingForJurisdiction(jurisdiction, dispositionCeilingForPack, opts);

// Normalized dunning cadence for the scheduler (M0.5): the generalization of
// askReaskCadence's nudge/escalate mechanic into pack-supplied data.
export const dunningCadenceForPack = (pack) => {
  const cadence = pack?.correspondence?.dunning_cadence || [];
  return cadence.map((entry) => ({
    step: entry.step,
    daysAfterDue: entry.days_after_due,
    tone: entry.tone,
    template: entry.template
  }));
};

export const escalationForPack = (pack) => ({
  afterStep: pack?.correspondence?.escalation?.after_step ?? null,
  to: pack?.correspondence?.escalation?.to ?? null
});

// Quote follow-up cadence (M2): follow-up N rides the send_quote action at
// cadence step N+1 (step 1 is the send itself); offsets count from the
// quote's SEND date.
export const quoteFollowUpCadenceForPack = (pack) => {
  const cadence = pack?.correspondence?.quote_follow_up_cadence || [];
  return cadence.map((entry) => ({
    step: entry.step,
    daysAfterSent: entry.days_after_sent,
    tone: entry.tone,
    template: entry.template
  }));
};

export const quoteNumberPrefixForPack = (pack) =>
  pack?.documents?.quote_number_prefix ?? null;

// gap 4: the accounting systems this pack's market offers. Empty means the
// market has no connector binding yet — a fact, not a gap in the pack.
export const platformsForPack = (pack) =>
  Array.isArray(pack?.platforms) ? [...pack.platforms] : [];

// Is `accountingSystem` a connector this jurisdiction's clients can use?
//
// Returns a VERDICT, not a boolean, because "we cannot decide" and "no, that
// system is not offered here" are different answers and only the second should
// ever refuse anything. `undecidable` is the honest reply for a jurisdiction
// with no authored pack — the same posture taxCodeJurisdiction takes when it
// cannot decide a code's validity, rather than validating against a foreign
// country's list.
//
// 'none' (the client-level "no connector") is always allowed: declining to
// connect a system is not a market question.
export const accountingSystemAvailability = ({ jurisdiction, accountingSystem, packsRoot } = {}) => {
  const system = String(accountingSystem || '').trim().toLowerCase();
  if (!system || system === 'none') return { verdict: 'allowed', reason: 'no_connector' };
  const loadOpts = packsRoot === undefined ? {} : { packsRoot };
  let packId;
  let platforms;
  try {
    packId = resolvePackIdForJurisdiction(jurisdiction, loadOpts);
    if (!packId) return { verdict: 'undecidable', reason: 'no_pack_for_jurisdiction' };
    platforms = platformsForPack(loadOutboundPack(packId, loadOpts));
  } catch {
    return { verdict: 'undecidable', reason: 'pack_unloadable' };
  }
  if (!platforms.length) return { verdict: 'undecidable', reason: 'pack_declares_no_platforms' };
  return platforms.includes(system)
    ? { verdict: 'allowed', reason: 'declared_by_pack', packId }
    : { verdict: 'not_offered', reason: 'absent_from_pack_platforms', packId, platforms };
};

// The pack's fallback coding vocabulary, normalized. Every entry carries its
// canonical role — display name is a view, role is the identity.
export const fallbackAccountsForPack = (pack) =>
  (pack?.chart_of_accounts?.fallback_accounts || [])
    .map((account) => ({ name: account.name, role: account.role }));

// Just the display names, in declaration order — the shape the coder's schema
// enum wants.
export const fallbackAccountNamesForPack = (pack) =>
  fallbackAccountsForPack(pack).map((account) => account.name);

// The pack's unknown-line terminal by NAME (validated present exactly once at
// load). Callers that must name it — the coding menu guarantees it is offered
// even under a truncated synced chart — read it from here rather than assuming
// a literal.
export const suspenseAccountNameForPack = (pack) =>
  fallbackAccountsForPack(pack).find((a) => a.role === SUSPENSE_ACCOUNT_ROLE)?.name ?? null;

// The pack's statutory obligations, normalized for the sweep. Provenance
// travels WITH the obligation into the run receipt — an obligation Donna acts
// on names the authority and instrument behind it wherever it surfaces.
export const statutoryObligationsForPack = (pack) =>
  (pack?.obligations?.items || []).map((item) => ({
    id: item.id,
    name: item.name,
    authority: item.authority,
    source: item.source,
    asOf: item.as_of,
    status: item.status,
    binding: item.binding ?? null,
    note: item.note ?? null
  }));

// Whether this pack's obligations have been enumerated at all, and when.
export const obligationSurveyForPack = (pack) => ({
  survey: pack?.obligations?.survey ?? null,
  asOf: pack?.obligations?.as_of ?? null
});

// The invoice-PDF artifact's page size (validated at load against
// KNOWN_PDF_PAGE_SIZES; no core default — see the validator).
export const invoicePdfPageForPack = (pack) =>
  pack?.documents?.invoice_pdf?.page ?? null;

// The quote-PDF artifact's page size — its own pack declaration, same
// closed vocabulary, same no-core-default posture.
export const quotePdfPageForPack = (pack) =>
  pack?.documents?.quote_pdf?.page ?? null;

// AR-4B3's optional CreditNote contract has no fallback. Public readers repeat
// the complete paired-contract guard so hand-built or post-load mutated packs
// cannot bypass the load-time validator.
export const creditNotePdfPageForPack = (pack) => {
  const verdict = creditNotePdfContractVerdict(pack);
  if (verdict.state === 'absent') {
    throw creditNoteContractError(
      'OUTBOUND_CREDIT_NOTE_PDF_CONTRACT_ABSENT',
      'the pack declares neither CreditNote sibling'
    );
  }
  if (verdict.state !== 'valid') {
    throw creditNoteContractError(
      'OUTBOUND_CREDIT_NOTE_PDF_CONTRACT_INVALID',
      verdict.errors.join('; ')
    );
  }
  const manifestVerdict = validateOutboundPackManifest(pack);
  if (!manifestVerdict.ok) {
    throw creditNoteContractError(
      'OUTBOUND_CREDIT_NOTE_PDF_CONTRACT_INVALID',
      manifestVerdict.errors.join('; ')
    );
  }
  return pack.documents.credit_note_pdf.page;
};

export const creditNotePdfTitleForPack = (pack, language) => {
  const page = creditNotePdfPageForPack(pack);
  const resolvedLanguage = String(language || '');
  const supported = pack?.correspondence?.languages || [];
  const title = pack?.documents?.credit_note_pdf?.titles_by_language?.[resolvedLanguage];
  if (!page || !/^[a-z]{2}$/.test(resolvedLanguage)
      || !supported.includes(resolvedLanguage) || !isNonEmptyString(title)) {
    throw creditNoteContractError(
      'OUTBOUND_CREDIT_NOTE_PDF_CONTRACT_INVALID',
      `language '${resolvedLanguage}' has no exact CreditNote title`
    );
  }
  return title;
};

// gap 11 / AR-4C: the pack's statutory document titles for the language the
// renderer will actually use, or null when the market declares none. The
// original scalar declaration remains the byte-stable one-language form; a
// multilingual pack must use the parallel language-keyed table (enforced at
// load). `languageForEntity` is shared with template selection so a title and
// its surrounding template can never resolve through different fallbacks.
export const statutoryTitlesForPack = (pack, language = null) => {
  const documents = pack?.documents;
  const resolvedLanguage = languageForEntity(pack, language);
  const keyed = documents?.statutory_titles_by_language;
  const titles = keyed && typeof keyed === 'object' && !Array.isArray(keyed)
    ? keyed[resolvedLanguage]
    : documents?.statutory_titles;
  if (!titles || typeof titles !== 'object' || Array.isArray(titles)) return null;
  const whenTaxRegistered = String(titles.invoice_when_tax_registered || '').trim();
  const otherwise = String(titles.invoice_otherwise || '').trim();
  if (!whenTaxRegistered || !otherwise) return null;
  return { whenTaxRegistered, otherwise };
};

// D4: the localized payment-block fragment for a live payment link. Returns
// the template string (uses {{payment_link_url}}) or null when the pack
// declares no payment_link rail — the caller then keeps the standing
// payment_instructions value.
export const paymentLinkInstructionsForPack = (pack, language = null) => {
  const rail = (pack?.payment_rails || []).find((r) => r?.kind === 'payment_link');
  if (!rail || !rail.instructions_template) return null;
  const lang = languageForEntity(pack, language);
  return rail.instructions_template[lang] ?? null;
};

// Pick the render language for an entity: the entity's preferred_language when
// the pack supports it, else the pack default. Localization is data (A7) —
// this is the ONLY place that fallback logic lives.
export const languageForEntity = (pack, preferredLanguage = null) => {
  const supported = pack?.correspondence?.languages || [];
  const preferred = String(preferredLanguage || '').trim().toLowerCase();
  if (preferred && supported.includes(preferred)) return preferred;
  return pack?.languages?.default ?? null;
};

// Node 20 (the pinned CI/runtime floor) exposes ECMA-402 TextInfo through the
// `textInfo` accessor; newer runtimes also expose `getTextInfo()`. Keep that
// compatibility in one boundary and preserve the same fail-closed result for
// malformed locales or an engine that supplies neither shape.
export const textDirectionForLocale = (locale) => {
  try {
    const parsed = new Intl.Locale(locale);
    const textInfo = typeof parsed.getTextInfo === 'function'
      ? parsed.getTextInfo()
      : parsed.textInfo;
    return ['ltr', 'rtl'].includes(textInfo?.direction) ? textInfo.direction : null;
  } catch {
    return null;
  }
};

// Resolve the delivery language without silently converting an unsupported
// counterparty preference into the pack default. `languageForEntity` remains
// the compact preview/mint helper for legacy callers; the irreversible send
// boundary uses this richer result and can therefore distinguish "no
// preference" from "Arabic requested but unavailable". A fallback is valid
// only when it was explicitly persisted on the party and the pack supports it.
export const resolveCorrespondenceLanguage = (pack, {
  requestedLanguage = null,
  fallbackLanguage = null,
  requestedSource = null
} = {}) => {
  const supported = pack?.correspondence?.languages || [];
  const packDefault = String(pack?.languages?.default || '').trim().toLowerCase();
  const requested = String(requestedLanguage || '').trim().toLowerCase();
  const fallback = String(fallbackLanguage || '').trim().toLowerCase();
  const actual = requested || packDefault;
  const source = requested
    ? (requestedSource || 'party_preference')
    : 'pack_default';

  if (!actual || !/^[a-z]{2}$/.test(actual)) {
    return {
      ok: false,
      reason: 'requested_language_invalid',
      requestedLanguage: actual || null,
      actualLanguage: null,
      languageSource: source,
      fallbackBasis: null,
      locale: null,
      direction: null
    };
  }

  let resolved = actual;
  let languageSource = source;
  // The configured fallback is part of the approval contract even when the
  // currently requested language is supported. Changing it after approval is
  // therefore visible drift rather than a silent future-policy change.
  let fallbackBasis = fallback ? `party_fallback_language:${fallback}` : null;
  if (!supported.includes(actual)) {
    if (!fallback || !/^[a-z]{2}$/.test(fallback) || !supported.includes(fallback)) {
      return {
        ok: false,
        reason: 'requested_language_unavailable',
        requestedLanguage: actual,
        actualLanguage: null,
        languageSource,
        fallbackBasis,
        locale: null,
        direction: null
      };
    }
    resolved = fallback;
    languageSource = 'party_explicit_fallback';
  }

  const locale = correspondenceLocaleForPack(pack, resolved);
  if (!locale) {
    return {
      ok: false,
      reason: 'correspondence_locale_unavailable',
      requestedLanguage: actual,
      actualLanguage: resolved,
      languageSource,
      fallbackBasis,
      locale: null,
      direction: null
    };
  }
  const direction = textDirectionForLocale(locale);
  if (!['ltr', 'rtl'].includes(direction)) {
    return {
      ok: false,
      reason: 'correspondence_direction_unavailable',
      requestedLanguage: actual,
      actualLanguage: resolved,
      languageSource,
      fallbackBasis,
      locale,
      direction: null
    };
  }
  return {
    ok: true,
    reason: null,
    requestedLanguage: actual,
    actualLanguage: resolved,
    languageSource,
    fallbackBasis,
    locale,
    direction
  };
};

// Resolve the Intl locale for the SAME correspondence language that selects
// the template. Multilingual packs fail closed without an exact mapping;
// single-language and small unvalidated probe packs retain the compact
// `number_locale` form.
export const correspondenceLocaleForPack = (pack, language = null) => {
  const resolvedLanguage = languageForEntity(pack, language);
  const supported = pack?.correspondence?.languages || [];
  const localeByLanguage = pack?.locale?.correspondence_locales;
  if (localeByLanguage !== undefined) {
    if (!isPlainObject(localeByLanguage) || !resolvedLanguage) return null;
    const locale = localeByLanguage[resolvedLanguage];
    return isBcp47LocaleTag(locale) ? locale.trim() : null;
  }
  if (supported.length > 1) return null;
  const locale = pack?.locale?.number_locale;
  return isBcp47LocaleTag(locale) ? locale.trim() : null;
};

// Locale-aware value formatting (A7: locale is DATA — the locale tag comes
// from the pack manifest, never a code literal; the noCoreLiterals lint pins
// that). Used at mint for the approval preview and again at the final
// language boundary before the renderer's dumb token substitution.
export const formatPackAmount = (pack, value, language = null) => {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  const locale = correspondenceLocaleForPack(pack, language);
  if (!locale) return null;
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  }).format(amount);
};

export const formatPackDate = (pack, isoDate, language = null) => {
  const day = String(isoDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const locale = correspondenceLocaleForPack(pack, language);
  if (!locale) return null;
  const [y, m, d] = day.split('-').map(Number);
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC'
  }).format(new Date(Date.UTC(y, m - 1, d)));
};

// Fail-closed template render: every {{token}} must resolve to a non-empty
// value. A missing value throws — an unresolved placeholder must never reach
// a counterparty's inbox, and the executor treats the throw as a blocked send.
export const renderPackTemplate = (pack, { template, language, values = {} } = {}) => {
  const variant = pack?.documents?.templates?.[template]?.[language];
  if (!variant) {
    throw new Error(`pack '${pack?.pack?.id}' has no template '${template}' in language '${language}'`);
  }
  const renderText = (text) => String(text).replace(TOKEN_RE, (_, token) => {
    const value = values[token];
    // Explicit empty blocks represent an inapplicable registration/tax limb.
    // Missing values still refuse; no other template acquires empty tokens.
    if (value === '' && INVOICE_DISPLAY_TEMPLATES.has(template)
      && INVOICE_OPTIONAL_BLOCK_TOKENS.includes(token)) return '';
    if (value === undefined || value === null || String(value).trim() === '') {
      throw new Error(`template '${template}' token '${token}' unresolved — refusing to render`);
    }
    return String(value);
  });
  return { subject: renderText(variant.subject), body: renderText(variant.body) };
};
