// Shared per-document context menu + delete confirmation. Extracted from the
// old documents-panel.jsx for the two-surface IA fold
// (docs/design-donna-two-surface-ia.md §3): the feed's doc-anchored Open rows
// carry the same per-doc actions the Documents tab offered, so no affordance
// was lost when the tab went — the tab code was deleted at the 2026-08-27
// graduation and these survive as the single implementation.
//
// Styling rides the existing .document-context-menu / .firm-delete-confirm
// classes; both components portal to document.body.

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useIntl } from 'react-intl';

export const DocumentContextMenu = ({ menu, items, onDismiss }) => {
  const intl = useIntl();
  const menuRef = useRef(null);
  const itemRefs = useRef([]);

  useEffect(() => {
    itemRefs.current[0]?.focus();
    const onPointerDown = (event) => {
      if (!menuRef.current?.contains(event.target)) onDismiss({ restoreFocus: true });
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [onDismiss]);

  const moveFocus = (direction) => {
    const available = itemRefs.current.filter(Boolean);
    if (!available.length) return;
    const current = available.indexOf(document.activeElement);
    const next = current < 0
      ? 0
      : (current + direction + available.length) % available.length;
    available[next]?.focus();
  };

  const estimatedHeight = items.length * 34 + items.filter((item) => item.separatorBefore).length * 11 + 10;
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - 252));
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - estimatedHeight - 8));

  return createPortal(
    <div
      ref={menuRef}
      className="document-context-menu"
      role="menu"
      aria-label={intl.formatMessage({ id: 'mounted.document.actions' })}
      style={{ left, top }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onDismiss({ restoreFocus: true });
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          moveFocus(1);
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          moveFocus(-1);
        } else if (event.key === 'Home') {
          event.preventDefault();
          itemRefs.current.filter(Boolean)[0]?.focus();
        } else if (event.key === 'End') {
          event.preventDefault();
          itemRefs.current.filter(Boolean).at(-1)?.focus();
        }
      }}
    >
      {items.map((item, index) => (
        <span key={item.id} style={{ display: 'block' }}>
          {item.separatorBefore ? <span className="document-context-menu__separator" aria-hidden="true" /> : null}
          <button
            ref={(element) => { itemRefs.current[index] = element; }}
            className={`document-context-menu__item${item.danger ? ' document-context-menu__item--danger' : ''}`}
            type="button"
            role="menuitem"
            onClick={item.onSelect}
          >
            <span>{item.label}</span>
            {item.hint ? <span className="document-context-menu__hint">{item.hint}</span> : null}
          </button>
        </span>
      ))}
    </div>,
    document.body
  );
};

export const DocumentDeleteConfirmation = ({ documents, onCancel, onConfirm }) => {
  const intl = useIntl();
  const count = documents.length;

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return createPortal(
    <>
      <div className="firm-delete-confirm__scrim" aria-hidden="true" onClick={onCancel} />
      <section
        className="firm-delete-confirm document-delete-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-document-title"
        aria-describedby="delete-document-description"
      >
        <div>
          <h2 id="delete-document-title">
            {intl.formatMessage({ id: 'mounted.document.deleteTitle' }, { count })}
          </h2>
          <p id="delete-document-description">
            {count === 1
              ? intl.formatMessage(
                  { id: 'mounted.document.deleteOneDesc' },
                  { filename: documents[0]?.filename || intl.formatMessage({ id: 'mounted.document.thisDocument' }) }
                )
              : intl.formatMessage({ id: 'mounted.document.deleteManyDesc' }, { count })}
          </p>
        </div>
        <div className="firm-delete-confirm__actions">
          <button className="btn btn-outline" type="button" autoFocus onClick={onCancel}>
            {intl.formatMessage({ id: 'mounted.document.keep' }, { count })}
          </button>
          <button className="btn btn-outline-red" type="button" onClick={onConfirm}>
            {intl.formatMessage({ id: 'mounted.document.delete' }, { count })}
          </button>
        </div>
      </section>
    </>,
    document.body
  );
};
