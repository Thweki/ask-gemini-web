import { access, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { DraftError } from './errors.js';
import type { Settings } from './config.js';

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
  const candidates = override ? [path.resolve(override)] : process.env.GEMINI_DRAFT_CHROME
    ? [path.resolve(process.env.GEMINI_DRAFT_CHROME)]
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
    const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
    if (!response.ok) return false;
    const data = await response.json() as { webSocketDebuggerUrl?: string };
    if (!data.webSocketDebuggerUrl) return false;
    const websocket = new URL(data.webSocketDebuggerUrl);
    const host = new URL(endpoint).hostname;
    return websocket.protocol === 'ws:' && [host, '127.0.0.1', 'localhost', '[::1]'].includes(websocket.hostname);
  } catch { return false; }
}

export async function startChrome(config: Settings, executable?: string, initialUrl = GEMINI) {
  const remember = async () => {
    await mkdir(config.home, { recursive: true, mode: 0o700 });
    await writeFile(path.join(config.home, 'connection.json'), JSON.stringify({ endpoint: config.endpoint }, null, 2) + '\n', { mode: 0o600 });
  };
  if (await endpointReady(config.endpoint)) { await remember(); return { started: false, endpoint: config.endpoint }; }
  const chrome = await findChrome(executable);
  // Always use our dedicated profile, never copy or attach the daily Chrome profile.
  await mkdir(config.profile, { recursive: true, mode: 0o700 });
  const port = new URL(config.endpoint).port || '80';
  const child = spawn(chrome, [
    '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
    `--user-data-dir=${config.profile}`, '--no-first-run', '--no-default-browser-check', initialUrl,
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  let failure: Error | undefined;
  child.on('error', error => { failure = error; });
  child.unref();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (failure) throw new DraftError('CHROME_START_FAILED', failure.message);
    if (await endpointReady(config.endpoint)) { await remember(); return { started: true, endpoint: config.endpoint, profile: config.profile }; }
    await pause(300);
  }
  throw new DraftError('CDP_UNAVAILABLE', 'Chrome 调试端口未就绪。请关闭该专用 Chrome 后重试，或检查端口是否冲突。');
}

export class Connection {
  private startupUrl?: string;
  private constructor(public browser: Browser, public context: BrowserContext) {}
  static async ensure(config: Settings) {
    const startupUrl = `about:blank#gemini-draft-${randomUUID()}`;
    const { started } = await startChrome(config, undefined, startupUrl);
    const connection = await Connection.open(config);
    if (started) connection.startupUrl = startupUrl;
    return connection;
  }
  static async open(config: Settings) {
    if (!await endpointReady(config.endpoint)) {
      throw new DraftError('CDP_UNAVAILABLE', '无法连接 Chrome。先运行 gemini-draft browser start 或 gemini-draft login。', 2);
    }
    try {
      const browser = await chromium.connectOverCDP(config.endpoint, { noDefaults: true, timeout: 10000 });
      const context = browser.contexts()[0];
      if (!context) { await browser.close(); throw new Error('Chrome 没有默认 context'); }
      return new Connection(browser, context);
    } catch (error) {
      throw new DraftError('CDP_CONNECT_FAILED', `CDP 连接失败：${error instanceof Error ? error.message : error}`);
    }
  }
  async page(fresh = false): Promise<Page> {
    if (!fresh) {
      const existing = this.context.pages().filter(page => isGemini(page.url()));
      if (existing.length) { await existing.at(-1)!.bringToFront(); return existing.at(-1)!; }
    }
    return this.newTaskPage();
  }
  async newTaskPage(url = GEMINI): Promise<Page> {
    const startup = this.context.pages().find(page => page.url() === this.startupUrl);
    this.startupUrl = undefined;
    const page = startup ?? await this.context.newPage();
    await page.bringToFront();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    return page;
  }
  async disconnect() {
    // For a connected Browser, close() disconnects; it does not terminate Chrome.
    await this.browser.close();
  }
}
