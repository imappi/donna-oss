// FI-3 read surface — pure view-model helpers for the ALV-return consequence
// envelope (docs/design-donna-finland-fi3-alv-return.md) and the persisted
// alv_returns lifecycle row.
//
// Render-the-persisted-verdict: everything here is formatting/labelling of what
// `getFinlandAlvReturnFromDb` (and the lifecycle row the API attaches) already
// says. NO arithmetic beyond display rounding, no re-derivation of any box, no
// model call. The statutory box map's source of truth is the server vocabulary
// (`server/donna/finland/alvCodes.js`, pin-tested); the labels here are
// display-only copies, same convention as annualReturnView.js.

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

// Display copies of the VSRALVKV field labels (order = render order).
const BOX_LABELS = [
  ['301', 'Vero kotimaan myynnistä 25,5 %'],
  ['302', 'Vero kotimaan myynnistä 14 %'],
  ['303', 'Vero kotimaan myynnistä 10 %'],
  ['304', 'Vero tavaroiden maahantuonnista EU:n ulkopuolelta'],
  ['305', 'Vero tavaraostoista muista EU-maista'],
  ['306', 'Vero palveluostoista muista EU-maista'],
  ['318', 'Vero rakentamispalvelun ostoista (käännetty)'],
  ['307', 'Kohdekauden vähennettävä vero'],
  ['309', '0-verokannan alainen liikevaihto'],
  ['310', 'Tavaroiden maahantuonnit EU:n ulkopuolelta'],
  ['311', 'Tavaroiden myynnit muihin EU-maihin'],
  ['312', 'Palveluiden myynnit muihin EU-maihin'],
  ['313', 'Tavaraostot muista EU-maista'],
  ['314', 'Palveluostot muista EU-maista'],
  ['319', 'Rakentamispalvelun myynnit (käännetty)'],
  ['320', 'Rakentamispalvelun ostot (käännetty)']
];
export const ALV_VIEW_BOX_FIELDS = BOX_LABELS.map(([field]) => field);

// The closed blocker vocabulary the engine emits (D-FI3-A4/A5). An unknown
// code renders as itself — surfacing beats prettiness.
const BLOCKER_VIEWS = {
  uncoded_revenue_lines: {
    severity: 'blocker',
    label: 'Tulotapahtumia ilman ALV-käsittelyä',
    hint: 'ALV-velvollisen kirjanpidossa jokaisella tulorivillä on oltava ALV-käsittely — koodaamaton tulo voi olla ilmoittamatonta myynnin veroa. Rivit on listattu alla.'
  },
  incompatible_tax_lines: {
    severity: 'blocker',
    label: 'ALV-koodi ei sovi tilille',
    hint: 'Myyntikoodi kululla, ostokoodi tuotolla tai ALV-koodi ALV-velkatilillä — rivit on listattu alla ja korjattava ennen ilmoitusta.'
  },
  // D-FI3-S5/S7 — the split-posting cross-check disagreed with the computed
  // boxes. Typical causes: a line coded before the split convention landed
  // (posted gross, no control leg — the S7 retroactivity catch), a hand-edited
  // control leg, or a manual journal on 2939/2940.
  control_account_mismatch: {
    severity: 'blocker',
    label: 'ALV-velkatilien kirjaukset eivät täsmää laskettuun veroon',
    hint: 'Kirjattujen ALV-erien (2939/2940) summa poikkeaa ilmoituksen laskennasta yli toleranssin — odotettu ja kirjattu summa näkyvät alla. Tyypillinen syy: ennen jakokirjauskäytäntöä bruttona kirjattu rivi tai käsin muokattu ALV-vienti. Korjaa uudelleenkoodauksella (peruutus + uusi kirjaus) ennen ilmoitusta.'
  }
};

