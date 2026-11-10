-- 204 — One dated receipt per client when its first-line lane is dark.
--
-- The first-line lane (JEV_RECONCILIATION, seeded on by every desktop book)
-- decides for a client only when its flag acts AND this host has the lane's
-- provider configured (TYPESAFE_API_KEY and TYPESAFE_MODEL) — the one rule in
-- server/donna/firstLineLane.js. When the flag acts and the provider is not
-- configured, the lanes that are configured decide, and the first writer that
-- asks writes one `model_lane.first_line_dark` audit row for the client (the
-- lane, why it is dark, which lane decided). This index makes that row one per
-- client however many writers ask at once: the writer inserts with
-- `on conflict ... do nothing`.
--
-- audit_events is append-only (119); an index changes no row.
create unique index if not exists audit_events_first_line_lane_dark_once
  on audit_events (firm_id, client_id)
  where action = 'model_lane.first_line_dark';
