import assert from 'node:assert/strict';

// Use the deployment's real headers and rewrite rather than a test-only CSP.
export function captureBrowserContract(config) {
  const entry = config.headers.find(row => row.source === '/capture');
  assert.ok(entry, 'deployed capture headers required');
  const headers = Object.fromEntries(entry.headers.map(row => [row.key, row.value]));
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
  assert.equal(headers['Cache-Control'], 'no-store');
  const csp = headers['Content-Security-Policy'];
  for (const directive of ["script-src 'self'", "connect-src 'self' https://*.supabase.co", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'"]) assert.ok(csp.includes(directive), directive);
  assert.ok(!/script-src[^;]*unsafe-|connect-src[^;]*\*/.test(csp.replace('https://*.supabase.co', 'https://supabase.co')));
  const rewrite = config.rewrites.find(row => row.source === '/api/donna/physical/:path*');
  assert.equal(rewrite?.destination, '/api/donna-router?path=physical/:path*');
  assert.ok(config.rewrites.some(row => row.destination === '/index.html'), 'capture SPA fallback required');
  return headers;
}
