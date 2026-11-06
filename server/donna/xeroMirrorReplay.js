// A mirror retry replays recorded accounting; current country prose is not a
// replacement for the payload accepted by the original provider operation.
export const xeroMirrorReplayError = (code, message) => Object.assign(new Error(message), { code, statusCode: 409 });

export const retainedXeroMirrorPreview = (transaction = {}) => {
  const payload = transaction.xero_writeback_payload ?? transaction.xero_mirror_retry_payload;
  if (payload == null) return null;
  if (!payload || !['SPEND', 'RECEIVE'].includes(payload.Type)
      || !payload.BankAccount || !(payload.BankAccount.AccountID || payload.BankAccount.Code)
      || !Array.isArray(payload.LineItems) || !payload.LineItems.length
      || payload.LineItems.some((line) => !line || !line.AccountCode || !line.TaxType)) {
    throw xeroMirrorReplayError('XERO_MIRROR_RETRY_PAYLOAD_INVALID',
      'The retained Xero payload is incomplete; restore its original accounting receipt before retrying.');
  }
  const recorded = structuredClone(payload);
  const line = recorded.LineItems[0];
  return {
    coding: { account_code: line.AccountCode, xero_tax_type: line.TaxType, tax_treatment: line.TaxType },
    bank_account: { code: recorded.BankAccount.Code || null, xero_account_id: recorded.BankAccount.AccountID || null },
    bank_transaction: recorded,
    replay_source: 'retained_provider_payload'
  };
};
