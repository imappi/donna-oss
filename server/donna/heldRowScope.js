// HELMIKUU S8 (Kari, 2026-09-24): "each row get its own but then make it
// smarter for the remaining same stuff where user can confirm the rest or keep
// going on a row basis". A held statement row's question names the other held
// rows of the same statement. Whether the owner's answer covers only this row
// or all the remaining rows is the strong model's reading, through the one
// typed owner-reply interpreter, as a closed choice. Anything but a clear
// all_remaining_rows, including a provider failure, acts on this row only.
import { interpretOwnerReply } from './ownerReplyInterpreter.js';

export const HELD_ROW_SCOPES = Object.freeze(['this_row_only', 'all_remaining_rows', 'unclear']);

export const heldRowScopeAdapter = Object.freeze({
  instructions: 'The ask confirmed one bank payment against one row of a statement and named the other rows of the same statement that are still waiting for confirmation. '
    + 'Decide only the scope of the owner\'s answer: this_row_only when it confirms just the payment it was asked about, or confirms or disputes rows one at a time; '
    + 'all_remaining_rows only when it clearly confirms every named remaining row as well; unclear when it could mean either, names only some of the other rows, '
    + 'or does not confirm this row. Never treat a partial or conditional answer as all_remaining_rows.',
  answerSchema: { type: 'string', enum: [...HELD_ROW_SCOPES] },
  validateAnswer: answer => HELD_ROW_SCOPES.includes(answer)
});

export const decideHeldRowScope = async ({ request, reply, siblings, interpret = interpretOwnerReply,
  env = process.env, fetchImpl = globalThis.fetch }) => {
  const context = { question: request?.question || '', reply: String(reply || ''),
    other_held_rows: (siblings || []).map(({ line_no, line_description, date, amount, currency, direction }) =>
      ({ line_no, line_description, date, amount, currency, direction })) };
  try {
    const interpretation = await interpret({ request, adapter: heldRowScopeAdapter, context, env, fetchImpl });
    const scope = interpretation.needsClarification ? 'unclear' : interpretation.answer;
    return { scope, acts_on: scope === 'all_remaining_rows' ? 'all_remaining_rows' : 'this_row_only',
      model: interpretation.model || null, prompt_version: interpretation.promptVersion || null,
      confidence: interpretation.confidence ?? null };
  } catch (error) {
    return { scope: 'unclear', acts_on: 'this_row_only', failure: error?.code || 'OWNER_REPLY_SCOPE_FAILED',
      model: error?.interpretation?.model || null, prompt_version: error?.interpretation?.prompt_version || null, confidence: null };
  }
};
