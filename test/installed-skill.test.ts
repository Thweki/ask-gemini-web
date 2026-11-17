import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function installedSkill(action: (fixture: {
  root: string; home: string; target: string;
  install: (args?: string[], environment?: Record<string, string>) => void;
  run: (runner?: string, args?: string[]) => Promise<{ status: number | null; stdout: string; stderr: string; probes: string[] }>;
}) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ask-gemini-web-installed-'));
  try {
    const checkout = path.join(root, 'checkout'), target = path.join(root, 'skill'), home = path.join(root, 'data');
    const cwd = path.join(root, 'work'), user = path.join(root, 'user');
    await mkdir(path.join(checkout, 'scripts'), { recursive: true });
    await mkdir(cwd); await mkdir(home); await mkdir(user);
    for (const name of ['scripts/install-skill.mjs', 'skills', 'dist', 'package.json', 'package-lock.json']) {
      await cp(path.resolve(name), path.join(checkout, name), { recursive: true });
    }
    const modules = path.resolve('node_modules');
    await symlink(modules, path.join(checkout, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const npm = path.join(root, 'npm-fixture.mjs');
    // Exercise the installer without downloading packages; reuse the tested dependencies.
    await writeFile(npm, `import assert from 'node:assert/strict';
      import { symlink } from 'node:fs/promises';
      assert.deepEqual(process.argv.slice(2), ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
      await symlink(${JSON.stringify(modules)}, 'node_modules', process.platform === 'win32' ? 'junction' : 'dir').catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });\n`);
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(ASK_GEMINI_WEB_|GEMINI_DRAFT_)/.test(key) || key === 'NODE_OPTIONS') delete env[key];
    }
    Object.assign(env, { HOME: user, USERPROFILE: user, LOCALAPPDATA: user, XDG_CONFIG_HOME: user, CODEX_HOME: path.join(user, '.codex'), npm_execpath: npm });
    const probesFile = path.join(root, 'probes.jsonl'), preload = path.join(root, 'offline.mjs');
    await writeFile(preload, `import { appendFileSync } from 'node:fs';
      import fs from 'node:fs/promises';
      import cp from 'node:child_process';
      import os from 'node:os';
      import { syncBuiltinESMExports } from 'node:module';
      // Every probe is unreachable, and process/profile discovery is isolated from the host.
      globalThis.fetch = async url => {
        appendFileSync(${JSON.stringify(probesFile)}, JSON.stringify(String(url)) + '\\n');
        return { ok: false };
      };
      const readdir = fs.readdir;
      fs.readdir = (directory, ...args) => directory === '/proc' ? Promise.resolve([]) : readdir(directory, ...args);
      cp.execFile = () => { throw new Error('No host process discovery in this fixture'); };
      os.homedir = () => ${JSON.stringify(user)};
      syncBuiltinESMExports();\n`);
    const install = (args: string[] = [], environment = {}) => {
      const result = spawnSync(process.execPath, [path.join(checkout, 'scripts/install-skill.mjs'), '--destination', target, ...args], {
        cwd, env: { ...env, ...environment }, encoding: 'utf8', timeout: 20000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).installed, target);
    };
    const run = async (runner = 'ask-gemini-web', args: string[] = []) => {
      await writeFile(probesFile, '');
      const result = spawnSync(process.execPath, [path.join(target, `scripts/${runner}.mjs`), 'browser', 'start', '--chrome', path.join(root, 'missing-chrome'), ...args], {
        cwd, env: { ...env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` }, encoding: 'utf8', timeout: 10000,
      });
      assert.ifError(result.error);
      return { status: result.status, stdout: result.stdout, stderr: result.stderr,
        probes: (await readFile(probesFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string) };
    };
    await action({ root, home, target, install, run });
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
}

const down = 'http://127.0.0.1:9555';
const probe = (endpoint: string) => `${endpoint}/json/version`;

test('new implicit installs save only home; installed canonical and legacy runners continue discovery and launch', async () => installedSkill(async ({ root, home, target, install, run }) => {
  for (const project of [undefined, { cdp: 'http://127.0.0.1:9333' }]) {
    const config = path.join(root, 'checkout/ask-gemini-web.config.json');
    if (project) await writeFile(config, JSON.stringify(project));
    install(['--home', home, ...(project ? ['--update'] : [])]);
    assert.deepEqual(JSON.parse(await readFile(path.join(target, 'connection.json'), 'utf8')), { home });
  }
  const saved = JSON.stringify({ endpoint: down });
  await writeFile(path.join(home, 'connection.json'), saved);
  for (const runner of ['ask-gemini-web', 'gemini-draft']) {
    const result = await run(runner);
    assert.equal(result.status, 1, result.stderr);
    // CHROME_NOT_FOUND proves startup reached launch after exhausting discovery.
    assert.equal(JSON.parse(result.stdout).error.code, 'CHROME_NOT_FOUND');
    assert.deepEqual(result.probes, [down, 'http://127.0.0.1:9222', 'http://127.0.0.1:9333'].map(probe));
    assert.equal(await readFile(path.join(home, 'connection.json'), 'utf8'), saved);
    if (runner === 'gemini-draft') assert.match(result.stderr, /deprecated.*ask-gemini-web.mjs/);
    else assert.equal(result.stderr, '');
  }
}));

test('old unmarked installed connections stay implicit before and after update', async () => installedSkill(async ({ home, target, install, run }) => {
  install(['--home', home]);
  const file = path.join(target, 'connection.json');
  const old = { home, endpoint: 'http://127.0.0.1:9444' };
  await writeFile(file, JSON.stringify(old));
  await writeFile(path.join(home, 'connection.json'), JSON.stringify({ endpoint: down }));
  for (const update of [false, true]) {
    if (update) install(['--update']);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), old);
    for (const runner of ['ask-gemini-web', 'gemini-draft']) {
      const result = await run(runner);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(JSON.parse(result.stdout).error.code, 'CHROME_NOT_FOUND');
      assert.deepEqual(result.probes, [old.endpoint, 'http://127.0.0.1:9222', 'http://127.0.0.1:9333'].map(probe));
    }
  }
  // A later command-line choice still overrides an implicit installation.
  const result = await run('ask-gemini-web', ['--cdp', old.endpoint]);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, 'CDP_UNAVAILABLE');
  assert.deepEqual(result.probes, [probe(old.endpoint)]);
}));

for (const source of ['cli', 'ASK_GEMINI_WEB_CDP', 'GEMINI_DRAFT_CDP']) {
  test(`explicit ${source} installs stay pinned across updates and fail closed without rewriting connections`, async () => installedSkill(async ({ home, target, install, run }) => {
    install(['--home', home, ...(source === 'cli' ? ['--cdp', down] : [])],
      source === 'cli' ? {} : { [source]: down });
    const file = path.join(target, 'connection.json');
    const expected = { home, endpoint: down, explicitCdp: true };
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), expected);
    install(['--update']);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), expected);
    const saved = JSON.stringify({ endpoint: 'http://127.0.0.1:9444' });
    await writeFile(path.join(home, 'connection.json'), saved);
    const skillConnection = await readFile(file, 'utf8');
    for (const runner of ['ask-gemini-web', 'gemini-draft']) {
      const result = await run(runner);
      assert.equal(result.status, 2, result.stderr);
      assert.equal(JSON.parse(result.stdout).error.code, 'CDP_UNAVAILABLE');
      assert.deepEqual(result.probes, [probe(down)], 'Explicit installs must never discover or launch.');
      assert.equal(await readFile(file, 'utf8'), skillConnection);
      assert.equal(await readFile(path.join(home, 'connection.json'), 'utf8'), saved);
    }
    const override = 'http://127.0.0.1:9444';
    const result = await run('ask-gemini-web', ['--cdp', override]);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stdout).error.code, 'CDP_UNAVAILABLE');
    assert.deepEqual(result.probes, [probe(override)], 'User command-line CDP overrides the saved explicit choice.');
  }));
}
