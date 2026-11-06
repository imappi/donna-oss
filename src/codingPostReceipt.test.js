import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildProposalApplyReceiptMetadata } from './lib/operatorProposalCards.js';

test('production receipt component distinguishes saved coding from failed posting',async t=>{
  const directory=await mkdtemp(resolve('.coding-receipt-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  await build({stdin:{contents:`export { ApplyReceiptStrip } from './src/components/shared/operator-proposal-card-strips.jsx'; export { LocaleProvider } from './src/i18n/LocaleProvider.jsx';`,resolveDir:process.cwd()},outfile:`${directory}/render.mjs`,bundle:true,format:'esm',platform:'node',packages:'external',jsx:'automatic',
    define:{'import.meta.env':'{}'},logLevel:'silent'});
  const {ApplyReceiptStrip,LocaleProvider}=await import(pathToFileURL(`${directory}/render.mjs`));
  const tone={receipt:{status:{partial:'#900',applied:'#090'},summarySize:12},warning:{},metaLine:{}};
  for(const status of ['error','posted']){
    const action={type:'apply_category',status:'applied',result:{account_name:'Rent',posting:{status,...(status==='error'?{error:'The matched evidence changed after coding.'}:{})}}};
    const receipt=buildProposalApplyReceiptMetadata(action);
    const html=renderToStaticMarkup(React.createElement(LocaleProvider,{initialPreferences:{locale:'en'}},React.createElement(ApplyReceiptStrip,{action,receipt,tone})));
    if(status==='error'){
      assert.equal(receipt.status,'partial');assert.equal(receipt.summary,'Coding saved; posting failed');
      assert.match(html,/Coding saved; posting failed/);assert.doesNotMatch(html,/Coded and posted/);
      assert.match(html,/matched evidence changed/);
    }else{assert.equal(receipt.status,'applied');assert.match(html,/Coded and posted/);}
  }
});
