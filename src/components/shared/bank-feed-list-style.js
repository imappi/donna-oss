import { T, D } from './design-tokens.js';

// Bank Feed is the list-system source of truth. Actions and Documents import
// these values directly so typography and row rhythm cannot drift by a half
// step while still looking "roughly" aligned.
export const BANK_FEED_LIST_MEASURE = 1080;
export const BANK_FEED_ROW_COLUMNS = '72px 1fr 120px 140px';

// A feed section owns the breathing room AFTER its rows. The next heading
// then contributes its standard top inset below. Keeping this separate from
// the heading is what gives stacked sections a deliberate 24px + 18px break
// without adding space above the first heading.
export const BANK_FEED_SECTION_STYLE = {
  padding: '0 0 24px'
};

export const BANK_FEED_SECTION_HEADING_STYLE = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  padding: '18px 0 8px',
  fontFamily: D.ui,
  fontSize: 13,
  lineHeight: 'normal',
  fontWeight: 600,
  color: T.ink
};

export const BANK_FEED_SECTION_COUNT_STYLE = {
  fontFamily: D.ui,
  fontSize: 12,
  lineHeight: 'normal',
  fontWeight: 400,
  color: T.muted,
  ...D.tabular
};

// Empty sections keep the same left inset and type scale as a real row.
// They are absence-of-data states, not a second visual system or a card.
export const BANK_FEED_EMPTY_STYLE = {
  padding: '10px 16px',
  fontFamily: D.ui,
  fontSize: 13,
  lineHeight: 'normal',
  color: T.muted
};

export const BANK_FEED_ROW_STYLE = {
  display: 'grid',
  gridTemplateColumns: BANK_FEED_ROW_COLUMNS,
  alignItems: 'center',
  gap: 18,
  padding: '10px 16px',
  position: 'relative',
  fontFamily: D.ui,
  fontSize: 13,
  lineHeight: 'normal',
  borderBottom: `1px solid ${T.ruleLight || T.rule}`
};

export const BANK_FEED_DATE_STYLE = {
  fontFamily: D.ui,
  fontSize: 12.5,
  lineHeight: 'normal',
  color: T.muted,
  ...D.tabular
};

export const BANK_FEED_PRIMARY_STYLE = {
  fontFamily: D.ui,
  fontSize: 13,
  lineHeight: 'normal',
  color: T.ink
};

export const BANK_FEED_AMOUNT_STYLE = {
  fontFamily: D.ui,
  fontSize: 13.5,
  lineHeight: 'normal',
  textAlign: 'end',
  fontWeight: 400,
  ...D.tabular
};

export const BANK_FEED_STATUS_STYLE = {
  fontFamily: D.ui,
  fontSize: 12.5,
  lineHeight: 'normal',
  color: T.muted
};

// The feed's state pill is the visual counterweight to the status dot. Rows
// carry 16px inline padding for their text columns, but these two edge markers
// deliberately terminate on the divider itself so the list has equal left and
// end anchors instead of a ragged empty gutter after short category names.
export const BANK_FEED_TRAILING_CELL_STYLE = {
  minWidth: 0,
  paddingInlineStart: 12,
  width: 'calc(100% + 16px)',
  maxWidth: 'none',
  marginInlineEnd: -16,
  justifyContent: 'flex-end',
  textAlign: 'end'
};

// Trailing-status pill voices (Kari's 2026-08-26 canary round 2: a row's
// trailing status is a right-aligned PILL, never bare text). Three voices:
// 'warm' is the needs-your-input amber chip, 'alert' the stalled/violation
// chip (a row resting at neither convergence terminal — the loudest voice,
// reserved for what should not exist), 'ink'/'muted' the neutral 4%-wash
// chip. Render inside BANK_FEED_TRAILING_CELL_STYLE so the pill terminates
// on the row's inline end edge like every other list.
export const bankFeedPillStyle = (voice = 'ink') => {
  const base = { display: 'inline-flex', alignItems: 'center', borderRadius: 999, whiteSpace: 'nowrap', fontFamily: D.ui, lineHeight: 'normal' };
  if (voice === 'warm') {
    return { ...base, fontSize: 11.5, fontWeight: 500, color: T.amber, background: T.amberSoft, padding: '3px 8px' };
  }
  if (voice === 'alert') {
    return { ...base, fontSize: 11.5, fontWeight: 500, color: T.alert, background: T.alertSoft, padding: '3px 8px' };
  }
  return {
    ...base,
    fontSize: 12.5,
    color: voice === 'muted' ? T.muted : T.ink,
    background: 'oklch(0.08 0 0 / 0.04)',
    padding: '3px 9px'
  };
};

export const BANK_FEED_DOT_STYLE = {
  position: 'absolute',
  insetInlineStart: 0,
  top: '50%',
  transform: 'translateY(-50%)',
  width: 7,
  height: 7,
  borderRadius: 999
};
