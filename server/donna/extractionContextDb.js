import { queryFirmDb } from './db/pool.js';
import { normalizeJurisdictionKey } from './taxCodeJurisdiction.js';
import { normalizeIsoCurrency } from './parsePrimitives.js';

// Context for reading evidence, never permission to code or post. Unlike coding
// policy resolution, missing country capabilities cannot stop durable intake.
export const extractionContextFromClient = (row = {}) => {
  const profile = row.profile || {};
  const jurisdiction = normalizeJurisdictionKey(row.jurisdiction);
  const profileJurisdiction = normalizeJurisdictionKey(profile.jurisdiction);
  const entityType = String(row.entity_type || profile.entityType || profile.entity_type || '').trim().toLowerCase();
  const profileEntityType = String(profile.entityType || profile.entity_type || '').trim().toLowerCase();
  const conflict = Boolean((profile.jurisdiction && profileJurisdiction !== jurisdiction)
    || (row.entity_type && profileEntityType && String(row.entity_type).trim().toLowerCase() !== profileEntityType)
    || (entityType && /^[a-z]{2}-/.test(entityType) && entityType.slice(0, 2) !== jurisdiction));
  const currencies = [...new Set([profile.currency, profile.accountingCurrency, profile.baseCurrency,
    profile.defaultCurrency, profile.default_currency].filter((v) => v != null && v !== '').map(normalizeIsoCurrency))];
  const ledgerCurrency = currencies.length === 1 && Intl.supportedValuesOf('currency').includes(currencies[0]) ? currencies[0] : '';
  return {
    id: row.id || null,
    display_name: row.company_name || null,
    legal_names: Array.isArray(row.legal_names) ? row.legal_names.filter(Boolean) : [],
    entity_type: entityType || null,
    jurisdiction: conflict ? null : jurisdiction || null,
    jurisdiction_status: conflict ? 'jurisdiction_context_conflict' : jurisdiction ? 'resolved' : 'jurisdiction_unresolved',
    ledger_currency: ledgerCurrency,
    ledger_currency_source: ledgerCurrency ? 'persisted_client_profile' : currencies.length ? 'conflicting_or_invalid_profile' : 'unresolved'
  };
};

export const getExtractionContextInDb = async ({ firmId, clientId, dbClient = null } = {}) => {
  if (!firmId || !clientId) return extractionContextFromClient();
  const query = dbClient ? dbClient.query.bind(dbClient) : queryFirmDb;
  const result = await query(
    'select id, company_name, legal_names, jurisdiction, entity_type, profile from clients where firm_id = $1 and id = $2 limit 1',
    [firmId, clientId]
  );
  return extractionContextFromClient(result.rows[0]);
};
