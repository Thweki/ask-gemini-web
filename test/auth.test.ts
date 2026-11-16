import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { Gemini } from '../src/gemini.js';
import { Connection } from '../src/browser.js';
import { domPage } from './support/dom-page.js';

const sorry = await readFile(new URL('./fixtures/google-sorry.html', import.meta.url), 'utf8');

test('sorry URL or verification elements on non-Gemini Google hosts have a distinct auth error', async () => {
  for (const [url, html] of [
    ['https://www.google.com/sorry/index?continue=private#token', '<body>Verification required</body>'],
    ['https://google.com/sorry', sorry],
    ['https://accounts.google.com/signin', '<form id="captcha-form"></form>'],
    ['https://www.google.com/search', '<div id="captcha-form"></div>'],
    ['https://accounts.google.com/signin', '<form action="/sorry/index"></form>'],
    ['https://www.google.com/search', '<iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe>'],
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

const loggedIn = '<button aria-label="Google Account">Account</button><textarea aria-label="Prompt"></textarea>';

test('traffic text alone never reports a sorry block on Google hosts', async () => {
  for (const [url, html, status] of [
    ['https://gemini.google.com/app', sorry, 'unknown'],
    ['https://gemini.google.com/app', '<body>异常流量</body>', 'unknown'],
    ['https://accounts.google.com/signin', '<body>可疑流量</body>', 'logged_out'],
    ['https://www.google.com/search', '<body>unusual traffic</body>', 'unknown'],
    ['https://google.com/sorry-not-a-page', '<body>異常流量</body>', 'unknown'],
  ]) {
    const { page } = domPage(html);
    page.url = () => url;
    const gemini = new Gemini(page);
    assert.equal((await gemini.auth()).status, status);
    // Avoid the normal unknown-page loading wait while checking the real auth path.
    const waitForAuth = gemini.waitForAuth.bind(gemini);
    gemini.waitForAuth = () => waitForAuth(0);
    await assert.rejects(gemini.requireLogin(), { code: `AUTH_${status.toUpperCase()}` });
  }
});

test('Gemini traffic phrases in sidebar, title, composer or hidden content remain logged in during collection', async () => {
  for (const phrase of ['unusual traffic', '异常流量', '可疑流量', '異常流量']) {
    for (const markup of [
      `<nav><a>${phrase}</a></nav>`, `<h1>${phrase}</h1>`,
      `<textarea aria-label="Draft">${phrase}</textarea>`, `<div hidden>${phrase}</div>`,
    ]) {
      // Use the content's textarea as the single composer when testing input text.
      const { page, document } = domPage(loggedIn + markup);
      if (markup.startsWith('<textarea')) document.querySelector('[aria-label="Prompt"]')!.remove();
      page.url = () => 'https://gemini.google.com/app';
      const gemini = new Gemini(page);
      assert.equal((await gemini.auth()).status, 'logged_in');
      assert.equal((await gemini.requireLogin()).status, 'logged_in');
      // Collection rechecks auth on the same page after the response starts.
      const response = document.createElement('model-response');
      response.textContent = phrase;
      document.body.appendChild(response);
      assert.equal((await gemini.auth()).status, 'logged_in');
      assert.equal((await gemini.requireLogin()).status, 'logged_in');
    }
  }
});

test('traffic phrases introduced after submission do not interrupt collection auth checks', async () => {
  const { page, document } = domPage(loggedIn);
  page.url = () => 'https://gemini.google.com/app';
  const gemini = new Gemini(page);
  await gemini.requireLogin();
  for (const phrase of ['unusual traffic', '异常流量', '可疑流量', '異常流量']) {
    document.querySelector('textarea')!.textContent = phrase;
    const title = document.createElement('h1');
    title.textContent = phrase;
    document.body.appendChild(title);
    assert.equal((await gemini.auth()).status, 'logged_in');
    assert.equal((await gemini.requireLogin()).status, 'logged_in');
  }
});

test('Gemini verification elements never report a sorry block', async () => {
  for (const markup of ['<form id="captcha-form"></form>', '<form action="/sorry/index"></form>',
    '<iframe title="verification" src="https://www.google.com/recaptcha/api2/anchor"></iframe>']) {
    const { page } = domPage(loggedIn + markup);
    page.url = () => 'https://gemini.google.com/app';
    const gemini = new Gemini(page);
    const status = markup.startsWith('<iframe') ? 'challenge' : 'logged_in';
    assert.equal((await gemini.auth()).status, status);
    if (status === 'challenge') await assert.rejects(gemini.requireLogin(), { code: 'AUTH_CHALLENGE' });
    else assert.equal((await gemini.requireLogin()).status, 'logged_in');
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
