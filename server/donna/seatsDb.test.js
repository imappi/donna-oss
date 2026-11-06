// Seat lifecycle writers + roster + external fences — behavior tests over an
// in-memory fake pg client (the deps-injection pattern of this module family).
// What's pinned here:
//   - invite: owner-gated; writes collaborator + assignments + seat.invited in
//     ONE transaction; duplicate email → 409; scoped owner cannot invite into
//     another customer's entities.
//   - roster: scoped callers see only their own row + seats intersecting their
//     allowed set; external seats are denied the roster outright; the expiry
//     sweep suspends-with-receipt.
//   - lifecycle ops: authorization per op (owner vs owner-or-partner),
//     reactivating an expired engagement refuses until extended.
//   - entity assignment: external seats can never drop to zero entities;
//     changes are receipted with added/removed provenance.
//   - fences: export deny for external seats; chase release honors the
//     EXTERNAL_SEAT_CHASE_RELEASE flag and receipts the refusal.
//   - invite email (migration 125): the sign-in link rides publicAppOrigin,
//     the exact address is always named; resend is owner-gated + invited-only
//     and stamps the outcome + seat.invite_email receipt on the row.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  listFirmSeats,
  inviteSeatInDb,
  updateSeatInDb,
  setSeatEntitiesInDb,
  sendSeatInviteEmail,
  resendSeatInviteEmail,
  assertExternalChaseReleaseAllowed,
  assertSeatExportAllowed
} from './seatsDb.js';

// ── The in-memory fake ───────────────────────────────────────────────────────

const mkStore = ({ members = [], collaborators = [], assignments = [], clients = [], flags = [] } = {}) => ({
  members, collaborators, assignments, clients, flags, audits: []
});

const fakeClientFor = (store) => ({
  query: async (sql, params = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^(begin|commit|rollback)$/i.test(text)) return { rows: [] };

    if (/insert into audit_events/i.test(text)) {
      // Some seat inserts carry the action as a SQL literal, others as a
      // parameter — record both so assertions can match either shape.
      store.audits.push({ sql: text, params });
      return { rows: [] };
    }

    if (/select \* from firm_members/i.test(text)) {
      return { rows: store.members.filter((r) => r.status === 'active') };
    }
    if (/select \* from firm_collaborators where firm_id = \$1 and id = \$2/i.test(text)) {
      return { rows: store.collaborators.filter((r) => r.id === params[1] && r.seat_role) };
    }
    if (/from firm_collaborators where firm_id = \$1 and seat_role is not null and status <> 'suspended' and ends_at/i.test(text)) {
      const now = Date.now();
      return { rows: store.collaborators.filter((r) => r.seat_role && r.status !== 'suspended' && r.ends_at && new Date(r.ends_at).getTime() <= now) };
    }
    if (/from firm_collaborators where firm_id = \$1 and \(seat_role is not null or role = 'owner'\)/i.test(text)) {
      return { rows: store.collaborators.filter((r) => r.seat_role || r.role === 'owner') };
    }
    if (/insert into firm_collaborators/i.test(text)) {
      const [id, firmId, email, name, seatRole, affiliation, endsAt] = params;
      if (store.collaborators.some((r) => r.email === email)) return { rows: [] }; // on conflict do nothing
      const row = {
        id, firm_id: firmId, email, name, role: seatRole, seat_role: seatRole, affiliation,
        status: 'invited', access_level: 'client_scoped', ends_at: endsAt, invited_at: new Date().toISOString(),
        activated_at: null, suspended_at: null, user_id: null
      };
      store.collaborators.push(row);
      return { rows: [row] };
    }
    if (/update firm_collaborators set status = 'suspended'/i.test(text)) {
      const row = store.collaborators.find((r) => r.id === params[0] && r.status !== 'suspended');
      if (!row) return { rows: [] };
      row.status = 'suspended'; row.suspended_at = new Date().toISOString();
      return { rows: [row] };
    }
    if (/update firm_collaborators set seat_role = \$2/i.test(text)) {
      const row = store.collaborators.find((r) => r.id === params[0]);
      row.seat_role = params[1]; row.role = params[1];
      return { rows: [row] };
    }
    if (/update firm_collaborators set status = \$2/i.test(text)) {
      const row = store.collaborators.find((r) => r.id === params[0]);
      row.status = params[1]; row.suspended_at = null; row.suspended_reason = null;
      return { rows: [row] };
    }
    if (/update firm_collaborators set ends_at = \$2/i.test(text)) {
      const row = store.collaborators.find((r) => r.id === params[0]);
      row.ends_at = params[1];
      return { rows: [row] };
    }
    if (/update firm_collaborators set invite_email_status = \$3/i.test(text)) {
      const row = store.collaborators.find((r) => r.id === params[1] && r.seat_role);
      if (!row) return { rows: [] };
      row.invite_email_status = params[2]; row.invite_email_reason = params[3];
      row.invite_email_at = new Date().toISOString();
      return { rows: [{ invite_email_status: row.invite_email_status, invite_email_reason: row.invite_email_reason, invite_email_at: row.invite_email_at }] };
    }

    if (/select principal_id, client_id from client_assignments/i.test(text)) {
      const ids = params[1] || [];
      return { rows: store.assignments.filter((a) => ids.includes(a.principal_id)) };
    }
    if (/insert into client_assignments/i.test(text)) {
      const [id, firmId, clientId, principalId, role, endsAt] = params;
      const existing = store.assignments.find((a) => a.client_id === clientId && a.principal_id === principalId);
      if (existing) { existing.role = role; existing.ends_at = endsAt; } else {
        store.assignments.push({ id, firm_id: firmId, client_id: clientId, principal_id: principalId, role, ends_at: endsAt });
      }
      return { rows: [] };
    }
    if (/update client_assignments set role = \$3/i.test(text)) {
      for (const a of store.assignments.filter((a) => a.principal_id === params[1])) a.role = params[2];
      return { rows: [] };
    }
    if (/update client_assignments set ends_at = \$3/i.test(text)) {
      for (const a of store.assignments.filter((a) => a.principal_id === params[1])) a.ends_at = params[2];
      return { rows: [] };
    }
    if (/delete from client_assignments/i.test(text)) {
      const removed = new Set(params[2] || []);
      store.assignments = store.assignments.filter((a) => !(a.principal_id === params[1] && removed.has(a.client_id)));
      return { rows: [] };
    }

    if (/select id, company_name from clients/i.test(text)) {
      return { rows: store.clients };
    }
    if (/select id from clients where firm_id = \$1 and id = any\(\$2\)/i.test(text)) {
      const wanted = new Set(params[1] || []);
      return { rows: store.clients.filter((c) => wanted.has(c.id)).map((c) => ({ id: c.id })) };
    }

    if (/from client_capability_config/i.test(text)) {
      return { rows: store.flags };
    }
    if (/from cohort_capability_config/i.test(text)) {
      return { rows: [] };
    }
    return { rows: [] };
  }
});

