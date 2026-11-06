// Country-owned statutory readers, watches, filing lifecycles and mandates.
// Moved from db/statutory.js without changing the named writers or receipt contracts.
import { toLocalIsoDay, toUtcIsoDay } from '../dates.js';
import { AE_VAT_THRESHOLD_EVIDENCE_TYPE, buildAeVatRegistrationWatch, buildAeVatThresholdEscalationQuestion } from './vatRegistrationThreshold.js';
import { resolveAeVatRegistrationOnDate } from './vatRegistration.js';
import { AE_VAT_RETURN_DEADLINE_EVIDENCE_TYPE, AE_VAT_RETURN_PERIOD_INTAKE_EVIDENCE_TYPE, aeVatReturnDeadlineAskId, aeVatReturnPeriodIntakeAskId, buildAeVatReturnDeadlineQuestion, buildAeVatReturnPeriodIntakeQuestion, classifyAeVatReturnPeriodDeadline } from './vatReturnDeadlines.js';
import { AE_CT_REGISTRATION_DEADLINE_EVIDENCE_TYPE, AE_CT_REGISTRATION_REFUSAL_CODES, AE_CT_REGISTRATION_STATUS_EVIDENCE_TYPE, aeCtRegistrationDeadlineAskId, aeCtRegistrationStatusAskId, buildAeCtRegistrationDeadlineQuestion, buildAeCtRegistrationStatusQuestion, classifyAeCtRegistrationDeadline } from './ctRegistrationEscalation.js';
import { buildAeCtRegistrationDeadlineRows } from './ctRegistrationDeadlines.js';
import { resolveAeCtRegistrationOnDate } from './ctRegistration.js';
import { deliverWhatsAppEvidenceAsksAfterSend } from '../db/channels.js';


// ── AE ae_vat_registration_threshold — the drain ────────────────────────────
//
// The Emirati sibling of drainGbVatThresholdEscalations above — the third
// market on the same duty shape, which is the obligations leg's generalisation
// evidence compounding. Two deliberate differences from the GB drain:
//
//   • the registered-client exclusion gates on the REGISTRATION RECORD
//     (ae/vatRegistration.js, resolved on the watch date) rather than a
//     return-lane flag — the AE return lane (ae_vat_return) has no flag yet.
//     `registered === true` is skipped; `false` AND `null`-unknown both run
//     the watch, because the escalation ask itself asks "have you already
//     registered?" — an unknown resolves through the owner, never a guess;
//   • the candidate query therefore fetches c.profile alongside the ids.
//
// One ask per (client, calendar year) — the SAME deterministic id shape as the
// GB drain, on purpose: it is one duty across markets, a client has exactly
// one jurisdiction, and if a client were ever mis-staged onto both watches the
// shared id would dedupe to one ask rather than nag twice.
const aeVatThresholdAskId = ({ firmId, clientId, year }) =>
  `vat-threshold-${firmId}-${clientId}-${year}`;


