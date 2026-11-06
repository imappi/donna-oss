// F-G10-3 — the EVL depreciation engine (menojäännöspoisto). Design:
// docs/design-donna-finland-evl-depreciation.md (D-G10-3-1…6).
//
// Computes the EVL 30 § MAXIMUM declining-balance depreciation (25 % of the
// machinery-and-equipment pool; a pool at or under the small-pool threshold
// may be deducted in full) from the cutover-recorded tax bases
// (profile.cutover.fixed_assets[].undepreciated_balance_eur) — and ONLY for
// the tilikausi the pack anchors to (as_of inside the year; the D-P2-5
// precedent). It never elects: EVL 30 § is a ceiling, taking less is
// legitimate tax planning, so the actual claim stays the booked poistot plus
// human-confirmed depreciation_difference records (the G-11 layer). When the
// books appear to claim more than the ceiling, the verdict carries a PROPOSED
// depreciation_difference record — surfaced, never auto-applied, and only
// when the machinery pool is the sole recorded category (in-year additions
// the engine cannot see legitimately raise the true ceiling; the note says
// so). Buildings depreciate per building under EVL 34 § at building-type
// rates the record does not carry — listed as not_computed, never guessed.
//
// KEEP-layer deterministic arithmetic on transcribed records; read-time only
// (INV-1: no writer, no migration, no route). Pure; never throws on garbage.

import { toUtcIsoDay } from '../dates.js';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const dateOnly = (value) => {
  const raw = String(value || '').slice(0, 10);
  if (!ISO_DATE.test(raw)) return null;
  // toUtcIsoDay round-trips a bare day and refuses an impossible one
  // (2026-02-30 → '', never a rolled-over March 2).
  return toUtcIsoDay(raw) === raw ? raw : null;
};

// Statutory rates by tax year (the FI-11 mileage-table pattern: the amounts
// are law, not a guess — each row carries its provenance). finlex.fi is
// proxy-blocked from this container class, so both values are corroborated
// against secondary sources only; the primary read is item 6 of the F-FI8-R1
// network-open checklist (docs/design-donna-finland-fi8-omavero-adapter.md) —
// flip confirmedAgainstPrimary in the same commit as the primary read.
export const EVL_DEPRECIATION_RATES_BY_YEAR = Object.freeze({
  2026: Object.freeze({
    machinery_and_equipment: 0.25,
    small_pool_full_deduction_max_eur: 1200,
    confirmedAgainstPrimary: false,
    source: 'EVL 30 § — RE-CORROBORATED via search extraction 2026-07-11 (vero.fi syventävä ohje "Poistot elinkeinoverotuksessa" titles + Tilisanomat/Procountor/Visma): 25 % menojäännöspoisto; EVL 30 § 5 mom small-pool ≤ €1,200 one-time full deduction confirmed as a DISTINCT rule from the EVL 33 § pienhankinta (per-item ≤ €1,200, €3,600/yr cap — deliberately not encoded here). Byte-level primary read pending (network-open checklist item 6)'
  })
});

const LATEST_RATE_YEAR = Math.max(...Object.keys(EVL_DEPRECIATION_RATES_BY_YEAR).map(Number));

// evlRatesForYear(year) → { year, rates, exact }. A year with no row gets the
// latest table flagged exact:false — substituted, never silent (FI-11).
export const evlRatesForYear = (year) => {
  const y = Number(year);
  if (EVL_DEPRECIATION_RATES_BY_YEAR[y]) return { year: y, rates: EVL_DEPRECIATION_RATES_BY_YEAR[y], exact: true };
  return { year: LATEST_RATE_YEAR, rates: EVL_DEPRECIATION_RATES_BY_YEAR[LATEST_RATE_YEAR], exact: false };
};

export const EVL_DEPRECIATION_PROVENANCE = Object.freeze({
  statute: 'EVL 30 § (menojäännöspoisto, koneet ja kalusto; pienen menojäännöksen kertavähennys); EVL 34 § (rakennukset — ei laskettavissa ilman rakennustyyppiä)',
  confirmedAgainstPrimary: false,
  corroboratedOn: '2026-07-11'
});