const depsFor = (store) => ({
  withFirmDbClient: async (callback) => callback(fakeClientFor(store)),
  queryFirmDb: (sql, params) => fakeClientFor(store).query(sql, params)
});

const OWNER = { principalType: 'firm_member', principalId: 'member-1', email: 'kari@books.example', unrestricted: true };
const CLOUD_OWNER = { principalType: 'firm_collaborator', principalId: 'collab-owner-1', email: 'owner@shop-com.example', role: 'owner', unrestricted: false };
const PARTNER_SEAT = { principalType: 'firm_collaborator', principalId: 'seat-p1', email: 'p@x-com.example', role: 'partner', seatRole: 'partner', affiliation: 'internal', unrestricted: false };
const JUNIOR_SEAT = { principalType: 'firm_collaborator', principalId: 'seat-j1', email: 'j@x-com.example', role: 'junior', seatRole: 'junior', affiliation: 'internal', unrestricted: false };
const EXTERNAL_SEAT = { principalType: 'firm_collaborator', principalId: 'seat-x1', email: 'x@x-com.example', role: 'senior', seatRole: 'senior', affiliation: 'external', unrestricted: false };

const CLIENTS = [{ id: 'client-a', company_name: 'Alpha Oy' }, { id: 'client-b', company_name: 'Beta Ltd' }];

// ── Invite ───────────────────────────────────────────────────────────────────

