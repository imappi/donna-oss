// FI-13 slice 13.0A-1 — the Oy acceptance envelope (D-FI13-13, pilot edition).
//
// "Donna for the Finnish owner-managed service Oy." This is the QUALIFICATION
// gate that keeps the narrow ICP narrow — and the narrow ICP is itself the
// escalation-rate control the whole business model leans on (CLAUDE.md: the ONE
// metric is the escalation rate; each disqualified category is tail-risk kept off
// the founder's desk). A client outside the envelope is NOT "Donna can probably
// handle it" — it is a DIFFERENT segment, each its own dated decision by Kari.
//
// Deterministic KEEP-layer evaluator, no model call anywhere. Sibling of
// scopeDrift.js, deliberately mirroring its shape (closed verdict enum, closed
// criterion catalog, fi+en copy, provenance.deterministic, stated attestations
// for boundaries Donna cannot derive). The DIFFERENCE: scopeDrift watches a LIVE
// book's posted-ledger signals for drift OUT of scope; this envelope qualifies a
// prospective Oy at onboarding (and re-qualifies on an ownership change) over
// DECLARED attributes. Complementary surfaces, not duplicates.
//
// Fail-closed by construction: a criterion PASSES only on an affirmative
// in-envelope answer. A disqualifying answer fires at the criterion's severity; a
// MISSING answer fires at `review_required` (you cannot accept a client into the
// pilot on an unanswered question). "Accepted" therefore means every gate was
// affirmatively cleared — never "nothing disqualifying was seen".
//
// STAGING NOTE: this is the PURE evaluator + its catalog (green-now, no fi-oy
// client exists). The persisted attribute source — the ownership/cap-table
// (D-FI13-14) and authority (D-FI13-11) models plus the onboarding intake — lands
// in slice 13.0A-2; a DB caller/route that renders this verdict wires up there.
// The AML/KYC counsel opinion is a SEPARATE hard pilot gate (§8) this evaluator
// does not and cannot substitute for.
//
// The catalog is SERVICE-SCOPE POLICY (the ratified pilot envelope), not statute:
// re-scope a criterion, or move a segment in, only on a dated call from Kari —
// same discipline as scopeDrift's severities and the prospecting §3C tiers.

// Verdict — severity-ordered (weakest → strongest); overall = the max fired.
//   • accepted        — every gate affirmatively cleared; inside the pilot envelope.
//   • review_required — a criterion needs a named human's confirmation before
//                       onboarding (an unanswered gate, or a soft gate like the
//                       audit-requirement / opening-balance-evidence check).
//   • out_of_segment  — a criterion places the client OUTSIDE the pilot segment
//                       (a holding company, a foreign shareholder, multiple share
//                       classes …). Not a bug to fix in code — a different segment
//                       that needs Kari's dated decision.
export const ACCEPTANCE_VERDICTS = Object.freeze([
  'accepted',
  'review_required',
  'out_of_segment'
]);

// Who a firing rests on (the two-terminal-states named-party doctrine). A
// DISQUALIFICATION escalates to this party; an UNANSWERED gate escalates to the
// owner (they hold the answer). Mirrors the StatutoryBlocker assignee vocabulary.
export const ACCEPTANCE_ESCALATION_PARTIES = Object.freeze(['firm', 'accountant', 'counsel', 'owner']);

const severityRank = (verdict) => ACCEPTANCE_VERDICTS.indexOf(verdict);

// A tri-state read of a declared boolean attribute: affirmative match → 'pass';
// explicit contrary boolean → 'fail'; missing/unknown → 'unknown' (fail-closed to
// review). `wantTrue` is the in-envelope answer.
const readBool = (value, wantTrue) => {
  if (value === undefined || value === null) return 'unknown';
  if (typeof value !== 'boolean') return 'unknown';
  return value === wantTrue ? 'pass' : 'fail';
};

