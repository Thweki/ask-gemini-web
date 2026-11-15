import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { chromeProcessHints, Connection, devToolsEndpoint, discoverEndpoint, endpointReady, launchChrome, startChrome } from '../src/browser.js';
import { Gemini } from '../src/gemini.js';
import type { Settings } from '../src/config.js';

async function temporary(action: (config: Settings) => Promise<void>) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'gemini-discovery-'));
  try { await action({ home, profile: path.join(home, 'chrome-profile'), runs: path.join(home, 'runs'), endpoint: 'http://127.0.0.1:9555' }); }
  finally { await rm(home, { recursive: true, force: true }); }
}
const noProcesses = async () => ({ profiles: [], endpoints: [] });

test('discovery probes configured endpoint, common ports, process hints and DevTools files in order', async () => temporary(async cfg => {
  const profile = path.join(cfg.home, 'fixture-profile');
  await mkdir(profile);
  await writeFile(path.join(profile, 'DevToolsActivePort'), '9444\n/devtools/browser/test\n');
  const tried: string[] = [];
  const ready = async (endpoint: string) => { tried.push(endpoint); return endpoint.endsWith(':9444'); };
  assert.equal(await discoverEndpoint(cfg, { ready, profiles: [profile], processes: async () => ({ profiles: [], endpoints: ['http://127.0.0.1:9666'] }) }), 'http://127.0.0.1:9444');
  assert.deepEqual(tried, [9555, 9222, 9333, 9666, 9444].map(port => `http://127.0.0.1:${port}`));
  tried.length = 0;
  assert.equal(await discoverEndpoint({ ...cfg, endpoint: 'http://127.0.0.1:9222' }, {
    ready: async endpoint => { tried.push(endpoint); return endpoint.endsWith(':9333'); }, profiles: [], processes: noProcesses,
  }), 'http://127.0.0.1:9333');
  assert.deepEqual(tried, ['http://127.0.0.1:9222', 'http://127.0.0.1:9333']);
}));

test('invalid/nonlocal candidates never reach the probe; missing and garbage DevTools files are skipped', async () => temporary(async cfg => {
  await writeFile(path.join(cfg.home, 'DevToolsActivePort'), 'http://example.com:9444\n');
  const tried: string[] = [];
  assert.equal(await discoverEndpoint({ ...cfg, endpoint: 'http://example.com:9222' }, {
    ready: async endpoint => { tried.push(endpoint); return false; }, commonPorts: [], profiles: [cfg.home, cfg.profile],
    processes: async () => ({ profiles: [], endpoints: ['http://user:pass@localhost:9444', 'http://example.com:9444'] }),
  }), undefined);
  assert.deepEqual(tried, []);
  for (const value of ['', 'garbage', '0', '65536', '-1', '9444x', 'http://localhost:9444']) assert.equal(devToolsEndpoint(value), undefined);
  assert.equal(devToolsEndpoint('9444\r\n/devtools/browser/test'), 'http://127.0.0.1:9444');
  assert.deepEqual(chromeProcessHints([
    ['/usr/bin/google-chrome', '--user-data-dir=/tmp/test-profile', '--remote-debugging-port=9444'],
    ['/usr/bin/chromium', '--remote-debugging-address=example.com', '--remote-debugging-port=9555'],
    ['/bin/other', '--remote-debugging-port=9666'],
    ['/usr/bin/chromium', '--remote-debugging-address', '::1', '--remote-debugging-port', '9777'],
  ]), { profiles: ['/tmp/test-profile'], endpoints: ['http://127.0.0.1:9444', 'http://[::1]:9777'] });
}));

test('endpointReady rejects remote HTTP before making any request and remote websocket hosts', async () => {
  let requests = 0;
  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    requests++;
    return { ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://example.com/devtools/browser/test' }) };
  });
  try {
    assert.equal(await endpointReady('http://example.com:9444'), false);
    assert.equal(requests, 0);
    assert.equal(await endpointReady('http://127.0.0.1:9444'), false);
  } finally { fetchMock.mock.restore(); }
});

test('reachable browser is remembered privately without creating a profile or launching', async () => temporary(async cfg => {
  const result = await startChrome(cfg, undefined, undefined, {
    discover: async () => 'http://127.0.0.1:9444', launch: async () => { throw new Error('Must not launch'); },
  });
  assert.deepEqual(result, { started: false, endpoint: 'http://127.0.0.1:9444' });
  assert.deepEqual(JSON.parse(await readFile(path.join(cfg.home, 'connection.json'), 'utf8')), { endpoint: result.endpoint });
  if (process.platform !== 'win32') assert.equal((await stat(path.join(cfg.home, 'connection.json'))).mode & 0o777, 0o600);
  await assert.rejects(access(cfg.profile), { code: 'ENOENT' });
}));

