-- 077 — FI-13 slice 13.0b: backfill every existing Finnish client to the
-- explicit legal form `fi-toiminimi`. DATA migration, idempotent, fail-hard.
--
-- WHY. D-FI13-1 point 2: before the guards can fail CLOSED on an unknown legal
-- form (the next slice), every existing Finnish client must carry an EXPLICIT
-- legal form — they are all toiminimi by construction (no fi-oy client has ever
-- existed; the Finnish vocabulary itself only landed in 13.0a). Until this runs,
-- Finnish clients have `entity_type = NULL`, which the resolver treats as
-- toiminimi during 13.0a/13.0b staging. This migration makes that implicit fact
-- EXPLICIT so the fail-closed flip can distinguish "known toiminimi" from
-- "genuinely unknown" without breaking a single live book.
--
-- BEHAVIOUR-NEUTRAL. `fi-toiminimi` resolves to the SAME internal axis
-- ('toiminimi') a NULL entity_type resolves to today (finlandEntityType /
-- assertFinlandToiminimiOnly, entity.js). So this migration changes NO runtime
-- behaviour — it is pure data hygiene that UNBLOCKS the fail-closed flip. It is
-- therefore safe to apply in ANY order relative to a code deploy. The flip that
-- DOES depend on this backfill ships as its own slice, gated on this migration
-- being confirmed applied in prod (verify-the-running-tree).
--
-- HOW a Finnish client is identified. There is no `jurisdiction = 'fi'` gate in
-- the tree (clients.jurisdiction is nullable and unreliably set); a Finnish
-- client is identified ONLY by carrying a FINLAND_* capability flag row in
-- client_capability_config (migration 042). This is a config-join backfill. NOTE
-- (documented, not silent): a client Finnish-flagged ONLY via a cohort (043) and
-- carrying no client-specific FINLAND_* row is NOT targeted here — the dormant
-- cohort layer is not in the pilot's onboarding path; if that ever changes, this
-- predicate widens.
--
-- FAIL-HARD (partial = FAILURE, not a warning — D-FI13-1). This runs inside the
-- migration runner's per-file transaction (scripts/migrate_firm_db.js): the DO
-- block RAISES a receipt NOTICE with the row count, then RAISES an EXCEPTION —
-- rolling the whole migration back and aborting the run — if ANY Finnish-flagged
-- client is left without a recognised Finnish legal form. A legal-safety backfill
-- must never half-apply.
--
-- IDEMPOTENT. The UPDATE only touches `entity_type IS NULL` rows, so a re-run
-- (or a client already set to fi-toiminimi in 13.0a) is a no-op. The runner also
-- records the version in schema_migrations and skips an applied file.

do $$
declare
  targeted_before integer;
  updated_count integer;
  remaining integer;
begin
  -- The set we intend to backfill: Finnish-flagged clients with no explicit
  -- legal form yet.
  select count(*) into targeted_before
  from clients c
  where c.entity_type is null
    and exists (
      select 1 from client_capability_config cfg
      where cfg.client_id = c.id
        and cfg.flag_key like 'FINLAND\_%' escape '\'
    );

  update clients c
     set entity_type = 'fi-toiminimi',
         updated_at = now()
   where c.entity_type is null
     and exists (
       select 1 from client_capability_config cfg
       where cfg.client_id = c.id
         and cfg.flag_key like 'FINLAND\_%' escape '\'
     );
  get diagnostics updated_count = row_count;

  -- The verified row-count receipt. targeted_before and updated_count MUST agree
  -- (the UPDATE predicate is identical to the target predicate) — a mismatch is a
  -- concurrent-write anomaly and trips the fail-hard check below.
  raise notice 'FI-13 077 backfill: % Finnish-flagged client(s) targeted, % set to fi-toiminimi', targeted_before, updated_count;

  -- Fail-hard: after the backfill, NO Finnish-flagged client may rest without a
  -- recognised Finnish legal form. Anything left is either an unbackfilled row
  -- (partial apply) or a pre-existing data inconsistency (a Finnish-flagged
  -- client mis-set to a non-Finnish entity_type) — both must stop the deploy and
  -- reach a human, not slip through.
  select count(*) into remaining
  from clients c
  where exists (
      select 1 from client_capability_config cfg
      where cfg.client_id = c.id
        and cfg.flag_key like 'FINLAND\_%' escape '\'
    )
    and (c.entity_type is null or c.entity_type not in ('fi-toiminimi', 'fi-oy'));

  if remaining > 0 then
    raise exception
      'FI-13 077 backfill INCOMPLETE: % Finnish-flagged client(s) still lack a recognised Finnish legal form (fi-toiminimi/fi-oy). A legal-safety backfill must fully apply — investigate these rows before re-running.', remaining;
  end if;
end $$;
