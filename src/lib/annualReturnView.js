// FI-12 read surface — pure view-model helpers for the persisted annual-return
// verdict (docs/design-donna-finland-fi12-read-surface.md, D-FI12-R3).
//
// Render-the-persisted-verdict: everything here is formatting/labelling of the
// consequence envelope `getFinlandAnnualReturnFromDb` returns. NO arithmetic
// beyond display rounding, no re-derivation of any figure, no model call.

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// EUR display: fi-style comma decimals + thin-space grouping ("12 345,67 €").
export const formatEur = (value) => {
  const n = Math.round((num(value) + Number.EPSILON) * 100) / 100;
  const [int, dec] = Math.abs(n).toFixed(2).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${n < 0 ? '−' : ''}${grouped},${dec} €`;
};

const fiDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${Number(m[3])}.${Number(m[2])}.${Number(m[1])}` : String(iso || '');
};

// The closed blocker vocabulary the DB caller emits. `no_prior_year_end` is
// info-grade (the envelope itself excludes it from the needs_review decision).
// An unknown code renders as itself — surfacing beats prettiness.
const BLOCKER_VIEWS = {
  missing_incorporation_date: {
    severity: 'blocker',
    label: 'Perustamispäivä puuttuu',
    hint: 'Tilikautta ei voi ratkaista ilman asiakkaan perustamispäivää — lisää se asiakkaan profiiliin.'
  },
  prior_balance_sheet_imbalance: {
    severity: 'blocker',
    label: 'Edellisen tilikauden tase ei täsmää',
    hint: 'Nettovarallisuutta (pääomatulo-osuuden jakoa) ei lasketa täsmäämättömästä taseesta; tulos näytetään kokonaan ansiotulona kunnes tase on korjattu.'
  },
  unmapped_income_rows: {
    severity: 'blocker',
    label: 'Kohdistamattomia tuloslaskelman rivejä',
    hint: 'Rivit, joita ei voitu kohdistaa veroilmoituksen eriin, on listattu alla — ne on koodattava ennen kuin ilmoitus on valmis.'
  },
  no_prior_year_end: {
    severity: 'info',
    label: 'Ei edellistä tilikautta',
    hint: 'Ensimmäinen tilikausi: pääomatulo-osuuden jako tehdään vasta, kun edellisen vuoden nettovarallisuus on olemassa.'
  }
};

export const blockerView = (code) => {
  const known = BLOCKER_VIEWS[code];
  if (known) return { code, ...known };
  return { code, severity: 'blocker', label: String(code || 'unknown'), hint: null };
};

const INCOME_LABELS = [
  ['sales', 'Liikevaihto (myyntituotot)'],
  ['otherIncome', 'Muut tuotot']
];
const EXPENSE_LABELS = [
  ['materials', 'Aineet, tarvikkeet ja tavarat'],
  ['personnel', 'Henkilöstökulut'],
  ['otherOperating', 'Muut vähennyskelpoiset kulut'],
  ['depreciation', 'Poistot'],
  ['financial', 'Rahoituskulut']
];
const ADDITIONAL_LABELS = [
  ['travel', 'Lisävähennys: matkakulut (ajopäiväkirja/päivärahat)'],
  ['other', 'Muut lisävähennykset']
];

const bucketRows = (bucket = {}, labels) =>
  labels
    .map(([key, label]) => ({ key, label, amount: num(bucket?.[key]), display: formatEur(bucket?.[key]) }))
    .filter((row) => row.amount !== 0);

