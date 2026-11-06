// The Donna chat grammar — ONE presentational vocabulary for every
// Donna-conversation surface: the bot message, the ink user bubble, the
// centered system notice, the quick-prompt pills, and the rounded
// composer card with the circular send arrow.
//
// Extracted from documents/document-chat.jsx (the reference
// implementation Kari named, 2026-08-05) so the dock's feed chat could
// adopt it instead of carrying a second, divergent style. Document chat
// imports these back — one rendering, one home. Polished same day on
// Kari's follow-up: the D avatar and the footer line are gone and the
// composer is a single tightened row — grammar-wide, so every surface
// moves together. Surface-specific pieces (candidate strips, action
// cards) stay with their surfaces; only the conversation grammar lives
// here.

import { useMemo, useState } from 'react';
import { useIntl } from 'react-intl';

import { V, D } from './design-tokens.js';
import { accountMenuParts } from '../../lib/donnaChatPresentation.js';
import { BidiText, FormattedValue } from '../../i18n/BidiText.jsx';
import { useInterfaceLocale } from '../../i18n/LocaleProvider.jsx';

const ASSISTANT_COLLAPSE_AT = 1100;
const USER_COLLAPSE_AT = 360;

const Toggle = ({ expanded, onClick, color = V.t2 }) => {
  const intl = useIntl();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      style={{
        border: 'none',
        background: 'transparent',
        color,
        fontFamily: D.ui,
        fontSize: 12,
        fontWeight: 550,
        padding: '6px 0 0',
        cursor: 'pointer'
      }}
    >
      {intl.formatMessage({ id: expanded ? 'donna.chat.showLess' : 'donna.chat.showMore' })}
    </button>
  );
};

const Collapsible = ({ children, text = '', limit, collapsedHeight, inverse = false }) => {
  const [expanded, setExpanded] = useState(false);
  const collapsible = String(text).length > limit;
  return (
    <>
      <div
        style={collapsible && !expanded ? {
          maxHeight: collapsedHeight,
          overflow: 'hidden',
          position: 'relative',
          maskImage: 'linear-gradient(to bottom, #000 76%, transparent)',
          WebkitMaskImage: 'linear-gradient(to bottom, #000 76%, transparent)'
        } : undefined}
      >
        {children}
      </div>
      {collapsible && (
        <div style={{ color: inverse ? V.bg : V.t2 }}>
          <Toggle expanded={expanded} color={inverse ? V.bg : V.t2} onClick={() => setExpanded((value) => !value)} />
        </div>
      )}
    </>
  );
};

export const AssistantBody = ({ children, text = '' }) => (
  <Collapsible text={text} limit={ASSISTANT_COLLAPSE_AT} collapsedHeight={330}>
    {children}
  </Collapsible>
);

export const BotMessage = ({ children, timestamp }) => (
  <div className="donna-chat-message" style={{ marginBottom: 20, minWidth: 0, animation: `chatMessageIn 180ms ${D.ease}` }}>
    <div
      style={{
        fontSize: 13.5,
        color: V.t2,
        lineHeight: 1.55,
        wordBreak: 'break-word',
        unicodeBidi: 'isolate'
      }}
      dir="auto"
    >
      {children}
    </div>
    {timestamp && (
      <div
        style={{
          fontSize: 11,
          color: V.t4,
          fontFamily: D.ui,
          marginTop: 4
        }}
      >
        <FormattedValue>{timestamp}</FormattedValue>
      </div>
    )}
  </div>
);

export const UserMessage = ({ children, timestamp }) => (
  <div
    className="donna-chat-message"
    style={{
      display: 'flex',
      justifyContent: 'flex-end',
      marginBottom: 18,
      flexDirection: 'column',
      alignItems: 'flex-end',
      animation: `chatMessageIn 160ms ${D.ease}`
    }}
  >
    <div
      style={{
        background: V.t1,
        color: V.bg,
        borderRadius: 14,
        borderEndEndRadius: 4,
        padding: '10px 16px',
        fontSize: 14,
        maxWidth: 420,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        unicodeBidi: 'isolate'
      }}
      dir="auto"
    >
      <Collapsible text={children} limit={USER_COLLAPSE_AT} collapsedHeight={108} inverse>
        {children}
      </Collapsible>
    </div>
    {timestamp && (
      <div
        style={{
          fontSize: 11,
          color: V.t4,
          fontFamily: D.ui,
          marginTop: 4
        }}
      >
        <FormattedValue>{timestamp}</FormattedValue>
      </div>
    )}
  </div>
);

