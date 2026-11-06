import { useEffect, useRef, useState } from 'react';
import { D } from './design-tokens.js';

// Overflow menu — the house "rarely-used lives behind ⋯" primitive (Kari,
// 2026-08-07: the bar carries daily work; admin/occasional destinations
// group into a quiet menu, native-app style — clarity, simplicity, speed).
//
// API:
//   items: Array<{ id, label, onSelect, active?, separatorBefore?, hint? }>
//          `active` marks the item with a check and warms the trigger so a
//          hidden-but-current destination is still discoverable. `hint` is
//          a right-aligned mono annotation (e.g. an accelerator like ⌘,).
//   label: aria-label/tooltip for the trigger. Defaults to 'More'.
//   renderTrigger({ open, toggle }): optional custom trigger (the sidebar
//          user card); default stays the quiet ⋯ chip.
//   placement: 'down' (default) | 'up' — 'up' opens the card above the
//          trigger (bottom-of-window triggers like the user card).
//   align: 'end' (default) | 'start' — which logical trigger edge the card hugs.
//          'left'/'right' remain accepted for legacy callers.
//   header: optional node rendered above the items behind a hairline
//          (identity line in the user menu).
//
// The trigger is a quiet square chip; the menu is a card on a hairline with
// the house shadow. Closes on outside click and Escape.
export const OverflowMenu = ({
  items = [],
  label = 'More',
  renderTrigger = null,
  placement = 'down',
  align = 'end',
  header = null
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const anyActive = items.some((i) => i.active);

  const toggle = () => setOpen((v) => !v);

  return (
    <span
      ref={rootRef}
      style={{ position: 'relative', display: renderTrigger ? 'block' : 'inline-flex', alignItems: 'center' }}
    >
      {renderTrigger ? (
        renderTrigger({ open, toggle })
      ) : (
        <button
          type="button"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          title={label}
          onClick={toggle}
          style={{
            width: 26,
            height: 26,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            borderRadius: 7,
            background: open ? 'oklch(0.08 0 0 / 0.06)' : 'transparent',
            color: anyActive || open ? D.ink : D.inkMute,
            cursor: 'pointer',
            fontSize: 16,
            lineHeight: 1,
            padding: 0
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = D.ink; }}
          onMouseLeave={(e) => { if (!open && !anyActive) e.currentTarget.style.color = D.inkMute; }}
        >
          ⋯
        </button>
      )}
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            ...(placement === 'up'
              ? { bottom: 'calc(100% + 6px)' }
              : { top: 'calc(100% + 6px)' }),
            ...(align === 'start'
              ? { insetInlineStart: 0 }
              : align === 'end'
                ? { insetInlineEnd: 0 }
                : align === 'left'
                  ? { left: 0 }
                  : { right: 0 }),
            minWidth: 200,
            zIndex: 50,
            background: D.card,
            border: `1px solid ${D.rule}`,
            borderRadius: 10,
            boxShadow: '0 1px 2px oklch(0.08 0 0 / 0.05), 0 10px 30px oklch(0.08 0 0 / 0.12)',
            padding: 5
          }}
        >
          {header && (
            <div style={{ padding: '7px 10px 9px', borderBottom: `1px solid ${D.ruleSoft}`, marginBottom: 5 }}>
              {header}
            </div>
          )}
          {items.map((item) => (
            <span key={item.id} style={{ display: 'block' }}>
              {item.separatorBefore && (
                <span
                  aria-hidden="true"
                  style={{ display: 'block', height: 1, background: D.ruleSoft, margin: '5px 4px' }}
                />
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  item.onSelect?.();
                }}
                style={{
                  display: 'flex',
                  width: '100%',
                  alignItems: 'center',
                  gap: 8,
                  font: 'inherit',
                  fontSize: 13,
                  textAlign: 'start',
                  padding: '7px 10px',
                  border: 'none',
                  borderRadius: 6,
                  background: 'transparent',
                  color: item.active ? D.ink : D.inkSoft,
                  fontWeight: item.active ? 600 : 400,
                  cursor: 'pointer'
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'oklch(0.08 0 0 / 0.04)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                {item.label}
                {item.active && (
                  <span aria-hidden="true" style={{ marginInlineStart: 'auto', fontSize: 11 }}>✓</span>
                )}
                {!item.active && item.hint && (
                  <span style={{ marginInlineStart: 'auto', fontFamily: D.mono, fontSize: 10.5, color: D.inkMute }}>
                    {item.hint}
                  </span>
                )}
              </button>
            </span>
          ))}
        </div>
      )}
    </span>
  );
};
