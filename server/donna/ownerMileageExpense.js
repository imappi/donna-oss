import { resolveOwnerExpenseCapability } from './ownerExpenseRegistry.js';
import { resolveSellerJurisdiction } from './ownerInvoiceSellerContext.js';
import { persistApplyReceipt } from './proposalStore.js';
import { getDispositionMaterialityPolicy, getDispositionMaterialityCeiling, exceedsMaterialityCeiling } from './dispositionMateriality.js';
import { toLocalIsoDay } from './dates.js';

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const clean = (value, max = 240) => String(value || '').trim().slice(0, max);
const yearFromDate = (date, fallback = new Date()) => {
  const match = String(date || '').match(/^(\d{4})/);
  if (match) return Number(match[1]);
  return new Date(fallback).getUTCFullYear();
};
export const buildOwnerMileageComputation = ({ jurisdiction, miles, km, date, now = new Date(), registry } = {}) => {
  const year = yearFromDate(date, now);
  const capability = resolveOwnerExpenseCapability({ jurisdiction, operation: 'mileage', registry });
  return capability ? capability.implementation({ miles, km, year })
    : { status: 'needs_clarification', reason: 'unsupported_jurisdiction', year };
};

const accountLabel = (account = {}) => [account.code || account.account_code, account.name || account.account_name].filter(Boolean).join(' · ') || account.name || account.account_name || account.code || account.account_code || '';
const scoreAccount = (account = {}, patterns = []) => {
  const hay = `${account.code || ''} ${account.account_code || ''} ${account.name || ''} ${account.account_name || ''} ${account.canonical_role || ''} ${account.account_type || ''}`.toLowerCase();
  return patterns.reduce((score, pattern) => score + (pattern.test(hay) ? 1 : 0), 0);
};

export const pickMileageAccounts = (accounts = []) => {
  const active = (Array.isArray(accounts) ? accounts : []).filter((a) => !a.status || a.status === 'active');
  const expense = active
    .map((account) => ({ account, score: scoreAccount(account, [/mileage/, /vehicle/, /auto/, /travel/, /expense/]) }))
    .filter((row) => row.score > 0 && !/liability|equity|income|revenue/i.test(String(row.account.account_type || '')))
    .sort((a, b) => b.score - a.score || accountLabel(a.account).localeCompare(accountLabel(b.account)))[0]?.account || null;
  const offset = active
    .map((account) => ({ account, score: scoreAccount(account, [/owner/, /member/, /director/, /loan/, /due to/, /equity/, /liability/]) }))
    .filter((row) => row.score > 0 && !/expense|income|revenue/i.test(String(row.account.account_type || '')))
    .sort((a, b) => b.score - a.score || accountLabel(a.account).localeCompare(accountLabel(b.account)))[0]?.account || null;
  return { expense, offset };
};

// The owner-facing "booked" line, per owner language (preferredOwnerTemplateLanguage,
// passed in by the caller). English is the historical copy, unchanged, and is
// also what the apply receipt records as operator_words. Finnish uses a decimal
// comma and the amount before the currency code, as the parse summaries do.
const MILEAGE_BOOKED_COPY = Object.freeze({
  en: ({ distance, unit, purpose, currency, amount }) =>
    `Booked: ${distance} ${unit}${distance === 1 ? '' : 's'} for ${purpose}, ${currency} ${amount.toFixed(2)} computed at the current mileage rate.`,
  fi: ({ distance, unit, purpose, currency, amount }) => {
    const shown = String(distance).replace('.', ',');
    const measured = unit === 'km' ? `${shown} km` : `${shown} ${distance === 1 ? 'maili' : 'mailia'}`;
    const rate = unit === 'km' ? 'kilometrikorvauksella' : 'mailikorvauksella';
    return `Kirjasin ${measured} (${purpose}): ${amount.toFixed(2).replace('.', ',')} ${currency} nykyisellä ${rate}.`;
  }
});

export const ownerMileageBookedText = ({ computation = {}, purpose = '', currency, amount, language = 'en' } = {}) =>
  (MILEAGE_BOOKED_COPY[language] || MILEAGE_BOOKED_COPY.en)({
    distance: computation.miles || computation.km,
    unit: computation.unit,
    purpose,
    currency: currency || computation.currency,
    amount: Number(amount)
  });