// The closed criterion catalog (D-FI13-13). Each maps a declared attribute to a
// severity + escalation party + owner/firm-readable copy. `read(attributes)` is
// pure and returns 'pass' | 'fail' | 'unknown'. Extend/re-scope only by PR on a
// dated Kari call — never by prose.
export const ACCEPTANCE_CRITERIA = Object.freeze([
  {
    id: 'finnish_private_limited',
    severity: 'out_of_segment',
    escalates_to: 'firm',
    requirement_en: 'A Finnish private limited company (osakeyhtiö / Oy).',
    requirement_fi: 'Suomalainen yksityinen osakeyhtiö (Oy).',
    note_en: 'This segment is the Finnish owner-managed service Oy. Another legal form (toiminimi, ky, ay, osuuskunta, public Oyj, a foreign entity) is a different segment.',
    note_fi: 'Segmentti on suomalainen omistajavetoinen palvelu-Oy. Muu yhtiömuoto (toiminimi, ky, ay, osuuskunta, julkinen Oyj, ulkomainen yhtiö) on eri segmentti.',
    read: (a) => (a.entityType === undefined || a.entityType === null ? 'unknown' : a.entityType === 'fi-oy' ? 'pass' : 'fail')
  },
  {
    id: 'finnish_tax_resident',
    severity: 'out_of_segment',
    escalates_to: 'firm',
    requirement_en: 'Finnish tax resident, no foreign permanent establishment.',
    requirement_fi: 'Suomessa verovelvollinen, ei ulkomaista kiinteää toimipaikkaa.',
    note_en: 'Cross-border residency changes the tax and reporting surface — a different segment.',
    note_fi: 'Rajat ylittävä verovelvollisuus muuttaa vero- ja ilmoituspintaa — eri segmentti.',
    read: (a) => readBool(a.taxResidentFinland, true)
  },
  {
    id: 'service_business',
    severity: 'out_of_segment',
    escalates_to: 'firm',
    requirement_en: 'A service business — no inventory or cost of goods sold.',
    requirement_fi: 'Palveluliiketoiminta — ei varastoa eikä myytyjen tuotteiden hankintamenoa.',
    note_en: 'Product/commerce accounting (inventory, COGS) is a scoped, separately-decided segment.',
    note_fi: 'Tuote-/kaupankäyntikirjanpito (varasto, hankintameno) on erikseen päätettävä segmentti.',
    read: (a) => (a.businessKind === undefined || a.businessKind === null ? 'unknown' : a.businessKind === 'service' ? 'pass' : 'fail')
  },
  {
    id: 'single_resident_natural_shareholder',
    severity: 'out_of_segment',
    escalates_to: 'firm',
    requirement_en: 'One Finnish-resident natural-person shareholder holding 100 %.',
    requirement_fi: 'Yksi Suomessa asuva luonnollinen henkilö omistaa 100 %.',
    note_en: 'Multiple owners, a corporate/holding shareholder, or a foreign owner changes ownership, YEL, dividends and 6B at once — a different segment.',
    note_fi: 'Useampi omistaja, yhtiö-/holdingomistaja tai ulkomainen omistaja muuttaa omistuksen, YEL:n, osingot ja 6B:n kerralla — eri segmentti.',
    read: (a) => {
      const single = readBool(a.singleShareholderFullOwnership, true);
      const resident = readBool(a.shareholdersAllFinnishResidentNaturalPersons, true);
      if (single === 'fail' || resident === 'fail') return 'fail';
      if (single === 'unknown' || resident === 'unknown') return 'unknown';
      return 'pass';
    }
  },
  {
    id: 'single_share_class',
    severity: 'out_of_segment',
    escalates_to: 'firm',
    requirement_en: 'One share class.',
    requirement_fi: 'Yksi osakelaji.',
    note_en: 'Multiple share classes (preference, option schemes) is a corporate-law-heavy segment.',
    note_fi: 'Useampi osakelaji (etuosakkeet, optiojärjestelyt) on yhtiöoikeudellisesti raskaampi segmentti.',
    read: (a) => {
      if (a.shareClassCount === undefined || a.shareClassCount === null) return 'unknown';
      return Number(a.shareClassCount) === 1 ? 'pass' : 'fail';
    }
  },
  {
    id: 'single_decision_maker_authority',
    severity: 'out_of_segment',
    escalates_to: 'firm',
    requirement_en: 'One decision-maker with board/representation authority.',
    requirement_fi: 'Yksi päätöksentekijä, jolla on hallitus-/edustamisvalta.',
    note_en: 'A multi-member board or split representation authority changes the authority model — a different segment.',
    note_fi: 'Monijäseninen hallitus tai jaettu edustamisvalta muuttaa valtuutusmallin — eri segmentti.',
    read: (a) => readBool(a.singleDecisionMakerWithAuthority, true)
  },
  {
    id: 'no_group_structure',
    severity: 'out_of_segment',
    escalates_to: 'firm',
    requirement_en: 'No subsidiaries, holdings, or group structure.',
    requirement_fi: 'Ei tytäryhtiöitä, omistusyhteysyrityksiä eikä konsernirakennetta.',
    note_en: 'Group accounting and consolidation is a separate segment.',
    note_fi: 'Konsernikirjanpito ja -tilinpäätös on erillinen segmentti.',
    read: (a) => readBool(a.hasSubsidiariesOrGroup, false)
  },
  {
    id: 'no_foreign_pe',
    severity: 'out_of_segment',
    escalates_to: 'firm',
    requirement_en: 'No foreign permanent establishment.',
    requirement_fi: 'Ei ulkomaista kiinteää toimipaikkaa.',
    note_en: 'A foreign PE pulls in another jurisdiction’s filing — a different segment.',
    note_fi: 'Ulkomainen kiinteä toimipaikka tuo toisen maan ilmoitusvelvollisuuden — eri segmentti.',
    read: (a) => readBool(a.hasForeignPermanentEstablishment, false)
  },
  {
    id: 'no_inventory_cogs',
    severity: 'out_of_segment',
    escalates_to: 'firm',
    requirement_en: 'No inventory / cost of goods sold.',
    requirement_fi: 'Ei varastoa eikä hankintamenoa (COGS).',
    note_en: 'Inventory/COGS accounting is the scoped commerce segment, decided separately.',
    note_fi: 'Varasto-/hankintamenokirjanpito on erikseen päätetty kaupan segmentti.',
    read: (a) => readBool(a.hasInventoryOrCogs, false)
  },
  {
    id: 'no_property_securities_crypto',
    severity: 'out_of_segment',
    escalates_to: 'firm',
    requirement_en: 'No property, securities, or crypto holdings.',
    requirement_fi: 'Ei kiinteistö-, arvopaperi- tai kryptovarallisuutta.',
    note_en: 'Investment/holding activity (valuation, capital gains) is a different segment.',
    note_fi: 'Sijoitus-/holdingtoiminta (arvostus, luovutusvoitot) on eri segmentti.',
    read: (a) => readBool(a.hasPropertySecuritiesOrCrypto, false)
  },
  {
    id: 'no_shareholder_loans',
    severity: 'out_of_segment',
    escalates_to: 'firm',
    requirement_en: 'No existing shareholder loans (osakaslaina).',
    requirement_fi: 'Ei olemassa olevia osakaslainoja.',
    note_en: 'A shareholder loan carries a tax clock (osakaslaina) and dual-treatment risk — out of the pilot envelope.',
    note_fi: 'Osakaslaina sisältää verokellon ja kahden käsittelyn riskin — pilotin ulkopuolella.',
    read: (a) => readBool(a.hasShareholderLoans, false)
  },
  {
    id: 'no_automated_dividends',
    severity: 'review_required',
    escalates_to: 'accountant',
    requirement_en: 'No automated dividend processing (dividends are detect-and-escalate in the pilot).',
    requirement_fi: 'Ei automatisoitua osingonjakoa (osingot havaitaan ja eskaloidaan pilotissa).',
    note_en: 'Dividends need an accountant-confirmed decision, withholding and 7812 treatment before the pilot books them — never automated.',
    note_fi: 'Osingot vaativat kirjanpitäjän vahvistaman päätöksen, ennakonpidätyksen ja 7812-käsittelyn ennen kirjausta — ei automatiikkaa.',
    read: (a) => readBool(a.wantsAutomatedDividends, false)
  },
  {
    id: 'owner_salary_external_payroll_only',
    severity: 'review_required',
    escalates_to: 'accountant',
    requirement_en: 'No employees except owner salary via an external payroll provider.',
    requirement_fi: 'Ei työntekijöitä paitsi omistajan palkka ulkoisen palkkahallinnon kautta.',
    note_en: 'Payroll is external, imported and reconciled (D-FI13-16); employees beyond the owner expand the payroll surface.',
    note_fi: 'Palkanlaskenta on ulkoinen, tuodaan ja täsmäytetään (D-FI13-16); omistajan lisäksi työntekijät laajentavat palkkapintaa.',
    read: (a) => readBool(a.employeesBeyondOwner, false)
  },
  {
    id: 'standard_or_verified_non_alv',
    severity: 'review_required',
    escalates_to: 'accountant',
    requirement_en: 'Standard ALV registration, or a verified non-ALV position; no complex cross-border ALV.',
    requirement_fi: 'Tavallinen ALV-rekisteröinti tai vahvistettu ei-ALV-asema; ei monimutkaista rajat ylittävää ALV:tä.',
    note_en: 'Complex cross-border ALV (EU trade, import, reverse charge) needs review before onboarding.',
    note_fi: 'Monimutkainen rajat ylittävä ALV (EU-kauppa, tuonti, käännetty verovelvollisuus) vaatii tarkistuksen ennen aloitusta.',
    read: (a) => {
      if (a.alvStatus === undefined || a.alvStatus === null) return 'unknown';
      if (a.alvStatus === 'standard' || a.alvStatus === 'verified_non_alv') return 'pass';
      return 'fail';
    }
  },
  {
    id: 'no_audit_requirement',
    severity: 'review_required',
    escalates_to: 'accountant',
    requirement_en: 'No statutory audit requirement (checked against the articles AND prior periods).',
    requirement_fi: 'Ei lakisääteistä tilintarkastusvelvollisuutta (tarkistettu yhtiöjärjestyksestä JA aiemmilta tilikausilta).',
    note_en: 'An audit requirement adds an auditor to the close — verify against the articles and the prior periods, not just the current thresholds.',
    note_fi: 'Tilintarkastusvelvollisuus tuo tilintarkastajan tilinpäätökseen — tarkista yhtiöjärjestyksestä ja aiemmilta tilikausilta, ei vain nykyisistä rajoista.',
    read: (a) => readBool(a.auditRequired, false)
  },
  {
    id: 'no_fiscal_period_change_in_progress',
    severity: 'review_required',
    escalates_to: 'accountant',
    requirement_en: 'No fiscal-period (tilikausi) change in progress.',
    requirement_fi: 'Ei tilikauden muutosta kesken.',
    note_en: 'A tilikausi change mid-onboarding complicates the period math and deadlines — settle it first.',
    note_fi: 'Tilikauden muutos kesken aloitusta mutkistaa kausilaskennan ja määräajat — ratkaistaan ensin.',
    read: (a) => readBool(a.fiscalPeriodChangeInProgress, false)
  },
  {
    id: 'clean_opening_balances_with_evidence',
    severity: 'review_required',
    escalates_to: 'accountant',
    requirement_en: 'Clean opening balances backed by evidence (no book remediation).',
    requirement_fi: 'Puhtaat avaavat saldot todistein (ei kirjanpidon korjaustyötä).',
    note_en: 'Remediating already-incorrect prior books is out of scope; the opening balance must be evidenced, not reconstructed by Donna.',
    note_fi: 'Jo virheellisen aiemman kirjanpidon korjaus ei kuulu palveluun; avaavan taseen on oltava todistettu, ei Donnan uudelleenrakentama.',
    read: (a) => readBool(a.openingBalancesCleanWithEvidence, true)
  },
  {
    id: 'modest_volume',
    severity: 'review_required',
    escalates_to: 'firm',
    requirement_en: 'Modest transaction volume.',
    requirement_fi: 'Kohtuullinen tapahtumavolyymi.',
    note_en: 'Very high volume changes the exception-handling economics — review before onboarding.',
    note_fi: 'Erittäin suuri volyymi muuttaa poikkeustenkäsittelyn taloutta — tarkistetaan ennen aloitusta.',
    read: (a) => readBool(a.modestVolume, true)
  },
  {
    id: 'no_rate_boundary_tilikausi',
    severity: 'review_required',
    escalates_to: 'accountant',
    requirement_en: 'No tilikausi crossing the 2026/2027 yhteisövero rate boundary.',
    requirement_fi: 'Ei 2026/2027 yhteisöverokannan rajan ylittävää tilikautta.',
    note_en: 'A period crossing the 20 % → 18 % boundary triggers a rate-change adjustment path kept cold in the pilot (D-FI13-3).',
    note_fi: 'Tilikausi, joka ylittää 20 % → 18 % rajan, laukaisee verokannan muutosoikaisun, joka pidetään pilotissa kylmänä (D-FI13-3).',
    read: (a) => readBool(a.tilikausiCrossesRateBoundary, false)
  },
  {
    id: 'no_ownership_change_in_progress',
    severity: 'review_required',
    escalates_to: 'accountant',
    requirement_en: 'No ownership change in progress (an ownership change mid-pilot re-qualifies the client).',
    requirement_fi: 'Ei omistuksenmuutosta kesken (omistuksenmuutos pilotin aikana uudelleenarvioi asiakkaan).',
    note_en: 'An ownership change touches YEL, losses and 6B at once — it escalates and re-runs this envelope, it is not silently absorbed.',
    note_fi: 'Omistuksenmuutos koskettaa YEL:iä, tappioita ja 6B:tä kerralla — se eskaloituu ja ajaa tämän arvioinnin uudelleen, ei imeydy hiljaa.',
    read: (a) => readBool(a.ownershipChangeInProgress, false)
  }
]);

