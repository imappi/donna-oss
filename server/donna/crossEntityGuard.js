// Cross-entity intake guard (Kari's dated go, 2026-08-04 — findings §4b-ix
// first case, §4b-xvi second case).
//
// The failure shape, seen twice in acceptance: a document whose FIRM SIDE
// belongs to a DIFFERENT entity than the book's — the pilot client's book holding an
// invoice billed to Donna (sat unmatched, merely confusing), then Honeybee's
// book auto-matching a payment confirmation for an Amex card held by
// "Jason — Desert Bloom Apiaries" (worse: the match went AUTO on amount+date
// and the missing-account path minted a liability account for a debt that may
// not be the book's at all). The strong extractor had already READ the
// account-holder name in both cases; nothing compared it to the book's
// identity before granting autonomy.
//
// What this module does: a PURE, deterministic comparison between the
// client's identity (clients.company_name + legal_names — the same anchor the
// extractor prompts use, clientIdentityPrompt.js) and the document's OWN-SIDE
// name as the persisted extraction recorded it. No LLM call, ever — this is
// Keep-layer arithmetic over verdicts the strong model already wrote
// (trust-the-strong-LLM: render the persisted verdict, don't re-ask).
//
// What a MISMATCH does downstream (wired in the family matchers + the
// auto-explain passes): DEMOTES autonomy, never blocks the work — the match
// writes 'suggested' instead of 'auto_matched', the auto-explain passes
// refuse to settle, and the payload carries the detected relation so the ask
// lane can put the real question to the owner ("Honeybee paid a card held by
// Jason — Desert Bloom Apiaries — what's the relationship?"). Confident ⇒
// auto-reconcile, unsure ⇒ ask the owner; a cross-entity payment is the
// definition of unsure.
//
// CONSERVATIVE BY CONSTRUCTION. The guard only fires on a CONFIDENT mismatch:
// the document must name its own side with a multi-token name that shares NO
// significant token with any of the client's names. Absent fields, one-token
// names ("Amex"), and partial overlaps all resolve to 'unknown'/'aligned' —
// byte-identical behavior to before the guard existed. Failing open on
// uncertainty is deliberate: a false mismatch would demote legitimate
// matches book-wide, which is a worse failure than missing an exotic one.

const LEGAL_SUFFIXES = new Set([
  'llc', 'ltd', 'limited', 'inc', 'incorporated', 'corp', 'corporation',
  'co', 'company', 'plc', 'pte', 'llp', 'lp', 'gmbh', 'oy', 'oyj', 'ab',
  'as', 'bv', 'sarl', 'sas', 'kg', 'pty'
]);

const significantTokens = (value) => {
  const tokens = String(value || '')
    .toLowerCase()
    // Em-dashes and slashes commonly join a person to their business
    // ("Jason — Desert Bloom Apiaries"); treat every separator as a break.
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 1 && !LEGAL_SUFFIXES.has(t));
  return tokens;
};

// Light stemming so "Apiary" and "Apiaries" count as the same token — the
// guard must not treat an inflection as a different word. Plural/singular
// collapse only; anything fancier is inference.
const stem = (token) => token.replace(/(ies|es|s)$/, (m) => (m === 'ies' ? 'y' : ''));

// Generic business nouns carry NO identity: two apiaries share "Apiary" the
// way two consultancies share "Consulting" — a collision on the industry
// word must count as zero evidence of being the same entity (the live case:
// "Desert Bloom Apiaries" vs "Honeybee Hills Apiary" share only the trade).
// Distinctiveness is what identifies; these tokens are excluded from the
// shared count on both sides.
const GENERIC_BUSINESS_TOKENS = new Set([
  'apiary', 'consulting', 'trading', 'venture', 'holding', 'service',
  'solution', 'group', 'partner', 'enterprise', 'international', 'global',
  'farm', 'studio', 'agency', 'associate', 'industry', 'business'
].map(stem));

const distinctiveTokens = (value) => significantTokens(value)
  .map(stem)
  .filter((t) => !GENERIC_BUSINESS_TOKENS.has(t));