// FI-09: uploaded sales documents, and separately uploaded supplier documents,
// the posted ledger does not recognise in the period. The engine names each
// one; the hint lists them so the firm sees exactly what the boxes leave out.
const RECOGNITION_RESTS = {
  no_settlement: 'maksua ei ole tiliotteilla',
  settlement_proposed: 'maksu on ehdotettu, ei vahvistettu',
  settlement_unposted: 'maksu on täsmäytetty, mutta kirjaus odottaa',
  settled_outside_period: 'maksu on kirjattu toiselle kaudelle'
};
const RECOGNITION_VIEWS = {
  unrecognized_sales_documents: {
    reviewKey: 'unrecognizedSales',
    label: 'Ladattuja myyntilaskuja puuttuu kirjanpidosta',
    lead: 'Nämä ladatut laskut eivät ole vielä tämän kauden kirjanpidossa, joten niiden myynti ja ALV puuttuvat yllä olevista luvuista:',
    what: (item) => (item.kind === 'credit_note' ? 'Hyvityslasku' : 'Myyntilasku'),
    netLabel: ''
  },
  unrecognized_purchase_documents: {
    reviewKey: 'unrecognizedPurchases',
    label: 'Ladattuja ostolaskuja puuttuu kirjanpidosta',
    lead: 'Nämä ladatut ostolaskut eivät ole vielä tämän kauden kirjanpidossa, joten niiden kulut ja vähennettävä ALV puuttuvat yllä olevista luvuista:',
    what: (item) => (item.kind === 'credit_note' ? 'Ostohyvityslasku' : 'Ostolasku'),
    netLabel: 'kulu '
  }
};
const unrecognizedHint = (view, gap) => {
  const items = Array.isArray(gap?.items) ? gap.items : [];
  const rows = items.map((item) => {
    const who = [item.invoice_numbers?.[0], item.counterparty ?? item.customer ?? item.vendor].filter(Boolean).join(', ');
    const amount = item.tax == null ? `${formatEur(item.gross)} (ALV-erittely puuttuu)` : `${view.netLabel}${formatEur(item.net)} + ALV ${formatEur(item.tax)}`;
    return `${view.what(item)}${who ? ` ${who}` : ''}${item.document_date ? ` (${fiDate(item.document_date)})` : ' (päiväys puuttuu)'}: ${amount} — ${RECOGNITION_RESTS[item.rests] || item.rests}${item.on_nobody ? '' : ', kysytty'}.`;
  });
  return [view.lead, ...rows].join(' ');
};

export const alvBlockerView = (code, review = null) => {
  const recognition = RECOGNITION_VIEWS[code];
  if (recognition) {
    return { code, severity: 'blocker', label: recognition.label, hint: unrecognizedHint(recognition, review?.[recognition.reviewKey]) };
  }
  const known = BLOCKER_VIEWS[code];
  if (known) return { code, ...known };
  return { code, severity: 'blocker', label: String(code || 'unknown'), hint: null };
};

const PERIOD_TYPE_LABELS = { month: 'kuukausi', quarter: 'neljännes', year: 'vuosi' };

// The lifecycle row's closed enum (migration 066) → owner-honest display. The
// two resting states are exactly the sanctioned terminals + on-owner.
const LIFECYCLE_VIEWS = {
  draft_pending_confirmation: { tone: 'pending', label: 'Odottaa omistajan vahvistusta (WhatsApp)' },
  filed: { tone: 'ok', label: 'Lähetetty Verohallinnolle' },
  cancelled: { tone: 'muted', label: 'Peruttu' }
};

// The previous COMPLETED period key for each cadence — the current one is still
// accruing. Pure calendar math shared by the default + the picker builders.
const prevMonthKey = (now) => {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-based; the previous month is m (1-based)
  const prevY = m === 0 ? y - 1 : y;
  const prevM = m === 0 ? 12 : m;
  return `${prevY}-${String(prevM).padStart(2, '0')}`;
};
const prevQuarterKey = (now) => {
  let qy = now.getUTCFullYear();
  let q = Math.floor(now.getUTCMonth() / 3); // previous quarter (0 → Q4 prior year)
  if (q === 0) { qy -= 1; q = 4; }
  return `${qy}-Q${q}`;
};
const prevYearKey = (now) => String(now.getUTCFullYear() - 1);

