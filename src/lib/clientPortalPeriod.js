// Derives the period the client portal HERO is allowed to speak about.
//
// The trap this closes: anchoring the hero's close-period claim to the
// newest loaded bank line. A book with only February 2025 transactions
// loaded greeted the client "I need N things before I can close FEBRUARY
// 2025" — but February isn't a close target the firm chose, it's just the
// latest row that happens to be in the book. That month is INFERRED, so the
// hero must NOT assert it; it speaks generically ("...before I can close
// your books") instead.
//
// A period is SPECIFIC only when it comes from an explicit firm action — an
// evidence request the firm raised (scoped to this client). Then, and only
// then, the hero may name the month. This is the "render the persisted
// verdict, not a guess" rail (CLAUDE.md) applied to portal copy: the newest
// bank line is a guess; an evidence request is a verdict.
//
// `label`/`title` are always formatted (tile copy still names the loaded
// month — "February statements…" — because that describes what to send, not
// a close commitment). The caller gates the assertive hero copy on
// `specific`, never on the label.

// Month label for the masthead ("FEBRUARY 2025"). The year rides along only
// when it isn't the current year, so a catch-up book reads "JULY 2025" while
// a live book stays a clean "JUNE". `now` is injectable for testing.
export const formatPeriodLabel = (date = new Date(), now = new Date()) => {
  const month = date.toLocaleDateString('en-US', { month: 'long' }).toUpperCase();
  return date.getFullYear() === now.getFullYear() ? month : `${month} ${date.getFullYear()}`;
};

// Title-case variant for tile descriptions ("February" not "FEBRUARY").
// Same current-year rule as formatPeriodLabel.
export const formatPeriodTitle = (date = new Date(), now = new Date()) => {
  const month = date.toLocaleDateString('en-US', { month: 'long' });
  return date.getFullYear() === now.getFullYear() ? month : `${month} ${date.getFullYear()}`;
};

const toDate = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

// The latest usable date across a set of evidence requests. The month a
// request pins is the period of the work it's about (the transaction date),
// falling back to when the firm raised it. Mirrors the date precedence in
// buildQuestionFromEvidenceRequest so the hero period and the question rows
// agree on which month is in play.
const latestEvidenceRequestDate = (evidenceRequests = []) => {
  let latest = null;
  for (const request of evidenceRequests || []) {
    const payload = request?.request_payload || {};
    const date =
      toDate(payload.date) ||
      toDate(request?.due_at) ||
      toDate(request?.created_at) ||
      toDate(request?.updated_at);
    if (!date) continue;
    if (!latest || date > latest) latest = date;
  }
  return latest;
};

const newestTransactionDate = (transactions = []) => {
  let latest = null;
  for (const tx of transactions || []) {
    const date = toDate(tx?.date) || toDate(tx?.transaction_date);
    if (!date) continue;
    if (!latest || date > latest) latest = date;
  }
  return latest;
};

// Returns { date, label, title, specific }.
//   specific:true  → an explicit (client-scoped) evidence-request period;
//                    the hero may name the month.
//   specific:false → inferred from the newest bank line, or an empty book;
//                    the hero must stay generic. `label`/`title` are still
//                    formatted (tile copy uses them) — only `specific` gates
//                    the close claim.
// An explicit evidence-request date always wins over the newest bank line,
// even an older one: the firm has actively scoped that month.
export const deriveClientPortalPeriod = ({
  evidenceRequests = [],
  transactions = [],
  now = new Date()
} = {}) => {
  const explicit = latestEvidenceRequestDate(evidenceRequests);
  const date = explicit || newestTransactionDate(transactions) || now;
  return {
    date,
    label: formatPeriodLabel(date, now),
    title: formatPeriodTitle(date, now),
    specific: Boolean(explicit)
  };
};
