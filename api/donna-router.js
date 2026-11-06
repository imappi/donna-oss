import { handleDonnaApiRequest } from '../server/donna/api.js';
import { trackHostedInvocation } from '../server/donna/db/pool.js';

const getPathValue = (value) => {
  if (Array.isArray(value)) return value.join('/');
  return typeof value === 'string' ? value : '';
};

export default function handler(req, res) {
  // Hosted session hygiene (pool.js): the last invocation to finish in this
  // instance hands its idle pooler sessions back before the platform freezes it.
  trackHostedInvocation(res);
  const requestUrl = new URL(req.url || '/', 'http://localhost');
  const rewrittenPath = getPathValue(req.query?.path) || requestUrl.searchParams.get('path') || '';
  requestUrl.searchParams.delete('path');
  req.url = `/api/donna${rewrittenPath ? `/${rewrittenPath}` : ''}${requestUrl.search}`;
  handleDonnaApiRequest(req, res);
}
