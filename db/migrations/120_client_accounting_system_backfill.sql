-- 120: stamp accounting_system on every un-stamped client, from its own
-- connection evidence — the data half of retiring the legacy read-time
-- 'xero' fallback (wave-13 slice candidate #1; Kari's dated go 2026-08-16).
--
-- History: the adapter registry's DEFAULT_ACCOUNTING_SYSTEM = 'xero'
-- fallback (accountingSystems/index.js) was introduced "for one deploy
-- cycle" so legacy un-stamped clients kept the historical Xero connector
-- path. It was never retired, and it armed a trap on the desktop
-- appliance: a desktop-born client (no Xero anywhere) resolved to the
-- Xero adapter and posting failed with "No Xero bank account is synced"
-- (honeybee, fixed by hand-stamping 'none'; the other appliance clients
-- were still un-stamped). Meanwhile the chat-apply lanes already treat
-- unset as 'none' — two contradictory null-defaults in one tree.
--
-- This backfill makes the stamp universal so the code-side fallback can
-- flip to 'none' in the same deploy without changing any real client's
-- routing:
--   has a xero_connections row        -> 'xero'
--   else has a qbo_connections row    -> 'qbo'
--   else has procountor_connections   -> 'procountor'
--   else                              -> 'none'  (Donna-native ledger)
-- Any connection row counts, not just status='connected' — an expired
-- Xero connection is still a Xero client whose routing must not silently
-- flip to the local ledger.
--
-- Provenance: accounting_system_set_by = 'migration:120' (+ _set_at), the
-- same profile keys stampProfileProvenance writes, so a backfilled stamp
-- stays distinguishable from an operator's explicit pick.
--
-- Re-run-safe: only touches rows where the key is absent or blank.

update clients c
   set profile = coalesce(c.profile, '{}'::jsonb) || jsonb_build_object(
         'accounting_system',
         case
           when exists (
             select 1 from xero_connections x
              where x.firm_id = c.firm_id and x.client_id = c.id
           ) then 'xero'
           when exists (
             select 1 from qbo_connections q
              where q.firm_id = c.firm_id and q.client_id = c.id
           ) then 'qbo'
           when exists (
             select 1 from procountor_connections p
              where p.firm_id = c.firm_id and p.client_id = c.id
           ) then 'procountor'
           else 'none'
         end,
         'accounting_system_set_by', 'migration:120',
         'accounting_system_set_at',
         to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       ),
       updated_at = now()
 where coalesce(c.profile->>'accounting_system', '') = '';
