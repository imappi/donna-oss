-- P0C (manual-upload source) — per-row signal hypothesis on the prospect.
--
-- A source module yields candidate references PLUS its signal hypothesis
-- (docs/design-donna-prospecting.md §5A). For Companies House sources the
-- signal is machine-derived at scan time; for manual uploads it is whatever
-- the human noticed ("hiring a part-time bookkeeper on Indeed", "complained
-- about Stripe payouts in a podcast"). The dossier drafter reads it as input
-- evidence to verify — it is a HYPOTHESIS, never auto-promoted to a cited
-- disorder signal (no signal, no dossier still binds at the validator).
--
-- Idempotent; safe to paste together with 051.

alter table marketing_prospect
  add column if not exists source_note text;
