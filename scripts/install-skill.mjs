#!/usr/bin/env node
import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const kind = option('--target') || 'both';
const update = args.includes('--update');
const skillName = 'ask-gemini-web';
const source = path.join(root, 'skills', skillName);
const project = existsSync(path.join(root, 'gemini-draft.config.json'))
  ? JSON.parse(await readFile(path.join(root, 'gemini-draft.config.json'), 'utf8')) : {};
const home = path.resolve(option('--home') || process.env.GEMINI_DRAFT_HOME || (project.home && path.resolve(root, project.home))
  || (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'gemini-draft') : path.join(os.homedir(), '.local/share/gemini-draft')));
const saved = existsSync(path.join(home, 'connection.json')) ? JSON.parse(await readFile(path.join(home, 'connection.json'), 'utf8')) : {};
const endpoint = option('--cdp') || process.env.GEMINI_DRAFT_CDP || saved.endpoint || project.cdp || 'http://127.0.0.1:9222';
const codexTarget = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills', skillName);
const agentsTarget = path.join(os.homedir(), '.agents/skills', skillName);
const destination = option('--destination');
const targets = destination ? [path.resolve(destination)]
  : kind === 'codex' ? [codexTarget]
  : kind === 'agents' ? [agentsTarget]
  : kind === 'both' ? [codexTarget, agentsTarget]
  : (() => { throw new Error('--target must be codex, agents or both'); })();
await access(path.join(root, 'dist/cli.js'));
for (const target of targets) if (existsSync(target)) {
  if (!update) throw new Error(`Destination exists; use --update only for a recognized ${skillName} installation: ${target}`);
  const manifest = JSON.parse(await readFile(path.join(target, 'runtime/package.json'), 'utf8'));
  const instructions = await readFile(path.join(target, 'SKILL.md'), 'utf8');
  if (manifest.name !== 'gemini-draft' || !/^name: (?:ask-gemini-web|gemini-draft)$/m.test(instructions)) throw new Error(`Not a recognized ${skillName} installation: ${target}`);
}

function installDependencies(directory) {
  const npm = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  if (!existsSync(npm)) throw new Error('Cannot locate npm CLI. Run the installer with npm run install:skill.');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: directory, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`npm ci exited ${code}`)));
  });
}
for (const target of targets) {
  await mkdir(path.dirname(target), { recursive: true });
  const previousDirectory = !destination && !existsSync(target) ? path.join(path.dirname(target), 'gemini-draft') : target;
  const previousConnection = path.join(previousDirectory, 'connection.json');
  const previous = update && existsSync(previousConnection) ? JSON.parse(await readFile(previousConnection, 'utf8')) : {};
  await cp(source, target, { recursive: true, force: update, errorOnExist: !update });
  const runtime = path.join(target, 'runtime');
  await mkdir(runtime, { recursive: true });
  await cp(path.join(root, 'dist'), path.join(runtime, 'dist'), { recursive: true });
  await cp(path.join(root, 'package.json'), path.join(runtime, 'package.json'));
  const lock = existsSync(path.join(root, 'package-lock.json')) ? 'package-lock.json' : 'npm-shrinkwrap.json';
  await cp(path.join(root, lock), path.join(runtime, 'package-lock.json'));
  await installDependencies(runtime);
  const connection = { home: option('--home') || process.env.GEMINI_DRAFT_HOME ? home : previous.home || home,
    endpoint: option('--cdp') || process.env.GEMINI_DRAFT_CDP ? endpoint : previous.endpoint || endpoint };
  await writeFile(path.join(target, 'connection.json'), JSON.stringify(connection, null, 2) + '\n');
  console.log(JSON.stringify({ installed: target, runner: path.join(target, 'scripts/gemini-draft.mjs'), ...connection }));
}