// Both limbs in ONE pass so the two verdicts derive identically by
// construction. Windows, all against `asOf`: (asOf − 12 months, asOf] is the
// preceding-12-months limb; (asOf, asOf + 30 days] is the next-30-days limb.
// The forward window reads only ALREADY-POSTED revenue dated into it — a
// strictly conservative floor on "committed supplies", never a projection or
// a run-rate. See the honesty note in ae/vatRegistrationThreshold.js.
const __aeVatThresholdWatch = async ({ client, firmId, clientId, asOf }) => {
  const asOfDate = new Date(`${asOf}T00:00:00Z`);
  const backFrom = new Date(asOfDate); backFrom.setUTCFullYear(backFrom.getUTCFullYear() - 1);
  const forwardTo = new Date(asOfDate); forwardTo.setUTCDate(forwardTo.getUTCDate() + 30);
  // UTC on purpose: both window edges are stepped from the bare day `asOf`
  // in Date.UTC space — the host zone must not move them.
  const iso = (d) => toUtcIsoDay(d);

  const result = await client.query(
    `select
       coalesce(sum(case when lj.journal_date >  $3 and lj.journal_date <= $4
                         then ll.credit - ll.debit else 0 end), 0) as rolling_turnover,
       coalesce(sum(case when lj.journal_date >  $4 and lj.journal_date <= $5
                         then ll.credit - ll.debit else 0 end), 0) as committed_next_30
       from ledger_lines ll
       join ledger_journals lj on lj.id = ll.journal_id
       join ledger_accounts la on la.id = ll.account_id
      where ll.firm_id = $1
        and ll.client_id = $2
        and la.account_type = 'revenue'
        and lj.status in ('posted', 'closed')
        and lj.journal_date >  $3
        and lj.journal_date <= $5`,
    [firmId, clientId, iso(backFrom), iso(asOfDate), iso(forwardTo)]
  );
  const row = result.rows[0] || {};
  return buildAeVatRegistrationWatch({
    asOf,
    rollingTurnover: Number(row.rolling_turnover) || 0,
    committedNext30Days: Number(row.committed_next_30) || 0
  });
};


// Runs on the jurisdiction-neutral statutory-obligation sweep (bound by name —
// core never imports ae/ directly). Sweeps every AE-jurisdiction client
// UNCONDITIONALLY (Kari 2026-08-31, "nothing dark" — the born-dark
// AE_VAT_THRESHOLD_WATCH flag is deleted; an ask-minting watch is outside the
// canary-reserved lanes of the 2026-08-27 rail), excludes a recorded
// VAT-registered client, and when the deterministic watch says `exceeded`
// mints ONE owner ask per calendar year (on conflict do nothing — an open ask
// is never re-nagged, a resolved ask stays answered for its year) with the
// audit event in the SAME transaction, then delivers over the existing
// WhatsApp evidence-ask substrate.
export const drainAeVatThresholdEscalations = async ({
  client,
  firmId = null,
  asOf = null,
  deliverAsksImpl = null
} = {}) => {
  // Host-local "today": the day the owner's wall clock says (audit F-11).
  const watchDate = asOf || toLocalIsoDay(new Date());
  const watchYear = Number(watchDate.slice(0, 4));
  const summary = { scanned: 0, exceeded: 0, minted: 0, delivered: 0, skipped: 0, errors: 0 };

  const candidateResult = await client.query(
    `select c.firm_id, c.id as client_id, c.profile
       from clients c
      where lower(coalesce(c.jurisdiction, c.profile->>'jurisdiction')) = 'ae'
        and ($1::text is null or c.firm_id = $1)
      order by c.firm_id, c.id`,
    [firmId]
  );

  for (const candidate of candidateResult.rows) {
    summary.scanned += 1;
    try {
      // A client with a recorded EFFECTIVE registration is off this watch —
      // its duties belong to the return lane (ae_vat_return). Tri-state on
      // purpose: false and unknown both stay ON the watch (see the module
      // header's scope-guard note).
      const profile = candidate.profile && typeof candidate.profile === 'object' && !Array.isArray(candidate.profile)
        ? candidate.profile : {};
      const registration = resolveAeVatRegistrationOnDate({
        registration: profile.vat_registration ?? null, onDate: watchDate
      });
      if (registration.registered === true) {
        summary.skipped += 1;
        continue;
      }
      const watch = await __aeVatThresholdWatch({
        client, firmId: candidate.firm_id, clientId: candidate.client_id, asOf: watchDate
      });
      if (watch.status !== 'exceeded') continue;
      summary.exceeded += 1;

      const question = buildAeVatThresholdEscalationQuestion({ watch });
      const askId = aeVatThresholdAskId({ firmId: candidate.firm_id, clientId: candidate.client_id, year: watchYear });
      await client.query('begin');
      let inserted = false;
      try {
        const insertResult = await client.query(
          `insert into client_evidence_requests (
             id, firm_id, client_id, status, evidence_type, question, request_payload,
             first_sent_at, last_sent_at, send_count, created_by
           )
           values ($1, $2, $3, 'open', $4, $5, $6::jsonb, now(), now(), 1, 'system')
           on conflict (id) do nothing
           returning id`,
          [
            askId, candidate.firm_id, candidate.client_id, AE_VAT_THRESHOLD_EVIDENCE_TYPE, question,
            JSON.stringify({
              kind: AE_VAT_THRESHOLD_EVIDENCE_TYPE,
              as_of: watchDate,
              year: watchYear,
              driving_limb: watch.drivingLimb,
              threshold_aed: watch.thresholdAed,
              rolling_turnover_aed: watch.rollingTurnover,
              committed_next_30_days_aed: watch.committedNext30Days
            })
          ]
        );
        inserted = insertResult.rows.length > 0;
        if (inserted) {
          // Audit-as-precondition: same transaction as the mint. The authority
          // basis is the bound statutory obligation itself — the watch runs
          // unconditionally for AE clients (Kari 2026-08-31).
          await client.query(
            `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
             values ($1, $2, 'system', 'system', 'vat_threshold.escalated', 'client_evidence_request', $3, $4::jsonb)`,
            [candidate.firm_id, candidate.client_id, askId, JSON.stringify({
              as_of: watchDate,
              year: watchYear,
              driving_limb: watch.drivingLimb,
              threshold_aed: watch.thresholdAed,
              rolling_turnover_aed: watch.rollingTurnover,
              committed_next_30_days_aed: watch.committedNext30Days,
              authority_basis: 'statutory_obligation:ae_vat_registration_threshold'
            })]
          );
        }
        await client.query('commit');
      } catch (mintError) {
        await client.query('rollback');
        throw mintError;
      }
      if (!inserted) {
        summary.skipped += 1;
        continue;
      }
      summary.minted += 1;
      const deliver = deliverAsksImpl
        || ((args) => deliverWhatsAppEvidenceAsksAfterSend({ client, ...args }));
      await deliver({ firmId: candidate.firm_id, clientId: candidate.client_id, evidenceRequestIds: [askId] });
      summary.delivered += 1;
    } catch (error) {
      summary.errors += 1;
    }
  }
  return summary;
};