export const buildOwnerMileageJournal = ({ action = {}, clientProfile = {}, accounts = [], actorId, sourceMessageId, model, now = new Date(), language = 'en' } = {}) => {
  const miles = Number(action.miles);
  const purpose = clean(action.purpose || action.reason, 280);
  const date = clean(action.date, 20) || toLocalIsoDay(now); // host-local day (audit F-11)
  const confidence = clean(action.confidence, 20) || 'medium';
  if (!Number.isFinite(miles) || miles <= 0) return { status: 'needs_clarification', reason: 'missing_distance' };
  if (!purpose) return { status: 'needs_clarification', reason: 'missing_business_purpose' };
  if (!['high', 'confirmed'].includes(confidence)) return { status: 'proposed', reason: 'low_confidence' };
  const computation = buildOwnerMileageComputation({ jurisdiction: clientProfile.jurisdiction, miles, date, now });
  if (computation.status !== 'computed') return computation;
  const { expense, offset } = pickMileageAccounts(accounts);
  if (!expense || !offset) return { status: 'proposed', reason: 'chart_account_resolution_required', computation };
  const amount = round2(computation.deduction);
  const currency = computation.currency;
  // RT-11b — the ceiling follows the client's pack (home currency); env is
  // the only override; no pack ⇒ the unset marker and the journal stays proposed.
  const materialityPolicy = getDispositionMaterialityPolicy({ jurisdiction: clientProfile.jurisdiction });
  const materialityCeiling = materialityPolicy.ceiling;
  if (exceedsMaterialityCeiling(amount, materialityCeiling)) {
    return {
      status: 'proposed',
      reason: 'above_materiality_ceiling',
      computation,
      materiality_ceiling: Number.isFinite(materialityCeiling) ? materialityCeiling : null,
      materiality_ceiling_source: materialityPolicy.source
    };
  }
  if (!(amount > 0)) return { status: 'needs_clarification', reason: 'zero_amount', computation };
  const sourceId = `owner_mileage:${sourceMessageId || `${date}:${miles}:${purpose}`}`;
  return {
    status: 'ready',
    computation,
    // English: the apply receipt's operator_words. ownerConsequence: the same
    // line in the owner's language, which is what the owner is sent.
    consequence: ownerMileageBookedText({ computation, purpose, currency, amount }),
    ownerConsequence: ownerMileageBookedText({ computation, purpose, currency, amount, language }),
    journal: {
      source_type: 'owner_stated_mileage',
      source_id: sourceId,
      journal_date: date,
      currency,
      amount,
      memo: `Owner-stated business mileage: ${purpose}`,
      accounts: [
        { ...expense, role: 'expense.mileage', label: accountLabel(expense) },
        { ...offset, role: 'liability.owner_reimbursement', label: accountLabel(offset) }
      ],
      lines: [
        { account: { ...expense, role: 'expense.mileage', label: accountLabel(expense) }, direction: 'debit', debit: amount, credit: 0, amount, currency, memo: purpose },
        { account: { ...offset, role: 'liability.owner_reimbursement', label: accountLabel(offset) }, direction: 'credit', debit: 0, credit: amount, amount, currency, memo: purpose }
      ]
    },
    payload: {
      source: 'owner_stated_mileage', actor_id: actorId || null, source_message_id: sourceMessageId || null,
      model: model || null, purpose, date, confidence, computation,
      authority_basis: { source: 'owner_attestation', actor_id: actorId || null, source_message_id: sourceMessageId || null }
    }
  };
};

