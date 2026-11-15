import { access, chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { createServer } from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { DraftError } from './errors.js';
import { localEndpoint, type Settings } from './config.js';
import { environment } from './deprecation.js';

export const GEMINI = 'https://gemini.google.com/app';
export const shutdown = new AbortController();
export const pause = async (ms: number) => {
  shutdown.signal.throwIfAborted();
  await new Promise<void>(resolve => setTimeout(resolve, ms));
  shutdown.signal.throwIfAborted();
};
export function isGemini(url: string) {
  try { return new URL(url).origin === 'https://gemini.google.com'; } catch { return false; }
}

export async function findChrome(override?: string): Promise<string> {
  const configured = override || environment('CHROME');
  const candidates = configured ? [path.resolve(configured)]
    : process.platform === 'win32' ? [
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    ] : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* Try next installation. */ }
  }
  throw new DraftError('CHROME_NOT_FOUND', '找不到 Chrome，请使用 --chrome 指定可执行文件路径。');
}

export async function endpointReady(endpoint: string) {
  try {
    endpoint = localEndpoint(endpoint);
    const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
    if (!response.ok) return false;
    const data = await response.json() as { webSocketDebuggerUrl?: string };
    if (!data.webSocketDebuggerUrl) return false;
    const websocket = new URL(data.webSocketDebuggerUrl);
    const host = new URL(endpoint).hostname;
    return websocket.protocol === 'ws:' && !websocket.username && !websocket.password
      && [host, '127.0.0.1', 'localhost', '[::1]'].includes(websocket.hostname);
  } catch { return false; }
}

export function devToolsEndpoint(contents: string): string | undefined {
  const first = contents.split(/\r?\n/)[0];
  if (!/^\d+$/.test(first)) return;
  const port = Number(first);
  if (port < 1 || port > 65535) return;
  return `http://127.0.0.1:${port}`;
}

export function chromeProcessHints(commandLines: string[][], platform = process.platform) {
  const profiles: string[] = [], endpoints: string[] = [];
  for (const args of commandLines) {
    if (!/chrome|chromium/i.test(path.basename(args[0] || ''))) continue;
    const flag = (name: string) => {
      const value = args.find(arg => arg.startsWith(`${name}=`));
      return value ? value.slice(name.length + 1) : args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
    };
    const address = flag('--remote-debugging-address');
    if (address && !['127.0.0.1', 'localhost', '::1'].includes(address)) continue;
    const profile = flag('--user-data-dir');
    if (profile && (platform === 'win32' ? path.win32 : path).isAbsolute(profile)) profiles.push(profile);
    const port = flag('--remote-debugging-port');
    const endpoint = port && devToolsEndpoint(port);
    if (endpoint) endpoints.push(address === '::1' ? endpoint.replace('127.0.0.1', '[::1]') : address === 'localhost' ? endpoint.replace('127.0.0.1', 'localhost') : endpoint);
  }
  return { profiles, endpoints };
}

function chromeCommandLine(line: string) {
  const match = line.trim().match(/^"?(.*?[\\/](?:Google Chrome|Chromium|chrome\.exe|chromium\.exe))"?(?=\s|$)(.*)$/i);
  if (!match) return [];
  // ps can print unquoted paths with spaces. Each relevant value ends at the
  // next switch; quoted Windows command lines also retain their full paths.
  const args = [match[1]];
  for (const flag of ['--user-data-dir', '--remote-debugging-address', '--remote-debugging-port']) {
    const boundary = flag === '--user-data-dir' ? '(?=\\s+"?--|$)' : '(?=\\s|$)';
    const value = match[2].match(new RegExp(`(?:^|\\s)"?${flag}(?:=|\\s+)(?:"([^"]*)"|'([^']*)'|(.+?))${boundary}`));
    if (value) args.push(`${flag}=${(value[1] ?? value[2] ?? value[3]).replace(/"$/, '').trim()}`);
  }
  return args;
}