export const SystemMessage = ({ children, timestamp }) => (
  <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 18 }}>
    <div
      style={{
        background: V.negSurface,
        color: V.neg,
        border: `1px solid ${V.neg}33`,
        borderRadius: 8,
        padding: '8px 14px',
        fontSize: 12.5,
        maxWidth: 520,
        lineHeight: 1.5,
        fontFamily: "'JetBrains Mono', monospace"
      }}
      dir="auto"
    >
      <div>{children}</div>
      {timestamp && (
        <div style={{ fontSize: 10, color: V.t4, marginTop: 4 }}>
          <FormattedValue>{timestamp}</FormattedValue>
        </div>
      )}
    </div>
  </div>
);

// Lightweight bold-marker formatter so welcome / assistant text can
// emphasise document names and key terms with **double-asterisks**.
// Anything more elaborate (markdown links, lists) is intentionally
// out of scope — the LLM produces prose and the renderer stays cheap.
export const FormattedText = ({ text }) => {
  if (typeof text !== 'string' || !text) return null;
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <BidiText direction="auto">
      {parts.map((part, index) => {
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          return (
            <strong key={index} style={{ fontWeight: 600, color: V.t1 }}>
              {part.slice(2, -2)}
            </strong>
          );
        }
        return <span key={index}>{part}</span>;
      })}
    </BidiText>
  );
};

const inlineParts = (text, keyPrefix = 'inline') => {
  const parts = String(text || '').split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={`${keyPrefix}-${index}`} style={{ fontWeight: 650, color: D.ink }}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return <em key={`${keyPrefix}-${index}`}>{part.slice(1, -1)}</em>;
    }
    return <span key={`${keyPrefix}-${index}`}>{part}</span>;
  });
};

const parseResponse = (text = '') => {
  const paragraphs = String(text).trim().split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  const intro = [];
  const sections = [];
  let section = null;

  paragraphs.forEach((paragraph) => {
    const heading = paragraph.match(/^\*\*(.+?)\*\*([^\n]*)\n?([\s\S]*)$/);
    if (heading) {
      section = {
        title: heading[1].trim(),
        meta: heading[2].trim().replace(/^\s*[—-]\s*/, ''),
        parts: heading[3].trim() ? [heading[3].trim()] : []
      };
      sections.push(section);
      return;
    }
    if (section) section.parts.push(paragraph);
    else intro.push(paragraph);
  });

  return { intro, sections };
};