const NOT_COMPUTED_REASONS_FI = Object.freeze({
  buildings:
    'Rakennukset poistetaan rakennuskohtaisesti EVL 34 §:n mukaan rakennustyypin prosentilla, jota kirjaus ei sisällä — Donna ei laske enimmäispoistoa. Kirjaa tarvittaessa poistoero (depreciation_difference).',
  other:
    'Luokalle "other" ei ole yhtä lakisääteistä poistoprosenttia — Donna ei laske enimmäispoistoa. Kirjaa tarvittaessa poistoero (depreciation_difference).'
});

const EPSILON = 0.01;

const sumBases = (assets, category) =>
  round2(
    assets
      .filter((a) => a && typeof a === 'object' && a.category === category)
      .reduce((acc, a) => acc + (Number(a.undepreciated_balance_eur) || 0), 0)
  );

// evaluateEvlDepreciation({ cutover, tilikausi, taxYear, bookedDepreciationEur,
// taxAdjustments }) → the verdict, or null when no pack / no recorded bases /
// no usable tax year — the annual-return envelope stays byte-identical
// (D-G10-3-6). `taxAdjustments` is the RAW profile.tax_adjustments list (the
// double-count guard reads existing depreciation_difference records for the
// year from it).
export const evaluateEvlDepreciation = ({
  cutover = null,
  tilikausi = null,
  taxYear,
  bookedDepreciationEur = null,
  taxAdjustments = null
} = {}) => {
  if (!cutover || typeof cutover !== 'object' || Array.isArray(cutover)) return null;
  const assets = Array.isArray(cutover.fixed_assets) ? cutover.fixed_assets : [];
  if (!assets.length) return null;
  const year = Number(taxYear);
  if (!Number.isInteger(year)) return null;

  const { year: rateYear, rates, exact } = evlRatesForYear(year);
  const rateView = {
    year: rateYear,
    machinery_rate: rates.machinery_and_equipment,
    small_pool_full_deduction_max_eur: rates.small_pool_full_deduction_max_eur,
    exact,
    confirmedAgainstPrimary: rates.confirmedAgainstPrimary,
    source: rates.source
  };

  const notComputed = [];
  for (const category of ['buildings', 'other']) {
    const hasAny = assets.some((a) => a && typeof a === 'object' && a.category === category);
    if (!hasAny) continue;
    notComputed.push({
      category,
      recorded_base_eur: sumBases(assets, category),
      reason_fi: NOT_COMPUTED_REASONS_FI[category]
    });
  }

  const base = {
    tax_year: year,
    rate: rateView,
    not_computed: notComputed,
    provenance: EVL_DEPRECIATION_PROVENANCE
  };

  // Anchor rule (D-G10-3-3): the recorded base is the opening menojäännös
  // ONLY for the tilikausi containing as_of. Later years need the roll-forward
  // (poisto elections + additions/disposals) — the named follow-up F-G10-3b.
  const asOf = dateOnly(cutover.as_of);
  const startsOn = dateOnly(tilikausi?.starts_on);
  const endsOn = dateOnly(tilikausi?.ends_on);
  const anchored = Boolean(asOf && startsOn && endsOn && asOf >= startsOn && asOf <= endsOn);
  if (!anchored) {
    return {
      ...base,
      status: 'not_anchored',
      pool: null,
      comparison: null,
      summary_fi:
        'Cutover-kanta ei ankkuroidu tähän tilikauteen — EVL-enimmäispoistoa ei lasketa kirjatusta kannasta (menojäännöksen vuosittainen seuranta on erillinen jatko).'
    };
  }

  const hasMachinery = assets.some((a) => a && typeof a === 'object' && a.category === 'machinery_and_equipment');
  let pool = null;
  if (hasMachinery) {
    const opening = sumBases(assets, 'machinery_and_equipment');
    const smallPool = opening <= rates.small_pool_full_deduction_max_eur + EPSILON;
    const maxPoisto = smallPool ? opening : round2(opening * rates.machinery_and_equipment);
    pool = {
      category: 'machinery_and_equipment',
      opening_menojaannos_eur: opening,
      max_poisto_eur: maxPoisto,
      small_pool_rule_applied: smallPool,
      closing_menojaannos_if_max_eur: round2(opening - maxPoisto)
    };
  }

  let comparison = null;
  if (pool) {
    // null/undefined is "figure unavailable", NOT zero — Number(null) is 0.
    const booked = bookedDepreciationEur == null ? NaN : Number(bookedDepreciationEur);
    const existingItems = (Array.isArray(taxAdjustments) ? taxAdjustments : []).filter(
      (item) =>
        item &&
        typeof item === 'object' &&
        item.type === 'depreciation_difference' &&
        Number(item.tax_year) === year &&
        Number.isFinite(Number(item.amount_eur))
    );
    const existingAdjustment = existingItems.length
      ? round2(existingItems.reduce((acc, item) => acc + Number(item.amount_eur), 0))
      : null;

    if (!Number.isFinite(booked)) {
      comparison = {
        booked_depreciation_eur: null,
        severity: 'unverified',
        existing_adjustment_eur: existingAdjustment,
        proposed_adjustment: null,
        note_fi: 'Kirjattuja poistoja ei ole saatavilla vertailuun.'
      };
    } else if (booked <= pool.max_poisto_eur + EPSILON) {
      comparison = {
        booked_depreciation_eur: round2(booked),
        severity: 'ok',
        headroom_eur: round2(pool.max_poisto_eur - booked),
        existing_adjustment_eur: existingAdjustment,
        proposed_adjustment: null,
        note_fi: 'Kirjatut poistot mahtuvat EVL 30 §:n enimmäispoistoon (cutover-kannasta laskettuna).'
      };
    } else if (existingAdjustment !== null) {
      // Caveat found on the 2026-07-11 verification sweep: the temporary
      // korotetut-poistot regime (doubled 50 % on NEW machinery, tax years
      // 2020–2025) makes a booked figure above the 25 % max LAWFUL for those
      // years — for a tax year ≤ 2025 a possible_excess here can be a false
      // positive. Surfaced-never-applied semantics already keep this safe;
      // the year-scoped refinement is named on the network-open checklist
      // item 6 (rides the same primary read).
      comparison = {
        booked_depreciation_eur: round2(booked),
        severity: 'possible_excess',
        excess_eur: round2(booked - pool.max_poisto_eur),
        existing_adjustment_eur: existingAdjustment,
        proposed_adjustment: null,
        note_fi: 'Kirjatut poistot ylittävät cutover-kannasta lasketun enimmäispoiston, mutta verovuodelle on jo kirjattu poistoero — ei uutta ehdotusta.'
      };
    } else if (notComputed.length) {
      comparison = {
        booked_depreciation_eur: round2(booked),
        severity: 'unverified',
        excess_eur: round2(booked - pool.max_poisto_eur),
        existing_adjustment_eur: null,
        proposed_adjustment: null,
        note_fi:
          'Kirjatut poistot ylittävät koneiden ja kaluston enimmäispoiston, mutta kirjattuun kantaan kuuluu myös eriä (rakennukset/muut), joiden poistoja Donna ei voi rajata — vertailu jää varmentamatta.'
      };
    } else {
      const excess = round2(booked - pool.max_poisto_eur);
      comparison = {
        booked_depreciation_eur: round2(booked),
        severity: 'possible_excess',
        excess_eur: excess,
        existing_adjustment_eur: null,
        proposed_adjustment: {
          type: 'depreciation_difference',
          tax_year: year,
          amount_eur: excess,
          note_fi:
            'Ehdotus: kirjanpidon poistot ylittävät EVL 30 §:n enimmäispoiston cutover-kannasta laskettuna. Lisää poistoero, jos tilikaudella ei ollut koneiden ja kaluston lisäyksiä — lisäykset kasvattavat menojäännöstä ja enimmäispoistoa, jolloin ylitystä ei välttämättä ole.'
        },
        note_fi:
          'Kirjanpidon poistot näyttävät ylittävän EVL-enimmäispoiston — ehdotettu poistoero odottaa ihmisen vahvistusta (kirjaus tehdään profiilin tax_adjustments-polkua).'
      };
    }
  }

  const summary_fi = pool
    ? comparison?.severity === 'possible_excess' && comparison.proposed_adjustment
      ? 'EVL-enimmäispoisto laskettu — kirjanpidon poistot näyttävät ylittävän sen; poistoero-ehdotus odottaa vahvistusta.'
      : `EVL 30 §:n enimmäispoisto laskettu cutover-kannasta${pool.small_pool_rule_applied ? ' (pieni menojäännös — vähennettävissä kokonaan)' : ''}.`
    : 'Kirjatussa kannassa ei ole koneita ja kalustoa — EVL 30 §:n enimmäispoistoa ei lasketa.';

  return { ...base, status: 'computed', pool, comparison, summary_fi };
};
