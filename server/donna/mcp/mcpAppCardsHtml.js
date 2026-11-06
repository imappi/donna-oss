// Donna hosted chat surface — the MCP Apps card bundle (ONE html document,
// two cards), served as the `ui://donna-books/cards` resource by
// mcpAppCards.js (docs/design-donna-chatgpt-app-build-brief.md §5 slice 4).
//
// A View under the MCP Apps extension (SEP-1865, revision 2026-01-26,
// modelcontextprotocol/ext-apps — read from the spec source, never memory):
//   - the host renders this HTML in a sandboxed iframe (web hosts: a
//     double-nested sandbox proxy) and talks JSON-RPC 2.0 over postMessage;
//   - the View sends `ui/initialize` { appInfo, appCapabilities,
//     protocolVersion } and, on the result, `ui/notifications/initialized`;
//     the host then sends `ui/notifications/tool-input` and
//     `ui/notifications/tool-result` (a CallToolResult: content +
//     structuredContent), and `ui/notifications/host-context-changed` for
//     theme changes; the View reports `ui/notifications/size-changed`;
//   - the View may call `tools/call` (proxied by the host to the SAME MCP
//     server, subject to the host's own approval) and `ui/open-link`.
//
// Doctrine, unchanged by the widget (the card is a WINDOW, never the brain):
//   - the ask card's Confirm button calls confirm_action through the host's
//     tools/call bridge with the exact { entity_id, message_id, action_index }
//     ask_donna returned — the two-call shape, the funnel's gates, the
//     receipt; the card never bypasses any of it and holds no state of its
//     own beyond what the tool result carried;
//   - no network: no fetch/XHR/WebSocket, no external scripts, styles, fonts
//     or images (the resource's CSP declares NO domains; the spec's
//     restrictive default applies), no alert/prompt/confirm/clipboard (which
//     ChatGPT forbids anyway); every string from a result is rendered as
//     text, never as HTML;
//   - copy in the bridge register: says plainly that nothing is recorded
//     until the owner confirms, and that tool results reach the chat
//     provider; no custody slogans, no prices; Donna's voice (no em dashes);
//   - demo results (demo: true) render the same cards with the demo notice.
//
// Design: the D language (src/components/shared/design-tokens.js — paper
// ground, ink, the warm accent, brick for genuine failure), compact inline
// card, phone-width safe (320px up, 44px tap targets), light and dark via the
// host's style variables with the D palette as fallbacks (light-dark()), the
// document declaring color-scheme so Claude's tokens resolve. Everything
// else on this surface stays text.

export const MCP_APP_CARDS_VERSION = '1.0.0';
export const MCP_APP_CARDS_APP_NAME = 'donna-books-cards';
export const MCP_APP_CARDS_PROTOCOL_VERSION = '2026-01-26';