test('invite: owner writes seat + assignments + seat.invited in one flow; roster shows it', async () => {
  const store = mkStore({ clients: CLIENTS });
  const deps = depsFor(store);
  const seat = await inviteSeatInDb({
    firmId: 'firm-1', actorPrincipal: OWNER, allowedClientIds: null,
    invite: { name: 'Maya K', email: 'Maya@Example.com', seatRole: 'junior', affiliation: 'internal', clientIds: ['client-a'] },
    deps
  });
  assert.equal(seat.seat_role, 'junior');
  assert.equal(seat.status, 'invited');
  assert.deepEqual(seat.client_ids, ['client-a']);
  assert.equal(store.collaborators.length, 1);
  assert.equal(store.collaborators[0].email, 'maya@example.com'); // normalized
  assert.equal(store.assignments.length, 1);
  assert.equal(store.assignments[0].role, 'junior');
  assert.ok(store.audits.some((a) => a.sql.includes('seat.invited') || a.params.includes('seat.invited')), 'seat.invited receipted');
});

test('invite: non-owner actors are refused; duplicate email 409; external needs entities + end date', async () => {
  const store = mkStore({ clients: CLIENTS });
  const deps = depsFor(store);
  await assert.rejects(
    inviteSeatInDb({ firmId: 'firm-1', actorPrincipal: PARTNER_SEAT, invite: { name: 'A', email: 'a@x-com.example', seatRole: 'junior' }, deps }),
    /Only the owner/
  );
  await inviteSeatInDb({ firmId: 'firm-1', actorPrincipal: OWNER, invite: { name: 'A', email: 'a@x-com.example', seatRole: 'junior' }, deps });
  await assert.rejects(
    inviteSeatInDb({ firmId: 'firm-1', actorPrincipal: OWNER, invite: { name: 'A2', email: 'a@x-com.example', seatRole: 'senior' }, deps }),
    (e) => e.statusCode === 409
  );
  await assert.rejects(
    inviteSeatInDb({ firmId: 'firm-1', actorPrincipal: OWNER, invite: { name: 'X', email: 'x2@x-com.example', seatRole: 'senior', affiliation: 'external' }, deps }),
    (e) => e.code === 'external_requires_entities'
  );
});

test('invite: a scoped cloud owner cannot invite into entities outside their own set', async () => {
  const store = mkStore({ clients: CLIENTS });
  const deps = depsFor(store);
  await assert.rejects(
    inviteSeatInDb({
      firmId: 'firm-1', actorPrincipal: CLOUD_OWNER, allowedClientIds: ['client-a'],
      invite: { name: 'B', email: 'b@x-com.example', seatRole: 'junior', clientIds: ['client-b'] }, deps
    }),
    (e) => e.code === 'ENTITY_OUT_OF_SCOPE'
  );
  const ok = await inviteSeatInDb({
    firmId: 'firm-1', actorPrincipal: CLOUD_OWNER, allowedClientIds: ['client-a'],
    invite: { name: 'B', email: 'b@x-com.example', seatRole: 'junior', clientIds: ['client-a'] }, deps
  });
  assert.deepEqual(ok.client_ids, ['client-a']);
});

// ── Roster ───────────────────────────────────────────────────────────────────

test('roster: unrestricted sees members + all seats; scoped sees own row + intersecting seats; external denied', async () => {
  const store = mkStore({
    members: [{ id: 'member-1', name: 'Kari', email: 'kari@books.example', status: 'active' }],
    collaborators: [
      { id: 'collab-owner-1', name: 'Shop Owner', email: 'owner@shop-com.example', role: 'owner', status: 'active' },
      { id: 'seat-j1', name: 'J', email: 'j@x-com.example', role: 'junior', seat_role: 'junior', affiliation: 'internal', status: 'active' },
      { id: 'seat-k1', name: 'K', email: 'k@x-com.example', role: 'junior', seat_role: 'junior', affiliation: 'internal', status: 'active' }
    ],
    assignments: [
      { principal_id: 'collab-owner-1', client_id: 'client-a', role: 'owner' },
      { principal_id: 'seat-j1', client_id: 'client-a', role: 'junior' },
      { principal_id: 'seat-k1', client_id: 'client-b', role: 'junior' }
    ],
    clients: CLIENTS
  });
  const deps = depsFor(store);
  const all = await listFirmSeats({ firmId: 'firm-1', principal: OWNER, allowedClientIds: null, deps });
  assert.equal(all.seats.length, 4); // member owner + cloud owner + 2 seats
  const scoped = await listFirmSeats({ firmId: 'firm-1', principal: CLOUD_OWNER, allowedClientIds: ['client-a'], deps });
  const ids = scoped.seats.map((s) => s.id).sort();
  assert.deepEqual(ids, ['collab-owner-1', 'seat-j1'], 'only own row + client-a seats; no members, no client-b seat');
  await assert.rejects(
    listFirmSeats({ firmId: 'firm-1', principal: EXTERNAL_SEAT, allowedClientIds: ['client-a'], deps }),
    (e) => e.code === 'EXTERNAL_SEAT_FORBIDDEN'
  );
});

