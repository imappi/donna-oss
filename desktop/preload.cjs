// Sandboxed preload (CommonJS — required under sandbox:true). Deliberately
// minimal: the renderer talks to Donna over its own origin's /api paths via
// the protocol proxy, so no IPC surface is needed for the books themselves.
// What lives here is the marker the SPA reads to know it's inside the
// desktop shell (window.location.protocol also says so), plus the surfaces
// that CANNOT go over the runtime API because they are the shell's own —
// today that is provider-key storage, which belongs to the OS keychain and
// the main process, never to the runtime and never to a database.
//
// The provider-key bridge is deliberately WRITE-AND-STATUS ONLY: save,
// clear, and a status projection carrying masked previews. There is no
// "read my key back" channel, so a compromised renderer cannot exfiltrate a
// key that was stored here. Senders are validated on the main side.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('donnaDesktop', {
  shell: true,
  clientPortal: {
    // The renderer supplies only the selected client identity. Main owns the
    // loopback preview URL, the session token, and shell.openExternal.
    open: (clientId) => ipcRenderer.invoke('donna:client-portal:open', { clientId })
  },
  providerKeys: {
    status: () => ipcRenderer.invoke('donna:provider-keys:status'),
    save: (keys) => ipcRenderer.invoke('donna:provider-keys:save', keys),
    clear: (provider) => ipcRenderer.invoke('donna:provider-keys:clear', { provider })
  }
});