// buildAnnualReturnViewModel(envelope) → everything the panel renders, or null
// for a shape that is not an annual-return envelope (callers hide the surface).
export const buildAnnualReturnViewModel = (envelope) => {
  if (!envelope || typeof envelope !== 'object' || !envelope.review || !envelope.return) return null;
  const verdict = envelope.return;
  const review = envelope.review;
  const tilikausi = envelope.tilikausi || null;

  const split = verdict.split && typeof verdict.split === 'object'
    ? {
        capitalReturnRate: num(verdict.split.capitalReturnRate),
        capitalIncome: formatEur(verdict.split.capitalIncome),
        earnedIncome: formatEur(verdict.split.earnedIncome),
        netBusinessAssets: verdict.netBusinessAssets == null ? null : formatEur(verdict.netBusinessAssets)
      }
    : null;

  return {
    status: review.status === 'ready' ? 'ready' : 'needs_review',
    taxYear: envelope.taxYear ?? verdict.taxYear ?? null,
    tilikausiLabel: tilikausi ? `${fiDate(tilikausi.starts_on)} – ${fiDate(tilikausi.ends_on)}` : null,
    basis: envelope.basis || null,
    blockers: (Array.isArray(review.blockers) ? review.blockers : []).map(blockerView),
    incomeRows: bucketRows(verdict.income, INCOME_LABELS),
    incomeTotal: formatEur(verdict.income?.total),
    expenseRows: bucketRows(verdict.deductibleExpenses, EXPENSE_LABELS),
    expenseTotal: formatEur(verdict.deductibleExpenses?.total),
    additionalRows: bucketRows(verdict.additionalDeductions, ADDITIONAL_LABELS),
    additionalTotal: num(verdict.additionalDeductions?.total) !== 0 ? formatEur(verdict.additionalDeductions?.total) : null,
    resultLabel: verdict.isLoss ? 'Elinkeinotoiminnan tappio' : 'Elinkeinotoiminnan tulos',
    result: formatEur(verdict.result),
    isLoss: verdict.isLoss === true,
    split,
    // The aggregator's honest deferral — rendered as a note, NEVER recomputed
    // client-side (render-the-persisted-verdict).
    splitDeferredNote: verdict.needsNetAssetsForSplit === true
      ? 'Pääomatulo-osuuden jako odottaa edellisen tilikauden nettovarallisuutta — tulos käsitellään toistaiseksi ansiotulona.'
      : null,
    // G-10: where the nettovarallisuus figure came from (the persisted verdict
    // stamps its own provenance; cutover_profile = the recorded prior-year
    // figure from the switcher's cutover pack).
    netAssetsSourceNote: verdict.net_assets_source === 'cutover_profile'
      ? 'Nettovarallisuus on kirjattu cutover-paketista (edellisen vuoden vahvistettu nettovarallisuus) — ei johdettu Donnan taseesta.'
      : null,
    // G-11: recorded accounting-vs-tax adjustments, rendered verbatim from the
    // verdict — per-item add-backs/deductions with the book-side result beside
    // the adjusted (taxable) one. Absent ⇒ null (surface hides the section).
    taxAdjustments: verdict.taxAdjustments && Array.isArray(verdict.taxAdjustments.items) && verdict.taxAdjustments.items.length
      ? {
          items: verdict.taxAdjustments.items.map((item) => ({
            type: item.type,
            label: item.label_fi || item.type,
            amount: formatEur(item.amount_eur),
            addBack: num(item.add_back_eur) !== 0 ? formatEur(item.add_back_eur) : null,
            deduction: num(item.deduction_eur) !== 0 ? formatEur(item.deduction_eur) : null,
            note: item.note || null
          })),
          totalAddBacks: formatEur(verdict.taxAdjustments.totalAddBacks),
          totalDeductions: formatEur(verdict.taxAdjustments.totalDeductions),
          resultBeforeAdjustments: formatEur(verdict.resultBeforeAdjustments)
        }
      : null,
    // G-10: cutover facts riding the envelope (losses Vero deducts in
    // assessment + recorded EVL asset bases) — informational, verbatim.
    cutover: envelope.cutover && typeof envelope.cutover === 'object'
      ? {
          confirmedLosses: (Array.isArray(envelope.cutover.confirmed_losses_on_record) ? envelope.cutover.confirmed_losses_on_record : [])
            .map((loss) => ({ taxYear: loss.tax_year, amount: formatEur(loss.amount_eur) })),
          fixedAssetTaxBases: (Array.isArray(envelope.cutover.fixed_asset_tax_bases) ? envelope.cutover.fixed_asset_tax_bases : [])
            .map((asset) => ({ description: asset.description, category: asset.category, base: formatEur(asset.undepreciated_balance_eur) })),
          lossesNote: envelope.cutover.losses_note_fi || null
        }
      : null,
    // F-G10-3: the EVL 30 § maximum-depreciation verdict, rendered verbatim —
    // pool figures, not-computed categories, the booked-vs-max comparison and
    // its proposal (human-confirmed; the view never applies anything).
    evlDepreciation: envelope.evl_depreciation && typeof envelope.evl_depreciation === 'object'
      ? {
          status: envelope.evl_depreciation.status || null,
          summary: envelope.evl_depreciation.summary_fi || null,
          rateLabel: envelope.evl_depreciation.rate && Number.isFinite(Number(envelope.evl_depreciation.rate.machinery_rate))
            ? `${Math.round(Number(envelope.evl_depreciation.rate.machinery_rate) * 100)} % (EVL 30 §)`
            : null,
          pool: envelope.evl_depreciation.pool && typeof envelope.evl_depreciation.pool === 'object'
            ? {
                openingBase: formatEur(envelope.evl_depreciation.pool.opening_menojaannos_eur),
                maxPoisto: formatEur(envelope.evl_depreciation.pool.max_poisto_eur),
                closingIfMax: formatEur(envelope.evl_depreciation.pool.closing_menojaannos_if_max_eur),
                smallPoolRuleApplied: envelope.evl_depreciation.pool.small_pool_rule_applied === true
              }
            : null,
          notComputed: (Array.isArray(envelope.evl_depreciation.not_computed) ? envelope.evl_depreciation.not_computed : [])
            .map((entry) => ({
              category: entry.category,
              base: formatEur(entry.recorded_base_eur),
              reason: entry.reason_fi || null
            })),
          comparison: envelope.evl_depreciation.comparison && typeof envelope.evl_depreciation.comparison === 'object'
            ? {
                severity: envelope.evl_depreciation.comparison.severity || null,
                booked: envelope.evl_depreciation.comparison.booked_depreciation_eur == null
                  ? null
                  : formatEur(envelope.evl_depreciation.comparison.booked_depreciation_eur),
                headroom: envelope.evl_depreciation.comparison.headroom_eur == null
                  ? null
                  : formatEur(envelope.evl_depreciation.comparison.headroom_eur),
                excess: envelope.evl_depreciation.comparison.excess_eur == null
                  ? null
                  : formatEur(envelope.evl_depreciation.comparison.excess_eur),
                existingAdjustment: envelope.evl_depreciation.comparison.existing_adjustment_eur == null
                  ? null
                  : formatEur(envelope.evl_depreciation.comparison.existing_adjustment_eur),
                proposedAdjustment: envelope.evl_depreciation.comparison.proposed_adjustment
                  ? {
                      type: envelope.evl_depreciation.comparison.proposed_adjustment.type,
                      amount: formatEur(envelope.evl_depreciation.comparison.proposed_adjustment.amount_eur),
                      note: envelope.evl_depreciation.comparison.proposed_adjustment.note_fi || null
                    }
                  : null,
                note: envelope.evl_depreciation.comparison.note_fi || null
              }
            : null,
          provenanceNote: envelope.evl_depreciation.rate?.confirmedAgainstPrimary === false
            ? 'EVL 30 §:n prosentti ja pienen menojäännöksen raja on varmennettu toissijaisista lähteistä — ensisijainen säädöslähde vahvistetaan erikseen.'
            : null
        }
      : null,
    unmappedRows: (Array.isArray(review.unmappedIncomeStatementRows) ? review.unmappedIncomeStatementRows : [])
      .map((row) => ({
        code: row.code ?? null,
        name: row.name ?? null,
        revenue: formatEur(row.revenue),
        expense: formatEur(row.expense)
      })),
    nonDeductibleNote: num(review.nonDeductibleIncomeTaxes) > 0
      ? `Tuloverot ${formatEur(review.nonDeductibleIncomeTaxes)} eivät ole vähennyskelpoisia — ne on jätetty tuloksen ulkopuolelle ja näytetään tässä.`
      : null,
    provenanceLine: envelope.provenance?.deterministic
      ? `Deterministinen laskenta kirjatusta pääkirjasta (ei mallikutsua)${envelope.provenance?.readAt ? ` · luettu ${fiDate(envelope.provenance.readAt)}` : ''}`
      : null
  };
};