test('roster: the expiry sweep suspends past-window seats WITH the receipt', async () => {
  const store = mkStore({
    collaborators: [
      { id: 'seat-x1', name: 'X', email: 'x@x-com.example', role: 'senior', seat_role: 'senior', affiliation: 'external', status: 'active', ends_at: '2026-01-01T00:00:00Z' }
    ],
    assignments: [{ principal_id: 'seat-x1', client_id: 'client-a', role: 'senior' }],
    clients: CLIENTS
  });
  const deps = depsFor(store);
  const roster = await listFirmSeats({ firmId: 'firm-1', principal: OWNER, allowedClientIds: null, deps });
  assert.equal(roster.seats[0].status, 'suspended');
  assert.ok(store.audits.some((a) => a.sql.includes('seat.suspended') || a.params.includes('seat.suspended')), 'expiry receipted, never a silent lapse');
});

// ── Lifecycle ops ────────────────────────────────────────────────────────────

const lifecycleStore = () => mkStore({
  collaborators: [{
    id: 'seat-1', name: 'S', email: 's@x-com.example', role: 'junior', seat_role: 'junior', affiliation: 'external',
    status: 'active', activated_at: '2026-08-01T00:00:00Z', ends_at: '2026-01-01T00:00:00Z'
  }],
  assignments: [{ principal_id: 'seat-1', client_id: 'client-a', role: 'junior' }],
  clients: CLIENTS
});

test('lifecycle: role change + suspend are owner-only; extend is owner-or-internal-partner', async () => {
  const store = lifecycleStore();
  const deps = depsFor(store);
  await assert.rejects(
    updateSeatInDb({ firmId: 'firm-1', actorPrincipal: PARTNER_SEAT, seatId: 'seat-1', op: 'role_change', params: { seat_role: 'senior' }, deps }),
    /Only the owner/
  );
  const changed = await updateSeatInDb({ firmId: 'firm-1', actorPrincipal: OWNER, seatId: 'seat-1', op: 'role_change', params: { seat_role: 'senior' }, deps });
  assert.equal(changed.seat_role, 'senior');
  assert.equal(store.assignments[0].role, 'senior', 'assignment rows follow the role change');
  assert.ok(store.audits.some((a) => a.sql.includes('seat.role_changed') || a.params.includes('seat.role_changed')));
  // extend by internal partner: allowed; junior seat actor: refused
  const extended = await updateSeatInDb({ firmId: 'firm-1', actorPrincipal: PARTNER_SEAT, seatId: 'seat-1', op: 'extend', params: { ends_at: '2030-01-01T00:00:00Z' }, deps });
  assert.equal(extended.ends_at, '2030-01-01T00:00:00.000Z');
  await assert.rejects(
    updateSeatInDb({ firmId: 'firm-1', actorPrincipal: JUNIOR_SEAT, seatId: 'seat-1', op: 'extend', params: { ends_at: '2031-01-01' }, deps }),
    (e) => e.code === 'SEAT_EXTEND_REQUIRES_PARTNER'
  );
});

test('lifecycle: reactivating an expired engagement refuses until extended', async () => {
  const store = lifecycleStore();
  store.collaborators[0].status = 'suspended';
  const deps = depsFor(store);
  await assert.rejects(
    updateSeatInDb({ firmId: 'firm-1', actorPrincipal: OWNER, seatId: 'seat-1', op: 'reactivate', deps }),
    (e) => e.code === 'SEAT_ENGAGEMENT_EXPIRED'
  );
  store.collaborators[0].ends_at = '2030-01-01T00:00:00Z';
  const back = await updateSeatInDb({ firmId: 'firm-1', actorPrincipal: OWNER, seatId: 'seat-1', op: 'reactivate', deps });
  assert.equal(back.status, 'active');
  assert.ok(store.audits.some((a) => a.sql.includes('seat.reactivated') || a.params.includes('seat.reactivated')));
});

// ── Entity assignment ────────────────────────────────────────────────────────