// The three picker groups, each newest-first. Split out so the picker can LEAD
// with the client's cadence (F-FI3-3) while still offering the others.
const monthOptions = (now) => {
  const options = [];
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth(); // 1-based previous month (getUTCMonth is 0-based current)
  if (m === 0) { y -= 1; m = 12; }
  for (let i = 0; i < 12; i += 1) {
    options.push({ key: `${y}-${String(m).padStart(2, '0')}`, label: `${String(m).padStart(2, '0')}/${y}` });
    m -= 1;
    if (m === 0) { y -= 1; m = 12; }
  }
  return options;
};
const quarterOptions = (now) => {
  const options = [];
  let qy = now.getUTCFullYear();
  let q = Math.floor(now.getUTCMonth() / 3); // previous quarter (0 → Q4 prior year)
  if (q === 0) { qy -= 1; q = 4; }
  for (let i = 0; i < 4; i += 1) {
    options.push({ key: `${qy}-Q${q}`, label: `Q${q}/${qy}` });
    q -= 1;
    if (q === 0) { qy -= 1; q = 4; }
  }
  return options;
};
const yearOptions = (now) => {
  const yr = now.getUTCFullYear();
  return [{ key: String(yr), label: String(yr) }, { key: String(yr - 1), label: String(yr - 1) }];
};

// Normalise a cadence to the ALV engine's period-type vocabulary. Unknown/absent
// ⇒ the D3 monthly default (mirrors the server's verokausiCadenceForProfile).
const CADENCE_TYPES = ['month', 'quarter', 'year'];
const normaliseCadence = (cadence) => (CADENCE_TYPES.includes(cadence) ? cadence : 'month');

// Book inspection follows the selected historical month, using the filing
// cadence returned by the scoped server reader. No registration is inferred.
export const alvPeriodForJournalMonth = (month, cadence = 'month') => {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(month || ''));
  if (!match) return '';
  if (normaliseCadence(cadence) === 'year') return match[1];
  if (normaliseCadence(cadence) === 'quarter') return `${match[1]}-Q${Math.ceil(Number(match[2]) / 3)}`;
  return month;
};

// defaultAlvPeriodKey(now, cadence) — the PREVIOUS completed period for the
// client's verokausi cadence (D3 monthly default; the current period is still
// accruing). Cadence omitted ⇒ monthly, so existing callers are unchanged.
export const defaultAlvPeriodKey = (now = new Date(), cadence = 'month') => {
  switch (normaliseCadence(cadence)) {
    case 'quarter': return prevQuarterKey(now);
    case 'year': return prevYearKey(now);
    default: return prevMonthKey(now);
  }
};

// alvPeriodOptions(now, cadence) — the picker vocabulary (12 months, 4 quarters,
// 2 years). The client's cadence group leads so the primary choices match how the
// client actually files; cadence omitted ⇒ monthly-first (the prior order).
export const alvPeriodOptions = (now = new Date(), cadence = 'month') => {
  const groups = { month: monthOptions(now), quarter: quarterOptions(now), year: yearOptions(now) };
  const lead = normaliseCadence(cadence);
  const rest = CADENCE_TYPES.filter((c) => c !== lead);
  return [lead, ...rest].flatMap((c) => groups[c]);
};

