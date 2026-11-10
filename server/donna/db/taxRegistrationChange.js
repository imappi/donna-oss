// A posted line's VAT/ALV registration basis, and whether the registration
// record still says what the line was posted under.
//
// Registration is evidence for the dated decision, never retrospective
// posting authority (codingEvidence.js, changedNativeRegistration). A Finnish
// or UK bank line posts with a VAT split only when the record says registered
// on its date (#55), and without VAT when it says not registered (#64). The
// record can change after the line posted: the owner answers that the
// business has been registered since an earlier date, or the firm corrects
// the record. The line's journal stays as it is. This module only reads:
//
// - postedTaxRegistrationStatus: the status a posted line was posted under.
//   A posted VAT-carrying code (the country's own recogniser,
//   taxRegistration.withoutTax.needsRegistration, on the tax type the
//   journal still carries after any correction) means it was posted as
//   registered: the ledger refuses such a code for a business that is not
//   (#55). Otherwise the coding's receipt of the fact it was coded under
//   (ai_suggestion.tax_registration_fact, written by #64) says not
//   registered. A line with neither (a line posted before #64 with no VAT
//   code, or one coded while the record was silent) has no known basis and
//   is not compared: nothing it was posted under can be shown to have changed.
//   After a correction case for this reason was corrected, the status it was
//   corrected under is the basis.
// - taxRegistrationChangeFor: the change, when the record's status on the
//   line's governing date is now registered for a line posted as not
//   registered, or not registered for a line posted as registered. A record
//   that is now silent on the date (unknown) is not a change here: the
//   registration question (#62) owns an unknown record. Only the status is
//   compared, so a change to a filing period, a basis or a VAT number moves
//   nothing.
// - The governing date is the one the receipt recorded, else the line's own
//   date: the date the bank-line posting policy reads registration on.
// - taxRegistrationPeriodState: whether the line's date is in a locked close
//   period, or in a VAT return the country records as filed (a country
//   declares filedReturnOn; the UK keeps no filed-return record today).
//
// The correction case that carries the change is the existing one
// (codingEvidence.js recoverChangedCodingEvidenceInDb). The profile writer
// (clients.js updateClientProfileInDb) names the lines a record change
// affects on its own receipt (postedLinesAffectedByRegistrationChange).
// Nothing here knows a country: the rule is the posting policy's
// taxRegistration declaration.
import { hash } from '../jevEvidenceContract.js';
import { correctionDeltaLines } from '../ledgerCorrectionLines.js';
import { resolvePostingPolicy } from '../postingPolicy.js';
import { clientFlagActs, readClientConfigSnapshot } from '../clientConfig.js';
import { toIsoDay } from '../dates.js';

// The rollout gate of the clock-side detection (codingEvidence.js). Off, the
// clock opens no case for this reason; the profile writer's receipt still
// names the affected lines, with correction_cases_enabled false.
export const TAX_REGISTRATION_RECHECK_FLAG = 'TAX_REGISTRATION_POSTED_RECHECK';
export const taxRegistrationRecheckActs = (snapshot) =>
  clientFlagActs({ flagKey: TAX_REGISTRATION_RECHECK_FLAG, snapshot, envFallback: () => false });
export const taxRegistrationRecheckActsWithClient = async ({ client, firmId, clientId }) =>
  taxRegistrationRecheckActs(await readClientConfigSnapshot(client, { firmId, clientId }));

// The receipt names at most this many lines; the count is always exact.
export const AFFECTED_LINE_ID_LIMIT = 200;

export const taxRegistrationRuleFor = (jurisdiction) => {
  try { return resolvePostingPolicy({ jurisdiction }).taxRegistration || null; } catch { return null; }
};

const stateOf = (status) => status?.registered === true ? 'registered' : status?.registered === false ? 'not_registered' : 'unknown';

// lines: the journal's posted lines net of its corrections (tax_type, debit, credit).
export const postedTaxRegistrationStatus = ({ rule, payload = {}, lines = [] }) => {
  if (!rule?.withoutTax) return null;
  const corrected = payload.coding_correction_required;
  if (corrected?.status === 'corrected' && corrected.tax_registration?.current?.status) {
    return { status: corrected.tax_registration.current.status, basis: 'corrected_case',
      on_date: corrected.tax_registration.on_date || null };
  }
  const receipt = payload.ai_suggestion?.tax_registration_fact || null;
  const onDate = toIsoDay(receipt?.on_date) || null;
  const vatCodes = [...new Set(lines.filter((line) => Number(line.debit || 0) || Number(line.credit || 0))
    .map((line) => String(line.tax_type || '').trim()).filter(Boolean))].filter((taxType) => {
    try { return Boolean(rule.withoutTax.needsRegistration({ taxType, taxTreatment: '', direction: '' })); } catch { return false; }
  }).sort();
  if (vatCodes.length) return { status: 'registered', basis: 'posted_vat_code', vat_codes: vatCodes, on_date: onDate };
  if (receipt?.status === 'not_registered') return { status: 'not_registered', basis: 'coding_receipt', on_date: onDate };
  return null;
};

