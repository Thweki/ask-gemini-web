#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';

const bundled = fileURLToPath(new URL('../runtime/dist/cli.js', import.meta.url));
const source = fileURLToPath(new URL('../../../dist/cli.js', import.meta.url));
const override = process.env.GEMINI_DRAFT_APP && path.resolve(process.env.GEMINI_DRAFT_APP, 'dist/cli.js');
const entry = override || (existsSync(bundled) ? bundled : source);
if (!existsSync(entry)) {
  console.error('CLI runtime missing. Install this skill with the gemini-draft installer, or build the source application and set GEMINI_DRAFT_APP.');
  process.exitCode = 2;
} else {
  const saved = fileURLToPath(new URL('../connection.json', import.meta.url));
  const connection = existsSync(saved) ? JSON.parse(readFileSync(saved, 'utf8')) : {};
  const args = [entry];
  if (connection.home) args.push('--home', connection.home);
  if (connection.endpoint) args.push('--cdp', connection.endpoint);
  args.push('--json', '--compact', ...process.argv.slice(2));
  const child = spawn(process.execPath, args, { stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 130 : 1); });
}
