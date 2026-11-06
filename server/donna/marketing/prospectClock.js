// The prospect clock — M2 of the closed-commercial-loop arc (Kari's call,
// 2026-07-24 session: close the loop before expanding acquisition; exit
// condition "no non-terminal prospect can remain indefinitely untouched").
//
// Two-terminal-states, applied on a timer. A prospect may legally REST as:
// a terminal, `on_kari` (his queue), `contacted_awaiting_reply` WITH a LIVE
// `next_action_at`, or `research_only` (the deliberate parking lane). The
// clock classifies every other rest — and every EXPIRED `next_action_at` —
// as due work, surfaces it in the /prospects/overview `due` block, and (at
// most once per cooldown) lands a founder nudge email, receipted as a
// `prospect_clock` source run. Nothing silent: the nudge IS the receipt row.
//
// The nudge email is an INTERNAL ops notification to the founder — not a
// marketing send to a lead, so the suppression/claim-checklist machinery
// (which governs lead-facing sends) deliberately does not apply. It rides
// the same one Resend module boundary as everything else.
//
// Deliberate NON-actions (named so nobody "fixes" them by accident):
//   - NO lifecycle transitions. Auto-closing a due `contacted_awaiting_reply`
//     requires the one-follow-up-then-close policy (prospecting doc §8),
//     which needs P1's follow-up machinery. That auto-close lands on THIS
//     seam when P1 ships; until then dueness surfaces, it never teleports.
//   - NO auto re-investigation of stalled transients. A cron spending
//     strong-model tokens is an authority decision, not a clock feature.
//   - NO LLM anywhere in this module; arithmetic only.
//
// Kill switch: MARKETING_CLOCK_FORCE_DISABLE (env may KILL a behavior, never
// enable one — the rollout-flags rail). The nudge recipient is
// MARKETING_CLOCK_NUDGE_TO; unset, the sweep still runs and receipts — only
// the email is skipped, loudly, in the summary (a destination address is
// deployment config the firm-agnostic marketing lab has no other home for;
// it is not a rollout gate).

import { TERMINAL_PROSPECT_STATUSES, CLOCK_SOURCE } from './prospectLab.js';
import {
  finishSourceRun,
  lastClockRunAt,
  listClockProspects,
  startSourceRun
} from './prospectLabDb.js';
import { sendEmail } from '../email/resendClient.js';
import { toLocalIsoDay } from '../dates.js';

const MS_PER_DAY = 86_400_000;

export const DUE_KINDS = Object.freeze([
  'revisit_due', // on_kari hold whose revisit date arrived
  'follow_up_due', // contacted_awaiting_reply past (or missing) its clock
  'stalled_transient', // candidate/investigating untouched too long
  'blocked_on_sends' // approved_for_* resting: P0 stops here until P1 ships
]);

