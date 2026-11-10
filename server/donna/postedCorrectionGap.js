// Posted bank lines in a VAT period whose correction case is still open.
//
// A posted line gets a correction case (transactions.payload
// .coding_correction_required, status 'pending') when its evidence changed
// after posting, or when the VAT registration record now contradicts what it
// was posted under (db/codingEvidence.js recoverChangedCodingEvidenceInDb,
// db/taxRegistrationChange.js). The posted journal stays as it is until the
// correction is made (db/codingCorrection.js), so a VAT return computed from
// the ledger over that line's period still reads the treatment Donna has
// already marked as in doubt.
//
// This module is the one read a return over a period uses to say so. It
// changes no figure and posts nothing: the return stays what the ledger says,
// and the open cases only decide that it is not ready, under their own
// blocker, with the lines named. When a case is corrected (status 'corrected')
// or closed without a correction ('no_correction_required'), the next read
// no longer finds it and the blocker is gone; nothing has to be cleared.
//
// Period membership is the posting's journal date, the date every VAT return
// builder assigns posted lines to periods by (lj.journal_date between the
// period bounds). The journal read is the one the case names
// (original_journal_id, else the line's ledger_journal_id), posted or closed.
// A case that cannot move because its own period is locked or its return is
// filed (CODING_CORRECTION_TAX_PERIOD_CLOSED on the case's recovery) belongs
// to that period's return and blocks only that one: a later period does not
// contain its journal date.
//
// Jurisdiction-neutral: reads only transactions and ledger_journals. Any
// pending reason counts.

export const OPEN_CODING_CORRECTION_BLOCKER = 'open_coding_corrections';

// The read names at most this many lines; the count is always exact.
export const OPEN_CODING_CORRECTION_LINE_LIMIT = 50;

export const readOpenCodingCorrectionsWithClient = async ({ client, firmId, clientId, period, limit = OPEN_CODING_CORRECTION_LINE_LIMIT }) => {
  const startsOn = period?.starts_on ?? period?.startsOn;
  const endsOn = period?.ends_on ?? period?.endsOn;
  const rows = (await client.query(
    `select t.id as transaction_id, j.id as journal_id, j.journal_date::text as journal_date,
            t.payload->'coding_correction_required'->>'reason' as reason,
            t.payload->'coding_correction_required'->>'next_action' as next_action,
            t.payload->'coding_correction_required'->'recovery'->>'state' as recovery_state,
            t.payload->'coding_correction_required'->'recovery'->>'code' as recovery_code,
            count(*) over () as total
       from transactions t
       join ledger_journals j
         on j.firm_id = t.firm_id and j.client_id = t.client_id
        and j.id = coalesce(t.payload->'coding_correction_required'->>'original_journal_id', t.payload->>'ledger_journal_id')
      where t.firm_id = $1 and t.client_id = $2
        and t.payload->'coding_correction_required'->>'status' = 'pending'
        and j.status in ('posted', 'closed')
        and j.journal_date >= $3::date and j.journal_date <= $4::date
      order by j.journal_date, t.id
      limit $5`,
    [firmId, clientId, startsOn, endsOn, limit]
  )).rows;
  const count = rows.length ? Number(rows[0].total) : 0;
  return {
    blocker: OPEN_CODING_CORRECTION_BLOCKER,
    period: { starts_on: startsOn, ends_on: endsOn },
    count,
    truncated: count > rows.length,
    items: rows.map((row) => ({
      transaction_id: row.transaction_id,
      journal_id: row.journal_id,
      journal_date: row.journal_date,
      reason: row.reason || null,
      next_action: row.next_action || null,
      recovery: row.recovery_state || row.recovery_code ? { state: row.recovery_state || null, code: row.recovery_code || null } : null
    }))
  };
};
