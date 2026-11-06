// MCP endpoint handshake file — how the Claude Desktop MCPB shim finds the
// running Donna (docs/design-donna-mcp-surface.md §4).
//
// The shim is a separate process launched by Claude Desktop; it cannot
// inherit DONNA_ACCESS_TOKEN or the socket path from the shell. So the shell
// writes this small file at boot — {socket_path, token} under the app's data
// dir, mode 0600 (owner-only: the token guards the local API, and the file
// sits in the same user profile that holds the database itself) — and
// removes it on quit. The token is per-boot (main.mjs mints it), so a stale
// file after a crash points at a dead socket and the shim degrades to a
// friendly "Donna isn't running" tool result, never a hang.
//
// The PRESENCE of this file exposes no book data: every MCP call still needs
// the per-entity MCP_ENTITY_EXPOSE consent flag to resolve to an acting
// stage, and the API refuses unauthenticated callers. The file is the wire,
// not the consent.
//
// Path contract (keep in lockstep with desktop/mcpb/server/shimCore.mjs,
// which probes the platform userData locations for the same relative path):
//   <dataDir>/runtime/mcp-endpoint.json

import fs from 'node:fs';
import path from 'node:path';

export const MCP_ENDPOINT_FILE_VERSION = 1;

export const mcpEndpointFilePath = (dataDir) =>
  path.join(dataDir, 'runtime', 'mcp-endpoint.json');

// Write (or refresh) the handshake file. Returns the path written. The mode
// is enforced with an explicit chmod too, because writeFileSync's `mode`
// only applies on creation and boot overwrites an existing file.
export const writeMcpEndpointFile = ({ dataDir, socketPath, token, fsImpl = fs } = {}) => {
  if (!dataDir || !socketPath || !token) {
    throw new Error('writeMcpEndpointFile requires dataDir, socketPath, token');
  }
  const filePath = mcpEndpointFilePath(dataDir);
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  fsImpl.writeFileSync(
    filePath,
    `${JSON.stringify({
      version: MCP_ENDPOINT_FILE_VERSION,
      socket_path: socketPath,
      token,
      api_prefix: '/api/donna/mcp'
    }, null, 2)}\n`,
    { mode: 0o600 }
  );
  fsImpl.chmodSync(filePath, 0o600);
  return filePath;
};

// Best-effort removal on quit — a missing file is fine; anything else is
// reported to the caller's logger, never thrown (quit must not wedge).
export const removeMcpEndpointFile = ({ dataDir, fsImpl = fs, logger = console } = {}) => {
  if (!dataDir) return false;
  const filePath = mcpEndpointFilePath(dataDir);
  try {
    fsImpl.unlinkSync(filePath);
    return true;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger.warn?.(`[mcp-endpoint] could not remove ${filePath}: ${error?.message || error}`);
    }
    return false;
  }
};