// The server's verokausi_basis → one owner-honest sentence, or null. Finnish,
// like the other notes in this view model. Two recorded VAT periods that
// differ, or a monthly default with nothing recorded, are shown here — the
// view never picks between them.
const CADENCE_WORDS = { month: 'kuukausi', quarter: 'neljännesvuosi', year: 'kalenterivuosi' };
const cadenceNoticeFor = (basis) => {
  if (!basis || typeof basis !== 'object') return null;
  const inUse = CADENCE_WORDS[normaliseCadence(basis.cadence)];
  const taxPeriod = CADENCE_WORDS[basis.recorded?.alv_registration_tax_period] || null;
  if (basis.disagreement && taxPeriod) {
    return {
      kind: 'disagreement',
      text: basis.defaulted
        ? `Yrityksen tiedoissa ei ole verokautta, joten luvut lasketaan oletuksella (${inUse}), mutta ALV-rekisteröinnissä verokausi on: ${taxPeriod}. Kirjaa verokausi yrityksen tietoihin, niin ristiriita poistuu.`
        : `Verokausi on kirjattu kahteen paikkaan eri tavoin – yrityksen tiedoissa: ${inUse}, ALV-rekisteröinnissä: ${taxPeriod}. Luvut lasketaan yrityksen tietojen verokaudella, kunnes toinen korjataan.`
    };
  }
  if (basis.defaulted) {
    return { kind: 'defaulted', text: `Yritykselle ei ole kirjattu verokautta, joten luvut lasketaan oletuksella (${inUse}).` };
  }
  return null;
};