export async function processHints(platform = process.platform,
  command = async (file: string, args: string[]) => (await promisify(execFile)(file, args, { timeout: 2000, maxBuffer: 4 * 1024 * 1024 })).stdout) {
  let lines: string[][] = [];
  if (platform === 'linux') {
    const pids = await readdir('/proc').catch(() => [] as string[]);
    lines = await Promise.all(pids.filter(pid => /^\d+$/.test(pid)).map(async pid => {
      const name = await readFile(`/proc/${pid}/comm`, 'utf8').catch(() => '');
      if (!/chrome|chromium/i.test(name)) return [];
      const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
      return command.split('\0').filter(Boolean);
    }));
  } else if (platform === 'darwin') {
    const output = await command('ps', ['-ax', '-o', 'command=']).catch(() => '');
    lines = output.split('\n').map(chromeCommandLine);
  } else if (platform === 'win32') {
    const output = await command('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; @(Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe' OR Name = 'chromium.exe'\" | Select-Object -ExpandProperty CommandLine) | ConvertTo-Json -Compress",
    ]).catch(() => '');
    try {
      const commands: unknown = JSON.parse(output.replace(/^\uFEFF/, ''));
      lines = (Array.isArray(commands) ? commands : [commands]).filter((line): line is string => typeof line === 'string').map(chromeCommandLine);
    } catch { /* Process inspection is optional; discovery can use profile files. */ }
  }
  return chromeProcessHints(lines, platform);
}

export function profileLocations(config: Settings, platform = process.platform, home = os.homedir()) {
  const base = platform === 'win32' ? process.env.LOCALAPPDATA || home
    : platform === 'darwin' ? path.join(home, 'Library/Application Support') : process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const names = platform === 'win32' ? ['Google/Chrome/User Data', 'Google/Chrome Beta/User Data', 'Chromium/User Data']
    : platform === 'darwin' ? ['Google/Chrome', 'Google/Chrome Beta', 'Chromium'] : ['google-chrome', 'google-chrome-beta', 'google-chrome-unstable', 'chromium', 'chromium-browser'];
  return [config.profile, ...names.map(name => path.join(base, name)),
    ...(platform === 'linux' ? [path.join(home, 'snap/chromium/common/chromium')] : [])];
}

export type DiscoveryOptions = {
  ready?: typeof endpointReady;
  commonPorts?: number[];
  profiles?: string[];
  processes?: () => Promise<ReturnType<typeof chromeProcessHints>>;
};

export async function discoverEndpoint(config: Settings, options: DiscoveryOptions = {}) {
  const tried = new Set<string>();
  const probe = async (input: string) => {
    let endpoint: string;
    try { endpoint = localEndpoint(input); } catch { return; }
    const key = endpoint;
    if (tried.has(key)) return;
    tried.add(key);
    return await (options.ready || endpointReady)(endpoint) ? endpoint : undefined;
  };
  const configured = await probe(config.endpoint);
  if (configured) return configured;
  if (explicitEndpoint(config)) throw unavailableEndpoint(config);
  for (const input of (options.commonPorts || [9222, 9333]).map(port => `http://127.0.0.1:${port}`)) {
    const endpoint = await probe(input);
    if (endpoint) return endpoint;
  }
  const hints = await (options.processes || processHints)();
  for (const input of hints.endpoints) {
    const endpoint = await probe(input);
    if (endpoint) return endpoint;
  }
  for (const profile of new Set([...(options.profiles || profileLocations(config)), ...hints.profiles])) {
    const contents = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
    const input = devToolsEndpoint(contents);
    if (!input) continue;
    const endpoint = await probe(input);
    if (endpoint) return endpoint;
  }
}

function explicitEndpoint(config: Settings) {
  return config.endpointSource === 'cli' || config.endpointSource === 'environment';
}

function unavailableEndpoint(config: Settings) {
  return new DraftError('CDP_UNAVAILABLE', `无法连接显式 CDP 地址 ${config.endpoint}。请启动该地址上的 Chrome，或去掉 --cdp / 清除 CDP 环境变量以使用自动发现。`, 2);
}

function availablePort(port: number) {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = (server.address() as { port: number }).port;
      server.close(error => error ? reject(error) : resolve(actual));
    });
  });
}

export async function launchPort(endpoint: string, available = availablePort) {
  const desired = Number(new URL(localEndpoint(endpoint)).port || 80);
  try { return await available(desired); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    return available(0);
  }
}