// AE ae_vat_return — the deadline-watch drain, bound as
// 'ae_vat_return_deadline_escalation' on the jurisdiction-neutral sweep.
// Sweeps every AE-jurisdiction client UNCONDITIONALLY (Kari 2026-08-31,
// "nothing dark" — the born-dark AE_VAT_RETURN_WATCH flag is deleted), and
// covers REGISTRANTS only — a not-registered or unknown client belongs to
// the threshold watch above, whose ask asks the registration question
// itself.
//
// Two ask kinds, both terminal-2 (on the owner), both deterministic-id
// deduped with audit-as-precondition in the mint transaction:
//   • no open recorded period → the period-INTAKE ask (one per client-year):
//     the FTA assigns periods per registrant, so only the owner's EmaraTax
//     view can supply them (ae/vatPeriods.js is where the answer lands).
//   • an open period due within the lead window or overdue → the DEADLINE ask
//     (one per period): preparation is attempted via the real route, so the
//     ask carries the prepared figures when the book supports them and the
//     NAMED blocker (a typed refusal) when it does not. Donna never files —
//     the ask says so.
export const drainAeVatReturnDeadlineEscalations = async ({
  client,
  firmId = null,
  asOf = null,
  deliverAsksImpl = null
} = {}) => {
  // Host-local "today": the day the owner's wall clock says (audit F-11).
  const watchDate = asOf || toLocalIsoDay(new Date());
  const watchYear = Number(watchDate.slice(0, 4));
  const summary = { scanned: 0, intake_minted: 0, due_periods: 0, minted: 0, delivered: 0, skipped: 0, errors: 0 };

  const candidateResult = await client.query(
    `select c.firm_id, c.id as client_id, c.profile
       from clients c
      where lower(coalesce(c.jurisdiction, c.profile->>'jurisdiction')) = 'ae'
        and ($1::text is null or c.firm_id = $1)
      order by c.firm_id, c.id`,
    [firmId]
  );

  const deliver = deliverAsksImpl
    || ((args) => deliverWhatsAppEvidenceAsksAfterSend({ client, ...args }));

  const mintAsk = async ({ candidateFirmId, clientId, askId, evidenceType, question, payload, auditAction, auditMetadata }) => {
    await client.query('begin');
    let inserted = false;
    try {
      const insertResult = await client.query(
        `insert into client_evidence_requests (
           id, firm_id, client_id, status, evidence_type, question, request_payload,
           first_sent_at, last_sent_at, send_count, created_by
         )
         values ($1, $2, $3, 'open', $4, $5, $6::jsonb, now(), now(), 1, 'system')
         on conflict (id) do nothing
         returning id`,
        [askId, candidateFirmId, clientId, evidenceType, question, JSON.stringify(payload)]
      );
      inserted = insertResult.rows.length > 0;
      if (inserted) {
        // Audit-as-precondition: same transaction as the mint. The authority
        // basis is the bound statutory obligation itself — the watch runs
        // unconditionally for AE clients (Kari 2026-08-31).
        await client.query(
          `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
           values ($1, $2, 'system', 'system', $3, 'client_evidence_request', $4, $5::jsonb)`,
          [candidateFirmId, clientId, auditAction, askId, JSON.stringify({
            ...auditMetadata,
            authority_basis: 'statutory_obligation:ae_vat_return'
          })]
        );
      }
      await client.query('commit');
    } catch (mintError) {
      await client.query('rollback');
      throw mintError;
    }
    return inserted;
  };

  for (const candidate of candidateResult.rows) {
    summary.scanned += 1;
    try {
      const profile = candidate.profile && typeof candidate.profile === 'object' && !Array.isArray(candidate.profile)
        ? candidate.profile : {};
      const registration = resolveAeVatRegistrationOnDate({
        registration: profile.vat_registration ?? null, onDate: watchDate
      });
      if (registration.registered !== true) {
        summary.skipped += 1;
        continue;
      }

      const periodResult = await client.query(
        `select id, period_key, start_date, end_date, due_date, status
           from ae_vat_periods
          where firm_id = $1 and client_id = $2 and status = 'open'
          order by start_date asc, id asc`,
        [candidate.firm_id, candidate.client_id]
      );

      if (periodResult.rows.length === 0) {
        const askId = aeVatReturnPeriodIntakeAskId({ firmId: candidate.firm_id, clientId: candidate.client_id, year: watchYear });
        const inserted = await mintAsk({
          candidateFirmId: candidate.firm_id,
          clientId: candidate.client_id,
          askId,
          evidenceType: AE_VAT_RETURN_PERIOD_INTAKE_EVIDENCE_TYPE,
          question: buildAeVatReturnPeriodIntakeQuestion(),
          payload: { kind: AE_VAT_RETURN_PERIOD_INTAKE_EVIDENCE_TYPE, as_of: watchDate, year: watchYear },
          auditAction: 'vat_return.period_intake_asked',
          auditMetadata: { as_of: watchDate, year: watchYear }
        });
        if (inserted) {
          summary.intake_minted += 1;
          await deliver({ firmId: candidate.firm_id, clientId: candidate.client_id, evidenceRequestIds: [askId] });
          summary.delivered += 1;
        } else {
          summary.skipped += 1;
        }
        continue;
      }

      for (const row of periodResult.rows) {
        const classification = classifyAeVatReturnPeriodDeadline({ period: row, asOf: watchDate });
        if (classification.state === 'scheduled') continue;
        summary.due_periods += 1;

        let vatReturn = null;
        let refusal = null;
        try {
          // Dynamic on purpose — see the import-cycle note at the top import.
          const { prepareAeVatReturnWithClient } = await import('./vatReturnRoute.js');
          const prepared = await prepareAeVatReturnWithClient({
            client,
            firmId: candidate.firm_id,
            clientId: candidate.client_id,
            periodKey: row.period_key,
            vatRegistration: profile.vat_registration,
            aeEstablishment: profile.ae_establishment
          });
          vatReturn = prepared.vatReturn;
        } catch (prepareError) {
          // Only the lane's own typed refusals become ask content — an
          // infrastructure error (module load, connection loss; Node errors
          // carry .code too) must never masquerade as a statutory blocker.
          if (!String(prepareError?.code || '').startsWith('AE_VAT')) throw prepareError;
          refusal = { code: prepareError.code, message: prepareError.message };
        }

        const askId = aeVatReturnDeadlineAskId({ firmId: candidate.firm_id, clientId: candidate.client_id, periodId: row.id });
        const inserted = await mintAsk({
          candidateFirmId: candidate.firm_id,
          clientId: candidate.client_id,
          askId,
          evidenceType: AE_VAT_RETURN_DEADLINE_EVIDENCE_TYPE,
          question: buildAeVatReturnDeadlineQuestion({ period: row, classification, vatReturn, refusal }),
          payload: {
            kind: AE_VAT_RETURN_DEADLINE_EVIDENCE_TYPE,
            as_of: watchDate,
            period_id: row.id,
            period_key: row.period_key,
            due_date: String(row.due_date),
            state: classification.state,
            days_until_due: classification.daysUntilDue,
            net_vat_aed: vatReturn ? vatReturn.netVat : null,
            outcome: vatReturn ? vatReturn.outcome : null,
            refusal_code: refusal ? refusal.code : null
          },
          auditAction: 'vat_return.deadline_escalated',
          auditMetadata: {
            as_of: watchDate,
            period_id: row.id,
            period_key: row.period_key,
            due_date: String(row.due_date),
            state: classification.state,
            refusal_code: refusal ? refusal.code : null
          }
        });
        if (inserted) {
          summary.minted += 1;
          await deliver({ firmId: candidate.firm_id, clientId: candidate.client_id, evidenceRequestIds: [askId] });
          summary.delivered += 1;
        } else {
          summary.skipped += 1;
        }
      }
    } catch (error) {
      summary.errors += 1;
    }
  }
  return summary;
};


