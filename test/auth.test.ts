import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { Gemini } from '../src/gemini.js';
import { Connection } from '../src/browser.js';
import { domPage } from './support/dom-page.js';

const sorry = await readFile(new URL('./fixtures/google-sorry.html', import.meta.url), 'utf8');

test('sorry URL or unusual-traffic copy has a distinct auth error without waiting or interacting', async () => {
  for (const [url, html] of [
    ['https://www.google.com/sorry/index?continue=private#token', '<body>Verification required</body>'],
    ['https://google.com/sorry', sorry],
    ['https://gemini.google.com/app', sorry],
    ['https://accounts.google.com/signin', '<body>可疑流量</body>'],
    ['https://gemini.google.com/app', '<body>异常流量</body>'],
  ]) {
    const { page } = domPage(html);
    page.url = () => url;
    const gemini = new Gemini(page);
    assert.equal((await gemini.auth()).status, 'blocked_sorry');
    assert.equal((await gemini.waitForAuth(0)).status, 'blocked_sorry');
    assert.ok(!(await gemini.auth()).url.includes('private'));
    await assert.rejects(gemini.requireLogin(), error => {
      assert.equal((error as any).code, 'AUTH_BLOCKED_SORRY');
      assert.equal((error as any).exitCode, 3);
      assert.match((error as Error).message, /该浏览器手动完成验证.*已经登录的浏览器/);
      return true;
    });
  }
});

test('blocked verification task page survives normal disconnect', async () => {
  const { page } = domPage(sorry);
  let closed = 0, disconnected = 0;
  page.url = () => 'https://www.google.com/sorry/index';
  page.goto = async () => null;
  page.close = async () => { closed++; };
  const original = { url: () => 'https://gemini.google.com/app/user', close: async () => assert.fail('User tab must stay open') };
  const context = { pages: () => [original], newPage: async () => page } as unknown as BrowserContext;
  const browser = { contexts: () => [context], close: async () => { disconnected++; } } as unknown as Browser;
  const fetchMock = mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/mock' }) }));
  const connectMock = mock.method(chromium, 'connectOverCDP', async () => browser);
  try {
    const connection = await Connection.open({ home: '/unused', profile: '/unused/profile', runs: '/unused/runs', endpoint: 'http://127.0.0.1:9444', endpointSource: 'cli' });
    await new Gemini(await connection.newTaskPage()).waitForAuth();
    await connection.disconnect();
    assert.equal(closed, 0);
    assert.equal(disconnected, 1);
  } finally { fetchMock.mock.restore(); connectMock.mock.restore(); }
});