const toMs = (value) => {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

// Classify one prospect's rest. Returns null for a LEGAL rest, or
// { due_kind, due_since } for one the clock must surface. Pure.
export const classifyProspectDueness = (
  prospect = {},
  { now = new Date(), staleAfterDays = 7 } = {}
) => {
  const status = prospect.status;
  if (TERMINAL_PROSPECT_STATUSES.includes(status) || status === 'research_only') return null;

  const nowMs = toMs(now);
  const nextAt = toMs(prospect.next_action_at);
  const updatedAt = toMs(prospect.updated_at);
  const staleMs = staleAfterDays * MS_PER_DAY;

  if (status === 'on_kari') {
    // on_kari without a revisit date is a legal rest — the queue IS the
    // surface. A hold whose revisit date passed is due again.
    if (nextAt != null && nextAt <= nowMs) {
      return { due_kind: 'revisit_due', due_since: prospect.next_action_at };
    }
    return null;
  }

  if (status === 'contacted_awaiting_reply') {
    // Legal ONLY with a live next_action_at (§5). A missing clock is itself
    // a violation to surface — due immediately, not silently fine.
    if (nextAt == null) {
      return { due_kind: 'follow_up_due', due_since: prospect.updated_at || null };
    }
    if (nextAt <= nowMs) {
      return { due_kind: 'follow_up_due', due_since: prospect.next_action_at };
    }
    return null;
  }

  if (status === 'candidate' || status === 'investigating') {
    // Transient hops the pipeline drains — stalled when untouched too long
    // (a drafter refusal leaves `investigating`; nothing retries on a clock).
    if (updatedAt != null && nowMs - updatedAt >= staleMs) {
      return { due_kind: 'stalled_transient', due_since: prospect.updated_at };
    }
    return null;
  }

  if (status === 'approved_for_draft' || status === 'approved_for_send') {
    // P0 stops here by design (zero sends until P1). Old approvals are still
    // surfaced so "approved and forgotten" cannot rest invisibly.
    if (updatedAt != null && nowMs - updatedAt >= staleMs) {
      return { due_kind: 'blocked_on_sends', due_since: prospect.updated_at };
    }
    return null;
  }

  return null;
};

export const summarizeDueness = (prospects = [], opts = {}) => {
  const due = [];
  const counts = Object.fromEntries(DUE_KINDS.map((kind) => [kind, 0]));
  for (const prospect of prospects) {
    const verdict = classifyProspectDueness(prospect, opts);
    if (!verdict) continue;
    counts[verdict.due_kind] += 1;
    due.push({
      id: prospect.id,
      company_name: prospect.company_name,
      status: prospect.status,
      tier: prospect.tier,
      due_kind: verdict.due_kind,
      due_since: verdict.due_since ?? null
    });
  }
  return { due, counts, due_total: due.length };
};

const isDisabled = (env) => {
  const v = String(env.MARKETING_CLOCK_FORCE_DISABLE || '').toLowerCase();
  return v === '1' || v === 'true';
};

const renderNudge = ({ due, counts, due_total }) => {
  // "since" is the host-local day Kari reads on the wall clock.
  const lines = due
    .slice(0, 20)
    .map((d) => `- ${d.company_name} · ${d.status} · ${d.due_kind}${d.due_since ? ` · since ${toLocalIsoDay(d.due_since)}` : ''}`);
  const breakdown = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${kind}: ${n}`)
    .join(', ');
  return {
    subject: `Prospect clock: ${due_total} item${due_total === 1 ? '' : 's'} due (${breakdown})`,
    text: [
      `The prospect clock found ${due_total} item${due_total === 1 ? '' : 's'} resting past their clock.`,
      '',
      ...lines,
      due.length > 20 ? `…and ${due.length - 20} more.` : '',
      '',
      'Review: /firms/marketing (Prospecting Lab).',
      'This is an internal ops nudge from the hourly prospect clock — it repeats at most once per cooldown while items stay due.'
    ].filter((l) => l !== '').join('\n')
  };
};

// The sweep. One firm-agnostic pass; hourly cron, concurrency 1. Injectable
// impls keep the tests pure (no pg, no Resend).
export const runMarketingProspectsDueSweep = async ({
  now = new Date(),
  logger,
  env = process.env,
  nudgeCooldownHours = Number(process.env.MARKETING_CLOCK_NUDGE_COOLDOWN_HOURS || 24),
  listClockProspectsImpl = listClockProspects,
  lastClockRunAtImpl = lastClockRunAt,
  startSourceRunImpl = startSourceRun,
  finishSourceRunImpl = finishSourceRun,
  sendEmailImpl = sendEmail
} = {}) => {
  const log = logger || console;
  const summary = {
    disabled: false,
    considered: 0,
    due_total: 0,
    counts: Object.fromEntries(DUE_KINDS.map((kind) => [kind, 0])),
    nudge_sent: false,
    nudge_skipped_recent: false,
    nudge_skipped_no_recipient: false,
    receipt_run_id: null,
    errors: []
  };

  if (isDisabled(env)) {
    summary.disabled = true;
    return summary;
  }

  let prospects = [];
  try {
    prospects = await listClockProspectsImpl();
  } catch (err) {
    log.error?.('prospect-clock: listing failed', { error: err?.message });
    summary.errors.push({ stage: 'list', message: err?.message || String(err) });
    return summary;
  }
  summary.considered = prospects.length;

  const dueness = summarizeDueness(prospects, { now });
  summary.due_total = dueness.due_total;
  summary.counts = dueness.counts;

  // Quiet clock: nothing due → no receipt row, no email. The Inngest run
  // history is the heartbeat; receipt rows mean "the clock escalated".
  if (dueness.due_total === 0) return summary;

  // Cooldown keys off the LAST prospect_clock receipt — a receipt row exists
  // exactly when a nudge round happened, so this is idempotent across hours.
  try {
    const lastRunAt = await lastClockRunAtImpl();
    const lastMs = toMs(lastRunAt);
    if (lastMs != null && toMs(now) - lastMs < nudgeCooldownHours * 3_600_000) {
      summary.nudge_skipped_recent = true;
      return summary;
    }
  } catch (err) {
    summary.errors.push({ stage: 'cooldown', message: err?.message || String(err) });
    return summary;
  }

  let run;
  try {
    run = await startSourceRunImpl({
      source: CLOCK_SOURCE,
      params: { due_total: dueness.due_total, counts: dueness.counts },
      startedBy: 'system:prospect_clock'
    });
    summary.receipt_run_id = run.id;
  } catch (err) {
    summary.errors.push({ stage: 'receipt', message: err?.message || String(err) });
    return summary;
  }

  let emailError = null;
  const recipient = String(env.MARKETING_CLOCK_NUDGE_TO || '').trim();
  if (!recipient) {
    summary.nudge_skipped_no_recipient = true;
    emailError = 'MARKETING_CLOCK_NUDGE_TO is not configured; nudge email skipped';
  } else {
    try {
      const { subject, text } = renderNudge(dueness);
      const result = await sendEmailImpl({ to: recipient, subject, text });
      if (result?.ok) summary.nudge_sent = true;
      else emailError = result?.error || result?.reason || 'nudge email send failed';
    } catch (err) {
      emailError = err?.message || String(err);
    }
  }
  if (emailError) summary.errors.push({ stage: 'nudge', message: emailError });

  try {
    await finishSourceRunImpl({
      runId: run.id,
      candidatesFound: dueness.due_total,
      prospectsMinted: 0,
      error: emailError
    });
  } catch (err) {
    summary.errors.push({ stage: 'receipt_finish', message: err?.message || String(err) });
  }

  return summary;
};