// How one document-side name relates to one client name. Counting runs over
// DISTINCTIVE tokens only; order matters for the head-token rule.
const relate = (docName, clientName) => {
  const doc = [...new Set(distinctiveTokens(docName))];
  const client = [...new Set(distinctiveTokens(clientName))];
  // A name that is all-generic ("Apiary Services") identifies nothing.
  if (doc.length === 0 || client.length === 0) return 'unknown';
  const clientSet = new Set(client);
  const shared = doc.filter((t) => clientSet.has(t));
  if (shared.length >= 2) return 'aligned';
  if (shared.length === 1) {
    // A singleton doc name aligns only when it matches the client's HEAD
    // token — the leading, most identifying word ("Honeybee" aligns with
    // "Honeybee Hills Apiary"; "Hills Trading" reducing to {hills} does
    // not). A singleton CLIENT name whose whole identity matched aligns.
    if (client.length === 1) return 'aligned';
    if (doc.length === 1 && shared[0] === client[0]) return 'aligned';
    // Otherwise a single shared token between substantial names is
    // genuinely ambiguous — never enough to fire on.
    return 'ambiguous';
  }
  // Zero distinctive overlap fires only when the document names its side
  // with SUBSTANCE: at least two significant tokens overall (so a bare
  // first name or brand word never fires) and at least one distinctive one.
  return significantTokens(docName).length >= 2 ? 'mismatch' : 'unknown';
};

// The document's OWN-SIDE name(s) — the party that should BE the book's
// entity, per document type. The counterparty legitimately differs and is
// never consulted.
export const documentOwnSideNames = (document = {}) => {
  const type = String(document?.document_type || '').toLowerCase();
  const names = [];
  const push = (value) => {
    const clean = String(value || '').trim();
    if (clean) names.push(clean);
  };
  if (type === 'sales_invoice' || type === 'issued_receipt') {
    // The book's entity ISSUED this document.
    push(document.vendor_name);
  } else if (type === 'supplier_bill' || type === 'receipt') {
    // The book's entity is the customer / bill-to side.
    push(document.customer_name);
  }
  // Generic-extractor documents (payment confirmations, account statements)
  // persist a full party list with roles in parse_summary.parties. The own
  // side is whoever PAID / holds the account — for the doc types above these
  // roles complement the header columns; for payment docs they are the only
  // source.
  const parties = Array.isArray(document?.parse_summary?.parties)
    ? document.parse_summary.parties
    : [];
  const OWN_SIDE_ROLES = new Set(
    type === 'sales_invoice' || type === 'issued_receipt'
      ? ['supplier', 'merchant']
      : ['payer', 'customer', 'company']
  );
  for (const party of parties) {
    if (party && OWN_SIDE_ROLES.has(String(party.role || '').toLowerCase())) {
      push(party.name);
    }
  }
  return names;
};

const clientNames = (clientIdentity = {}) => {
  const names = [];
  if (clientIdentity?.display_name) names.push(clientIdentity.display_name);
  for (const legal of Array.isArray(clientIdentity?.legal_names) ? clientIdentity.legal_names : []) {
    if (legal) names.push(legal);
  }
  // Owner-accepted own-side names (recordAcceptedEntityNameWithClient below):
  // a human confirmed a match this guard had capped, vouching that paper
  // bearing this name belongs in this book. Consulted HERE ONLY — never by
  // the extractor identity anchors (clientIdentityPrompt) — so a related
  // entity's name can align the guard without teaching extraction that the
  // name is "us".
  for (const accepted of Array.isArray(clientIdentity?.accepted_names) ? clientIdentity.accepted_names : []) {
    if (accepted) names.push(accepted);
  }
  return names;
};