// buildAlvReturnViewModel(envelope) → everything the panel renders, or null for
// a shape that is not an ALV-return envelope (callers hide the surface).
export const buildAlvReturnViewModel = (envelope) => {
  if (!envelope || typeof envelope !== 'object' || !envelope.review || !envelope.alvReturn) return null;
  const alvReturn = envelope.alvReturn;
  const review = envelope.review;
  const period = envelope.period || {};
  const boxes = alvReturn.boxes || {};

  const payable = num(alvReturn.payable);
  const lifecycleRow = envelope.lifecycle && typeof envelope.lifecycle === 'object' ? envelope.lifecycle : null;
  const lifecycleView = lifecycleRow ? LIFECYCLE_VIEWS[lifecycleRow.status] || null : null;

  return {
    status: review.status === 'ready' ? 'ready' : 'needs_review',
    periodKey: period.key || null,
    periodTypeLabel: PERIOD_TYPE_LABELS[period.type] || null,
    periodRangeLabel: period.starts_on && period.ends_on ? `${fiDate(period.starts_on)} – ${fiDate(period.ends_on)}` : null,
    nilReturn: alvReturn.nilReturn === true,
    refund: alvReturn.refund === true,
    payableLabel: alvReturn.refund === true ? 'Palautukseen oikeuttava vero (308)' : 'Maksettava vero (308)',
    payableDisplay: formatEur(alvReturn.refund === true ? Math.abs(payable) : payable),
    boxRows: BOX_LABELS
      .map(([field, label]) => ({ field, label, amount: num(boxes[field]), display: formatEur(boxes[field]) }))
      .filter((row) => row.amount !== 0),
    blockers: (Array.isArray(review.blockers) ? review.blockers : []).map((code) => alvBlockerView(code, review)),
    uncodedRevenueLines: (Array.isArray(review.uncodedRevenueLines) ? review.uncodedRevenueLines : [])
      .map((line) => ({
        journalId: line.journal_id ?? null,
        accountCode: line.account_code ?? null,
        display: formatEur(line.amount)
      })),
    incompatibleLines: (Array.isArray(review.incompatibleLines) ? review.incompatibleLines : [])
      .map((line) => ({
        journalId: line.journal_id ?? null,
        accountCode: line.account_code ?? null,
        taxType: line.tax_type ?? null,
        display: formatEur(line.amount)
      })),
    uncodedExpenseNote: num(review.uncodedExpenseLineCount) > 0
      ? `${num(review.uncodedExpenseLineCount)} kulutapahtumaa ilman ALV-käsittelyä — vähennys jää käyttämättä (ei estä ilmoitusta).`
      : null,
    // D-FI3-S5 — the control cross-check, rendered from the persisted verdict.
    // Expected vs actual rows appear when the check ran (they are the diagnosis
    // an operator needs when the mismatch blocker fires); the unmarked-movement
    // INFO note is the 308 settlement's designed resting surface.
    controlCheckRows: review.controlCheck?.ran
      ? [
          { key: 'outputTax', label: 'Myynnin vero ALV-veloissa (2939)', pair: review.controlCheck.outputTax },
          { key: 'domesticDeductible', label: 'Vähennettävä vero ALV-saamisissa (2940)', pair: review.controlCheck.domesticDeductible }
        ].map(({ key, label, pair }) => ({
          key,
          label,
          expected: formatEur(pair?.expected),
          actual: formatEur(pair?.actual),
          // Mirrors the engine's verdict: outside tolerance = the mismatch that
          // blocks; within it, the row is informational agreement.
          mismatch: Math.abs(num(pair?.expected) - num(pair?.actual)) > num(review.controlCheck.tolerance)
        }))
      : [],
    unmarkedControlMovementNote: num(review.controlCheck?.unmarkedControlMovement) !== 0
      ? `${formatEur(Math.abs(num(review.controlCheck.unmarkedControlMovement)))} liikettä ALV-velkatileillä ilman ALV-roolimerkintää (esim. OmaVero-maksu tai käsin tehty vienti) — ei estä ilmoitusta.`
      : null,
    // The D-FI3-A2 assumption, surfaced verbatim — never silently assumed away.
    // Where the cadence came from (server verokausi_basis). Two recorded VAT
    // periods that differ, or a monthly default with nothing recorded, are
    // shown — never resolved silently here.
    cadenceNotice: cadenceNoticeFor(envelope.verokausi_basis),
    selfAssessedNote: alvReturn.selfAssessedFullyDeductible === true && num(boxes['307']) !== 0
      ? 'Käännetyn verovelvollisuuden ja maahantuonnin vero on vähennetty täysimääräisesti (oletus: vain vähennyskelpoista liiketoimintakäyttöä).'
      : null,
    // The client's other live returns whose dates overlap this period (the
    // server's covered_by: a filed 2026-Q3 covers 2026-09). Rendered as the
    // server says; the view decides nothing about which return counts.
    coveredBy: (Array.isArray(envelope.covered_by) ? envelope.covered_by : [])
      .filter((row) => row && row.period_key && (row.status === 'filed' || row.status === 'draft_pending_confirmation'))
      .map((row) => ({
        periodKey: row.period_key,
        status: row.status,
        tone: row.status === 'filed' ? 'ok' : 'pending',
        rangeLabel: row.starts_on && row.ends_on ? `${fiDate(row.starts_on)} – ${fiDate(row.ends_on)}` : null
      })),
    lifecycle: lifecycleRow
      ? {
          status: lifecycleRow.status,
          tone: lifecycleView?.tone || 'muted',
          label: lifecycleView?.label || String(lifecycleRow.status),
          filedAt: lifecycleRow.filed_at ? fiDate(lifecycleRow.filed_at) : null,
          submissionId: lifecycleRow.filing_receipt?.submission_id || null,
          cancelReason: lifecycleRow.cancel_reason || null
        }
      : null,
    provenanceLine: envelope.provenance?.deterministic
      ? `Deterministinen laskenta kirjatusta pääkirjasta (ei mallikutsua)${envelope.provenance?.readAt ? ` · luettu ${fiDate(envelope.provenance.readAt)}` : ''}`
      : null,
    boxMapUnconfirmedNote: envelope.provenance?.boxMap && envelope.provenance.boxMap.confirmedAgainstPrimary === false
      ? 'Kenttäkartta odottaa vahvistusta ensisijaisesta VSRALVKV-tietuekuvauksesta (F-FI3-1).'
      : null
  };
};
