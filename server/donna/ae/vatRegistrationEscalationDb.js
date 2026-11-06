// AE ae_vat_registration — the registration-status watch's DB half: the
// drain the jurisdiction-neutral sweep runs (bound as
// 'ae_vat_registration_escalation', reached through firmDb.js's lazy
// re-export so outbound/ never imports ae/ directly) and the persisted
// VAT-activity evidence read it keys on. Pure half + design:
// ae/vatRegistrationEscalation.js. RT-19 (forensics F-23).
//
// Same writer and audience rules as the corporate-tax STATUS ask
// (drainAeCtRegistrationEscalations, firmDb.js): client-audience
// client_evidence_requests row, created_by 'system', deterministic id with
// `on conflict do nothing`, audit-as-precondition in the SAME transaction
// with `authority_basis: statutory_obligation:ae_vat_registration`, then
// delivery over the existing WhatsApp evidence-ask substrate. Sweeps every
// AE-jurisdiction client UNCONDITIONALLY (no flag — "nothing dark").
//
// Cheap by construction — one clients read, then per AE client three small
// indexed reads (latest ask, evidence, nothing else) — which is why the
// binding also runs on the HOURLY statutory cadence: a client born after the
// 04:15 tick, or a first FTA VAT payment coded at 10:00, is asked within the
// hour instead of tomorrow. Boot catch-up rides the local scheduler's bounded
// latest-missed-tick rule for the hourly function id.

import { deliverWhatsAppEvidenceAsksAfterSend } from '../firmDb.js';
import { toLocalIsoDay } from '../dates.js';
import { resolveAeVatRegistrationOnDate } from './vatRegistration.js';
import {
  AE_VAT_REGISTRATION_STATUS_EVIDENCE_TYPE,
  aeVatRegistrationStatusAskId,
  buildAeVatRegistrationStatusQuestion,
  classifyAeVatRegistrationAsk,
  isoDayOf
} from './vatRegistrationEscalation.js';

export const AE_VAT_CONTROL_ROLE = 'liability.sales_tax_payable';

// findAeVatActivityEvidence({ client, firmId, clientId, limit }) → the
// persisted signals, most recent first, at most `limit` per kind. Every
// row is a verdict something already wrote (a coding, a posting, an
// extraction) resolved to the chart by ROLE — never a keyword guess.
export const findAeVatActivityEvidence = async ({ client, firmId, clientId, limit = 3 } = {}) => {
  const coded = await client.query(
    `select 'vat_control_account_coding' as kind, t.id as ref, t.transaction_date::text as on_date,
            case when coalesce(t.money_out, 0) <> 0 then t.money_out else t.money_in end as amount,
            t.currency, left(coalesce(t.description, ''), 80) as label
       from transactions t
       join ledger_accounts la
         on la.firm_id = t.firm_id and la.client_id = t.client_id
        and la.canonical_role = $3 and la.status = 'active'
        and (
          (t.account_code is not null and la.code = t.account_code)
          or (t.payload->'ai_suggestion'->>'account_code' is not null and la.code = t.payload->'ai_suggestion'->>'account_code')
          or (t.payload->'ai_suggestion'->>'proposed_account' is not null
              and lower(la.name) = lower(t.payload->'ai_suggestion'->>'proposed_account'))
        )
      where t.firm_id = $1 and t.client_id = $2
      order by t.transaction_date desc nulls last, t.id desc
      limit $4`,
    [firmId, clientId, AE_VAT_CONTROL_ROLE, limit]
  );
  const posted = await client.query(
    `select 'vat_control_account_posting' as kind, lj.id as ref, lj.journal_date::text as on_date,
            case when coalesce(ll.credit, 0) <> 0 then ll.credit else ll.debit end as amount,
            la.currency, null::text as label
       from ledger_lines ll
       join ledger_journals lj on lj.id = ll.journal_id
       join ledger_accounts la on la.id = ll.account_id
      where lj.firm_id = $1 and lj.client_id = $2 and lj.status in ('posted', 'closed')
        and la.canonical_role = $3
      order by lj.journal_date desc nulls last, lj.id desc
      limit $4`,
    [firmId, clientId, AE_VAT_CONTROL_ROLE, limit]
  );
  const invoices = await client.query(
    `select 'vat_bearing_sales_invoice' as kind, d.id as ref, d.document_date::text as on_date,
            d.tax_amount as amount, d.currency, coalesce(d.reference_number, d.filename) as label
       from documents d
      where d.firm_id = $1 and d.client_id = $2
        and d.document_type = 'sales_invoice'
        and coalesce(d.tax_amount, 0) > 0
        and d.duplicate_of is null
      order by d.document_date desc nulls last, d.id desc
      limit $3`,
    [firmId, clientId, limit]
  );
  return [...coded.rows, ...posted.rows, ...invoices.rows];
};

