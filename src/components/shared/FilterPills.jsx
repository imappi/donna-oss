// The `FilterPills` strip that used to live here is GONE (2026-08-08).
//
// It was the shared tab strip for the Documents inbox and the Bank Feed —
// text tabs, ink underline, mono count chips. Both consumers have since
// moved to the house `SegmentedControl`: the bank feed on 2026-08-07 (the
// Open/Reconciled switch), Documents on 2026-08-08 (Kari: the All/Bills/
// Payments filters should read as the same control). That left the
// component with zero importers, which is the ghost this repo's
// "wire UI into the mounted surface" rail exists to prevent — a plausible
// component sitting in shared/ waiting for a future session to wire it
// into a surface and quietly reintroduce a retired grammar.
//
// Do NOT restore it. An exclusive, single-active switch is a
// `SegmentedControl` (see that file's header for the current rule); nav
// tabs keep the underline grammar in the entity toolbar (FirmOpsConsole
// implements its own).
//
// The file survives ONLY for the constant below, which both surfaces still
// import. It is a layout fact about the workspace, not part of the retired
// component.

// Height of the entity workspace's sticky toolbar (FirmOpsConsole). Strips
// that render INSIDE the entity workspace pass this as `top` so the two
// sticky bars stack when pinned instead of fighting for top: 0.
//
// Back to 48 (2026-08-29): the Actions / Material switch is gone and the
// entity toolbar is one row again. Anything sticky inside a pane reads this,
// so the number and the bar's actual height must move together.
export const STACKED_STRIP_TOP = 48;