const ProsePart = ({ text, sectionKey }) => {
  const lines = String(text).split('\n').map((line) => line.trim()).filter(Boolean);
  const bulletLines = lines.filter((line) => /^[-•]\s+/.test(line));
  const accountMenu = accountMenuParts(text);
  const accountLead = accountMenu?.lead || '';
  const accountItems = accountMenu?.items || null;

  if (accountItems) {
    return (
      <div>
        {accountLead && <div style={{ marginBottom: 7 }}>{inlineParts(accountLead, `${sectionKey}-account-lead`)}</div>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 5px' }}>
          {accountItems.map((item, index) => (
            <span key={`${sectionKey}-account-${index}`} style={{ padding: '3px 7px', borderRadius: 6, background: D.paperDeep, color: D.inkSoft, fontSize: 11.5, lineHeight: 1.35 }}>
              {item}
            </span>
          ))}
        </div>
      </div>
    );
  }

  if (bulletLines.length) {
    const lead = lines.filter((line) => !/^[-•]\s+/.test(line));
    return (
      <div>
        {lead.map((line, index) => <div key={`${sectionKey}-lead-${index}`} style={{ marginBottom: 7 }}>{inlineParts(line, `${sectionKey}-lead-${index}`)}</div>)}
        <ul style={{ margin: 0, paddingInlineStart: 18, display: 'grid', gap: 7 }}>
          {bulletLines.map((line, index) => <li key={`${sectionKey}-bullet-${index}`}>{inlineParts(line.replace(/^[-•]\s+/, ''), `${sectionKey}-bullet-${index}`)}</li>)}
        </ul>
      </div>
    );
  }

  return <div>{lines.map((line, index) => <div key={`${sectionKey}-line-${index}`}>{inlineParts(line, `${sectionKey}-line-${index}`)}</div>)}</div>;
};

// Turns the structure Donna already writes — venture headings, account menus
// and decision lists — into readable message parts. It deliberately remains
// dependency-free: this app has no Markdown or shadcn runtime, and adding one
// solely for the dock would create a second design system.
export const StructuredResponse = ({ text }) => {
  const parsed = useMemo(() => parseResponse(text), [text]);
  if (!text) return null;
  if (!parsed.sections.length) {
    return <div dir="auto" style={{ whiteSpace: 'pre-wrap', unicodeBidi: 'isolate' }}>{inlineParts(text)}</div>;
  }
  return (
    <div dir="auto" style={{ unicodeBidi: 'isolate' }}>
      {parsed.intro.map((part, index) => (
        <div key={`intro-${index}`} style={{ marginBottom: 12 }}><ProsePart text={part} sectionKey={`intro-${index}`} /></div>
      ))}
      <div style={{ display: 'grid', gap: 8 }}>
        {parsed.sections.map((item, index) => (
          <section key={`${item.title}-${index}`} style={{ border: `1px solid ${D.ruleSoft}`, borderRadius: 10, background: D.card, padding: '10px 11px 11px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '3px 7px', marginBottom: item.parts.length ? 8 : 0 }}>
              <span style={{ color: D.ink, fontSize: 12.5, fontWeight: 650 }}>{item.title}</span>
              {item.meta && <span style={{ color: D.inkMute, fontSize: 11.5, ...D.tabular }}>{inlineParts(item.meta, `meta-${index}`)}</span>}
            </div>
            <div style={{ display: 'grid', gap: 9 }}>
              {item.parts.map((part, partIndex) => <ProsePart key={`${item.title}-${partIndex}`} text={part} sectionKey={`section-${index}-${partIndex}`} />)}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
};

// Quick-prompt pills under the welcome message — click drops the text
// into the composer. (No left indent: they align with the bot text,
// which runs full-width now the avatar is gone.) Solid white on the
// paper panel with near-full ink — the earlier translucent white +
// 48%-ink read as washed-out grey buttons (Kari's 2026-08-05 pass:
// "more white to pop, darker text, more padding between them").
export const PromptPills = ({ prompts = [], onPick }) => (
  <div
    style={{
      margin: '-6px 0 18px 0',
      display: 'flex',
      flexWrap: 'wrap',
      gap: 8
    }}
  >
    {prompts.map((prompt) => (
      <button
        key={prompt}
        type="button"
        onClick={() => onPick(prompt)}
        dir="auto"
        style={{
          padding: '6px 12px',
          borderRadius: 8,
          border: `1px solid ${V.borderSubtle}`,
          background: '#fff',
          color: V.t2,
          fontSize: 12.5,
          fontWeight: 500,
          fontFamily: D.ui,
          cursor: 'pointer',
          boxShadow: '0 1px 4px rgba(46,42,34,0.05)',
          transition: 'all 0.15s'
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = V.t1;
          e.currentTarget.style.borderColor = V.t4;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = V.t2;
          e.currentTarget.style.borderColor = V.borderSubtle;
        }}
      >
        {prompt}
      </button>
    ))}
  </div>
);

// Single-row card: the textarea and the send arrow share one line, the
// arrow pinned bottom-right as the draft grows. Tight side margins so
// the card runs wide with breathing room on both sides; no footer line
// beneath it (Kari, 2026-08-05).
export const Composer = ({
  draft,
  textareaRef,
  onInput,
  onKeyDown,
  onSend,
  submitting,
  sendError,
  // Casual by default (Kari, 2026-08-05) — the composer explains itself;
  // the Cmd/Ctrl+Enter hint was noise. Surfaces can still override.
  placeholder = null,
  // Universal @mentions: staged-mention chips above the card + the typeahead
  // dropdown floating over it (hence position:relative on the card).
  mentionChips = null,
  mentionOverlay = null
}) => {
  const intl = useIntl();
  const { direction } = useInterfaceLocale();
  const canSend = !!draft.trim() && !submitting;
  const resolvedPlaceholder = placeholder || intl.formatMessage({ id: 'donna.chat.composer.placeholder' });
  return (
    <div
      style={{
        padding: '10px 14px 14px',
        flexShrink: 0,
        background: 'transparent'
      }}
    >
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        {mentionChips}
        <div
          style={{
            position: 'relative',
            border: `0.5px solid ${V.border}`,
            borderRadius: 10,
            background: V.surface,
            transition: 'all 0.25s',
            boxShadow: '0px 4px 14px rgba(46,42,34,0.05)',
            display: 'flex',
            alignItems: 'flex-end'
          }}
          onFocusCapture={(e) => {
            e.currentTarget.style.borderColor = V.t4;
            e.currentTarget.style.boxShadow = '0px 4px 20px rgba(46,42,34,0.08)';
          }}
          onBlurCapture={(e) => {
            e.currentTarget.style.borderColor = V.border;
            e.currentTarget.style.boxShadow = '0px 4px 14px rgba(46,42,34,0.05)';
          }}
        >
          {mentionOverlay}
          <textarea
            ref={textareaRef}
            value={draft}
            onInput={onInput}
            onChange={() => {}}
            onKeyDown={onKeyDown}
            disabled={submitting}
            rows={1}
            placeholder={resolvedPlaceholder}
            dir="auto"
            style={{
              flex: 1,
              minWidth: 0,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              fontFamily: D.ui,
              fontSize: 14,
              color: V.t1,
              paddingBlock: 12,
              paddingInlineStart: 16,
              paddingInlineEnd: 6,
              resize: 'none',
              lineHeight: 1.55,
              minHeight: 44,
              boxSizing: 'border-box'
            }}
          />
          <button
            type="button"
            onClick={onSend}
            disabled={!canSend}
            aria-label={intl.formatMessage({ id: submitting ? 'donna.chat.sending' : 'donna.chat.send' })}
            style={{
              width: 28,
              height: 28,
              marginBlockStart: 0,
              marginBlockEnd: 8,
              marginInlineStart: 4,
              marginInlineEnd: 8,
              background: canSend ? V.t1 : V.border,
              color: canSend ? V.bg : V.t4,
              border: 'none',
              borderRadius: '50%',
              cursor: canSend ? 'pointer' : 'not-allowed',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'background 0.15s',
              flexShrink: 0
            }}
            onMouseEnter={(e) => {
              if (canSend) e.currentTarget.style.background = V.accent;
            }}
            onMouseLeave={(e) => {
              if (canSend) e.currentTarget.style.background = V.t1;
            }}
          >
            {submitting ? (
              <span style={{ fontSize: 11, fontWeight: 700 }}>…</span>
            ) : (
              <svg
                viewBox="0 0 24 24"
                width="13"
                height="13"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ transform: direction === 'rtl' ? 'scaleX(-1)' : undefined }}
              >
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
            )}
          </button>
        </div>
        {sendError && (
          <div
            style={{
              fontSize: 11,
              color: V.neg,
              fontFamily: "'JetBrains Mono', monospace",
              textAlign: 'center',
              marginTop: 6
            }}
          >
            <BidiText direction="auto">{sendError}</BidiText>
          </div>
        )}
      </div>
    </div>
  );
};