const summariseEvidence = (evidence) => evidence.map((item) => ({
  kind: item.kind,
  ref: item.ref,
  on_date: item.on_date || null,
  amount: item.amount === null || item.amount === undefined ? null : Number(item.amount),
  currency: item.currency || null,
  label: item.label || null
}));

export const drainAeVatRegistrationEscalations = async ({
  client,
  firmId = null,
  asOf = null,
  deliverAsksImpl = null
} = {}) => {
  // "Today" for the host's wall clock (dates.js, RT-07) — the day the owner
  // reads as today on the appliance, never a UTC day that lags it by hours.
  const watchDate = asOf || toLocalIsoDay(new Date());
  const summary = {
    scanned: 0, evidence_seen: 0, minted: 0, delivered: 0, skipped: 0, errors: 0, skip_reasons: {}
  };

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

  const skip = (reason) => {
    summary.skipped += 1;
    summary.skip_reasons[reason] = (summary.skip_reasons[reason] || 0) + 1;
  };

  for (const candidate of candidateResult.rows) {
    summary.scanned += 1;
    try {
      const profile = candidate.profile && typeof candidate.profile === 'object' && !Array.isArray(candidate.profile)
        ? candidate.profile : {};
      const registration = resolveAeVatRegistrationOnDate({
        registration: profile.vat_registration ?? null, onDate: watchDate
      });
      const askResult = await client.query(
        `select id, status, resolved_at, responded_at, created_at
           from client_evidence_requests
          where firm_id = $1 and client_id = $2 and evidence_type = $3
          order by created_at desc, id desc
          limit 1`,
        [candidate.firm_id, candidate.client_id, AE_VAT_REGISTRATION_STATUS_EVIDENCE_TYPE]
      );
      const latestAsk = askResult.rows[0] || null;
      // A recorded registration needs no evidence read; every other state
      // does (the evidence decides between the copy shapes and, for a
      // recorded "not registered", whether the question re-opens at all).
      const evidence = registration.registered === true
        ? []
        : await findAeVatActivityEvidence({ client, firmId: candidate.firm_id, clientId: candidate.client_id });
      if (evidence.length > 0) summary.evidence_seen += 1;

      const verdict = classifyAeVatRegistrationAsk({ registration, latestAsk, evidence, asOf: watchDate });
      if (verdict.action !== 'ask') {
        skip(verdict.reason);
        continue;
      }

      const answeredAt = latestAsk && String(latestAsk.status).toLowerCase() === 'resolved'
        ? isoDayOf(latestAsk.resolved_at || latestAsk.responded_at || latestAsk.created_at)
        : null;
      const askId = aeVatRegistrationStatusAskId({ firmId: candidate.firm_id, clientId: candidate.client_id, asOf: watchDate });
      const question = buildAeVatRegistrationStatusQuestion({ reason: verdict.reason, evidence, answeredAt });
      const evidenceSummary = summariseEvidence(evidence);

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
            askId, candidate.firm_id, candidate.client_id, AE_VAT_REGISTRATION_STATUS_EVIDENCE_TYPE, question,
            JSON.stringify({
              kind: AE_VAT_REGISTRATION_STATUS_EVIDENCE_TYPE,
              as_of: watchDate,
              reason: verdict.reason,
              registration_reason: registration.reason,
              previous_ask_id: latestAsk ? latestAsk.id : null,
              answered_at: answeredAt,
              vat_activity_evidence: evidenceSummary
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
             values ($1, $2, 'system', 'system', 'vat_registration.status_asked', 'client_evidence_request', $3, $4::jsonb)`,
            [candidate.firm_id, candidate.client_id, askId, JSON.stringify({
              as_of: watchDate,
              reason: verdict.reason,
              registration_reason: registration.reason,
              previous_ask_id: latestAsk ? latestAsk.id : null,
              vat_activity_evidence: evidenceSummary,
              authority_basis: 'statutory_obligation:ae_vat_registration'
            })]
          );
        }
        await client.query('commit');
      } catch (mintError) {
        await client.query('rollback');
        throw mintError;
      }
      if (!inserted) {
        skip('ask_id_exists');
        continue;
      }
      summary.minted += 1;
      await deliver({ firmId: candidate.firm_id, clientId: candidate.client_id, evidenceRequestIds: [askId] });
      summary.delivered += 1;
    } catch (error) {
      summary.errors += 1;
    }
  }
  return summary;
};