const CRITERIA_BY_ID = new Map(ACCEPTANCE_CRITERIA.map((c) => [c.id, c]));

// Boundaries the OWNER must affirm because Donna cannot derive them (mirrors
// scopeDrift's stated_exclusions): these ride EVERY evaluation as owner
// attestations so onboarding never silently assumes them. They correspond to the
// attested-only criteria above; stating them is how the answer arrives through
// the normal ask lane and the disclosure rests ON THE OWNER (two-terminal-states).
export const ACCEPTANCE_STATED_ATTESTATIONS = Object.freeze([
  {
    id: 'no_foreign_pe',
    note_en: 'Confirm the company has no foreign permanent establishment or cross-border activity.',
    note_fi: 'Vahvista, ettei yhtiöllä ole ulkomaista kiinteää toimipaikkaa tai rajat ylittävää toimintaa.'
  },
  {
    id: 'no_shareholder_loans',
    note_en: 'Confirm there are no existing shareholder loans (osakaslaina).',
    note_fi: 'Vahvista, ettei olemassa olevia osakaslainoja ole.'
  },
  {
    id: 'no_ownership_change_in_progress',
    note_en: 'Tell Donna if ownership changes during the engagement — it re-qualifies the client.',
    note_fi: 'Kerro Donnalle, jos omistus muuttuu palvelun aikana — se arvioidaan uudelleen.'
  }
]);

