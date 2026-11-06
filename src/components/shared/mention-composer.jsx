// Universal @mentions — the ONE composer grammar + comment rendering
// (build 2 slice 4, docs/design-donna-universal-mentions.md §1/§6, D6).
//
// One module, three exports, shared by BOTH artifact chat surfaces
// (transaction-artifact.jsx, document-chat.jsx) so the rail's look is decided
// once:
//   - useMentionComposer  — the typeahead + structured-ref state for a chat
//     composer. Mentions travel as STRUCTURED REFS minted here from the
//     server's eligible roster (GET /mentions/roster) — the API is exact and
//     re-validates; this typeahead is where ambiguity is resolved by a human
//     picking (D6). Free text is never parsed server-side.
//   - MentionChipsRow / MentionTypeaheadOverlay — the composer affordances.
//     The External badge on an external seat is MANDATORY wherever the seat
//     appears (build-1 seats spec §4.5) — it renders in the dropdown AND the
//     chips from the roster's own affiliation field.
//   - CommentMessage + filterSupersededComments — how a persisted comment row
//     (payload.kind 'comment' / 'thread_resolution') renders in the chat
//     stream: human speech as a left-aligned attributed card, visually
//     distinct from the firm↔Donna bubbles; an edit supersedes its original
//     (the stream shows the latest, the original stays retrievable in the
//     store); a redacted body renders the marker, never the text.

import { useEffect, useRef, useState } from 'react';

import { V, D } from './design-tokens.js';
import { fetchMentionRoster } from '../../lib/firmApi.js';
import {
  filterMentionOptionsForSelection,
  isDirectDonnaMention,
  nextMentionSelection,
  pendingAgentMentionAsks
} from '../../lib/mentionActivity.js';

export const MENTION_FLAVOR_OPTIONS = Object.freeze([
  { id: 'mention', label: 'Mention', hint: 'FYI — nothing blocks' },
  { id: 'assign', label: 'Assign', hint: 'hand this item to them' },
  { id: 'ask', label: 'Ask', hint: 'blocks until they answer' }
]);

const TYPEAHEAD_LIMIT = 8;
const TYPEAHEAD_DEBOUNCE_MS = 140;

// The active "@token" at the caret: the last '@' at a word start before the
// caret, with no whitespace/newline between it and the caret.
const activeMentionToken = (text, caret) => {
  if (typeof text !== 'string' || caret == null) return null;
  const upTo = text.slice(0, caret);
  const at = upTo.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/[\s([{]/.test(upTo[at - 1])) return null;
  const query = upTo.slice(at + 1);
  if (/[\s\n]/.test(query) || query.length > 40) return null;
  return { at, query };
};

export const useMentionComposer = ({ clientId, setDraft, textareaRef }) => {
  const [mentions, setMentions] = useState([]);
  const [flavor, setFlavor] = useState('mention');
  const [typeahead, setTypeahead] = useState({ open: false, options: [], active: 0, at: 0 });
  const fetchSeq = useRef(0);
  const debounceRef = useRef(null);

  useEffect(() => () => clearTimeout(debounceRef.current), []);

  // Human Assign/Ask take exactly one addressee. Agents are always staged
  // alone by pick(): Donna is a direct chat turn and a hired specialist is an
  // Ask, so neither can fall into the old agent-FYI no-op state.
  useEffect(() => {
    if (flavor === 'mention') return;
    const single = mentions.length === 1;
    const assignToAgent = flavor === 'assign' && single && mentions[0].actor_type === 'agent';
    if (!single || assignToAgent) setFlavor('mention');
  }, [flavor, mentions]);

  const close = () => setTypeahead((t) => (t.open ? { ...t, open: false } : t));

  // Call from the surface's onInput handler AFTER its own setDraft, with the
  // textarea element (value + selectionStart drive the token detection).
  const handleInput = (element) => {
    const token = activeMentionToken(element?.value, element?.selectionStart);
    if (!token || !clientId) {
      close();
      return;
    }
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const seq = ++fetchSeq.current;
      try {
        const result = await fetchMentionRoster({ clientId, query: token.query });
        if (seq !== fetchSeq.current) return; // a newer keystroke superseded this fetch
        const options = filterMentionOptionsForSelection({
          current: mentions,
          options: result?.actors || []
        }).slice(0, TYPEAHEAD_LIMIT);
        setTypeahead({ open: options.length > 0, options, active: 0, at: token.at });
      } catch {
        // roster unavailable — the composer stays a plain composer
        if (seq === fetchSeq.current) close();
      }
    }, TYPEAHEAD_DEBOUNCE_MS);
  };

  const pick = (option) => {
    const element = textareaRef?.current;
    if (!element || !option) return;
    const caret = element.selectionStart ?? element.value.length;
    const token = activeMentionToken(element.value, caret);
    const start = token ? token.at : caret;
    const display = option.display || option.agent_id || option.principal_id || 'someone';
    const nextText = `${element.value.slice(0, start)}@${display} ${element.value.slice(caret)}`;
    setDraft(nextText);
    setMentions((prev) => {
      const next = nextMentionSelection({ current: prev, picked: option });
      setFlavor(next.flavor);
      return next.mentions;
    });
    setTypeahead({ open: false, options: [], active: 0, at: 0 });
    requestAnimationFrame(() => {
      element.focus();
      const pos = start + display.length + 2;
      try { element.setSelectionRange(pos, pos); } catch { /* non-fatal */ }
    });
  };

  // Returns true when the key was consumed by the typeahead — the surface's
  // own handler (Cmd+Enter send etc.) must yield in that case.
  const handleKeyDown = (event) => {
    if (!typeahead.open) return false;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setTypeahead((t) => ({ ...t, active: (t.active + 1) % t.options.length }));
      return true;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setTypeahead((t) => ({ ...t, active: (t.active - 1 + t.options.length) % t.options.length }));
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      pick(typeahead.options[typeahead.active]);
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return true;
    }
    return false;
  };

  const removeMention = (key) => setMentions((prev) => prev.filter((m) => m.key !== key));
  const reset = () => {
    setMentions([]);
    setFlavor('mention');
    setTypeahead({ open: false, options: [], active: 0, at: 0 });
  };

  return {
    mentions,
    flavor,
    directDonna: isDirectDonnaMention(mentions),
    setFlavor,
    typeahead,
    handleInput,
    handleKeyDown,
    pick,
    removeMention,
    reset,
    setTypeaheadActive: (index) => setTypeahead((t) => ({ ...t, active: index }))
  };
};

