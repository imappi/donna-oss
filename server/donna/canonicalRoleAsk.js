// Canonical-role ask — turning a planner refusal into the owner's question.
//
// `canonicalRoleResolution.js` decides WHICH role questions must go to the
// owner. This module decides how one of them is ASKED: its identity (anchor and
// blocker code), its owner-facing wording, and the payload a reply is resolved
// against. Pure — no DB, no model, no clock — so the wording and the identity
// rules are testable without either.
//
// WHY THE ASK IS ANCHORED ON THE ROLE, NOT ON THE INVOICE THAT TRIPPED IT.
// The refusal surfaces at a posting site: a VAT-carrying sale hits
// OUTBOUND_AR_NO_SALES_TAX_ACCOUNT and is skipped. But the question is not about
// that invoice. "Which of your accounts is the VAT one" is asked once for the
// whole book, blocks every VAT-carrying sale simultaneously, and is answered
// once. Anchoring it on the invoice would mint a fresh ask per invoice for one
// standing question — the KUILI BARBACOA duplicate loop (migration 108) in a
// different costume. So the anchor is `account_role:<role>` and the migration
// 108 unique index does the rest: one active ask per (client, role, blocker).
//
// WHY THE OWNER IS THE RIGHT ADDRESSEE. Under the 2026-07-23 self-service
// re-amendment the fork is FACT vs KNOWLEDGE. What a VAT control account IS, is
// knowledge, and Donna answers that herself. Which of the two accounts the
// owner's previous bookkeeper set up is the VAT one is a fact about their chart.
// When the chart genuinely does not say, no amount of model strength invents it,
// and there is no bookkeeper behind Donna to ask instead.

import { roleMeta } from './accountRoles.js';
import { buildCanonicalAnchor } from './askIdentity.js';

// Blocker codes. Distinct per REFUSAL, not per role: an owner who is asked to
// disambiguate a contended role and later asked to supply a missing one is being
// asked two different questions, and both may legitimately be live at once on
// different roles. `normalizeBlockerCode` would map these onto themselves.
export const CANONICAL_ROLE_BLOCKER_CODES = Object.freeze({
  singleton_contended: 'account_role_ambiguous',
  no_candidate: 'account_role_missing'
});

export const CANONICAL_ROLE_EVIDENCE_TYPES = Object.freeze(Object.values(CANONICAL_ROLE_BLOCKER_CODES));

// Owner-facing names for the roles that actually reach an ask. ACCOUNT_ROLES
// labels are written for the ledger ("Sales tax / VAT payable"); an owner should
// be asked in the words they use for their own books. Anything not listed falls
// back to the ledger label rather than inventing a phrasing.
const OWNER_ROLE_PHRASES = {
  'liability.sales_tax_payable': 'VAT or sales tax account',
  'liability.tax_payable': 'corporation tax account',
  'liability.accounts_payable': 'trade creditors account',
  'liability.payroll_payable': 'payroll liabilities account',
  'liability.director_loan': "director's loan account",
  'asset.accounts_receivable': 'trade debtors account',
  'asset.cash': 'main bank account',
  'asset.inventory': 'stock account',
  'asset.fixed': 'fixed assets account',
  'revenue.operating': 'main sales account',
  'equity.share_capital': 'share capital account',
  'equity.retained_earnings': 'retained earnings account'
};

// The same roles in the words a Finnish owner uses for their own books
// (everyday tilikartta names, nominative, so a sentence never inflects them).
const FINNISH_OWNER_ROLE_PHRASES = {
  'liability.sales_tax_payable': 'ALV-velkatili',
  'liability.tax_payable': 'tuloverovelkatili',
  'liability.accounts_payable': 'ostovelkatili',
  'liability.payroll_payable': 'palkkavelkatili',
  'liability.director_loan': 'osakaslainatili',
  'asset.accounts_receivable': 'myyntisaamistili',
  'asset.cash': 'pääpankkitili',
  'asset.inventory': 'varastotili',
  'asset.fixed': 'käyttöomaisuustili',
  'revenue.operating': 'päämyyntitili',
  'equity.share_capital': 'osakepääomatili',
  'equity.retained_earnings': 'edellisten tilikausien voittovarojen tili'
};

// `language` is the owner's (preferredOwnerTemplateLanguage). A role with no
// owner phrase falls back to the ledger label in either language.
export const ownerPhraseForRole = (role, language = 'en') =>
  (language === 'fi' ? FINNISH_OWNER_ROLE_PHRASES : OWNER_ROLE_PHRASES)[String(role || '')]
    || roleMeta(role)?.label || String(role || '');

const accountLabel = (candidate = {}, language = 'en') => {
  const code = String(candidate.code ?? '').trim();
  const name = String(candidate.name ?? '').trim();
  if (code && name) return `${code} ${name}`;
  return name || code || (language === 'fi' ? 'nimetön tili' : 'an unnamed account');
};

// Voice rule (Kari, 2026-07-21): never an em or en dash. Comma, colon, or a new
// sentence. Every string built here obeys it, which is why the lists below join
// on ', ' and ' or ' rather than setting phrases off with dashes.
const joinCandidates = (candidates = [], language = 'en') => {
  const labels = candidates.map((candidate) => accountLabel(candidate, language));
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  return language === 'fi'
    ? `${labels.slice(0, -1).join(', ')} tai ${labels[labels.length - 1]}`
    : `${labels.slice(0, -1).join(', ')}, or ${labels[labels.length - 1]}`;
};

