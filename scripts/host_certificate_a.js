#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { buildDesktopHandlerManifest } from '../server/donna/desktop/handlerManifest.js';
import { applyDesktopBuildIdentityDefaults } from '../server/donna/desktop/buildIdentity.js';
import { closeFirmDbPool } from '../server/donna/firmDb.js';
import { observeHostCertificateA } from '../server/donna/hostCertificateA.js';

export const parseHostCertificateArgs = (argv = []) => {
  const args = { output: null, requirePass: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--require-pass') args.requirePass = true;
    else if (token === '--output') args.output = argv[++index] || null;
    else if (token.startsWith('--output=')) args.output = token.slice('--output='.length);
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (argv.includes('--output') && !args.output) throw new Error('--output requires a path.');
  return args;
};

export const applyBuildIdentityDefaults = (env = process.env) => {
  applyDesktopBuildIdentityDefaults(env, { rootDir: process.cwd() });
};

export const runHostCertificateA = async ({ argv = process.argv.slice(2), env = process.env } = {}) => {
  const args = parseHostCertificateArgs(argv);
  applyBuildIdentityDefaults(env);
  const schedulerEnabled = !/^(off|0|false)$/i.test(String(env.DONNA_DESKTOP_SCHEDULER || ''));
  const manifest = buildDesktopHandlerManifest({ rootDir: process.cwd() });
  const receipt = await observeHostCertificateA({ env, rootDir: process.cwd(), manifest, schedulerEnabled });
  const json = `${JSON.stringify(receipt, null, 2)}\n`;
  if (args.output) {
    const target = path.resolve(args.output);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, json, 'utf8');
  } else {
    process.stdout.write(json);
  }
  if (args.requirePass && receipt.status !== 'PASS') {
    const error = new Error(`Host Certificate A is ${receipt.status}, not PASS.`);
    error.exitCode = receipt.status === 'INCOMPLETE' ? 2 : 1;
    error.receipt = receipt;
    throw error;
  }
  return receipt;
};

const main = async () => {
  try {
    const receipt = await runHostCertificateA();
    if (process.argv.some((arg) => arg === '--output' || arg.startsWith('--output='))) {
      console.log(`Host Certificate A: ${receipt.status}`);
    }
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = error?.exitCode || 1;
  } finally {
    await closeFirmDbPool();
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