const externalBadge = (
  <span
    style={{
      fontSize: 9,
      fontWeight: 700,
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      color: V.neg,
      border: `1px solid ${V.neg}55`,
      borderRadius: 4,
      padding: '0px 4px'
    }}
  >
    External
  </span>
);

const actorSubLabel = (option) => {
  if (option.actor_type === 'agent') {
    return option.agent_id === 'donna' ? 'Operator' : `Agent · ${option.role || 'specialist'}`;
  }
  return option.seat_role ? option.seat_role.charAt(0).toUpperCase() + option.seat_role.slice(1) : 'Team';
};

// Rendered by the surface INSIDE its composer card wrapper (which must be
// position:relative) — the dropdown floats above the textarea.
export const MentionTypeaheadOverlay = ({ state, onPick, onHover }) => {
  if (!state?.open || !state.options.length) return null;
  return (
    <div
      style={{
        position: 'absolute',
        bottom: '100%',
        left: 12,
        right: 12,
        marginBottom: 6,
        background: V.bg,
        border: `1px solid ${V.borderSubtle}`,
        borderRadius: 10,
        boxShadow: '0px 8px 24px rgba(46,42,34,0.12)',
        zIndex: 30,
        overflow: 'hidden'
      }}
      role="listbox"
    >
      {state.options.map((option, index) => (
        <div
          key={option.key}
          role="option"
          aria-selected={index === state.active}
          onMouseDown={(e) => { e.preventDefault(); onPick(option); }}
          onMouseEnter={() => onHover && onHover(index)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '7px 12px',
            cursor: 'pointer',
            background: index === state.active ? V.intelSurface : 'transparent',
            fontFamily: D.ui
          }}
        >
          <span style={{ fontSize: 13, color: V.t1, fontWeight: 600 }}>
            {option.display || option.agent_id || option.principal_id}
          </span>
          <span style={{ fontSize: 11, color: V.t3 }}>{actorSubLabel(option)}</span>
          {option.affiliation === 'external' && externalBadge}
          {option.email && (
            <span style={{ marginLeft: 'auto', fontSize: 11, color: V.t4 }}>{option.email}</span>
          )}
        </div>
      ))}
    </div>
  );
};

