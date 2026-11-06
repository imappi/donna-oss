import { D } from './design-tokens.js';

// Status tones on the D (paper + ink + warm) palette. D deliberately has no
// green and no amber, so the four-tone vocabulary collapses the way the client
// portal already collapsed it (see UPLOAD_STATUS_TONE_COLOR in
// donna-client-portal.jsx): resolved reads as INK, anything wanting attention
// reads as the WARM accent, genuine failure gets D.alert, and quiet/indefinite
// states sit at muted ink.
//
// Keep the { bg, fg } shape: consumers read `.fg` off this map.
export const STATUS_CHIP_TONES = {
  ok:    { bg: D.ruleSoft,   fg: D.ink },
  amber: { bg: D.accentWash, fg: D.accentWarmFlat },
  alert: { bg: D.alertWash,  fg: D.alert },
  muted: { bg: D.ruleSoft,   fg: D.inkMute }
};

// Three-voice rendering (Kari's 2026-08-05 calm-the-chips call): the COLOR
// lives in a 6px dot, the label stays ink-family, and there is no wash
// container — a filled pill on every row was the restlessness. Voices:
//   ok / muted — settled / informational: no dot, soft or muted ink text
//   amber      — needs you: warm accent dot, ink text
//   alert      — genuine failure: brick dot, brick text
// (STATUS_CHIP_TONES above is kept for consumers that read .fg directly.)
const CHIP_VOICES = {
  ok:    { dot: null,             fg: D.inkSoft },
  amber: { dot: D.accentWarmFlat, fg: D.ink },
  alert: { dot: D.alert,          fg: D.alert },
  muted: { dot: null,             fg: D.inkMute }
};

export const StatusChip = ({ label, tone = 'muted' }) => {
  const voice = CHIP_VOICES[tone] || CHIP_VOICES.muted;
  return (
    // Stage 3 of the two-voice type doctrine (Kari, 2026-08-08): a status is
    // not machine output — it is a word the operator reads — so the label sits
    // on the system face, not JetBrains Mono. The tracked mini-caps go with it:
    // every `label` in documentsInbox.js is already authored in sentence case
    // ("Matched · auto", "With the client"), so dropping textTransform renders
    // what the vocabulary actually says instead of shouting it. Same treatment
    // the sidebar's "Entities" label got in #1502.
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      color: voice.fg,
      fontFamily: D.ui, fontSize: 12, fontWeight: 600,
      letterSpacing: 0,
      whiteSpace: 'nowrap'
    }}>
      {voice.dot && (
        <span
          aria-hidden="true"
          style={{ width: 6, height: 6, borderRadius: 999, background: voice.dot, flex: '0 0 auto' }}
        />
      )}
      {label}
    </span>
  );
};
