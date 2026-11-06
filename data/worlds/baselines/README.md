# EAW baselines

This directory is the **single writable baseline root** for executable
accounting worlds. EAW code neither reads nor writes the legacy
`data/evals/baselines` tree.

Baseline files are immutable, canonical `eaw.world-baseline.v1` receipts. A
receipt binds suite, capability, family, and world identity; all five lifecycle
component versions; the SHA-256 digest of the loaded solver; response-proven
model identity; a complete live-run receipt; and the result. Saves are atomic
and non-clobbering. Configured fallbacks and legacy/unproven provenance may be
described by validation diagnostics, but cannot be saved or compared as
assurance baselines.

No generated baseline is committed by Unit 38. Runner integration is deferred
to its dependent unit.
