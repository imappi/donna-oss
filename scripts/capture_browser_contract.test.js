import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { captureBrowserContract } from './capture_browser_contract.mjs';

test('delegated browser proof consumes deployed restrictive headers and the real physical router rewrite',async()=>{
  const config=JSON.parse(await readFile(new URL('../vercel.json',import.meta.url),'utf8'));
  captureBrowserContract(config);
  const changed=structuredClone(config);changed.rewrites=changed.rewrites.filter(row=>row.source!=='/api/donna/physical/:path*');
  assert.throws(()=>captureBrowserContract(changed));
  const relaxed=structuredClone(config);relaxed.headers.find(row=>row.source==='/capture').headers.find(row=>row.key==='Content-Security-Policy').value="default-src *; script-src 'self' 'unsafe-inline'; connect-src *";
  assert.throws(()=>captureBrowserContract(relaxed));
  const main=await readFile(new URL('../src/main.jsx',import.meta.url),'utf8');
  assert.match(main,/capture \? <CaptureTaskPage/);assert.match(main,/capture \? null : <Analytics/);
});