export async function launchChrome(config: Settings, executable?: string, initialUrl = GEMINI,
  dependencies = { findChrome, spawn, ready: endpointReady, launchPort }) {
  const chrome = await dependencies.findChrome(executable);
  const port = await dependencies.launchPort(config.endpoint);
  const endpoint = `http://127.0.0.1:${port}`;
  await mkdir(config.profile, { recursive: true, mode: 0o700 });
  const child = dependencies.spawn(chrome, [
    '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
    `--user-data-dir=${config.profile}`, '--no-first-run', '--no-default-browser-check', initialUrl,
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  let failure: Error | undefined;
  child.on('error', error => { failure = error; });
  child.unref();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (failure) throw new DraftError('CHROME_START_FAILED', failure.message);
    if (child.exitCode !== null && child.exitCode !== undefined) break;
    if (await dependencies.ready(endpoint)) return { started: true, endpoint, profile: config.profile };
    await pause(300);
  }
  throw new DraftError('CDP_UNAVAILABLE', `Chrome 调试端口未就绪：${endpoint}。请检查专用 profile 或端口冲突。`);
}

export async function startChrome(config: Settings, executable?: string, initialUrl = GEMINI,
  dependencies = { discover: discoverEndpoint, launch: launchChrome, ready: endpointReady }) {
  let endpoint: string | undefined;
  if (explicitEndpoint(config)) {
    if (!await dependencies.ready(config.endpoint)) throw unavailableEndpoint(config);
    endpoint = config.endpoint;
  } else endpoint = await dependencies.discover(config);
  const result = endpoint ? { started: false, endpoint } : await dependencies.launch(config, executable, initialUrl);
  await mkdir(config.home, { recursive: true, mode: 0o700 });
  const file = path.join(config.home, 'connection.json');
  await writeFile(file, JSON.stringify({ endpoint: result.endpoint }, null, 2) + '\n', { mode: 0o600 });
  await chmod(file, 0o600);
  return result;
}

const endpoints = new WeakMap<Page, string>();
export const pageEndpoint = (page: Page) => endpoints.get(page);

export class Connection {
  private startupUrl?: string;
  private pages = new Set<Page>();
  private currentPage?: Page;
  private constructor(public browser: Browser, public context: BrowserContext,
    public endpoint: string, public started = false) {}
  get browserInfo() { return { started: this.started, endpoint: this.endpoint }; }
  static async ensure(config: Settings, executable?: string) {
    const startupUrl = `about:blank#ask-gemini-web-${randomUUID()}`;
    const { started, endpoint } = await startChrome(config, executable, startupUrl);
    const connection = await Connection.open({ ...config, endpoint });
    connection.started = started;
    if (started) {
      connection.startupUrl = startupUrl;
      const startup = connection.context.pages().find(page => page.url() === startupUrl);
      if (startup) connection.pages.add(startup);
    }
    return connection;
  }
  static async open(config: Settings) {
    if (!await endpointReady(config.endpoint)) {
      throw new DraftError('CDP_UNAVAILABLE', '无法连接 Chrome。先运行 ask-gemini-web browser start 或 ask-gemini-web login。', 2);
    }
    try {
      const browser = await chromium.connectOverCDP(config.endpoint, { noDefaults: true, timeout: 10000 });
      const context = browser.contexts()[0];
      if (!context) { await browser.close(); throw new Error('Chrome 没有默认 context'); }
      return new Connection(browser, context, config.endpoint);
    } catch (error) {
      throw new DraftError('CDP_CONNECT_FAILED', `CDP 连接失败（${config.endpoint}）：${error instanceof Error ? error.message : error}`);
    }
  }
  async page(fresh = false): Promise<Page> {
    if (!fresh && this.currentPage && !this.currentPage.isClosed()) return this.currentPage;
    this.currentPage = await this.newTaskPage();
    return this.currentPage;
  }
  async newTaskPage(url = GEMINI): Promise<Page> {
    const startup = this.context.pages().find(page => page.url() === this.startupUrl);
    this.startupUrl = undefined;
    const page = startup ?? await this.context.newPage();
    this.pages.add(page);
    endpoints.set(page, this.endpoint);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    return page;
  }
  async disconnect(keepPages = false) {
    try {
      if (!keepPages) await Promise.all([...this.pages].map(page => page.close().catch(() => {})));
    } finally {
      this.pages.clear();
      // A CDP Browser.close() disconnects without terminating Chrome.
      await this.browser.close();
    }
  }
}
