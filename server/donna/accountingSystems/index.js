// accountingSystems/ — the adapter layer that decouples the firm's
// downstream connector (Xero today, QBO next) from the route handlers.
// Routes resolve a client's accounting_system and dispatch through the
// resolved adapter; the Xero adapter wraps the existing xero* writers
// (zero behaviour change) and the QBO/none adapters are scaffolds that
// report "not available" instead of silently hitting Xero.

import { xeroAdapter } from './xeroAdapter.js';
import { qboAdapter } from './qboAdapter.js';
import { procountorAdapter } from './procountorAdapter.js';
import { noneAdapter } from './noneAdapter.js';

export {
  AccountingSystemNotAvailableError,
  ACCOUNTING_AUDIT_ACTIONS,
  ACCOUNTING_ADAPTER_VERBS
} from './contract.js';
export { xeroAdapter, qboAdapter, procountorAdapter, noneAdapter };

// Adapter inherited when accounting_system is unset. The historical 'xero'
// fallback ("for one deploy cycle", Phase 3a) is RETIRED (2026-08-16):
// migration 120 stamped every existing client from its own connection
// evidence and createClientInDb stamps new clients at birth, so unset no
// longer occurs in real data — and when it does (a hand-inserted row, a
// pre-migration snapshot), routing an unknown client's writes to Xero was
// the wrong default anyway. 'none' is fail-closed: the noneAdapter refuses
// every connector verb cleanly instead of attempting an external write,
// and it matches the chat-apply lanes, which already resolved unset to
// 'none'. (src/lib/clientAxes.js keeps its own 'xero' default
// DELIBERATELY — it only drives the neutral "connect Xero or QuickBooks"
// portal tile for a client who hasn't chosen, never a write path.)
export const DEFAULT_ACCOUNTING_SYSTEM = 'none';

const ADAPTERS = {
  xero: xeroAdapter,
  qbo: qboAdapter,
  procountor: procountorAdapter,
  none: noneAdapter
};

// Host Certificate A inventories the exact adapter registry without reaching
// through this module's private implementation object.
export const ACCOUNTING_SYSTEM_IDS = Object.freeze(Object.keys(ADAPTERS).sort());

// Resolve the adapter for a client's accounting_system value. Unset/null
// or an unrecognised id resolves to the default ('none') — a clean
// "no external system" refusal, never a silent Xero attempt.
export const getAccountingSystemAdapter = (systemId) => {
  const id = typeof systemId === 'string' && systemId.trim()
    ? systemId.trim().toLowerCase()
    : DEFAULT_ACCOUNTING_SYSTEM;
  return ADAPTERS[id] || ADAPTERS[DEFAULT_ACCOUNTING_SYSTEM];
};
