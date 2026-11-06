#!/usr/bin/env node
// Donna MCPB shim — stdio entry point (docs/design-donna-mcp-surface.md §4).
//
// Launched by Claude Desktop as the extension's MCP server. This file owns
// ONLY the stdio pipe; every message is handled by shimCore.mjs, and every
// decision is Donna's, over the authenticated local API. Zero dependencies
// on purpose: the MCPB bundle ships no node_modules.

import fs from 'node:fs';
import http from 'node:http';
import process from 'node:process';

import { handleMcpMessage, readEndpoint, splitNdjson } from './shimCore.mjs';

const ctx = {
  // Re-read per call: Donna may start/stop (new per-boot token) while the
  // shim process lives on in Claude Desktop.
  getEndpoint: () => readEndpoint({ fsImpl: fs }),
  httpImpl: http
};

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const { messages, rest } = splitNdjson(buffer);
  buffer = rest;
  for (const message of messages) {
    handleMcpMessage(message, ctx)
      .then((response) => {
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      })
      .catch((error) => {
        if (message?.id !== undefined && message?.id !== null) {
          process.stdout.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32603, message: String(error?.message || error) }
          })}\n`);
        }
      });
  }
});
process.stdin.on('end', () => process.exit(0));
