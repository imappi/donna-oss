export const clientPortalPath = (clientId) => {
  const id = String(clientId || '').trim();
  return id ? `/client/${encodeURIComponent(id)}` : null;
};

// One intent, two hosts. Web opens the portal on its current app origin;
// Electron delegates only the client identity to its narrow preload bridge so
// main can launch the token-gated local preview in the system browser.
export const openClientPortal = async ({
  clientId,
  desktopBridge = typeof window !== 'undefined' ? window.donnaDesktop?.clientPortal : null,
  location = typeof window !== 'undefined' ? window.location : null,
  openWindow = typeof window !== 'undefined' ? window.open.bind(window) : null
} = {}) => {
  const path = clientPortalPath(clientId);
  if (!path) throw new Error('A client is required to open the portal.');

  if (typeof desktopBridge?.open === 'function') {
    const result = await desktopBridge.open(String(clientId).trim());
    if (!result?.ok) throw new Error(result?.error || 'Could not open the client portal preview.');
    return { host: 'desktop', url: null };
  }

  if (!location?.origin || typeof openWindow !== 'function') {
    throw new Error('The browser portal is unavailable.');
  }
  const url = new URL(path, location.origin).toString();
  const opened = openWindow(url, '_blank', 'noopener,noreferrer');
  if (!opened) throw new Error('The browser blocked the client portal window.');
  return { host: 'web', url };
};
