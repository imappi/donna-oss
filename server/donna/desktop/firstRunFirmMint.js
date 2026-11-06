// Gate 3 (first-run onboarding) — the firm mint. A virgin appliance DB has
// zero `firms` rows, so the SPA's client-create FK-fails on
// `clients_firm_id_fkey` (findings §4b / Gate 0 finding 2) and the desktop
// silently falls back to operating as the demo firm id. This module is the
// FIRST code path in the tree that creates a firm (the cloud's provisioning
// routes refuse to by design — one firm, many clients; selfProvisionDb.js).
//
// Shape follows selfProvisionDb.js: orchestration with injected DB deps so
// the decision logic is unit-testable; the route in api.js wires the real
// deps. Three refusals, all typed: not the desktop host (403 — the cloud
// must never grow a firm-mint surface by accident), a firm already exists
// (409 — first-run means FIRST; this also makes the route inert on every
// live book), and invalid input (400).
//
// Identity matters here more than anywhere: the member row minted below is
// the appliance's first REAL principal (name + email from the owner's own
// hands), the precondition for actor attribution (operator-safety substrate
// #1). Threading it into the desktop's synthetic access-token principal is
// Gate 2+ follow-up work, recorded — not smuggled in here.

export class FirstRunValidationError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}

export class FirstRunNotDesktopError extends Error {
  constructor() {
    super('First-run firm mint is only available on the desktop host.');
    this.statusCode = 403;
  }
}

export class FirstRunAlreadyProvisionedError extends Error {
  constructor(firmId) {
    super('A firm already exists; first-run onboarding is complete.');
    this.statusCode = 409;
    this.firmId = firmId || null;
  }
}

// The jurisdictions the onboarding select offers, with their default
// currencies. Informational firm-level fields (firms.jurisdiction is text,
// not an engine gate) — the pack contract governs per-client behavior, so
// offering SG here does not require an SG pack to exist.
export const FIRST_RUN_JURISDICTIONS = Object.freeze({
  GB: 'GBP',
  SG: 'SGD',
  FI: 'EUR',
  US: 'USD'
});

export const slugifyFirmName = (name) =>
  String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const normalizeFirstRunInput = (body = {}) => {
  const firmName = String(body.firm_name ?? body.firmName ?? '').trim();
  const ownerName = String(body.owner_name ?? body.ownerName ?? '').trim();
  const ownerEmail = String(body.owner_email ?? body.ownerEmail ?? '').trim().toLowerCase();
  const jurisdiction = String(body.jurisdiction ?? '').trim().toUpperCase();
  const rawCurrency = String(body.currency ?? '').trim().toUpperCase();

  if (!firmName) throw new FirstRunValidationError('Firm name is required.');
  if (!ownerName) throw new FirstRunValidationError('Your name is required.');
  if (!EMAIL_SHAPE.test(ownerEmail)) throw new FirstRunValidationError('A valid email is required.');
  if (!(jurisdiction in FIRST_RUN_JURISDICTIONS)) {
    throw new FirstRunValidationError(
      `Jurisdiction must be one of: ${Object.keys(FIRST_RUN_JURISDICTIONS).join(', ')}.`
    );
  }
  const currency = rawCurrency || FIRST_RUN_JURISDICTIONS[jurisdiction];
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new FirstRunValidationError('Currency must be a 3-letter code.');
  }
  const slug = slugifyFirmName(firmName);
  if (!slug) throw new FirstRunValidationError('Firm name must contain letters or digits.');

  return { firmName, ownerName, ownerEmail, jurisdiction, currency, slug };
};

// The mint. deps:
//   withFirmDbClientFn — firmDb.withFirmDbClient (a client with query())
//   isDesktopHost      — hostPlaneSeed.isDesktopHostEnv
//   seedFirmMetadata   — hostPlaneSeed.seedDesktopFirmMetadataWithClient
// Ids are deterministic from the slug: zero-firms is a precondition, so
// collisions are impossible by construction.
export const mintFirstRunFirm = async ({ input, deps }) => {
  const { withFirmDbClientFn, isDesktopHost, seedFirmMetadata } = deps || {};
  if (typeof isDesktopHost !== 'function' || !isDesktopHost()) {
    throw new FirstRunNotDesktopError();
  }
  const { firmName, ownerName, ownerEmail, jurisdiction, currency, slug } = input;
  const firmId = `firm-${slug}`;
  const memberId = `member-${slugifyFirmName(ownerEmail.split('@')[0]) || 'owner'}`;

  return withFirmDbClientFn(async (client) => {
    await client.query('begin');
    try {
      const existing = await client.query('select id from firms limit 1');
      if (existing.rows.length) {
        // Not an error path that needs the transaction — but rollback keeps
        // the invariant that every exit from this block ends the tx.
        await client.query('rollback');
        throw new FirstRunAlreadyProvisionedError(existing.rows[0].id);
      }
      await client.query(
        `insert into firms (id, name, slug, jurisdiction, default_currency, metadata)
         values ($1, $2, $3, $4, $5, $6::jsonb)`,
        [firmId, firmName, slug, jurisdiction, currency, JSON.stringify({ created_via: 'desktop_first_run' })]
      );
      await client.query(
        `insert into firm_members (id, firm_id, email, name, role, status, access_level, metadata)
         values ($1, $2, $3, $4, 'admin', 'active', 'owner', $5::jsonb)`,
        [memberId, firmId, ownerEmail, ownerName, JSON.stringify({ created_via: 'desktop_first_run' })]
      );
      // Attribution: the owner who typed the form is the actor — the first
      // audit row on this book that names a real human, not 'system'.
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, null, 'firm_member', $2, 'firm.first_run_minted', 'firm', $1, $3::jsonb)`,
        [firmId, ownerEmail, JSON.stringify({ member_id: memberId, jurisdiction, currency, source: 'desktop_first_run' })]
      );
      // The runtime-posture seed (auto-explain enables + loops tier) in the
      // SAME transaction — a firm born mid-session must not wait for the
      // next boot's backfill (the seedDesktopClientPlaneRowsWithClient
      // rationale, applied to the firm half).
      const seeded = typeof seedFirmMetadata === 'function'
        ? await seedFirmMetadata(client, { firmId })
        : [];
      await client.query('commit');
      return { firmId, memberId, slug, jurisdiction, currency, seeded };
    } catch (error) {
      try { await client.query('rollback'); } catch {}
      throw error;
    }
  });
};

// Client-create firm resolution (the silent-demo-fallback fix, Gate 0
// finding 2's second half). Order: an explicitly requested firm wins; an
// explicitly CONFIGURED default (env) wins next; then, when exactly one
// firm exists, that one — the appliance's normal state, and the honest
// answer on any single-firm deployment; only then the legacy demo-id
// constant, which the FK will police as before. Pure — the DB wrapper
// lives in firmDb.js.
export const resolveClientCreateFirmId = ({ requestedFirmId = null, configuredFirmId = null, firmRows = [] } = {}) => {
  if (requestedFirmId) return requestedFirmId;
  if (configuredFirmId) return configuredFirmId;
  if (Array.isArray(firmRows) && firmRows.length === 1 && firmRows[0]?.id) return firmRows[0].id;
  return null;
};
