import { D, T } from './design-tokens.js';

// Segmented control — the house macOS-style view switcher (Kari,
// 2026-08-07: "neatly crafted segmented control"). A quiet 4%-wash track;
// the active segment lifts on a card-white thumb with a whisper shadow.
// Counts use the label's exact face, size, weight, and line-height, with only
// tabular figures and quieter ink distinguishing them. A count is part of the
// label, not a second typographic voice.
//
// Use for EXCLUSIVE VIEW SWITCHES (Open/Reconciled, Chat/Audit, the
// Documents type filters). Nav tabs keep the underline grammar (entity
// toolbar).
//
// AMENDS the earlier "filter strips keep FilterPills" clause (Kari,
// 2026-08-08: the Documents All/Bills/Payments strip should read as the
// same control as the bank feed's Open/Reconciled). The distinction was
// never behavioural — both are exclusive, single-active switches — and it
// left two grammars on peer tabs of the same workspace. `FilterPills` had
// no consumers left after that move and is gone; its `STACKED_STRIP_TOP`
// constant lives on, since both surfaces still stack under the toolbar.
//
// API: segments: Array<{ id, label, count? }> · active: id · onChange(id)
//      size: 'md' (default) | 'sm' · equalWidth: boolean
export const SegmentedControl = ({ segments = [], active, onChange, size = 'md', equalWidth = false }) => {
  const sm = size === 'sm';
  return (
    <div
      role="tablist"
      style={{
        display: equalWidth ? 'inline-grid' : 'inline-flex',
        ...(equalWidth
          ? {
              gridAutoFlow: 'column',
              // minmax(base, 1fr): every track stays EQUAL — at least the
              // base #1560 validated (104px at the entity switch), all
              // growing together when one label needs more. A bare fixed
              // base clipped the long temporary segments the entity switch
              // renders for active ⋯ menu tabs ("People & ownership").
              gridAutoColumns: sm ? 'minmax(76px, 1fr)' : 'minmax(104px, 1fr)'
            }
          : {}),
        alignItems: 'center',
        gap: 2,
        padding: 2,
        borderRadius: 8,
        background: 'oklch(0.08 0 0 / 0.04)'
      }}
    >
      {segments.map((s) => {
        const isActive = s.id === active;
        return (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange?.(s.id)}
            style={{
              font: 'inherit',
              fontSize: sm ? 12 : 13,
              fontWeight: isActive ? 600 : 500,
              lineHeight: 1.2,
              padding: sm ? '3px 10px' : '5px 12px',
              border: 'none',
              borderRadius: 6,
              background: isActive ? T.card : 'transparent',
              color: isActive ? D.ink : D.inkMute,
              boxShadow: isActive
                ? '0 1px 2px oklch(0.08 0 0 / 0.10), 0 0 0 0.5px oklch(0.08 0 0 / 0.05)'
                : 'none',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: equalWidth ? 'center' : 'flex-start',
              gap: 6,
              whiteSpace: 'nowrap',
              minWidth: 0
            }}
            onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.color = D.ink; }}
            onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.color = D.inkMute; }}
          >
            {s.label}
            {s.count != null && (
              // Same typography as its own label — D.tabular aligns the
              // figures without introducing a second font or size.
              <span
                style={{
                  font: 'inherit',
                  fontSize: 'inherit',
                  fontWeight: 'inherit',
                  lineHeight: 'inherit',
                  ...D.tabular,
                  color: isActive ? D.inkSoft : D.inkMute
                }}
              >
                {s.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};
