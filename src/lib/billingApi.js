// Client-side billing calls. Thin wrappers over the /api/donna/billing/*
// endpoints, reusing firmFetch so the portal's auth headers (and 401 refresh)
// apply exactly as they do for every other firm/portal request.
//
// The subscription gates client-portal access: the gate reads `status`, and the
// paywall calls `startCheckout` / `openBillingPortal`, which return a Stripe URL
// the browser is sent to. Nothing here ever touches a secret key — the
// publishable side of Stripe is a hosted redirect, so the client only handles
// URLs.

import { firmFetch, coerceErrorMessage } from './firmApi.js';

const parseOrThrow = async (response, fallback) => {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(coerceErrorMessage(body.error, fallback));
    error.status = response.status;
    error.code = body.code;
    throw error;
  }
  return body;
};

// Read the subscription gate state for a client. Shape:
//   { billing_enabled, status, entitled, current_period_end, has_customer }
// `entitled` is the only field the gate needs — it is true when billing is
// disabled (fail-open) or the subscription is active/trialing.
export const fetchBillingStatus = async (clientId, { signal } = {}) => {
  const response = await firmFetch(
    `/api/donna/billing/status?client_id=${encodeURIComponent(clientId)}`,
    { method: 'GET', headers: { Accept: 'application/json' }, signal }
  );
  return parseOrThrow(response, `Billing status request failed with ${response.status}`);
};

// Start a hosted Checkout Session for an offer and return its URL. The caller
// redirects. `offer` is { kind, bandId, months } — the price is re-derived
// server-side from the band (never sent/trusted from the client).
export const startCheckout = async (clientId, offer) => {
  const response = await firmFetch('/api/donna/billing/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, offer })
  });
  const body = await parseOrThrow(response, 'Could not start checkout.');
  return body.url;
};

// Open the Stripe Billing Portal (manage card / cancel) and return its URL.
export const openBillingPortal = async (clientId) => {
  const response = await firmFetch('/api/donna/billing/portal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId })
  });
  const body = await parseOrThrow(response, 'Could not open the billing portal.');
  return body.url;
};