// evaluateAcceptanceEnvelope({ attributes }) → { verdict, failures, accepted,
// evaluatedCriterionIds, stated_attestations, provenance }.
//
// Pure, never throws. `failures` carries ONLY the fired criteria (disqualified or
// unanswered), each with its severity, escalation party and deterministic reason.
// `verdict` is the max severity fired ('accepted' when none fires). A firing with
// reason 'unconfirmed' (a missing answer) always escalates to the owner — they
// hold the answer; a 'disqualified' firing escalates to the criterion's party.
export const evaluateAcceptanceEnvelope = ({ attributes = {} } = {}) => {
  const failures = [];
  for (const criterion of ACCEPTANCE_CRITERIA) {
    const outcome = criterion.read(attributes);
    if (outcome === 'pass') continue;
    const disqualified = outcome === 'fail';
    failures.push({
      id: criterion.id,
      // A disqualifying answer fires at the criterion's severity; an unanswered
      // gate can never be worse than review_required (we simply don't know yet).
      severity: disqualified ? criterion.severity : 'review_required',
      reason: disqualified ? 'disqualified' : 'unconfirmed',
      escalates_to: disqualified ? criterion.escalates_to : 'owner',
      requirement_en: criterion.requirement_en,
      requirement_fi: criterion.requirement_fi,
      note_en: criterion.note_en,
      note_fi: criterion.note_fi
    });
  }

  const verdict = failures.reduce(
    (worst, f) => (severityRank(f.severity) > severityRank(worst) ? f.severity : worst),
    'accepted'
  );

  return {
    verdict,
    accepted: verdict === 'accepted',
    failures,
    evaluatedCriterionIds: ACCEPTANCE_CRITERIA.map((c) => c.id),
    // Ride every evaluation regardless of outcome — an un-derivable boundary must
    // always be stated for the owner to affirm, never only when something fires.
    stated_attestations: ACCEPTANCE_STATED_ATTESTATIONS,
    provenance: {
      deterministic: true,
      policy: 'Oy acceptance envelope (docs/design-donna-finland-fi13-osakeyhtio.md D-FI13-13); a segment moves in only by a dated Kari decision'
    }
  };
};

// criterionById(id) — catalog lookup for callers that render a single gate.
export const criterionById = (id) => CRITERIA_BY_ID.get(id) || null;