// The assessment. Returns { verdict, own_side, matched_client_name }:
//   aligned  — at least one own-side name aligns with a client name; autonomy
//              proceeds exactly as before.
//   mismatch — EVERY own-side name with substance mismatches EVERY client
//              name: the document does not belong to this book's entity.
//              `own_side` carries the name for the ask / the payload receipt.
//   unknown  — nothing to compare (absent fields, one-token names, ambiguous
//              overlap, no client identity). No behavior change.
export const assessDocumentEntityAlignment = ({ clientIdentity = null, document = null } = {}) => {
  const ownSide = documentOwnSideNames(document || {});
  const clients = clientNames(clientIdentity || {});
  if (!ownSide.length || !clients.length) return { verdict: 'unknown', own_side: null, matched_client_name: null };

  let firstMismatch = null;
  let sawMismatch = false;
  let sawAmbiguous = false;
  for (const docName of ownSide) {
    let nameVerdict = 'unknown';
    for (const clientName of clients) {
      const r = relate(docName, clientName);
      if (r === 'aligned') return { verdict: 'aligned', own_side: docName, matched_client_name: clientName };
      if (r === 'ambiguous') nameVerdict = 'ambiguous';
      else if (r === 'mismatch' && nameVerdict !== 'ambiguous') nameVerdict = 'mismatch';
    }
    if (nameVerdict === 'mismatch') {
      sawMismatch = true;
      if (!firstMismatch) firstMismatch = docName;
    }
    if (nameVerdict === 'ambiguous') sawAmbiguous = true;
  }
  // Any ambiguity anywhere → fail open. Only a clean sweep of confident
  // mismatches fires the guard.
  if (sawMismatch && !sawAmbiguous) {
    return { verdict: 'mismatch', own_side: firstMismatch, matched_client_name: null };
  }
  return { verdict: 'unknown', own_side: null, matched_client_name: null };
};

// The payload stamp a matcher writes when the guard fires — the persisted
// receipt the reconcile UI and the ask lane both render (render the persisted
// verdict; never re-infer at the surface).
export const crossEntityPayload = (assessment = {}) => ({
  detected: true,
  own_side: assessment.own_side || null,
  reason: 'document_own_side_does_not_match_client_identity'
});

// Convenience reader for callers already holding a DB client inside the
// writer transaction (the matchers, the auto-explain passes). Soft-fails to
// null → the assessment resolves 'unknown' → no behavior change.
export const readClientIdentityWithClient = async (client, { firmId, clientId } = {}) => {
  if (!client || !firmId || !clientId) return null;
  try {
    const result = await client.query(
      'select id, company_name, legal_names, profile from clients where firm_id = $1 and id = $2 limit 1',
      [firmId, clientId]
    );
    if (!result.rows.length) return null;
    const row = result.rows[0];
    const profile = row.profile && typeof row.profile === 'object' ? row.profile : {};
    return {
      id: row.id,
      display_name: row.company_name || null,
      legal_names: Array.isArray(row.legal_names) ? row.legal_names.filter(Boolean) : [],
      accepted_names: Array.isArray(profile.cross_entity_accepted_names)
        ? profile.cross_entity_accepted_names.filter((n) => typeof n === 'string' && n.trim())
        : []
    };
  } catch (error) {
    console.warn('[crossEntityGuard] identity read failed — guard resolves unknown', {
      error: error?.message || String(error)
    });
    return null;
  }
};

// The learning half of the guard (Kari's dated go, 2026-08-25). A human
// CONFIRM of a match this guard capped is the confirmation moment: the owner
// vouched that paper bearing the document's own-side name belongs in this
// book. Record that name on the client row so the next assessment aligns —
// correction-as-training-signal, deterministic, no inference. Stored at
// clients.profile.cross_entity_accepted_names: consulted only by this guard
// (via readClientIdentityWithClient), never by the extractor identity
// anchors, and it dies with the client row by construction (the firm-memory
// rail). The caller owns the transaction; the audit row is written here IN
// that transaction — the learning cannot commit without its receipt.
export const recordAcceptedEntityNameWithClient = async (
  client,
  { firmId, clientId, ownSideName, actorId = 'system', matchId = null } = {}
) => {
  const name = String(ownSideName || '').trim();
  if (!client || !firmId || !clientId || !name) return { recorded: false, reason: 'missing_input' };
  const update = await client.query(
    `update clients
     set profile = jsonb_set(coalesce(profile, '{}'::jsonb), '{cross_entity_accepted_names}',
           coalesce(profile->'cross_entity_accepted_names', '[]'::jsonb) || to_jsonb($3::text)),
         updated_at = now()
     where firm_id = $1 and id = $2
       and not coalesce(profile->'cross_entity_accepted_names', '[]'::jsonb) @> to_jsonb($3::text)
     returning id`,
    [firmId, clientId, name]
  );
  if (!update.rows.length) return { recorded: false, reason: 'already_recorded' };
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', $3, 'client.cross_entity_name_accepted', 'client', $2, $4::jsonb)`,
    [firmId, clientId, actorId || 'system', JSON.stringify({ name, match_id: matchId, source: 'match_confirmed' })]
  );
  return { recorded: true, name };
};
