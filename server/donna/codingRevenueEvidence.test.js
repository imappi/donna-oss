import test from 'node:test';
import assert from 'node:assert/strict';
import {codingRevenueEvidenceGap} from './codingRevenueEvidence.js';
import {__shouldAutoApplyBatchSuggestion} from './db/coding.js';
import {evaluateCodingAutoPost,buildOwnerAsk} from './codingAutoPost.js';
const transaction={money_in:455,money_out:0},suggestion={proposed_account:'Sales',confidence:'high',evidence_required:false,auto_explain_limit:1000};
test('a bank deposit or slip cannot establish operating revenue; supported source families and non-sales roles remain usable',()=>{
 assert.equal(codingRevenueEvidenceGap({transaction,suggestion}),true);
 assert.equal(codingRevenueEvidenceGap({transaction,suggestion,matchedDocument:{document_type:'deposit_slip',match_status:'confirmed'}}),true);
 for(const type of ['sales_invoice','issued_receipt','payout_statement'])assert.equal(codingRevenueEvidenceGap({transaction,suggestion,matchedDocument:{document_type:type,match_status:'auto_matched'}}),false);
 assert.equal(codingRevenueEvidenceGap({transaction,suggestion:{...suggestion,proposed_account:'Interest income'}}),false);
 assert.equal(codingRevenueEvidenceGap({transaction,suggestion:{...suggestion,proposed_account:'Operating supplies'}}),false);
 assert.equal(__shouldAutoApplyBatchSuggestion(transaction,suggestion),false);
});
test('the existing sweep makes one precise source question instead of accepting unsupported Sales',()=>{
 const verdict=evaluateCodingAutoPost({suggestion,moneyIn:455});
 assert.equal(verdict.action,'owner_ask');assert.equal(verdict.reason,'revenue_source_required');
 const ask=buildOwnerAsk({reason:verdict.reason,suggestion,line:{description:'Bank deposit',money_in:455,currency:'EUR'}});
 assert.equal(ask.evidence_type,'supporting_document');assert.match(ask.question,/cashbook or till reconciliation/);assert.match(ask.question,/already recorded/);
 assert.equal(evaluateCodingAutoPost({suggestion,moneyIn:455,hasPendingEvidenceRequest:true}).action,'skip');
 assert.equal(evaluateCodingAutoPost({suggestion,moneyIn:455,hasSuggestedDocMatch:true}).reason,'doc_match_pending');
});
