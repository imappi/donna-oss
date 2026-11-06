const clean = (value) => String(value || '').trim();

// Read-only chat actions can be minted on a venture thread (no client_id in
// the action schema) or on the firm Inbox (client_id required). Normalize both
// into the same explicit target object before the click leaves the card.
export const financialReportTargetForAction = (action = {}, fallbackClientId = null) => {
  if (action.type !== 'open_financials') return null;
  const clientId = clean(action.client_id || fallbackClientId);
  if (!clientId) return null;
  const period = clean(action.period);
  return {
    clientId,
    clientName: clean(action.client_name) || null,
    period: /^\d{4}-(0[1-9]|1[0-2])$/.test(period) ? period : null
  };
};

export const documentTargetForAction = (action = {}, fallbackClientId = null) => {
  if (action.type !== 'open_document') return null;
  const clientId = clean(action.client_id || fallbackClientId);
  const documentId = clean(action.document_id);
  if (!clientId || !documentId) return null;
  return { clientId, documentId };
};
