// Parse the JSON a model returned: plain JSON, a fenced ```json block, or the
// outermost {...} span. Throws when none of those parses. Moved unchanged out
// of the retired support-resolution runtime (runtime.js) on 2026-11-05.
export const extractJson = (text) => {
  const trimmed = text?.trim() || '';
  if (!trimmed) throw new Error('Empty model response.');
  try {
    return JSON.parse(trimmed);
  } catch {}

  const fenced = trimmed.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return JSON.parse(fenced[1].trim());

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  }
  throw new Error('Could not parse JSON from model response.');
};
