import { D } from './design-tokens.js';

// ONE button law (Kari, 2026-08-07: "button style varies" — it must not).
// Three voices, shared geometry, so every surface's buttons read as one
// system:
//   btnPrimary  — the ONE loud action on a surface: ink pill, paper text.
//   btnChip     — everything else clickable: quiet hairline chip, soft ink.
//   btnDisabled — the primary's resting/blocked state.
// Hover treatment stays at the call site (color → D.ink on chips; slight
// opacity on primary) so these stay plain style objects.
const base = {
  font: 'inherit',
  fontSize: 12.5,
  lineHeight: 1.2,
  padding: '7px 14px',
  borderRadius: 999,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6
};

export const btnPrimary = {
  ...base,
  fontWeight: 600,
  border: 'none',
  background: D.ink,
  color: D.paper
};

export const btnChip = {
  ...base,
  fontWeight: 500,
  border: `1px solid ${D.rule}`,
  background: 'transparent',
  color: D.inkSoft
};

export const btnDisabled = {
  ...base,
  fontWeight: 600,
  border: `1px solid ${D.ruleSoft}`,
  background: 'transparent',
  color: D.inkMute,
  cursor: 'default'
};