test('entities: partner reassigns within scope; external seats can never reach zero entities', async () => {
  const store = lifecycleStore();
  const deps = depsFor(store);
  await assert.rejects(
    setSeatEntitiesInDb({ firmId: 'firm-1', actorPrincipal: OWNER, seatId: 'seat-1', clientIds: [], deps }),
    (e) => e.code === 'external_requires_entities'
  );
  const updated = await setSeatEntitiesInDb({ firmId: 'firm-1', actorPrincipal: PARTNER_SEAT, seatId: 'seat-1', clientIds: ['client-b'], deps });
  assert.deepEqual(updated.client_ids, ['client-b']);
  assert.deepEqual(store.assignments.map((a) => a.client_id), ['client-b']);
  const receipt = store.audits.find((a) => a.sql.includes('seat.entities_changed') || a.params.includes('seat.entities_changed'));
  assert.ok(receipt, 'entity change receipted');
  const metadata = JSON.parse(receipt.params[receipt.params.length - 1]);
  assert.deepEqual(metadata.added, ['client-b']);
  assert.deepEqual(metadata.removed, ['client-a']);
  // junior seats cannot manage entities at all
  await assert.rejects(
    setSeatEntitiesInDb({ firmId: 'firm-1', actorPrincipal: JUNIOR_SEAT, seatId: 'seat-1', clientIds: ['client-a'], deps }),
    (e) => e.code === 'SEAT_ENTITIES_REQUIRES_PARTNER'
  );
});

// ── Fences ───────────────────────────────────────────────────────────────────

test('export fence: external denied, everyone else passes', () => {
  assert.throws(() => assertSeatExportAllowed(EXTERNAL_SEAT), (e) => e.code === 'EXTERNAL_SEAT_EXPORT_DENIED');
  assert.doesNotThrow(() => assertSeatExportAllowed(OWNER));
  assert.doesNotThrow(() => assertSeatExportAllowed(CLOUD_OWNER));
  assert.doesNotThrow(() => assertSeatExportAllowed(JUNIOR_SEAT)); // internal seats may export
  assert.doesNotThrow(() => assertSeatExportAllowed(null));
});

test('chase fence: internal passes silently; external denied + receipted when the flag is off; allowed at canary', async () => {
  const offStore = mkStore({});
  await assert.doesNotReject(assertExternalChaseReleaseAllowed({ firmId: 'firm-1', clientId: 'client-a', principal: JUNIOR_SEAT, deps: depsFor(offStore) }));
  assert.equal(offStore.audits.length, 0, 'internal seats leave no fence trace');
  await assert.rejects(
    assertExternalChaseReleaseAllowed({ firmId: 'firm-1', clientId: 'client-a', principal: EXTERNAL_SEAT, deps: depsFor(offStore) }),
    (e) => e.statusCode === 403 && e.code === 'SEAT_AUTHORITY_ROUTED'
  );
  assert.ok(offStore.audits.some((a) => a.sql.includes('seat.approval_routed') || a.params.includes('seat.approval_routed')), 'the routed refusal is receipted');
  const onStore = mkStore({ flags: [{ flag_key: 'EXTERNAL_SEAT_CHASE_RELEASE', stage: 'canary', source: 'manual', client_id: 'client-a' }] });
  await assert.doesNotReject(assertExternalChaseReleaseAllowed({ firmId: 'firm-1', clientId: 'client-a', principal: EXTERNAL_SEAT, deps: depsFor(onStore) }));
});

// ── Invite email (migration 125: link, receipt, resend) ──────────────────────

const mailDeps = (store, { env = {}, sent = [] } = {}) => ({
  ...depsFor(store),
  env: { RESEND_API_KEY: 'test-key', ...env },
  sendEmail: async (message) => { sent.push(message); return { ok: true, id: 'email-1' }; }
});

test('invite email: carries the sign-in link when a public origin is declared; always names the exact address', async () => {
  const sent = [];
  const seat = { email: 'maya@example.com', name: 'Maya K', seat_role: 'junior', affiliation: 'internal', ends_at: null };
  const withOrigin = await sendSeatInviteEmail({
    seat, firmName: 'Alpha Oy',
    deps: { env: { RESEND_API_KEY: 'k', PUBLIC_APP_URL: 'https://app.example.com' }, sendEmail: async (m) => { sent.push(m); return { ok: true }; } }
  });
  assert.equal(withOrigin.status, 'sent');
  assert.ok(sent[0].html.includes('href="https://app.example.com"'), 'sign-in link present');
  assert.ok(sent[0].html.includes('maya@example.com'), 'the exact address is named');
  const withoutOrigin = await sendSeatInviteEmail({
    seat, firmName: 'Alpha Oy',
    deps: { env: { RESEND_API_KEY: 'k' }, sendEmail: async (m) => { sent.push(m); return { ok: true }; } }
  });
  assert.equal(withoutOrigin.status, 'sent');
  assert.ok(!sent[1].html.includes('href='), 'no dead link without an origin');
  assert.ok(sent[1].html.includes('maya@example.com'), 'the exact address is still named');
  const skipped = await sendSeatInviteEmail({ seat, deps: { env: {}, sendEmail: async () => ({ ok: true }) } });
  assert.deepEqual(skipped, { status: 'skipped', reason: 'resend_not_configured' });
});