// `language` is the owner's (preferredOwnerTemplateLanguage); it only picks the
// wording of the returned `consequence` (the text the owner is sent). The
// receipt's operator_words stay English.
export const recordOwnerMileageExpenseInDb = async ({ firmId, clientId, action, actorId, sourceMessageId, model, now = new Date(), language = 'en', deps = {} } = {}) => {
  const { withFirmDbClient, writeValidatedJournal } = deps;
  const db = withFirmDbClient || (await import('./firmDb.js')).withFirmDbClient;
  const writeJournal = writeValidatedJournal || (await import('./ledgerPostingGateway.js')).writeValidatedJournalWithinTransaction;
  return db(async (client) => {
    let profileRes;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await client.query('begin');
      try {
        // Keep provisioning's key-first order and avoid a shared-lock upgrade
        // when the existing journal writer fills a chart dependency.
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`entity-readiness:${firmId}:${clientId}`]);
        // A profile updater can already own this row while its dependency
        // trigger waits on our key. Never wait for that row with the key held.
        profileRes = await client.query('select id, jurisdiction, entity_type, profile from clients where firm_id = $1 and id = $2 limit 1 for update nowait', [firmId, clientId]);
        break;
      } catch (error) {
        await client.query('rollback');
        if (error.code !== '55P03' || attempt === 2) throw error;
        // No effects have started. Let the updater finish without holding any
        // transaction lock, then re-admit against its newly committed country.
        await client.query('select id from clients where firm_id = $1 and id = $2 limit 1 for update', [firmId, clientId]);
      }
    }
    try {
      const row = profileRes.rows[0] || {};
      const identity = resolveSellerJurisdiction(row);
      const profile = { ...row, jurisdiction: identity.jurisdiction, accounting_currency: profileRes.rows[0]?.profile?.accounting_currency || profileRes.rows[0]?.profile?.currency || undefined };
      const date = clean(action?.date, 20) || toLocalIsoDay(now);
      const purpose = clean(action?.purpose || action?.reason, 280);
      const sourceId = `owner_mileage:${sourceMessageId || `${date}:${Number(action?.miles)}:${purpose}`}`;
      // A repeated owner message is a replay of its retained decision. The shared
      // journal primitive permits upsert; this domain writer must not use that to
      // reinterpret an old mileage claim under a changed country, date or chart.
      const retained = await client.query(
        `select j.id, j.status, j.reversed_at, j.payload, j.currency, (select coalesce(sum(l.debit),0) from ledger_lines l where l.journal_id = j.id) as amount, cp.id as close_period_id
         from ledger_journals j
         left join close_periods cp on cp.firm_id = j.firm_id and cp.client_id = j.client_id
           and cp.status = 'locked' and j.journal_date between cp.period_start and cp.period_end
         where j.firm_id = $1 and j.client_id = $2 and j.source_type = 'owner_stated_mileage'
           and j.source_id = $3 limit 1 for update of j`,
        [firmId, clientId, sourceId]
      );
      if (retained.rows[0]) {
        const existing = retained.rows[0];
        if (existing.close_period_id) {
          const error = new Error('Ledger journal is in a locked close period. Post a dated adjustment journal instead of reposting.');
          error.code = 'LEDGER_LOCKED_PERIOD_IMMUTABLE';
          error.statusCode = 409;
          throw error;
        }
        await client.query('commit');
        if (!['posted', 'closed'].includes(existing.status) || existing.reversed_at) return { status: 'preserved', reason: 'historical_mileage_corrected', ledger_journal_id: existing.id };
        return { status: 'booked', replay: true, ledger_status: existing.status, ledger_journal_id: existing.id,
          ledger_amount: Number(existing.amount), ledger_currency: existing.currency,
          computation: existing.payload?.computation || null };
      }
      const accountsRes = await client.query('select id, code, name, account_type, canonical_role, currency, status from ledger_accounts where firm_id = $1 and client_id = $2 and coalesce(status, $3) = $3', [firmId, clientId, 'active']);
      const built = buildOwnerMileageJournal({ action, clientProfile: profile, accounts: accountsRes.rows, actorId, sourceMessageId, model, now, language });
      if (built.status !== 'ready') {
        await client.query('commit');
        return built;
      }
      const posted = await writeJournal(client, built.journal, { firmId, clientId, payload: built.payload, actorId });
      const audit = await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, 'client', $3, 'owner_mileage.booked', 'ledger_journal', $4, $5::jsonb)
         returning id`,
        [firmId, clientId, actorId || null, posted.ledger_journal_id, JSON.stringify({ ...built.payload, ledger_journal_id: posted.ledger_journal_id })]
      );
      await persistApplyReceipt({
        client, firmId, clientId,
        receipt: {
          proposal_id: null,
          model: model || 'unknown',
          prompt_version: null,
          context_snapshot_id: null,
          candidate_ids_seen: [],
          candidate_ids_rejected: [],
          facts_available: ['owner_stated_mileage'],
          facts_used: ['owner_stated_mileage', 'current_mileage_rate', 'client_chart_of_accounts'],
          facts_conflicted: [],
          examples_available: [],
          examples_used: [],
          playbooks_used: [],
          policies_used: ['owner_stated_mileage_guardrails'],
          checks: { status: 'pass', checks: [
            { name: 'distance_and_purpose_present', status: 'pass', detail: null },
            { name: 'current_rate_exact', status: built.computation.exactRate ? 'pass' : 'fail', detail: built.computation.source || null },
            { name: 'materiality_ceiling', status: 'pass', detail: `${built.journal.currency} ${built.journal.amount.toFixed(2)} <= ${getDispositionMaterialityCeiling({ jurisdiction: profile.jurisdiction })}` },
            { name: 'period_not_locked', status: 'pass', detail: built.journal.journal_date },
            { name: 'chart_accounts_resolved', status: 'pass', detail: built.journal.accounts.map(accountLabel).join(' / ') },
            { name: 'journal_balances', status: 'pass', detail: `${built.journal.currency} ${built.journal.amount.toFixed(2)}` }
          ] },
          final_writer: 'recordOwnerMileageExpenseInDb',
          audit_event_ids: audit.rows[0]?.id ? [String(audit.rows[0].id)] : [],
          rows_touched: [posted.ledger_journal_id],
          per_target: [{ target: posted.ledger_journal_id, applied: true, error: null }],
          operator_words: built.consequence
        }
      });
      await client.query('commit');
      return { status: 'booked', ...posted, consequence: built.ownerConsequence, computation: built.computation, audit_event_id: audit.rows[0]?.id || null };
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};
