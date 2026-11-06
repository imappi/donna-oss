// Assistant identity — the per-client display name for Donna (D-PA-3,
// docs/design-donna-personal-agent.md §5).
//
// Owners may rename their assistant ("Tessa", "Aino") for a personal
// connection. The name is CLIENT DATA (clients.profile.assistant_name,
// jsonb — no migration), never a flag, and never weakens the honest-promise
// disclosure: the portal prompt states the assistant is the business's AI
// bookkeeper regardless of what it is called.
//
// Pure leaf: no imports, no I/O. Sanitization is deliberately conservative
// because the resolved name is interpolated into client-facing copy AND the
// portal chat system prompt — a name must never be able to smuggle prompt
// instructions (newlines, backticks, braces) into either.

export const DEFAULT_ASSISTANT_NAME = 'Donna';
export const MAX_ASSISTANT_NAME_LENGTH = 24;

// Allowed: unicode letters/digits, space, and the small punctuation set real
// names use (period, apostrophe, hyphen). Everything else is stripped.
const DISALLOWED_CHARS = /[^\p{L}\p{N} .'\-]/gu;

// Normalize a raw candidate into a safe display name, or null when nothing
// usable remains. Single line, collapsed whitespace, hard length cap.
export const sanitizeAssistantName = (raw) => {
  const collapsed = String(raw ?? '')
    .replace(DISALLOWED_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ASSISTANT_NAME_LENGTH)
    .trim();
  return collapsed || null;
};

// The one resolver every surface uses: a client profile (or any object with
// assistant_name) in, a renderable name out. Falsy/unusable → 'Donna'.
export const resolveAssistantName = (profile) =>
  sanitizeAssistantName(profile?.assistant_name) || DEFAULT_ASSISTANT_NAME;
