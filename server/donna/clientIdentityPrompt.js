// Client-identity prompt fragment — shared across the invoice / bill /
// receipt extractors so they speak with one voice about "which name on
// the page is the firm side, not the counterparty."
//
// Why this exists: without telling the LLM the client's name, the model
// has no way to tell which party on the document is the entity whose
// books are being kept. On a bill from a director to the company (e.g.
// the director → the client company) the model has no anchor for "the client is
// us; never return it as the counterparty." The shape on the page is
// symmetric — two names, one labelled "From", one labelled "Bill to" —
// and a weak-model AR-mode extractor can pick the wrong side.
//
// This fragment is appended to each extractor's INSTRUCTIONS. It is
// intentionally short: prompt bloat hurts more than it helps, and the
// canonical instructions already cover the field-level extraction rules.
//
// See `docs/donna-llm-trust-strategy.md` and `CLAUDE.md` for the broader
// principle this fragment serves (Slice A of the LLM-trust downgrade
// plan — give the strong model the context it needs instead of writing
// post-processing rules to clean up its confused output).

const sanitize = (value) => {
  if (value == null) return '';
  return String(value).trim().slice(0, 200);
};

const uniqueNames = (clientIdentity) => {
  if (!clientIdentity) return [];
  const out = [];
  const seen = new Set();
  const push = (name) => {
    const clean = sanitize(name);
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(clean);
  };
  push(clientIdentity.display_name);
  if (Array.isArray(clientIdentity.legal_names)) {
    for (const legal of clientIdentity.legal_names) push(legal);
  }
  return out;
};

// Returns a prompt fragment to APPEND to an extractor's INSTRUCTIONS.
// Empty string when no identity is available — callers can concatenate
// unconditionally.
export const buildClientIdentityPromptFragment = (clientIdentity) => {
  const names = uniqueNames(clientIdentity);
  const context = clientIdentity?.jurisdiction_status
    ? `\n\nENTITY CONTEXT — jurisdiction: ${sanitize(clientIdentity.jurisdiction) || 'unresolved'} (${sanitize(clientIdentity.jurisdiction_status)}); book currency: ${sanitize(clientIdentity.ledger_currency) || 'unresolved'}. These are entity facts, not document evidence. Never infer the entity jurisdiction from the document currency or substitute the book currency for an unreadable document currency.`
    : '';
  if (names.length === 0) return context;
  const display = names[0];
  const aliases = names.slice(1);
  const aliasLine = aliases.length
    ? `\nAlso recorded as: ${aliases.map((a) => `"${a}"`).join(', ')}.`
    : '';
  return `

FIRM-SIDE ANCHOR — the entity whose books are being kept is named "${display}".${aliasLine}
Never return this entity, or a close variant of its name, as the counterparty. If you see this name in a "From" / "Issued by" / "Vendor" position, that confirms the entity is the firm side; if you see it in a "Bill to" / "Sold to" / "Customer" position, that is the counterparty's view of the firm. Either way, the counterparty is the OTHER party on the document, never this entity.${context}`;
};