export const MCP_APP_CARDS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Donna</title>
<style>
:root {
  color-scheme: light dark;
  --d-paper: var(--color-background-primary, light-dark(#ffffff, #1e1d1b));
  --d-ground: var(--color-background-secondary, light-dark(#fbfbf8, #171614));
  --d-ink: var(--color-text-primary, light-dark(#141413, #f5f3ee));
  --d-ink-soft: var(--color-text-secondary, light-dark(rgba(20,20,19,0.72), rgba(245,243,238,0.74)));
  --d-ink-mute: var(--color-text-tertiary, light-dark(rgba(20,20,19,0.56), rgba(245,243,238,0.58)));
  --d-rule: var(--color-border-primary, light-dark(rgba(20,20,19,0.15), rgba(245,243,238,0.18)));
  --d-rule-soft: var(--color-border-secondary, light-dark(rgba(20,20,19,0.08), rgba(245,243,238,0.10)));
  --d-warm: #d4a056;
  --d-warm-wash: light-dark(rgba(212,160,86,0.16), rgba(212,160,86,0.22));
  --d-alert: light-dark(#8f3a2b, #d9836f);
  --d-alert-wash: light-dark(rgba(143,58,43,0.10), rgba(217,131,111,0.16));
  --d-ok: light-dark(#3d5a2f, #a6c98f);
  --d-radius: var(--border-radius-md, 12px);
  --d-font: var(--font-sans, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
  --d-mono: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
html[data-theme="dark"] { color-scheme: dark; }
html[data-theme="light"] { color-scheme: light; }
html, body { margin: 0; padding: 0; background: transparent; }
body { font-family: var(--d-font); color: var(--d-ink); font-size: 14px; line-height: 1.45; -webkit-font-smoothing: antialiased; }
.card { background: var(--d-paper); border: 1px solid var(--d-rule); border-radius: var(--d-radius); padding: 14px 16px 12px; max-width: 560px; box-sizing: border-box; }
.eyebrow { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--d-ink-mute); margin: 0 0 4px; }
.headline { font-size: 17px; font-weight: 600; margin: 0 0 10px; color: var(--d-ink); }
.entity { font-weight: 500; color: var(--d-ink-soft); }
.tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 0 0 10px; }
@media (max-width: 400px) { .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.tile { border: 1px solid var(--d-rule-soft); border-radius: 10px; padding: 8px 10px; background: var(--d-ground); min-width: 0; }
.tile .n { font-size: 20px; font-weight: 600; line-height: 1.1; font-variant-numeric: tabular-nums; }
.tile .l { font-size: 11px; color: var(--d-ink-mute); margin-top: 2px; }
.tile.you .n { color: var(--d-warm); }
.list { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--d-rule-soft); }
.list li { display: flex; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--d-rule-soft); align-items: flex-start; }
.list .who { flex: 1 1 auto; min-width: 0; }
.list .who .t { font-weight: 500; }
.list .who .r { color: var(--d-ink-soft); font-size: 13px; }
.list .amt { flex: 0 0 auto; font-variant-numeric: tabular-nums; font-family: var(--d-mono); font-size: 13px; white-space: nowrap; }
.dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--d-rule); margin-right: 6px; vertical-align: 1px; }
.dot.you { background: var(--d-warm); }
.text { white-space: pre-wrap; margin: 0 0 10px; }
.proposal { border: 1px solid var(--d-rule); border-left: 3px solid var(--d-warm); border-radius: 10px; padding: 10px 12px; margin: 0 0 8px; background: var(--d-ground); }
.proposal .s { margin: 0 0 8px; }
.proposal .state { font-size: 13px; color: var(--d-ink-soft); margin: 6px 0 0; }
.proposal .state.ok { color: var(--d-ok); }
.proposal .state.bad { color: var(--d-alert); }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
button { font: inherit; font-weight: 600; min-height: 44px; padding: 0 16px; border-radius: 999px; border: 1px solid var(--d-ink); background: var(--d-ink); color: var(--d-paper); cursor: pointer; }
button.secondary { background: transparent; color: var(--d-ink); }
button[disabled] { opacity: 0.55; cursor: default; }
.note { font-size: 12px; color: var(--d-ink-mute); margin: 10px 0 0; }
.demo { font-size: 12px; color: var(--d-warm); background: var(--d-warm-wash); border-radius: 8px; padding: 6px 10px; margin: 0 0 10px; }
.error { color: var(--d-alert); background: var(--d-alert-wash); border-radius: 8px; padding: 8px 10px; }
.waiting { color: var(--d-ink-mute); font-size: 13px; padding: 6px 0; }
</style>
</head>
<body>
<div id="root" class="card"><div class="waiting">Waiting for Donna.</div></div>
<script>
(function () {
  'use strict';
  var APP = { name: '${MCP_APP_CARDS_APP_NAME}', version: '${MCP_APP_CARDS_VERSION}' };
  var PROTOCOL = '${MCP_APP_CARDS_PROTOCOL_VERSION}';
  var root = document.getElementById('root');
  var pending = {};
  var nextId = 1;
  var toolInput = null;
  var lastResult = null;

  function post(msg) { try { window.parent.postMessage(msg, '*'); } catch (e) {} }
  function request(method, params) {
    var id = nextId++;
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      post({ jsonrpc: '2.0', id: id, method: method, params: params || {} });
    });
  }
  function notify(method, params) { post({ jsonrpc: '2.0', method: method, params: params || {} }); }
  function reply(id, result) { post({ jsonrpc: '2.0', id: id, result: result }); }
  function replyError(id, code, message) { post({ jsonrpc: '2.0', id: id, error: { code: code, message: message } }); }

  function applyHostContext(ctx) {
    if (!ctx) return;
    if (ctx.theme === 'dark' || ctx.theme === 'light') {
      document.documentElement.setAttribute('data-theme', ctx.theme);
      document.documentElement.style.colorScheme = ctx.theme;
    }
    var vars = ctx.styles && ctx.styles.variables;
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        if (/^--[a-z0-9-]+$/i.test(k) && typeof vars[k] === 'string') document.documentElement.style.setProperty(k, vars[k]);
      });
    }
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.jsonrpc !== '2.0') return;
    if (data.id !== undefined && data.id !== null && typeof data.method !== 'string') {
      var p = pending[data.id];
      if (!p) return;
      delete pending[data.id];
      if (data.error) p.reject(data.error); else p.resolve(data.result);
      return;
    }
    if (typeof data.method !== 'string') return;
    var params = data.params || {};
    var isRequest = data.id !== undefined && data.id !== null;
    switch (data.method) {
      case 'ui/notifications/tool-input': toolInput = params.arguments || null; break;
      case 'ui/notifications/tool-input-partial': break;
      case 'ui/notifications/tool-result': lastResult = params; render(params); break;
      case 'ui/notifications/tool-cancelled': renderError('Cancelled: ' + String(params.reason || 'the call was cancelled')); break;
      case 'ui/notifications/host-context-changed': applyHostContext(params); break;
      case 'ui/resource-teardown': if (isRequest) reply(data.id, {}); break;
      case 'ping': if (isRequest) reply(data.id, {}); break;
      case 'tools/list': if (isRequest) reply(data.id, { tools: [] }); break;
      default: if (isRequest) replyError(data.id, -32601, 'Method not found: ' + data.method);
    }
  });

  // ── Rendering (text only; every value from a result is textContent) ──
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function money(amount, currency) {
    if (amount === null || amount === undefined || isNaN(Number(amount))) return '';
    var n = Number(amount);
    var abs = Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    var s = (currency ? currency + ' ' : '') + abs;
    return n < 0 ? '(' + s + ')' : s;
  }
  function clear() { while (root.firstChild) root.removeChild(root.firstChild); }
  function demoBanner(sc) {
    if (!sc || !sc.demo) return null;
    return el('div', 'demo', 'Demo data. Nothing here is real and nothing you do here changes any books.');
  }
  function footer(extra) {
    var t = (extra ? extra + ' ' : '') + 'Every call is written to Donna\\u2019s audit trail. Tool results are sent to the chat provider you are using.';
    return el('p', 'note', t);
  }

  function renderError(text) {
    clear();
    root.appendChild(el('div', 'error', text));
    sizeChanged();
  }

  function render(result) {
    var sc = result && result.structuredContent;
    if (result && result.isError) {
      var t = (result.content && result.content[0] && result.content[0].text) || 'Donna refused this call.';
      return renderError(t);
    }
    if (!sc || typeof sc !== 'object') return renderError('No result to show.');
    if (sc.totals && sc.entity) return renderClose(sc);
    if (typeof sc.text === 'string' && Array.isArray(sc.actions)) return renderAsk(sc);
    return renderError('This card does not know how to show that result.');
  }

  // ── Close-status card ──
  function renderClose(sc) {
    clear();
    var totals = sc.totals || {};
    var blocks = Number(totals.blocks_close || 0);
    var d = demoBanner(sc); if (d) root.appendChild(d);
    root.appendChild(el('p', 'eyebrow', 'Close status'));
    var h = el('h1', 'headline', blocks === 0 ? 'Nothing blocks the close' : (blocks === 1 ? 'One item blocks the close' : blocks + ' items block the close'));
    root.appendChild(h);
    root.appendChild(el('p', 'entity', sc.entity && sc.entity.name ? sc.entity.name : ''));
    var tiles = el('div', 'tiles');
    [
      ['auto_cleared', 'Cleared by Donna', ''],
      ['confirmable', 'Posting with the close', ''],
      ['client_info_needed', 'Waiting on you', 'you'],
      ['operator_blocker', 'Needs your decision', 'you']
    ].forEach(function (row) {
      var tile = el('div', 'tile' + (row[2] ? ' ' + row[2] : ''));
      tile.appendChild(el('div', 'n', Number(totals[row[0]] || 0)));
      tile.appendChild(el('div', 'l', row[1]));
      tiles.appendChild(tile);
    });
    root.appendChild(tiles);
    var blockers = Array.isArray(sc.blockers) ? sc.blockers.slice(0, 5) : [];
    if (blockers.length) {
      var list = el('ul', 'list');
      blockers.forEach(function (b) {
        var li = el('li');
        var who = el('div', 'who');
        var title = el('div', 't');
        var dot = el('span', 'dot' + (b.kind === 'client_evidence_request' ? ' you' : ''));
        title.appendChild(dot);
        title.appendChild(document.createTextNode((b.counterparty || b.descriptor || 'Item') + (b.date ? ' \\u00b7 ' + b.date : '')));
        who.appendChild(title);
        if (b.reason) who.appendChild(el('div', 'r', b.reason));
        li.appendChild(who);
        li.appendChild(el('div', 'amt', money(b.amount, b.currency)));
        list.appendChild(li);
      });
      root.appendChild(list);
    }
    var more = (Array.isArray(sc.blockers) ? sc.blockers.length : 0) - blockers.length;
    var asks = Number(sc.open_owner_asks || 0);
    var extra = (asks ? (asks === 1 ? 'One question is waiting on you. ' : asks + ' questions are waiting on you. ') : '')
      + (sc.blockers_truncated || more > 0 ? 'Ask Donna for the full list. ' : '');
    root.appendChild(footer(extra.trim()));
    sizeChanged();
  }

  // ── Ask card ──
  function renderAsk(sc) {
    clear();
    var d = demoBanner(sc); if (d) root.appendChild(d);
    root.appendChild(el('p', 'eyebrow', 'Donna' + (sc.entity && sc.entity.name ? ' \\u00b7 ' + sc.entity.name : '')));
    root.appendChild(el('p', 'text', sc.text));
    var proposals = sc.actions.filter(function (a) { return a && a.requires_confirmation; });
    proposals.forEach(function (a) { root.appendChild(proposalBlock(sc, a)); });
    var acts = el('div', 'actions');
    if (sc.portal_link && sc.portal_link.url) {
      var open = el('button', 'secondary', 'Open in Donna');
      open.addEventListener('click', function () {
        open.disabled = true;
        request('ui/open-link', { url: String(sc.portal_link.url) }).catch(function () {}).then(function () { open.disabled = false; });
      });
      acts.appendChild(open);
    }
    if (acts.childNodes.length) root.appendChild(acts);
    root.appendChild(footer(proposals.length ? 'Nothing is recorded until you confirm.' : ''));
    sizeChanged();
  }

  function proposalBlock(sc, action) {
    var box = el('div', 'proposal');
    box.appendChild(el('p', 's', action.summary || ('Proposed ' + String(action.type || 'action'))));
    var state = el('p', 'state', sc.demo ? 'Demo proposal. Confirming here records nothing.' : 'Not recorded yet.');
    var acts = el('div', 'actions');
    var btn = el('button', null, 'Confirm');
    btn.addEventListener('click', function () {
      btn.disabled = true;
      state.className = 'state';
      state.textContent = 'Confirming with Donna.';
      var args = { entity_id: sc.entity && sc.entity.id, message_id: sc.message_id, action_index: action.index };
      request('tools/call', { name: 'confirm_action', arguments: args }).then(function (res) {
        var out = res && res.structuredContent;
        if (res && res.isError) {
          var t = (res.content && res.content[0] && res.content[0].text) || 'Donna refused the confirmation.';
          state.className = 'state bad'; state.textContent = t; btn.disabled = false; sizeChanged(); return;
        }
        if (out && out.applied) {
          state.className = 'state ok';
          state.textContent = out.replay ? 'Already recorded earlier.' : (out.action_type === 'record_mileage' ? 'Recorded. The mileage entry is in the books.' : 'Recorded. Your answer is filed and the question is closed.');
          btn.textContent = 'Confirmed';
          context('The owner confirmed action ' + action.index + ' on message ' + sc.message_id + ' from the card; Donna applied it (' + String(out.action_type || 'action') + ').');
        } else {
          state.className = 'state';
          state.textContent = (out && out.text) || (out && out.reason) || (out && out.outcome === 'demo_not_applied' ? 'Demo: nothing was recorded.' : 'Not recorded: ' + String((out && out.outcome) || 'not applied') + '.');
          btn.disabled = !(out && out.outcome === 'demo_not_applied') ? false : true;
          if (out && out.outcome === 'demo_not_applied') btn.textContent = 'Confirmed (demo)';
        }
        sizeChanged();
      }).catch(function (err) {
        state.className = 'state bad';
        state.textContent = 'Could not reach Donna: ' + String((err && err.message) || 'the chat app declined the call') + '.';
        btn.disabled = false;
        sizeChanged();
      });
    });
    acts.appendChild(btn);
    box.appendChild(acts);
    box.appendChild(state);
    return box;
  }

  function context(text) {
    request('ui/update-model-context', { content: [{ type: 'text', text: text }] }).catch(function () {});
  }

  // ── Size reporting ──
  var sizeTimer = null;
  function sizeChanged() {
    if (sizeTimer) clearTimeout(sizeTimer);
    sizeTimer = setTimeout(function () {
      var h = Math.ceil(document.documentElement.scrollHeight || document.body.scrollHeight || 0);
      var w = Math.ceil(document.documentElement.scrollWidth || document.body.scrollWidth || 0);
      notify('ui/notifications/size-changed', { width: w, height: h });
    }, 30);
  }
  if (typeof ResizeObserver === 'function') {
    try { new ResizeObserver(function () { sizeChanged(); }).observe(document.body); } catch (e) {}
  }

  // ── Handshake ──
  request('ui/initialize', { appInfo: APP, appCapabilities: { availableDisplayModes: ['inline'] }, protocolVersion: PROTOCOL })
    .then(function (result) {
      applyHostContext(result && result.hostContext);
      notify('ui/notifications/initialized', {});
      sizeChanged();
    })
    .catch(function () {
      notify('ui/notifications/initialized', {});
    });
})();
</script>
</body>
</html>
`;
