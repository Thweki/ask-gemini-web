import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { Gemini, isGoogleSorryHost } from '../src/gemini.js';
import { Connection } from '../src/browser.js';
import { waitForLogin } from '../src/login.js';
import { domPage } from './support/dom-page.js';

const sorry = await readFile(new URL('./fixtures/google-sorry.html', import.meta.url), 'utf8');

const sorryHosts = ['google.com', 'google.co.jp', 'google.com.hk', 'google.co.uk', 'google.de']
  .flatMap(host => ['', 'www.', 'ipv4.', 'ipv6.'].map(prefix => prefix + host));
const verification = ['<form id="captcha-form"></form>', '<form action="/sorry/index"></form>',
  '<iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe>'];

test('sorry host whitelist excludes account, Gemini, other services and lookalike hosts', () => {
  for (const host of sorryHosts) assert.equal(isGoogleSorryHost(host), true, host);
  for (const host of ['accounts.google.com', 'gemini.google.com', 'mail.google.com', 'docs.google.com',
    'googleusercontent.com', 'google.com.evil.example', 'www.google.co.jp.evil.example',
    'evilgoogle.com', 'www.ipv4.google.com', 'google.company', 'google.co.abc']) {
    assert.equal(isGoogleSorryHost(host), false, host);
  }
});

test('sorry URLs alone or visible verification elements on search hosts have a distinct auth error', async () => {
  for (const [url, html] of [
    ...sorryHosts.flatMap(host => ['/sorry', '/sorry/index'].map(path =>
      [`https://${host}${path}?continue=private#token`, '<body>Verification required</body>'])),
    ['https://google.com/sorry', sorry],
    ...['www.google.com', 'google.co.jp'].flatMap(host => verification.map(html => [`https://${host}/search`, html])),
    ['https://www.google.com/search', verification.join('')],
    ['https://www.google.com/search', `<div hidden>${verification[0]}</div>${verification[2]}`],
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

test('account pages are classified before any verification scan, regardless of visibility', async () => {
  for (const [path, status] of [['/signin', 'logged_out'], ['/challenge', 'challenge'],
    ['/signin/v2/challenge', 'challenge'], ['/recovery', 'challenge'], ['/sorry', 'logged_out']]) {
    for (const markup of verification) {
      for (const html of [markup, `<div hidden>${markup}</div>`, `<div style="display:none">${markup}</div>`]) {
        const { page } = domPage(html);
        page.url = () => `https://accounts.google.com${path}?login_hint=private#token`;
        page.locator = () => assert.fail('Account classification must precede all element scans');
        const gemini = new Gemini(page);
        assert.equal((await gemini.auth()).status, status);
        assert.equal((await gemini.waitForAuth(0)).status, status);
        await assert.rejects(gemini.requireLogin(), { code: `AUTH_${status.toUpperCase()}`, exitCode: 3 });
      }
    }
  }
});

test('hidden verification on search hosts and verification on unrelated hosts never report sorry blocks', async () => {
  for (const host of sorryHosts) {
    for (const markup of verification) {
      for (const html of [`<div hidden>${markup}</div>`, `<div style="display:none">${markup}</div>`]) {
        const { page } = domPage(html);
        page.url = () => `https://${host}/search`;
        assert.equal((await new Gemini(page).auth()).status, 'unknown');
      }
    }
  }
  for (const host of ['mail.google.com', 'docs.google.com', 'googleusercontent.com',
    'google.com.evil.example', 'www.google.co.jp.evil.example']) {
    const { page } = domPage(verification.join(''));
    page.url = () => `https://${host}/sorry/index`;
    assert.equal((await new Gemini(page).auth()).status, 'unknown');
  }
});

test('CLI login polling survives account reCAPTCHA and optional challenge until logged in', async () => {
  for (const hidden of [false, true]) {
    for (const challenge of [false, true]) {
      const markup = hidden ? `<div hidden>${verification.join('')}</div>` : verification.join('');
      const { page, document } = domPage(markup);
      const paths = ['/signin', ...(challenge ? ['/signin/v2/challenge'] : []), '/app'];
      let stage = 0;
      page.url = () => `https://${stage === paths.length - 1 ? 'gemini' : 'accounts'}.google.com${paths[stage]}`;
      const gemini = new Gemini(page);
      const requireLogin = mock.method(gemini, 'requireLogin');
      const statuses: string[] = [];
      const auth = await waitForLogin(gemini, 10000, auth => statuses.push(auth.status), async ms => {
        assert.equal(ms, 1000);
        assert.ok(++stage < paths.length, 'Login must finish on the Gemini page');
        if (stage === paths.length - 1) document.body.innerHTML = loggedIn;
      });
      assert.equal(auth.status, 'logged_in');
      assert.deepEqual(statuses, ['logged_out', ...(challenge ? ['challenge'] : [])]);
      assert.equal(requireLogin.mock.callCount(), 0, 'Account verification must not take the fatal sorry path');
      assert.equal((await gemini.requireLogin()).status, 'logged_in');
    }
  }
});

test('CLI login polling still fails closed on real sorry blocks and on timeout', async () => {
  const { page } = domPage('');
  page.url = () => 'https://ipv6.google.co.jp/sorry';
  const gemini = new Gemini(page);
  await assert.rejects(waitForLogin(gemini, 10000, undefined,
    async () => assert.fail('Sorry blocks must stop polling')), { code: 'AUTH_BLOCKED_SORRY', exitCode: 3 });
  await assert.rejects(waitForLogin(gemini, 0), { code: 'LOGIN_TIMEOUT', exitCode: 3 });
});

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
  for (const path of ['/app', '/sorry/index']) {
    for (const markup of [...verification,
      '<iframe title="verification" src="https://www.google.com/recaptcha/api2/anchor"></iframe>']) {
      for (const hidden of [false, true]) {
        const { page } = domPage(loggedIn + (hidden ? `<div hidden>${markup}</div>` : markup));
        page.url = () => `https://gemini.google.com${path}`;
        const gemini = new Gemini(page);
        const status = !hidden && markup.includes('title="verification"') ? 'challenge' : 'logged_in';
        assert.equal((await gemini.auth()).status, status);
        if (status === 'challenge') await assert.rejects(gemini.requireLogin(), { code: 'AUTH_CHALLENGE' });
        else assert.equal((await gemini.requireLogin()).status, 'logged_in');
      }
    }
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