// AE ae_corporate_tax_registration — the registry-watch drain, bound as
// 'ae_ct_registration_escalation' on the jurisdiction-neutral sweep. Sweeps
// every AE-jurisdiction client UNCONDITIONALLY (Kari 2026-08-31, "nothing
// dark" — the flag this drain was born with was deleted the same day it was
// born) and hands the profile to the PURE row builder, whose verdict is
// already terminal-shaped: [] means the duty is discharged (a recorded
// registration is the evidence — the sweep stays silent), and every row is
// 'scheduled' (a computed application deadline) or 'on_owner' (a named
// refusal).
//
// Two ask kinds, both terminal-2 (on the owner), both deterministic-id
// deduped per client-year with audit-as-precondition in the mint transaction:
//   • the STATUS ask — the registration status itself is unknown; for a
//     registry duty "unknown" must not read as either answer, so the status
//     is the owner fact requested.
//   • the DEADLINE ask — the duty is live: either a computed deadline inside
//     the lead window (or past — the overdue copy carries the waiver note),
//     or an 'on_owner' refusal naming the facts the profile cannot settle
//     (incorporation/licence dates, the natural-person turnover year, a
//     recorded deregistration). The owner registers in EmaraTax — Donna
//     never registers; every ask says so.
export const drainAeCtRegistrationEscalations = async ({
  client,
  firmId = null,
  asOf = null,
  deliverAsksImpl = null
} = {}) => {
  // Host-local "today": the day the owner's wall clock says (audit F-11).
  const watchDate = asOf || toLocalIsoDay(new Date());
  const watchYear = Number(watchDate.slice(0, 4));
  const summary = { scanned: 0, status_minted: 0, due_rows: 0, minted: 0, delivered: 0, skipped: 0, errors: 0 };

  const candidateResult = await client.query(
    `select c.firm_id, c.id as client_id, c.profile
       from clients c
      where lower(coalesce(c.jurisdiction, c.profile->>'jurisdiction')) = 'ae'
        and ($1::text is null or c.firm_id = $1)
      order by c.firm_id, c.id`,
    [firmId]
  );

  const deliver = deliverAsksImpl
    || ((args) => deliverWhatsAppEvidenceAsksAfterSend({ client, ...args }));

  const mintAsk = async ({ candidateFirmId, clientId, askId, evidenceType, question, payload, auditAction, auditMetadata }) => {
    await client.query('begin');
    let inserted = false;
    try {
      const insertResult = await client.query(
        `insert into client_evidence_requests (
           id, firm_id, client_id, status, evidence_type, question, request_payload,
           first_sent_at, last_sent_at, send_count, created_by
         )
         values ($1, $2, $3, 'open', $4, $5, $6::jsonb, now(), now(), 1, 'system')
         on conflict (id) do nothing
         returning id`,
        [askId, candidateFirmId, clientId, evidenceType, question, JSON.stringify(payload)]
      );
      inserted = insertResult.rows.length > 0;
      if (inserted) {
        // Audit-as-precondition: same transaction as the mint. The authority
        // basis is the bound statutory obligation itself — the watch runs
        // unconditionally for AE clients (Kari 2026-08-31).
        await client.query(
          `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
           values ($1, $2, 'system', 'system', $3, 'client_evidence_request', $4, $5::jsonb)`,
          [candidateFirmId, clientId, auditAction, askId, JSON.stringify({
            ...auditMetadata,
            authority_basis: 'statutory_obligation:ae_corporate_tax_registration'
          })]
        );
      }
      await client.query('commit');
    } catch (mintError) {
      await client.query('rollback');
      throw mintError;
    }
    return inserted;
  };

  for (const candidate of candidateResult.rows) {
    summary.scanned += 1;
    try {
      const profile = candidate.profile && typeof candidate.profile === 'object' && !Array.isArray(candidate.profile)
        ? candidate.profile : {};
      const registration = resolveAeCtRegistrationOnDate({
        registration: profile.ct_registration ?? null, onDate: watchDate
      });
      const rows = buildAeCtRegistrationDeadlineRows({
        profile, onDate: watchDate, refusalCodes: AE_CT_REGISTRATION_REFUSAL_CODES
      });
      // Discharged: a recorded registration (or one recorded with a future
      // effective date) IS the evidence — nothing to schedule, nothing to ask.
      if (rows.length === 0) {
        summary.skipped += 1;
        continue;
      }

      for (const row of rows) {
        if (row.terminal === 'on_owner' && row.key === 'ct_registration') {
          const askId = aeCtRegistrationStatusAskId({ firmId: candidate.firm_id, clientId: candidate.client_id, year: watchYear });
          const inserted = await mintAsk({
            candidateFirmId: candidate.firm_id,
            clientId: candidate.client_id,
            askId,
            evidenceType: AE_CT_REGISTRATION_STATUS_EVIDENCE_TYPE,
            question: buildAeCtRegistrationStatusQuestion(),
            payload: {
              kind: AE_CT_REGISTRATION_STATUS_EVIDENCE_TYPE,
              as_of: watchDate,
              year: watchYear,
              refusal_code: row.reason_code,
              registration_reason: registration.reason
            },
            auditAction: 'ct_registration.status_asked',
            auditMetadata: { as_of: watchDate, year: watchYear, registration_reason: registration.reason }
          });
          if (inserted) {
            summary.status_minted += 1;
            await deliver({ firmId: candidate.firm_id, clientId: candidate.client_id, evidenceRequestIds: [askId] });
            summary.delivered += 1;
          } else {
            summary.skipped += 1;
          }
          continue;
        }

        let classification = null;
        if (row.terminal !== 'on_owner') {
          classification = classifyAeCtRegistrationDeadline({ row, asOf: watchDate });
          if (classification.state === 'scheduled') continue;
        }
        summary.due_rows += 1;

        const askId = aeCtRegistrationDeadlineAskId({ firmId: candidate.firm_id, clientId: candidate.client_id, year: watchYear });
        const inserted = await mintAsk({
          candidateFirmId: candidate.firm_id,
          clientId: candidate.client_id,
          askId,
          evidenceType: AE_CT_REGISTRATION_DEADLINE_EVIDENCE_TYPE,
          question: buildAeCtRegistrationDeadlineQuestion({ row, classification, registration }),
          payload: {
            kind: AE_CT_REGISTRATION_DEADLINE_EVIDENCE_TYPE,
            as_of: watchDate,
            year: watchYear,
            due_date: row.due_date,
            state: classification ? classification.state : 'blocked',
            days_until_due: classification ? classification.daysUntilDue : null,
            refusal_code: row.terminal === 'on_owner' ? row.reason_code : null,
            registration_reason: registration.reason
          },
          auditAction: 'ct_registration.deadline_escalated',
          auditMetadata: {
            as_of: watchDate,
            year: watchYear,
            due_date: row.due_date,
            state: classification ? classification.state : 'blocked',
            refusal_code: row.terminal === 'on_owner' ? row.reason_code : null,
            registration_reason: registration.reason
          }
        });
        if (inserted) {
          summary.minted += 1;
          await deliver({ firmId: candidate.firm_id, clientId: candidate.client_id, evidenceRequestIds: [askId] });
          summary.delivered += 1;
        } else {
          summary.skipped += 1;
        }
      }
    } catch (error) {
      summary.errors += 1;
    }
  }
  return summary;
};


