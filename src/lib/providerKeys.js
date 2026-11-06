// Renderer half of the BYO provider-key bridge (technical plan §7). The
// keys themselves live in the OS keychain behind the shell's main process —
// this module only carries intent across the contextBridge and hands back
// the masked status projection.
//
// NEVER put a provider key in localStorage, sessionStorage, component state
// that outlives a save, a query param, or the runtime API. The whole point
// of routing through the shell is that the renderer holds no key material:
// the surface here can save, clear, and read STATUS — there is no read-back.

const bridge = () => (typeof window !== 'undefined' ? window.donnaDesktop?.providerKeys : null) || null;

// False in the browser (the web session reads keys from the server env) and
// in any shell build that predates this bridge — the screen says which.
export const providerKeyStorageSupported = () => Boolean(bridge());

export const fetchProviderKeyStatus = async () => {
  const api = bridge();
  if (!api) return null;
  return api.status();
};

// `keys` is { openai?, anthropic? }; an absent or blank field means "leave
// this one as it is", so saving one key never wipes the other.
export const saveProviderKeys = async (keys) => {
  const api = bridge();
  if (!api) return { ok: false, error: 'Key storage needs the Donna desktop app.', status: null };
  return api.save(keys);
};

// provider: 'openai' | 'anthropic' | 'all'
export const clearProviderKey = async (provider) => {
  const api = bridge();
  if (!api) return { ok: false, error: 'Key storage needs the Donna desktop app.', status: null };
  return api.clear(provider);
};

// "Saved today 18:04" reads better than an ISO string on a settings row.
export const formatKeySavedAt = (iso) => {
  if (!iso) return '';
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return '';
  return when.toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
  });
};