// Chips + the flavor selector — rendered above the composer card when at
// least one mention is staged. Assign/Ask need exactly one addressee (the
// server refuses more); Assign never targets an agent (an agent has no
// queue — ask it instead), so that option disables itself honestly.
export const MentionChipsRow = ({ mentions, flavor, onFlavorChange, onRemove }) => {
  if (!mentions?.length) return null;
  const singleAgent = mentions.length === 1 && mentions[0].actor_type === 'agent';
  const directDonna = isDirectDonnaMention(mentions);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 6,
        padding: '0 4px 6px',
        fontFamily: D.ui
      }}
    >
      {mentions.map((m) => (
        <span
          key={m.key}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 12,
            color: V.intel,
            background: V.intelSurface,
            border: `1px solid ${V.intel}33`,
            borderRadius: 999,
            padding: '2px 8px'
          }}
        >
          @{m.display || m.agent_id || m.principal_id}
          {m.affiliation === 'external' && externalBadge}
          <button
            type="button"
            onClick={() => onRemove(m.key)}
            aria-label={`Remove @${m.display || m.agent_id || m.principal_id}`}
            style={{
              border: 'none',
              background: 'transparent',
              color: V.t4,
              cursor: 'pointer',
              padding: 0,
              fontSize: 12,
              lineHeight: 1
            }}
          >
            ×
          </button>
        </span>
      ))}
      {!directDonna && (
        <span style={{ display: 'inline-flex', gap: 4, marginLeft: 'auto' }}>
          {MENTION_FLAVOR_OPTIONS.map((option) => {
            const requiresSingle = option.id === 'assign' || option.id === 'ask';
            const disabled = (requiresSingle && mentions.length !== 1)
              || (singleAgent && option.id !== 'ask');
            const selected = flavor === option.id;
            return (
              <button
                key={option.id}
                type="button"
                disabled={disabled}
                title={option.id === 'assign' && singleAgent
                  ? 'An agent has no queue — ask it instead'
                  : option.id === 'mention' && singleAgent
                    ? 'Agents do not receive FYI notifications — ask them to get a reply'
                    : option.hint}
                onClick={() => onFlavorChange(option.id)}
                style={{
                  fontSize: 11,
                  fontFamily: D.ui,
                  padding: '2px 9px',
                  borderRadius: 999,
                  border: `1px solid ${selected ? V.intel : V.borderSubtle}`,
                  background: selected ? V.intel : 'transparent',
                  color: selected ? V.bg : (disabled ? V.t4 : V.t2),
                  cursor: disabled ? 'not-allowed' : 'pointer'
                }}
              >
                {option.label}
              </button>
            );
          })}
        </span>
      )}
    </div>
  );
};

// ── Rendering the persisted comment lane ────────────────────────────────────

export const isCommentMessage = (message) =>
  ['comment', 'thread_resolution'].includes(message?.payload?.kind);

// The stream shows the LATEST version of an edited comment: hide any row a
// later comment supersedes (the original stays retrievable in the store —
// edit is a new row, never an UPDATE).
export const filterSupersededComments = (messages = []) => {
  const superseded = new Set(
    messages
      .map((m) => m?.payload?.supersedes_message_id)
      .filter(Boolean)
      .map(String)
  );
  return messages.filter((m) => !superseded.has(String(m?.id)));
};

const actorLabelFor = (message) => {
  const raw = String(message?.actor_id || '').trim();
  if (!raw) return 'Identity not recorded';
  const local = raw.includes('@') ? raw.slice(0, raw.indexOf('@')) : raw;
  return local.charAt(0).toUpperCase() + local.slice(1);
};

const FLAVOR_TAGS = {
  mention: { label: 'Mentioned', color: V.intel },
  assign: { label: 'Assigned', color: V.intel },
  ask: { label: 'Ask', color: V.neg }
};

const AGENT_WORKING_PHRASES = [
  'Reading your message…',
  'Checking the artifact…',
  'Preparing a reply…'
];

