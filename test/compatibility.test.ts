import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultHome, settings } from '../src/config.js';
import { findChrome } from '../src/browser.js';

async function isolated(action: (root: string, warnings: string[]) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ask-gemini-web-compat-'));
  const names = ['ASK_GEMINI_WEB_HOME', 'ASK_GEMINI_WEB_CDP', 'ASK_GEMINI_WEB_CHROME', 'GEMINI_DRAFT_HOME', 'GEMINI_DRAFT_CDP', 'GEMINI_DRAFT_CHROME', 'LOCALAPPDATA'];
  const saved = names.map(name => process.env[name]);
  names.forEach(name => delete process.env[name]);
  process.env.LOCALAPPDATA = path.join(root, 'local');
  const warnings: string[] = [];
  const stderr = mock.method(console, 'error', (message: string) => warnings.push(message));
  const home = mock.method(os, 'homedir', () => path.join(root, 'user'));
  try { await action(root, warnings); }
  finally {
    stderr.mock.restore(); home.mock.restore();
    names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; });
    await rm(root, { recursive: true, force: true });
  }
}

test('new config wins, legacy config and environment warn, precedence remains intact', async () => isolated(async (root, warnings) => {
  const old = path.join(root, 'gemini-draft.config.json'), current = path.join(root, 'ask-gemini-web.config.json');
  await writeFile(old, JSON.stringify({ home: 'legacy-data', cdp: 'http://127.0.0.1:9444' }));
  const legacy = settings({}, root);
  assert.equal(legacy.home, path.join(root, 'legacy-data'));
  assert.equal(legacy.endpoint, 'http://127.0.0.1:9444');
  assert.match(warnings.pop()!, /deprecated.*gemini-draft.config.json/);
  await writeFile(current, JSON.stringify({ home: 'data', cdp: 'http://127.0.0.1:9555' }));
  await writeFile(old, 'invalid ignored legacy file');
  assert.equal(settings({}, root).endpoint, 'http://127.0.0.1:9555');
  assert.equal(warnings.length, 0);
  process.env.GEMINI_DRAFT_HOME = path.join(root, 'old-home');
  await mkdir(process.env.GEMINI_DRAFT_HOME);
  await writeFile(path.join(process.env.GEMINI_DRAFT_HOME, 'connection.json'), '{"endpoint":"http://127.0.0.1:9444"}');
  assert.equal(settings({}, root).endpoint, 'http://127.0.0.1:9444');
  assert.ok(warnings.some(line => /GEMINI_DRAFT_HOME.*ASK_GEMINI_WEB_HOME/.test(line)));
  process.env.GEMINI_DRAFT_CDP = 'http://127.0.0.1:9555';
  assert.equal(settings({}, root).endpoint, 'http://127.0.0.1:9555');
  assert.ok(warnings.some(line => /GEMINI_DRAFT_CDP.*ASK_GEMINI_WEB_CDP/.test(line)));
  process.env.ASK_GEMINI_WEB_HOME = path.join(root, 'new-home');
  process.env.ASK_GEMINI_WEB_CDP = 'http://127.0.0.1:9444';
  warnings.length = 0;
  assert.equal(settings({}, root).home, process.env.ASK_GEMINI_WEB_HOME);
  assert.equal(settings({}, root).endpoint, process.env.ASK_GEMINI_WEB_CDP);
  assert.equal(warnings.length, 0);
  assert.equal(settings({ home: root, cdp: 'http://127.0.0.1:9555' }, root).home, root);
  assert.equal(settings({ home: root, cdp: 'http://127.0.0.1:9555' }, root).endpoint, 'http://127.0.0.1:9555');
  await writeFile(current, 'invalid new config');
  await assert.rejects(async () => settings({}, root), { code: 'INVALID_CONFIG' });
}));

test('default homes reuse legacy local/platform data without migration and prefer existing new homes', async () => isolated(async (root, warnings) => {
  for (const platform of ['linux', 'win32'] as const) {
    const project = path.join(root, platform), user = path.join(root, platform, 'user');
    await mkdir(project, { recursive: true });
    const data = platform === 'win32' ? process.env.LOCALAPPDATA! : path.join(user, '.local/share');
    const current = path.join(data, 'ask-gemini-web'), old = path.join(data, 'gemini-draft');
    assert.equal(defaultHome(project, user, platform), current);
    await mkdir(old, { recursive: true });
    assert.equal(defaultHome(project, user, platform), old);
    await mkdir(path.join(project, '.gemini-draft'));
    assert.equal(defaultHome(project, user, platform), path.join(project, '.gemini-draft'));
    await mkdir(current);
    assert.equal(defaultHome(project, user, platform), current);
    await mkdir(path.join(project, '.ask-gemini-web'));
    assert.equal(defaultHome(project, user, platform), path.join(project, '.ask-gemini-web'));
  }
  const project = path.join(root, 'selected-old-home');
  const old = path.join(project, '.gemini-draft');
  await mkdir(old, { recursive: true });
  await writeFile(path.join(old, 'connection.json'), '{"endpoint":"http://127.0.0.1:9444"}');
  assert.equal(settings({}, project).home, old);
  assert.equal(settings({}, project).endpoint, 'http://127.0.0.1:9444');
  assert.equal(settings({}, project).profile, path.join(old, 'chrome-profile'));
  assert.ok(warnings.every(line => /deprecated/.test(line)));
}));

test('Chrome environment alias warns and new variable or explicit option wins', async () => isolated(async (root, warnings) => {
  const old = path.join(root, 'old-chrome'), current = path.join(root, 'new-chrome');
  await writeFile(old, ''); await writeFile(current, '');
  process.env.GEMINI_DRAFT_CHROME = old;
  assert.equal(await findChrome(), old);
  assert.match(warnings.pop()!, /GEMINI_DRAFT_CHROME.*ASK_GEMINI_WEB_CHROME/);
  process.env.ASK_GEMINI_WEB_CHROME = current;
  assert.equal(await findChrome(), current);
  assert.equal(await findChrome(old), old);
  assert.equal(warnings.length, 0);
}));

test('canonical and legacy runners preserve machine stdout; deprecated package bin warns', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(manifest.version, '0.2.1');
  assert.equal(manifest.bin['ask-gemini-web'], 'dist/cli.js');
  assert.equal(manifest.bin['gemini-draft'], 'dist/cli.js');
  for (const runner of ['ask-gemini-web', 'gemini-draft']) {
    const r = spawnSync(process.execPath, [`skills/ask-gemini-web/scripts/${runner}.mjs`, 'run', '--stdin', '--dry-run'], {
      input: '{"prompt":"离线测试"}', encoding: 'utf8', timeout: 10000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).prompt, '离线测试');
    if (runner === 'gemini-draft') assert.match(r.stderr, /deprecated.*ask-gemini-web.mjs/);
    else assert.equal(r.stderr, '');
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ask-gemini-web-bin-'));
  try {
    const bin = path.join(dir, 'gemini-draft');
    await symlink(path.resolve('dist/cli.js'), bin);
    const r = spawnSync(process.execPath, [bin, '--compact', 'run', '--stdin', '--dry-run'], {
      input: '{"prompt":"Offline"}', encoding: 'utf8', timeout: 10000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).prompt, 'Offline');
    assert.match(r.stderr, /deprecated.*gemini-draft.*ask-gemini-web/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
