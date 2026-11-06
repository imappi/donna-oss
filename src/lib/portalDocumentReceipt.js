// Receipt of source files across every period, never a category/month coverage
// or bookkeeping-completion verdict. Unknown types/statuses remain on file.
export const summarizePortalDocuments = ({ documents = [], clientId } = {}) => {
  const statuses = { pending: 0, processing: 0, completed: 0, failed: 0, onFile: 0 };
  const seen = new Set();
  for (const document of documents) {
    if (!clientId || document?.client_id !== clientId || !document.id || seen.has(document.id)) continue;
    seen.add(document.id);
    const status = ['pending', 'processing', 'completed', 'failed'].includes(document.parse_status)
      ? document.parse_status : 'onFile';
    statuses[status] += 1;
  }
  return { total: seen.size, statuses };
};
