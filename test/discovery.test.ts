import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm, access, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { chromeProcessHints, Connection, devToolsEndpoint, discoverEndpoint, endpointReady, launchChrome, startChrome, processHints, parseChromeCmdline, listeningChromeEndpoints } from '../src/browser.js';
import { Gemini } from '../src/gemini.js';
import type { Settings } from '../src/config.js';

async function temporary(action: (config: Settings) => Promise<void>) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'gemini-discovery-'));
  try { await action({ home, profile: path.join(home, 'chrome-profile'), runs: path.join(home, 'runs'), endpoint: 'http://127.0.0.1:9555', endpointSource: 'default' }); }
  finally { await rm(home, { recursive: true, force: true }); }
}
const noListening = async () => [];
const noProcesses = async () => ({ profiles: [], endpoints: [] });

test('discovery probes configured endpoint, common ports, process hints and DevTools files in order', async () => temporary(async cfg => {
  const profile = path.join(cfg.home, 'fixture-profile');
  await mkdir(profile);
  await writeFile(path.join(profile, 'DevToolsActivePort'), '9444\n/devtools/browser/test\n');
  const tried: string[] = [];
  const ready = async (endpoint: string) => { tried.push(endpoint); return endpoint.endsWith(':9444'); };
  assert.equal(await discoverEndpoint(cfg, { ready, listening: noListening, profiles: [profile], processes: async () => ({ profiles: [], endpoints: ['http://127.0.0.1:9666'] }) }), 'http://127.0.0.1:9444');
  assert.deepEqual(tried, [9555, 9222, 9333, 9666, 9444].map(port => `http://127.0.0.1:${port}`));
  tried.length = 0;
  assert.equal(await discoverEndpoint({ ...cfg, endpoint: 'http://127.0.0.1:9222' }, {
    ready: async endpoint => { tried.push(endpoint); return endpoint.endsWith(':9333'); }, profiles: [], processes: noProcesses,
  }), 'http://127.0.0.1:9333');
  assert.deepEqual(tried, ['http://127.0.0.1:9222', 'http://127.0.0.1:9333']);
}));

test('IPv6 on a failed IPv4 port is still probed and reused without launching', async () => temporary(async cfg => {
  const tried: string[] = [];
  const config = { ...cfg, endpoint: 'http://127.0.0.1:9222' };
  const discover = () => discoverEndpoint(config, {
    ready: async endpoint => { tried.push(endpoint); return endpoint === 'http://[::1]:9222'; },
    commonPorts: [9222], profiles: [], processes: noProcesses,
    listening: async () => ['http://localhost:9222/', 'http://[::1]:9222/'],
  });
  assert.deepEqual(await startChrome(config, undefined, undefined, {
    ready: endpointReady, discover, launch: async () => { assert.fail('IPv6 listener must prevent launch'); },
  }), { started: false, endpoint: 'http://[::1]:9222' });
  assert.deepEqual(tried, ['http://127.0.0.1:9222', 'http://localhost:9222', 'http://[::1]:9222']);
}));

test('localhost and IPv4 are probed independently in either failure order without launching', async () => temporary(async cfg => {
  for (const [failed, working] of [['127.0.0.1', 'localhost'], ['localhost', '127.0.0.1']]) {
    const config = { ...cfg, endpoint: `http://${failed}:9222/` };
    const tried: string[] = [];
    const endpoint = `http://${working}:9222`;
    const forbidden = async (): Promise<never> => assert.fail('Reachable candidate must prevent fallback or launch');
    const discover = () => discoverEndpoint(config, {
      ready: async input => { tried.push(input); return input === endpoint; }, commonPorts: [9222], profiles: [],
      processes: async () => ({ profiles: [], endpoints: [endpoint] }), listening: forbidden,
    });
    assert.deepEqual(await startChrome(config, undefined, undefined, {
      ready: endpointReady, discover, launch: forbidden,
    }), { started: false, endpoint });
    assert.deepEqual(tried, [`http://${failed}:9222`, endpoint]);
  }
}));

