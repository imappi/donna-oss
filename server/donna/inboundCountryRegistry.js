// Named composition root for persisted country ask kinds. Flags remain inside
// their owned adapters as authority gates; they never choose another ask's lane.
// Persisted ask kinds retain their historical conversation consumer. This registry
// does not authorize a new country operation from current profile hints; each
// existing lifecycle still owns its stored draft, mandate and owner receipt checks.
import * as fi from './finland/inboundHandlers.js';
import * as gb from './gb/inboundHandlers.js';
import * as ae from './ae/inboundHandlers.js';
import * as sg from './singapore/inboundHandlers.js';
import { normalizeProfileJurisdiction } from './profileValidation.js';
export { startInvoiceIssuance, sniffEInvoiceXml, FINLAND_EINVOICE_RECEIVE_FLAG_KEY, receiveEInvoiceDocument, createIlmoitinSubmitAlvReturn } from './finland/inboundHandlers.js';
export { createIrasSubmitGstF5 } from './singapore/inboundHandlers.js';

export const createInboundCountryRegistry = (adapters) => {
  if (!Array.isArray(adapters)) throw new TypeError('Inbound registration requires an ordered adapter list.');
  const ids = new Set();
  for (const adapter of adapters) {
    if (!adapter || !/^[a-z]{2}$/.test(adapter.jurisdiction) || !Array.isArray(adapter.replies)) {
      throw new TypeError('Inbound registration requires a canonical jurisdiction and reply adapters.');
    }
    if (ids.has(adapter.jurisdiction)) throw new TypeError(`Duplicate inbound jurisdiction: ${adapter.jurisdiction}`);
    ids.add(adapter.jurisdiction);
    const replyIds = new Set();
    for (const reply of adapter.replies) {
      if (typeof reply?.id !== 'string' || !reply.id || replyIds.has(reply.id) || typeof reply.matches !== 'function' || typeof reply.run !== 'function') {
        throw new TypeError('Inbound reply requires a unique named match and run operation.');
      }
      replyIds.add(reply.id);
    }
    if (adapter.opening && (typeof adapter.opening.matches !== 'function' || typeof adapter.opening.resolve !== 'function'
      || !['flagReaderKey', 'resolverKey', 'createAskKey', 'postKey'].every(key => typeof adapter.opening[key] === 'string' && adapter.opening[key]))) {
      throw new TypeError('Opening-balance registration requires its existing writer and flag operations.');
    }
  }
  return Object.freeze([...adapters]);
};

// Evaluate only at invocation: the channel/firmDb cycle can enter a country
// module first. Reading imported objects at initialization would enter its TDZ.
// Reply order stays FI invoice, FI ALV, SG GST; GB opening outranks FI opening.
export const registeredInboundCountries = () => createInboundCountryRegistry([
  fi.COUNTRY_INBOUND_ADAPTER, sg.COUNTRY_INBOUND_ADAPTER, gb.COUNTRY_INBOUND_ADAPTER, ae.COUNTRY_INBOUND_ADAPTER
]);

export const resolveCountryInboundReply = (ask, { registry = registeredInboundCountries() } = {}) => {
  for (const adapter of registry) {
    for (const reply of adapter.replies) if (reply.matches(ask)) return reply;
  }
  return null;
};

export const resolveCountryOpeningBinding = (ask, { registry = registeredInboundCountries() } = {}) => {
  for (const adapter of [...registry].reverse()) {
    if (adapter.opening?.matches(ask)) return adapter.opening;
  }
  return null;
};

export const resolveInboundCountry = (jurisdiction, { registry = registeredInboundCountries() } = {}) => {
  const country = normalizeProfileJurisdiction(jurisdiction);
  return registry.find(adapter => adapter.jurisdiction === country) || null;
};