test('no reachable candidate launches only the dedicated profile and records the actual free endpoint', async () => temporary(async cfg => {
  let spawned = 0;
  const launch = async () => launchChrome(cfg, '/mock/chrome', 'about:blank', {
    findChrome: async () => '/mock/chrome', launchPort: async () => 9444, ready: async () => true,
    spawn: ((_command: string, args: string[]) => {
      spawned++;
      assert.ok(args.includes(`--user-data-dir=${cfg.profile}`));
      assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
      assert.ok(args.includes('--remote-debugging-port=9444'));
      return { on() {}, unref() {}, exitCode: null };
    }) as any,
  });
  const result = await startChrome(cfg, undefined, undefined, { discover: async () => undefined, launch });
  assert.equal(result.started, true);
  assert.equal(spawned, 1);
  assert.equal(result.endpoint, 'http://127.0.0.1:9444');
  await access(cfg.profile);
  assert.equal(JSON.parse(await readFile(path.join(cfg.home, 'connection.json'), 'utf8')).endpoint, result.endpoint);
}));

test('attached connections own new tabs only; signed-out auth reports endpoint without launching', async () => temporary(async cfg => {
  let disconnected = false, opened = 0;
  let originalTouches = 0;
  const original = { url: () => 'https://gemini.google.com/app/oracle', close: async () => { originalTouches++; },
    goto: async () => { originalTouches++; }, bringToFront: async () => { originalTouches++; } };
  const ours = { goto: async () => {}, isClosed: () => false, close: async () => { opened--; }, setDefaultTimeout() {} };
  const context = { pages: () => [original], newPage: async () => { opened++; return ours; } } as unknown as BrowserContext;
  const browser = { contexts: () => [context], close: async () => { disconnected = true; } } as unknown as Browser;
  const fetchMock = mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/mock' }) }));
  const connectMock = mock.method(chromium, 'connectOverCDP', async () => browser);
  const authMock = mock.method(Gemini.prototype, 'waitForAuth', async () => ({ status: 'logged_out', reason: 'Sign in', url: 'https://gemini.google.com/app' } as const));
  try {
    const connection = await Connection.ensure(cfg);
    try {
      assert.equal(connection.started, false);
      const page = await connection.page();
      assert.notEqual(page, original);
      assert.equal(await connection.page(), page);
      assert.equal(opened, 1);
      await assert.rejects(new Gemini(page).requireLogin(), error => {
        assert.equal((error as any).code, 'AUTH_LOGGED_OUT');
        assert.equal((error as any).exitCode, 3);
        assert.match((error as Error).message, /9555.*gemini-draft login/);
        return true;
      });
      await assert.rejects(access(cfg.profile), { code: 'ENOENT' });
      authMock.mock.restore();
      const loggedIn = mock.method(Gemini.prototype, 'waitForAuth', async () => ({ status: 'logged_in', reason: 'Account and composer', url: 'https://gemini.google.com/app' } as const));
      try { assert.equal((await new Gemini(page).requireLogin()).status, 'logged_in'); }
      finally { loggedIn.mock.restore(); }
    } finally { await connection.disconnect(); }
    assert.equal(opened, 0);
    assert.equal(disconnected, true);
    assert.equal(originalTouches, 0);
    assert.equal(JSON.parse(await readFile(path.join(cfg.home, 'connection.json'), 'utf8')).endpoint, cfg.endpoint);
  } finally { fetchMock.mock.restore(); connectMock.mock.restore(); authMock.mock.restore(); }
}));

test('busy launch port selects a free loopback port; unrelated binding errors are surfaced', async () => {
  const { launchPort } = await import('../src/browser.js');
  const tried: number[] = [];
  assert.equal(await launchPort('http://127.0.0.1:9555', async port => {
    tried.push(port);
    if (port) throw Object.assign(new Error('busy'), { code: 'EADDRINUSE' });
    return 9444;
  }), 9444);
  assert.deepEqual(tried, [9555, 0]);
  await assert.rejects(launchPort('http://127.0.0.1:9555', async () => {
    throw Object.assign(new Error('denied'), { code: 'EPERM' });
  }), { code: 'EPERM' });
});
