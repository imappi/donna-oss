// In-workspace wrapper for the afterSign hook. electron-builder ≥26.15
// refuses a hook module path that resolves outside the workspace root
// (desktop/): "Hook module path … resolves outside the workspace root" —
// observed live on 26.15.3, first unsigned Mac build, 2026-08-07. The real
// hook stays in scripts/desktop-sign-pg.mjs next to its stage/verify
// siblings; this file only re-exports it. The IMPORT crossing the boundary
// is fine — the containment check applies to the configured hook path, not
// to the module graph.
export { default } from '../../scripts/desktop-sign-pg.mjs';