test('only exact normalized origins are deduplicated across candidate sources', async () => temporary(async cfg => {
  const tried: string[] = [];
  assert.equal(await discoverEndpoint({ ...cfg, endpoint: 'http://LOCALHOST:80/' }, {
    ready: async endpoint => { tried.push(endpoint); return false; }, commonPorts: [80], profiles: [],
    processes: async () => ({ profiles: [], endpoints: ['http://localhost', 'http://127.0.0.1/', 'http://[::1]:80/'] }),
    listening: async () => ['http://localhost:80/', 'http://127.0.0.1:80/', 'http://[::1]/'],
  }), undefined);
  assert.deepEqual(tried, ['http://localhost', 'http://127.0.0.1', 'http://[::1]']);
}));

test('invalid/nonlocal candidates never reach the probe; missing and garbage DevTools files are skipped', async () => temporary(async cfg => {
  await writeFile(path.join(cfg.home, 'DevToolsActivePort'), 'http://example.com:9444\n');
  const tried: string[] = [];
  assert.equal(await discoverEndpoint({ ...cfg, endpoint: 'http://example.com:9222' }, {
    ready: async endpoint => { tried.push(endpoint); return false; }, listening: noListening, commonPorts: [], profiles: [cfg.home, cfg.profile],
    processes: async () => ({ profiles: [], endpoints: ['http://user:pass@localhost:9444', 'http://example.com:9444',
      'https://localhost:9444', 'http://localhost:9444/path', 'http://localhost:9444?token=private',
      'http://localhost:9444#token', 'not a URL'] }),
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
    ready: endpointReady,
    discover: async () => 'http://127.0.0.1:9444', launch: async () => { throw new Error('Must not launch'); },
  });
  assert.deepEqual(result, { started: false, endpoint: 'http://127.0.0.1:9444' });
  assert.deepEqual(JSON.parse(await readFile(path.join(cfg.home, 'connection.json'), 'utf8')), { endpoint: result.endpoint });
  if (process.platform !== 'win32') assert.equal((await stat(path.join(cfg.home, 'connection.json'))).mode & 0o777, 0o600);
  await assert.rejects(access(cfg.profile), { code: 'ENOENT' });
}));

test('explicit endpoints fail closed without discovery, launch or connection changes', async () => temporary(async cfg => {
  const file = path.join(cfg.home, 'connection.json');
  const original = '{"endpoint":"http://127.0.0.1:9444"}\n';
  await writeFile(file, original);
  for (const endpointSource of ['cli', 'environment'] as const) {
    const explicit = { ...cfg, endpointSource };
    let probes = 0;
    const ready = async (endpoint: string) => { probes++; assert.equal(endpoint, cfg.endpoint); return false; };
    const forbidden = async (): Promise<never> => { assert.fail('Must not discover or launch'); };
    await assert.rejects(startChrome(explicit, undefined, undefined, { ready, discover: forbidden, launch: forbidden }), error => {
      assert.equal((error as any).code, 'CDP_UNAVAILABLE');
      assert.equal((error as any).exitCode, 2);
      assert.match((error as Error).message, /9555.*Chrome.*--cdp/);
      return true;
    });
    assert.equal(probes, 1);
    assert.equal(await readFile(file, 'utf8'), original);
    await assert.rejects(discoverEndpoint(explicit, { ready, processes: forbidden }), { code: 'CDP_UNAVAILABLE' });
    assert.equal(probes, 2);
    await assert.rejects(access(cfg.profile), { code: 'ENOENT' });
  }
  const forbidden = async (): Promise<never> => { assert.fail('Must not discover or launch'); };
  assert.deepEqual(await startChrome({ ...cfg, endpointSource: 'cli' }, undefined, undefined, {
    ready: async endpoint => endpoint === cfg.endpoint, discover: forbidden, launch: forbidden,
  }), { started: false, endpoint: cfg.endpoint });
}));

test('implicit remembered, project and default endpoints still discover or launch', async () => temporary(async cfg => {
  for (const endpointSource of ['remembered', 'project', 'default'] as const) {
    for (const reachable of [false, true]) {
      let discoveries = 0, launches = 0;
      const result = await startChrome({ ...cfg, endpointSource }, undefined, undefined, {
        ready: async () => { assert.fail('Implicit endpoints use discovery'); },
        discover: async () => { discoveries++; return reachable ? 'http://127.0.0.1:9444' : undefined; },
        launch: async () => { launches++; return { started: true, endpoint: 'http://127.0.0.1:9444', profile: cfg.profile }; },
      });
      assert.equal(discoveries, 1);
      assert.equal(launches, reachable ? 0 : 1);
      assert.equal(result.started, !reachable);
      assert.equal(JSON.parse(await readFile(path.join(cfg.home, 'connection.json'), 'utf8')).endpoint, result.endpoint);
    }
  }
}));

test('macOS and Windows process hints preserve profile paths with spaces and only accept local ports', async () => {
  const mac = '/Users/test/Library/Application Support/Google/Chrome';
  const executable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  for (const profile of [mac, `"${mac}"`]) {
    const hints = await processHints('darwin', async (file, args) => {
      assert.equal(file, 'ps'); assert.deepEqual(args, ['-ax', '-o', 'command=']);
      return `${executable} --user-data-dir=${profile} --remote-debugging-port=9444\n/usr/bin/other --remote-debugging-port=9555`;
    });
    assert.deepEqual(hints, { profiles: [mac], endpoints: ['http://127.0.0.1:9444'] });
  }
  const profile = 'C:\\Users\\test\\Local Data\\Chrome';
  const command = `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir="${profile}" --remote-debugging-port=9555`;
  for (const output of [JSON.stringify(command), JSON.stringify([command, null, 'other.exe --remote-debugging-port=9222'])]) {
    assert.deepEqual(await processHints('win32', async (file, args) => {
      assert.equal(file, 'powershell.exe'); assert.ok(args.includes('-NoProfile'));
      assert.match(args.at(-1)!, /Get-CimInstance Win32_Process/);
      return output;
    }), { profiles: [profile], endpoints: ['http://127.0.0.1:9555'] });
  }
  assert.deepEqual(await processHints('win32', async () => JSON.stringify(`${command} https://gemini.google.com/app`)),
    { profiles: [profile], endpoints: ['http://127.0.0.1:9555'] });
  // A positional URL immediately after a quoted profile must not become part of it.
  for (const quote of ['"', "'"]) {
    assert.deepEqual(await processHints('win32', async () => JSON.stringify(
      `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9555 --user-data-dir=${quote}${profile}${quote} https://gemini.google.com/app`)),
    { profiles: [profile], endpoints: ['http://127.0.0.1:9555'] });
    assert.deepEqual(await processHints('darwin', async () => `${executable} --remote-debugging-port=9444 --user-data-dir=${quote}${mac}${quote} https://gemini.google.com/app`),
      { profiles: [mac], endpoints: ['http://127.0.0.1:9444'] });
  }
  assert.deepEqual(await processHints('win32', async () => JSON.stringify(`${command} --remote-debugging-address=example.com`)), { profiles: [], endpoints: [] });
  assert.deepEqual(await processHints('win32', async () => { throw new Error('PowerShell unavailable'); }), { profiles: [], endpoints: [] });
  assert.deepEqual(await processHints('win32', async () => 'invalid JSON'), { profiles: [], endpoints: [] });
});

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
  const result = await startChrome(cfg, undefined, undefined, { ready: endpointReady, discover: async () => undefined, launch });
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
        assert.match((error as Error).message, /9555.*ask-gemini-web login/);
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


test('Linux cmdline parser accepts rewritten argv, classic argv and quoted executable/profile paths', async () => {
  const real = (await readFile(new URL('./fixtures/chrome-linux-cmdline.txt', import.meta.url), 'utf8')).trim();
  assert.deepEqual(chromeProcessHints([parseChromeCmdline(real + '\0')]), {
    profiles: ['/home/box/chrome-profile/Fork-6'], endpoints: ['http://127.0.0.1:9228'],
  });
  const args = ['/opt/google/chrome/chrome', '--user-data-dir', '/tmp/Profile With Spaces',
    '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost', '--remote-debugging-port=9444', '--remote-debugging-address=127.0.0.1'];
  assert.deepEqual(parseChromeCmdline(args.join('\0') + '\0'), args);
  assert.deepEqual(chromeProcessHints([parseChromeCmdline(args.join('\0'))]), {
    profiles: ['/tmp/Profile With Spaces'], endpoints: ['http://127.0.0.1:9444'],
  });
  for (const quote of ['"', "'"]) {
    const line = `${quote}/opt/Chrome Test/chrome${quote} --proxy-bypass-list=<-loopback>;localhost --host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost --user-data-dir=${quote}/tmp/Profile With Spaces${quote} --remote-debugging-port 9555 --remote-debugging-address ::1`;
    assert.deepEqual(chromeProcessHints([parseChromeCmdline(line + '\0')]), {
      profiles: ['/tmp/Profile With Spaces'], endpoints: ['http://[::1]:9555'],
    });
  }
});

test('cmdline tokenization handles long whitespace runs in well under a second', () => {
  const line = '/tmp/chrome' + ' '.repeat(32000) + 'x';
  const start = performance.now();
  assert.deepEqual(parseChromeCmdline(line + '\0'), [line]);
  assert.ok(performance.now() - start < 500, 'Tokenization must not backtrack over whitespace');
});

test('single-segment cmdlines keep mid-path quotes literal and stop unquoted profiles at URLs or flags', () => {
  for (const separator of ['=', ' ']) {
    for (const profile of ["/tmp/Jane's Profile", '/tmp/Jane"s Profile', '/tmp/Profile']) {
      for (const tail of ['', ' https://gemini.google.com/app', ' http://localhost/start', ' -incognito']) {
        const line = `/opt/google/chrome/chrome --user-data-dir${separator}${profile}${tail} --remote-debugging-port=9444`;
        assert.deepEqual(chromeProcessHints([parseChromeCmdline(line + '\0')]), {
          profiles: [profile], endpoints: ['http://127.0.0.1:9444'],
        }, line);
      }
    }
    for (const quote of ['"', "'"]) {
      const line = `/opt/google/chrome/chrome --user-data-dir${separator}${quote}/tmp/Profile With Spaces${quote} https://gemini.google.com/app --remote-debugging-port=9444`;
      assert.deepEqual(chromeProcessHints([parseChromeCmdline(line + '\0')]), {
        profiles: ['/tmp/Profile With Spaces'], endpoints: ['http://127.0.0.1:9444'],
      });
    }
  }
});

test('NUL-separated profile values resembling flags remain intact', () => {
  const args = ['/opt/google/chrome/chrome', '--user-data-dir=/tmp/a --remote-debugging-port=9555',
    '--remote-debugging-port=9228'];
  for (const trailing of ['', '\0']) {
    const parsed = parseChromeCmdline(args.join('\0') + trailing);
    assert.deepEqual(parsed, args);
    assert.deepEqual(chromeProcessHints([parsed]), {
      profiles: ['/tmp/a --remote-debugging-port=9555'], endpoints: ['http://127.0.0.1:9228'],
    });
  }
});

test('NUL-separated profile values containing a URL remain intact', () => {
  const args = ['/opt/google/chrome/chrome', '--user-data-dir', '/tmp/Profile https://example.com',
    '--remote-debugging-port=9444'];
  assert.deepEqual(parseChromeCmdline(args.join('\0') + '\0'), args);
  assert.deepEqual(chromeProcessHints([parseChromeCmdline(args.join('\0'))]), {
    profiles: ['/tmp/Profile https://example.com'], endpoints: ['http://127.0.0.1:9444'],
  });
});

test('pure /proc discovery accepts only same-UID Chrome hints and loopback TCP listeners', async () => temporary(async cfg => {
  const proc = path.join(cfg.home, 'proc');
  const uid = 1000;
  for (const [pid, name, inodes, realUid] of [
    ['101', 'chrome', ['11', '12', '13', '14', '15'], uid], ['102', 'node', ['16'], uid],
    ['103', 'chrome', ['17'], uid + 1], ['104', 'chrome', ['18'], undefined],
    ['105', 'chromium', ['19'], undefined],
  ] as const) {
    const directory = path.join(proc, pid, 'fd');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(proc, pid, 'comm'), name + '\n');
    if (realUid !== undefined) await writeFile(path.join(proc, pid, 'status'), `Name:\t${name}\nUid:\t${realUid}\t${uid}\t${uid}\t${uid}\n`);
    if (pid === '105') await writeFile(path.join(proc, pid, 'status'), 'Uid: invalid\n');
    const port = pid === '101' ? 9444 : pid === '103' ? 9555 : 9666;
    await writeFile(path.join(proc, pid, 'cmdline'), [`/usr/bin/${name}`, `--remote-debugging-port=${port}`, `--user-data-dir=/tmp/${pid}`].join('\0') + '\0');
    for (const inode of inodes) await symlink(`socket:[${inode}]`, path.join(directory, inode));
  }
  await mkdir(path.join(proc, 'net'));
  const row = (address: string, port: number, inode: string, state = '0A') =>
    `0: ${address}:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 ${state} 0:0 0:0 0 1000 0 ${inode}`;
  const loopback = os.endianness() === 'LE' ? '0100007F' : '7F000001';
  const ipv6 = os.endianness() === 'LE' ? '00000000000000000000000001000000' : '00000000000000000000000000000001';
  await writeFile(path.join(proc, 'net/tcp'), ['header', row(loopback, 9444, '11'), row('00000000', 9555, '12'),
    row('0200000A', 9666, '13'), row(loopback, 9777, '14', '01'), row(loopback, 9888, '16'),
    row(loopback, 9555, '17'), row(loopback, 9666, '18'), row(loopback, 9777, '19')].join('\n'));
  await writeFile(path.join(proc, 'net/tcp6'), ['header', row(ipv6, 9999, '15'), row('00000000000000000000000000000000', 9222, '12')].join('\n'));
  assert.deepEqual(await listeningChromeEndpoints('linux', proc, uid), ['http://127.0.0.1:9444', 'http://[::1]:9999']);
  assert.deepEqual(await listeningChromeEndpoints('linux', path.join(proc, 'missing')), []);
  assert.deepEqual(await listeningChromeEndpoints('darwin', proc), []);
  const noCommand = async (): Promise<never> => { assert.fail('Linux discovery must only read /proc'); };
  assert.deepEqual(await processHints('linux', noCommand, proc, uid), {
    profiles: ['/tmp/101'], endpoints: ['http://127.0.0.1:9444'],
  });
  assert.deepEqual(await processHints('linux', noCommand, path.join(proc, 'missing'), uid), { profiles: [], endpoints: [] });
}));

test('listener fallback follows process hints, skips tried origins and remote endpoints, and precedes launch', async () => temporary(async cfg => {
  const tried: string[] = [];
  const discover = () => discoverEndpoint(cfg, {
    ready: async endpoint => { tried.push(endpoint); return endpoint.endsWith(':9444'); }, profiles: [],
    processes: async () => ({ profiles: [], endpoints: ['http://127.0.0.1:9666'] }),
    listening: async () => {
      assert.deepEqual(tried, [9555, 9222, 9333, 9666].map(port => `http://127.0.0.1:${port}`));
      return ['http://localhost:9222', 'http://127.0.0.1:9333', 'http://localhost:9666', 'http://remote.example:9777', 'http://127.0.0.1:9444'];
    },
  });
  const result = await startChrome(cfg, undefined, undefined, {
    ready: endpointReady, discover, launch: async () => { assert.fail('Ready listening endpoint must prevent launch'); },
  });
  assert.deepEqual(result, { started: false, endpoint: 'http://127.0.0.1:9444' });
  assert.deepEqual(tried, [...[9555, 9222, 9333, 9666].map(port => `http://127.0.0.1:${port}`),
    'http://localhost:9222', 'http://localhost:9666', 'http://127.0.0.1:9444']);
}));
