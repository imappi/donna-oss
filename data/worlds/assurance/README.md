# Oracle-assurance records

This directory is reserved for independently signed `eaw.oracle-assurance.v1`
records. It intentionally contains no approval record today.

`server/donna/world/oracleAssurance.js` validates the practitioner identity and
independence declaration, jurisdiction and accounting-view competence, exact
policy-pack version and digest, blind case work, legitimate alternatives and
disagreement dispositions, oracle-gap findings, the decision and effective
period, and mandatory re-review triggers. Reviewed content is digest-bound; a
real record additionally needs an Ed25519 signature whose public key and
practitioner identity match Kari's separately supplied dated reviewer
arrangement.

The gate has three relevant outcomes:

- `awaiting_independent_review`: no valid real independent signature exists;
  Appendix D box 6 remains refused and unticked.
- `independent_review_refused`: the arranged practitioner signed a refusal;
  Appendix D box 6 remains refused and unticked.
- `ready_for_certification_review`: a valid arranged practitioner signed an
  effective approval with no open or blocking oracle gap. This still does not
  tick or certify Appendix D box 6; only the certification reviewer may do so.

Citations and commercial-package comparisons may be recorded only as
supplemental signals. They never substitute for the blind practitioner work.
Synthetic fixtures must use `synthetic_shape_non_signing`; even a
cryptographically valid test-key signature cannot open the gate for that
purpose.

External blocker: **BLOCKED — CLAUDE/KARI LANE.** Kari must make the deferred
dated practitioner arrangement, and the named independent practitioner must
perform and sign the review. Codex and models cannot create that authority.