// The four questions in Finnish: the sinä form a small accounting firm uses
// with its client, the same facts and the same "reply with the code" ask.
const finnishRoleQuestion = ({ refusal, held, candidates, phrase }) => {
  const list = joinCandidates(candidates, 'fi');
  if (refusal === 'singleton_contended') {
    return held
      ? `Kirjanpidossasi on jo yksi ${phrase}, mutta ${candidates.length === 1 ? 'myös tämä tili voisi olla se' : 'myös nämä tilit voisivat olla se'}: ${list}. Mitä tiliä käytän? Vastaa tilin numerolla.`
      : `Kirjanpidossasi on useampi tili, joka voisi olla ${phrase}: ${list}. En pysty nimistä päättelemään, mikä on mikä, enkä halua arvata verotukseen liittyvissä asioissa. Mitä tiliä käytän? Vastaa tilin numerolla.`;
  }
  if (candidates.length) {
    return `Minun pitää tietää, mikä tileistäsi on ${phrase}, ennen kuin voin kirjata sille. Vaihtoehdot ovat: ${list}. Mitä tiliä käytän? Vastaa tilin numerolla, tai kerro, jos se ei ole mikään näistä.`;
  }
  return `En löydä kirjanpidostasi tiliä, joka voisi olla ${phrase}, ja tarvitsen sellaisen ennen kuin voin kirjata sille. Lisäänkö sellaisen, vai onko se kirjanpidossasi nimellä, jota en tunnistanut?`;
};

/**
 * Build the owner ask for one `ask_owner` entry from planCanonicalRoleResolution.
 *
 * @param {object} params
 * @param {object} params.ask  one entry of the planner's `asks` array
 * @param {'fi'|'en'} [params.language]  the owner's language (preferredOwnerTemplateLanguage)
 * @returns {{
 *   anchor: string, blocker_code: string, evidence_type: string,
 *   question: string, request_payload: object
 * }|null}  null when the ask is not one this module can express
 */
export const buildCanonicalRoleAsk = ({ ask = {}, language = 'en' } = {}) => {
  const role = String(ask.role || '').trim();
  const refusal = String(ask.refusal || '').trim();
  const blockerCode = CANONICAL_ROLE_BLOCKER_CODES[refusal];
  // Fail closed and silently rather than minting a mis-identified ask: an
  // unknown refusal means the planner grew a terminal this module has not been
  // taught to word, and a wrongly-anchored ask is worse than no ask.
  if (!role || !blockerCode || !roleMeta(role)) return null;

  const candidates = Array.isArray(ask.candidates) ? ask.candidates.filter(Boolean) : [];
  const phrase = ownerPhraseForRole(role, language);
  const anchor = buildCanonicalAnchor({ accountRole: role });

  let question;
  if (language === 'fi') {
    question = finnishRoleQuestion({ refusal, held: Number(ask.held_count) > 0, candidates, phrase });
  } else if (refusal === 'singleton_contended') {
    // The owner is choosing between accounts Donna can see and cannot separate.
    // Say plainly that she cannot tell, rather than implying she has a view she
    // is withholding.
    const held = Number(ask.held_count) > 0;
    question = held
      ? `I already have one account set as your ${phrase}, and ${candidates.length === 1 ? 'another account looks' : 'other accounts look'} like ${candidates.length === 1 ? 'it' : 'they'} could be it too: ${joinCandidates(candidates)}. Which one should I use? Reply with the code.`
      : `More than one account in your books could be your ${phrase}: ${joinCandidates(candidates)}. I cannot tell which is which from the names, and I do not want to guess on tax. Which one should I use? Reply with the code.`;
  } else if (candidates.length) {
    question = `I need to know which account is your ${phrase} before I can post to it. These are the ones it could be: ${joinCandidates(candidates)}. Which should I use? Reply with the code, or tell me if it is not one of these.`;
  } else {
    // Nothing in the chart could legally carry the role. The honest ask is not
    // "pick one", it is "there isn't one, should I add it".
    question = `I cannot find an account in your books to use as your ${phrase}, and I need one before I can post to it. Should I add one, or is it there under a name I have not recognised?`;
  }

  return {
    anchor,
    blocker_code: blockerCode,
    evidence_type: blockerCode,
    question,
    request_payload: {
      // The reply resolver's working set: which role is being settled, and the
      // exact accounts offered. Persisted so a reply arriving days later is
      // matched against what the owner was actually shown, not against a chart
      // that may have changed underneath the question.
      canonical_role: role,
      role_label: roleMeta(role)?.label || role,
      owner_phrase: phrase,
      refusal,
      held_count: Number(ask.held_count) || 0,
      had_refused_proposals: Boolean(ask.had_refused_proposals),
      candidates: candidates.map((candidate) => ({
        account_id: candidate.account_id ?? null,
        code: candidate.code ?? null,
        name: candidate.name ?? null
      }))
    }
  };
};

/**
 * Build every ask for a plan, dropping the ones this module cannot express.
 * Deterministically ordered by role so two runs over one chart produce the same
 * sequence of asks.
 */
export const buildCanonicalRoleAsks = ({ plan = {}, language = 'en' } = {}) =>
  (Array.isArray(plan.asks) ? plan.asks : [])
    .map((ask) => buildCanonicalRoleAsk({ ask, language }))
    .filter(Boolean)
    .sort((a, b) => String(a.anchor).localeCompare(String(b.anchor)));