// AE ae_vat_registration — the VAT-registration STATUS watch, bound as
// 'ae_vat_registration_escalation' on the jurisdiction-neutral sweep (RT-19,
// forensics F-23: ae_vat_periods could not self-start because nothing asked
// the owner for the registration + TRN the period writer requires). The
// drain lives with its lane (ae/vatRegistrationEscalationDb.js) and is
// reached through this lazy re-export so outbound/ keeps its rule of never
// importing ae/ directly; the import is dynamic because that module imports
// deliverWhatsAppEvidenceAsksAfterSend from here (the vatReturnRoute.js
// cycle note above). Same writer and audience rules as the CT status ask.
export const drainAeVatRegistrationEscalations = async (args = {}) => {
  const { drainAeVatRegistrationEscalations: drain } = await import('./vatRegistrationEscalationDb.js');
  return drain(args);
};

// The existing named owner-reply writer is a registered AE operation.
export { recordAeVatRegistrationReply } from './vatRegistrationReply.js';

import { prepareAeVatReturnWithClient } from './vatReturnRoute.js';

// Country-owned owner-surface profile mapping; the shared dispatcher selects
// this operation without knowing this country's registration/profile fields.
export const prepareOwnerVatReturnWithClient = ({ client, firmId, clientId, periodKey, asOf, profile }) =>
  prepareAeVatReturnWithClient({
    client, firmId, clientId, periodKey, asOf,
    vatRegistration: profile?.vat_registration,
    aeEstablishment: profile?.ae_establishment
  });

export { getOwnerReplyAdapters } from './ownerReplyAdapter.js';