test('resend: owner re-sends a pending invite; outcome stamped on the row + seat.invite_email receipted', async () => {
  const store = mkStore({ clients: CLIENTS });
  const deps = depsFor(store);
  await inviteSeatInDb({
    firmId: 'firm-1', actorPrincipal: OWNER,
    invite: { name: 'Maya K', email: 'maya@example.com', seatRole: 'junior', clientIds: ['client-a'] }, deps
  });
  const seatId = store.collaborators[0].id;
  const sent = [];
  const result = await resendSeatInviteEmail({
    firmId: 'firm-1', actorPrincipal: OWNER, seatId, firmName: 'Alpha Oy',
    deps: mailDeps(store, { env: { PUBLIC_APP_URL: 'https://app.example.com' }, sent })
  });
  assert.equal(result.invite_email.status, 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'maya@example.com');
  assert.equal(result.seat.invite_email_status, 'sent');
  assert.equal(store.collaborators[0].invite_email_status, 'sent');
  assert.ok(store.collaborators[0].invite_email_at, 'stamp carries a timestamp');
  assert.ok(store.audits.some((a) => a.params.includes('seat.invite_email')), 'seat.invite_email receipted');
});

test('resend: a skipped send stamps skipped with its reason', async () => {
  const store = mkStore({ clients: CLIENTS });
  const deps = depsFor(store);
  await inviteSeatInDb({
    firmId: 'firm-1', actorPrincipal: OWNER,
    invite: { name: 'Maya K', email: 'maya@example.com', seatRole: 'junior' }, deps
  });
  const seatId = store.collaborators[0].id;
  const result = await resendSeatInviteEmail({
    firmId: 'firm-1', actorPrincipal: OWNER, seatId,
    deps: { ...depsFor(store), env: {}, sendEmail: async () => ({ ok: true }) }
  });
  assert.equal(result.invite_email.status, 'skipped');
  assert.equal(store.collaborators[0].invite_email_status, 'skipped');
  assert.equal(store.collaborators[0].invite_email_reason, 'resend_not_configured');
});

test('resend guards: owner-only; invited-only; scoped owner stays inside their entity set', async () => {
  const store = mkStore({ clients: CLIENTS });
  const deps = depsFor(store);
  await inviteSeatInDb({
    firmId: 'firm-1', actorPrincipal: OWNER,
    invite: { name: 'Maya K', email: 'maya@example.com', seatRole: 'junior', clientIds: ['client-b'] }, deps
  });
  const seatId = store.collaborators[0].id;
  await assert.rejects(
    resendSeatInviteEmail({ firmId: 'firm-1', actorPrincipal: PARTNER_SEAT, seatId, deps: mailDeps(store) }),
    (e) => e.statusCode === 403 && /Only the owner/.test(e.message)
  );
  await assert.rejects(
    resendSeatInviteEmail({ firmId: 'firm-1', actorPrincipal: EXTERNAL_SEAT, seatId, deps: mailDeps(store) }),
    (e) => e.code === 'EXTERNAL_SEAT_FORBIDDEN'
  );
  // a scoped owner whose allowed set does not cover the seat's entities
  await assert.rejects(
    resendSeatInviteEmail({ firmId: 'firm-1', actorPrincipal: CLOUD_OWNER, allowedClientIds: ['client-a'], seatId, deps: mailDeps(store) }),
    (e) => e.code === 'ENTITY_OUT_OF_SCOPE'
  );
  // an activated seat has nothing to resend
  store.collaborators[0].status = 'active';
  await assert.rejects(
    resendSeatInviteEmail({ firmId: 'firm-1', actorPrincipal: OWNER, seatId, deps: mailDeps(store) }),
    (e) => e.statusCode === 409 && e.code === 'SEAT_NOT_INVITED'
  );
});
