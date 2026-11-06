// Outbound sending identity + unsubscribe plumbing (M1, G8 — decision D7).
//
// D7 (recommendation adopted for Phase 1): counterparty sends go from the
// SHARED Resend-verified domain with the customer's business name in the
// From DISPLAY and the owner's own email as reply-to. The From address must
// NEVER impersonate the customer's domain without their DNS delegation —
// per-customer sending domains are a later, deliberate slice. The address
// half of From therefore always comes from resendClient's verified default;
// only the display name is per-customer.
//
// Unsubscribe (the marketing rail, ported): every counterparty email carries
// a working one-click unsubscribe — the List-Unsubscribe headers here plus
// the {{unsubscribe_url}} template token resolved from the action's bearer
// token (093). The public endpoint writes outbound_suppression; the next
// send attempt gate-blocks and the chase stops honestly.
//
// Base URL: env is legitimate here (deployment-shape config, not behavior) —
// OUTBOUND_PUBLIC_BASE_URL, falling back to the marketing rail's
// MARKETING_PUBLIC_BASE_URL. Without one the unsubscribe URL cannot exist,
// so the send REFUSES (fail-closed at render, receipted) rather than mailing
// a dead or missing link.
//
// Owner reply-to resolution mirrors clientSubscriptionDb's billing ladder:
// profile.email → contact_email → owner_email → null (null keeps the
// resendClient default, the kari@books.example mailbox).

import { defaultFrom, defaultReplyTo } from '../email/resendClient.js';
import { publicAppOrigin } from '../publicAppOrigin.js';

const cleanStr = (v) => String(v ?? '').trim();

// The verified-domain ADDRESS with a per-customer display name. Display names
// are quoted-string sanitized (quotes/newlines stripped) — a display name is
// data, never header syntax.
export const buildCounterpartyFrom = ({ ownerBusinessName } = {}) => {
  const base = defaultFrom();
  const address = (base.match(/<([^>]+)>/) || [null, base])[1].trim();
  const name = cleanStr(ownerBusinessName).replace(/[\r\n"<>@]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name) return base;
  return `"${name} via Donna" <${address}>`;
};

export const resolveOwnerReplyTo = (profile = {}) => {
  const p = profile && typeof profile === 'object' ? profile : {};
  return cleanStr(p.email) || cleanStr(p.contact_email) || cleanStr(p.owner_email) || null;
};

export const outboundPublicBaseUrl = (env = process.env) => publicAppOrigin(env);

export const buildOutboundUnsubscribeUrl = (baseUrl, token) => {
  const base = cleanStr(baseUrl).replace(/\/+$/, '');
  const clean = cleanStr(token);
  if (!base || !clean) return null;
  return `${base}/api/donna/outbound/unsubscribe?token=${encodeURIComponent(clean)}`;
};

// G15/D12 — the owner workspace deep link the digest carries once the base
// URL + workspace route exist: /firms?entity=<clientId>&tab=actions is the
// Actions tab of the entity workspace (App.jsx owns the param names). Null
// when either half is missing — the digest renders without it, exactly like
// the approve links.
export const buildOwnerWorkspaceUrl = (baseUrl, clientId) => {
  const base = cleanStr(baseUrl).replace(/\/+$/, '');
  const id = cleanStr(clientId);
  if (!base || !id) return null;
  return `${base}/client/${encodeURIComponent(id)}#list`;
};

export const buildOutboundApprovalUrl = (baseUrl, token, decision = 'approve') => {
  const base = cleanStr(baseUrl).replace(/\/+$/, '');
  const clean = cleanStr(token);
  if (!base || !clean) return null;
  return `${base}/api/donna/outbound/approval?token=${encodeURIComponent(clean)}&decision=${encodeURIComponent(decision)}`;
};

// One-click unsubscribe headers (marketingOutbound's shape — cheap now,
// mandatory if volume ever approaches bulk-sender territory).
export const buildUnsubscribeHeaders = (unsubscribeUrl) =>
  unsubscribeUrl
    ? {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
      }
    : {};

// The per-client identity the executor resolves once per sweep and hands to
// the deliverer alongside each rendered send.
export const buildCounterpartySendingIdentity = ({ ownerBusinessName, profile } = {}) => ({
  from: buildCounterpartyFrom({ ownerBusinessName }),
  replyTo: resolveOwnerReplyTo(profile)
});

// Resolve the identity bytes the provider boundary will actually use. The
// executor fingerprints these values before sending, including the Resend
// defaults that would otherwise be filled in only after the receipt boundary.
export const completeOutboundSendingIdentity = (identity = null) => ({
  from: cleanStr(identity?.from) || defaultFrom(),
  replyTo: cleanStr(identity?.replyTo) || defaultReplyTo()
});