export const taxRegistrationGoverningDate = ({ row, posted }) =>
  posted?.on_date || toIsoDay(row.transaction_date ?? row.date ?? null) || null;

export const taxRegistrationStatusOn = ({ rule, profile, onDate }) => {
  let status;
  try { status = rule.onDate({ profile: profile || {}, onDate }); } catch { status = { registered: null, reason: 'registration_unavailable' }; }
  return { status: stateOf(status), reason: status?.reason || null };
};

const CHANGES = Object.freeze({ not_registered: 'registered', registered: 'not_registered' });
export const taxRegistrationChangeFor = ({ rule, profile, row, lines }) => {
  const posted = postedTaxRegistrationStatus({ rule, payload: row.payload || {}, lines });
  if (!posted) return null;
  const onDate = taxRegistrationGoverningDate({ row, posted });
  if (!onDate) return null;
  const current = taxRegistrationStatusOn({ rule, profile, onDate });
  if (CHANGES[posted.status] !== current.status) return null;
  const direction = current.status === 'registered' ? 'became_registered' : 'became_not_registered';
  return { version: 1, on_date: onDate, direction, posted, current,
    digest: hash({ on_date: onDate, posted: posted.status, current: current.status }) };
};

// The posted lines of a bank line's journal net of its correction journals,
// for every posted line of the client (or the ids given). One read.
export const readPostedLineTaxTypes = async ({ client, firmId, clientId, transactionIds = null }) => {
  const rows = (await client.query(`select t.id, t.transaction_date, t.payload, j.id as journal_id,
      (select coalesce(jsonb_agg(jsonb_build_object('account_code', l.account_code, 'currency', l.currency, 'tax_type', l.tax_type,
          'role', l.payload->>'role', 'debit', l.debit, 'credit', l.credit) order by l.line_no, l.id), '[]'::jsonb)
         from ledger_lines l
        where l.firm_id = j.firm_id and l.client_id = j.client_id
          and (l.journal_id = j.id or l.journal_id in (select cj.id from ledger_journals cj where cj.firm_id = j.firm_id
            and cj.client_id = j.client_id and cj.correction_of_journal_id = j.id and cj.status in ('posted', 'closed')))) as lines
    from transactions t
    join ledger_journals j on j.firm_id = t.firm_id and j.client_id = t.client_id and j.id = t.payload->>'ledger_journal_id'
      and j.source_id = t.id and j.status in ('posted', 'closed')
   where t.firm_id = $1 and t.client_id = $2 and ($3::text[] is null or t.id = any($3::text[]))
   order by t.id`, [firmId, clientId, transactionIds])).rows;
  return rows.map((row) => ({ ...row, lines: correctionDeltaLines([], row.lines || []) }));
};

// Locked close period or filed VAT return on the line's date. Nothing posts
// into either; the correction case says which.
export const taxRegistrationPeriodState = async ({ client, firmId, clientId, rule, onDate }) => {
  const locked = (await client.query(`select id, period_start::text as period_start, period_end::text as period_end from close_periods
     where firm_id = $1 and client_id = $2 and status = 'locked' and $3::date between period_start and period_end
     order by period_start limit 1`, [firmId, clientId, onDate])).rows[0] || null;
  const declared = typeof rule?.filedReturnOn === 'function';
  const filed = declared ? await rule.filedReturnOn({ query: client.query.bind(client), firmId, clientId, onDate }) : null;
  return { locked: Boolean(locked), close_period_id: locked?.id || null,
    return_filed: declared ? Boolean(filed) : null,
    filed_return_id: filed?.id || null, filed_return_period: filed?.period_key || null };
};

// The lines one record change touches, for the change's own receipt: posted
// lines whose status on their governing date differs between the record
// before and after, and whose posted basis the new record now contradicts.
// correction_case: whether the existing correction case watches the line (an
// autonomous coding; a line a person decided is outside it today).
export const postedLinesAffectedByRegistrationChange = async ({ client, firmId, clientId, jurisdiction, before, after, autonomous }) => {
  const rule = taxRegistrationRuleFor(jurisdiction);
  if (!rule?.withoutTax || !rule.profileField || hash(before?.[rule.profileField] ?? null) === hash(after?.[rule.profileField] ?? null)) return null;
  const affected = [];
  for (const row of await readPostedLineTaxTypes({ client, firmId, clientId })) {
    const change = taxRegistrationChangeFor({ rule, profile: after, row, lines: row.lines });
    if (!change) continue;
    if (taxRegistrationStatusOn({ rule, profile: before, onDate: change.on_date }).status === change.current.status) continue;
    affected.push({ transaction_id: row.id, journal_id: row.journal_id, on_date: change.on_date, direction: change.direction,
      posted: change.posted.status, current: change.current.status, correction_case: Boolean(autonomous(row.payload || {})) });
  }
  return { profile_field: rule.profileField, count: affected.length,
    correction_case_count: affected.filter((line) => line.correction_case).length,
    lines: affected.slice(0, AFFECTED_LINE_ID_LIMIT), truncated: affected.length > AFFECTED_LINE_ID_LIMIT,
    correction_cases_enabled: await taxRegistrationRecheckActsWithClient({ client, firmId, clientId }) };
};