// Scoped lifecycle feedback, not generic presence/typing: it appears only
// after the user has submitted an addressed agent turn. It uses the ordinary
// inbound-message geometry (avatar + small typing bubble) so the stream reads
// like chat, not like a second control/status rail above the composer. For an
// asynchronous specialist ASK it is derived from persisted ask/reply comment
// rows, so a refresh cannot make owed work look as if it vanished.
export const AgentMentionActivity = ({ messages = [], activeAgent = null }) => {
  const pending = pendingAgentMentionAsks(messages);
  const agent = activeAgent || pending[0] || null;
  const [phraseIndex, setPhraseIndex] = useState(0);

  useEffect(() => {
    if (!agent) return undefined;
    const timer = window.setInterval(() => {
      setPhraseIndex((index) => (index + 1) % AGENT_WORKING_PHRASES.length);
    }, 1400);
    return () => window.clearInterval(timer);
  }, [agent?.agent_id, agent?.ask_id]);

  if (!agent) return null;
  const display = agent.display || agent.agent_id || 'Donna';
  return (
    <div
      role="status"
      aria-live="polite"
      className="donna-chat-message"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '0 0 18px',
        color: D.inkMute,
        fontFamily: D.ui,
        fontSize: 12.5,
        animation: `chatMessageIn 160ms ${D.ease}`
      }}
    >
      <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>
        {display} is working on your message
      </span>
      <span
        aria-hidden="true"
        style={{
          width: 26,
          height: 26,
          borderRadius: '50%',
          background: V.t1,
          color: V.bg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 10,
          fontWeight: 700,
          flexShrink: 0,
          marginTop: 2
        }}
      >
        {display.slice(0, 1).toUpperCase()}
      </span>
      <span
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          minHeight: 26,
          padding: '3px 10px',
          borderRadius: '4px 12px 12px 12px',
          background: V.surface,
          border: `1px solid ${V.borderSubtle}`
        }}
      >
        <span style={{ color: D.inkSoft, fontWeight: 600 }}>{display}</span>
        <span
          key={AGENT_WORKING_PHRASES[phraseIndex]}
          className="donna-working-verb"
          style={{ animation: `donnaVerbIn 180ms ${D.ease}` }}
        >
          {AGENT_WORKING_PHRASES[phraseIndex]}
        </span>
        <span style={{ display: 'inline-flex', gap: 3 }}>
          {[0, 1, 2].map((index) => (
            <span
              key={index}
              className="donna-working-dot"
              style={{
                width: 4,
                height: 4,
                borderRadius: '50%',
                background: D.accentWarmFlat,
                animation: `dotPulse 1.05s ${index * 120}ms ease-in-out infinite`
              }}
            />
          ))}
        </span>
      </span>
    </div>
  );
};

// Human (or agent) speech on the artifact — one card grammar for both chat
// surfaces: the viewer's own speech is right-aligned; every counterpart is
// left-aligned and attributed. Both stay distinct from machine system notes.
export const CommentMessage = ({ message, timestamp }) => {
  const payload = message?.payload || {};
  if (payload.kind === 'thread_resolution') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 18 }}>
        <div
          style={{
            fontSize: 12,
            color: V.t3,
            fontFamily: D.ui,
            border: `1px dashed ${V.borderSubtle}`,
            borderRadius: 999,
            padding: '4px 14px'
          }}
        >
          ✓ Thread resolved{payload.outcome_note ? ` — ${payload.outcome_note}` : ''}
          {payload.policy_memory_candidate ? ' · flagged for policy memory' : ''}
        </div>
      </div>
    );
  }
  const flavorTag = message?.role === 'assistant' && payload.ask_id
    ? { label: 'Replied', color: V.intel }
    : FLAVOR_TAGS[payload.flavor] || null;
  const redacted = payload.content_redacted === true;
  const mentionRefs = Array.isArray(payload.mentions) ? payload.mentions : [];
  if (message?.viewer_is_actor === true) {
    return (
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
            borderRadius: '14px 14px 4px 14px',
            padding: '10px 16px',
            fontSize: 14,
            maxWidth: 420,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word'
          }}
        >
          {redacted ? '[redacted]' : message.content}
        </div>
        {timestamp && (
          <div style={{ fontSize: 11, color: V.t4, fontFamily: D.ui, marginTop: 4 }}>
            {timestamp}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="donna-chat-message" style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 18, animation: `chatMessageIn 180ms ${D.ease}` }}>
      <div
        style={{
          borderLeft: `3px solid ${flavorTag ? flavorTag.color : V.intel}`,
          background: V.intelSurface,
          borderRadius: '4px 12px 12px 4px',
          padding: '9px 14px',
          maxWidth: 520,
          fontFamily: D.ui
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: V.t1 }}>{actorLabelFor(message)}</span>
          {flavorTag && (
            <span
              style={{
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: flavorTag.color
              }}
            >
              {flavorTag.label}
            </span>
          )}
          {payload.supersedes_message_id && (
            <span style={{ fontSize: 10, color: V.t4 }}>edited</span>
          )}
          {timestamp && (
            <span style={{ fontSize: 10, color: V.t4, fontFamily: "'JetBrains Mono', monospace" }}>
              {timestamp}
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 13.5,
            lineHeight: 1.55,
            color: redacted ? V.t4 : V.t1,
            fontStyle: redacted ? 'italic' : 'normal',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word'
          }}
        >
          {message.content}
        </div>
        {mentionRefs.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 6 }}>
            {mentionRefs.map((m, index) => (
              <span
                key={`${message.id}-ref-${index}`}
                style={{
                  fontSize: 11,
                  color: V.intel,
                  border: `1px solid ${V.intel}33`,
                  borderRadius: 999,
                  padding: '1px 7px'
                }}
              >
                @{m.display || m.agent_id || m.principal_id}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
