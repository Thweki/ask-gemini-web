import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { readFile, mkdtemp, writeFile, readdir, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { Gemini } from '../src/gemini.js';
import { Connection, endpointReady, GEMINI } from '../src/browser.js';
import { compileJob, execute, loadJob, resume, RunStore } from '../src/jobs.js';
import { settings } from '../src/config.js';
import { previewSelection } from '../src/selection.js';

let browser: Browser;
const fixture = await readFile(new URL('./fixtures/gemini.html', import.meta.url), 'utf8');
before(async () => {
  // Headless temporary profile over a private pipe; all network requests are intercepted.
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => { await browser?.close(); });

async function context(html = fixture) {
  const ctx = await browser.newContext();
  await ctx.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  return ctx;
}
async function page(ctx: BrowserContext, url = GEMINI) {
  const page = await ctx.newPage(); await page.goto(url); return page;
}
function factory(ctx: BrowserContext) {
  return async () => ({ browser, context: ctx, newTaskPage: (url?: string) => page(ctx, url), disconnect: async () => {} }) as Connection;
}

test('auth requires account evidence, rejects anonymous composer, recognizes consent/challenge', async () => {
  const ctx = await context();
  try {
    const p = await page(ctx); const gemini = new Gemini(p);
    assert.equal((await gemini.auth()).status, 'logged_in');
    await p.locator('[aria-label="Google Account"]').evaluate(element => element.remove());
    assert.equal((await gemini.auth()).status, 'unknown');
    await p.evaluate(() => { const a = document.createElement('a'); a.href = 'https://accounts.google.com'; a.textContent = 'Sign in'; document.body.append(a); });
    assert.equal((await gemini.auth()).status, 'logged_out');
    await p.evaluate(() => { const d = document.createElement('div'); d.setAttribute('role', 'dialog'); d.textContent = 'Privacy consent'; document.body.append(d); });
    assert.equal((await gemini.auth()).status, 'consent_required');
    await p.goto('https://accounts.google.com/signin/v2/challenge?login_hint=private@example.com#token');
    assert.equal((await gemini.auth()).status, 'challenge');
    assert.equal((await gemini.auth()).url, 'https://accounts.google.com/signin/v2/challenge');
  } finally { await ctx.close(); }
});

test('models are read dynamically; unavailable/missing choices never silently fall back', async () => {
  const ctx = await context();
  try {
    const p = await page(ctx); const gemini = new Gemini(p);
    const list = await gemini.models();
    assert.equal(list.models.length, 3);
    assert.equal(list.models[2].availability, 'unavailable');
    assert.equal((await gemini.selectModel('test-reasoning')).name, 'Test Reasoning');
    assert.equal((await gemini.models()).models.find(m => m.name === 'Test Reasoning')?.selected, true);
    await assert.rejects(gemini.selectModel('Test Premium'), { code: 'MODEL_UNAVAILABLE' });
    await assert.rejects(gemini.selectModel('missing'), { code: 'MODEL_NOT_FOUND' });
    assert.equal(await p.evaluate(() => (window as any).sendCount), 0);
  } finally { await ctx.close(); }
});

test('thinking submenu is independently scoped, selected, and verified', async () => {
  const ctx = await context();
  try {
    const p = await page(ctx); const gemini = new Gemini(p);
    assert.equal((await gemini.thinking()).current, 'medium');
    assert.deepEqual((await gemini.thinking()).levels.map(option => option.id), ['low', 'medium', 'high']);
    assert.equal((await gemini.selectThinking('low')).id, 'low');
    assert.equal((await gemini.selectThinking('mid')).id, 'medium');
    await assert.rejects(gemini.selectThinking('xhigh'), { code: 'THINKING_UNAVAILABLE' });
    assert.equal((await gemini.models()).models.length, 3);
    assert.equal(await p.evaluate(() => (window as any).sendCount), 0);
  } finally { await ctx.close(); }
});

test('thinking fails closed on missing, invalid, or parent-menu aria-controls', async () => {
  const ctx = await context();
  try {
    const p = await page(ctx); const gemini = new Gemini(p);
    for (const id of [null, 'invalid id', 'model-menu']) {
      await p.locator('#model-menu [aria-haspopup]').evaluate((element, value) => {
        if (value === null) element.removeAttribute('aria-controls');
        else element.setAttribute('aria-controls', value);
      }, id);
      await assert.rejects(gemini.selectThinking('low'), { code: 'THINKING_MENU_UNKNOWN' });
      assert.equal((await gemini.models()).current, 'Test Fast');
      assert.equal(await p.evaluate(() => (window as any).sendCount), 0);
    }
  } finally { await ctx.close(); }
});

test('localized model labels keep stable model IDs and a single current model name', async () => {
  const ctx = await context();
  try {
    const p = await page(ctx); const gemini = new Gemini(p);
    for (const mode of ['日常帮助', 'Everyday help']) {
      await p.locator('#model-menu [role="menuitemradio"]').first().evaluate((element, label) => {
        element.innerHTML = `<span>${label}</span><br><span>4 Hydrogen</span>`;
      }, mode);
      await p.locator('[data-test-id="bard-mode-menu-button"]').evaluate((element, label) => {
        element.innerHTML = `Hydrogen<br>${label}`;
      }, mode);
      const list = await gemini.models();
      assert.equal(list.current, '4 Hydrogen');
      assert.equal(list.models[0].id, '4-hydrogen');
      assert.equal(list.models[0].name, '4 Hydrogen');
      assert.equal(list.models[0].mode, mode);
      assert.equal((await gemini.selectModel('4-hydrogen')).mode, mode);
    }
  } finally { await ctx.close(); }
});

test('thinking normalizes Standard/Extended and description labels, rejects unknown and duplicate levels', async () => {
  const ctx = await context();
  try {
    const p = await page(ctx); const gemini = new Gemini(p);
    await p.locator('#thinking-menu button').nth(1).evaluate(element => { element.innerHTML = '<span>Standard</span><br>Balanced'; });
    await p.locator('#thinking-menu button').nth(2).evaluate(element => { element.innerHTML = '<span>深度模式</span><br>Extended thinking'; });
    assert.deepEqual((await gemini.thinking()).levels.map(level => level.id), ['low', 'medium', 'high']);
    assert.equal((await gemini.selectThinking('Extended')).id, 'high');
    await p.locator('#thinking-menu button').first().evaluate(element => { element.innerHTML = '<span>Mystery</span><br>Unknown effort'; });
    await assert.rejects(gemini.selectThinking('medium'), { code: 'THINKING_UNKNOWN' });
    await p.locator('#thinking-menu button').first().evaluate(element => { element.innerHTML = '<span>Medium</span>'; });
    await assert.rejects(gemini.thinking(), { code: 'AMBIGUOUS_THINKING' });
    assert.equal(await p.evaluate(() => (window as any).sendCount), 0);
  } finally { await ctx.close(); }
});

test('successful CLI generation keeps stderr empty for compact/json/quiet modes', async t => {
  let port: number | undefined;
  for (const candidate of [9444, 9555]) {
    const free = await new Promise<boolean>(resolve => {
      const server = createServer();
      server.once('error', () => resolve(false));
      server.listen(candidate, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (free) { port = candidate; break; }
  }
  if (!port) { t.skip('Isolated CDP ports 9444 and 9555 are unavailable.'); return; }
  const home = await mkdtemp(path.join(os.tmpdir(), 'gemini-cli-cdp-'));
  const ctx = await chromium.launchPersistentContext(path.join(home, 'test-profile'), {
    channel: 'chrome', headless: true, args: [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'],
  });
  try {
    await ctx.route('**/*', route => route.fulfill({ contentType: 'text/html', body: fixture }));
    if (!await endpointReady(`http://127.0.0.1:${port}`)) {
      assert.ok(!process.env.CI, 'CI must allow the local HTTP CDP integration test.');
      t.skip('This sandbox blocks local HTTP CDP; run outside it to verify CLI transport.');
      return;
    }
    const original = await page(ctx, 'https://gemini.google.com/app/original-agent-task');
    const existingPages = ctx.pages();
    const session = await ctx.newCDPSession(original);
    let targetId: string;
    try { targetId = (await session.send('Target.getTargetInfo')).targetInfo.targetId; }
    finally { await session.detach(); }
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { id: string }[];
    assert.ok(targets.some(target => target.id === targetId), 'CDP endpoint must belong to this throwaway Chrome.');
    const prompt = '请写一段青竹短文。';
    const job = path.join(home, 'job.json');
    await writeFile(job, JSON.stringify({ prompt }));
    for (const flag of ['--compact', '--json', '--quiet']) {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', flag, '--home', home,
        '--cdp', `http://127.0.0.1:${port}`, 'run', job], { windowsHide: true });
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      const closed = new Promise(resolve => child.once('close', resolve));
      const timer = setTimeout(() => child.kill(), 25000);
      try { assert.equal(await closed, 0, stdout + stderr); } finally { clearTimeout(timer); }
      assert.equal(stderr, '');
      const result = JSON.parse(stdout);
      assert.equal(result.state, 'complete');
      assert.equal(result.promptSha256, createHash('sha256').update(prompt).digest('hex'));
      if (flag === '--compact') assert.equal(stdout.trim().split('\n').length, 1);
      assert.deepEqual(ctx.pages(), existingPages);
      assert.equal(original.url(), 'https://gemini.google.com/app/original-agent-task');
      assert.equal(await original.evaluate(() => (window as any).sendCount), 0);
    }
    const signedOut = fixture.replace('<button aria-label="Google Account">Account</button>', '<a href="https://accounts.google.com">Sign in</a>');
    await ctx.route('**/*', route => route.fulfill({ contentType: 'text/html', body: signedOut }));
    for (const command of [['ready'], ['auth', 'status'], ['doctor']]) {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--json', '--home', home,
        '--cdp', `http://127.0.0.1:${port}`, ...command], { windowsHide: true });
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      const closed = new Promise(resolve => child.once('close', resolve));
      const timer = setTimeout(() => child.kill(), 25000);
      try { assert.equal(await closed, 3, stdout + stderr); } finally { clearTimeout(timer); }
      const result = JSON.parse(stdout);
      assert.equal(result.endpoint, `http://127.0.0.1:${port}`);
      assert.equal(result.next, 'ask-gemini-web login');
      assert.equal(stderr, '');
      assert.deepEqual(ctx.pages(), existingPages);
      await assert.rejects(access(path.join(home, 'chrome-profile')), { code: 'ENOENT' });
    }
  } finally { await ctx.close(); await rm(home, { recursive: true, force: true, maxRetries: 5 }); }
});

test('preview restores model and thinking after successful routing and failed overrides', async () => {
  const ctx = await context();
  try {
    const p = await page(ctx); const gemini = new Gemini(p);
    const plan = await previewSelection(gemini, { taskText: 'Write an article', model: 'Test Reasoning', thinking: 'high' });
    assert.equal(plan.thinking.id, 'high');
    assert.equal((await gemini.models()).models.find(option => option.selected)?.name, 'Test Fast');
    assert.equal((await gemini.thinking()).current, 'medium');
    await assert.rejects(previewSelection(gemini, { taskText: 'Write', thinking: 'xhigh' }), { code: 'THINKING_UNAVAILABLE' });
    assert.equal((await gemini.thinking()).current, 'medium');
    assert.equal(await p.evaluate(() => (window as any).sendCount), 0);
  } finally { await ctx.close(); }
});

test('generation requires completion controls and detects quota independently of response text', async () => {
  const ctx = await context();
  try {
    const p = await page(ctx); const gemini = new Gemini(p);
    await p.evaluate(() => {
      const response = document.createElement('model-response');
      response.innerHTML = '<div class="markdown">Still streaming.</div>';
      document.body.append(response);
    });
    assert.equal((await gemini.progress()).done, false);
    await p.evaluate(() => {
      const copy = document.createElement('button'); copy.setAttribute('aria-label', 'Copy');
      document.querySelector('model-response')!.append(copy);
      const stop = document.createElement('button'); stop.setAttribute('aria-label', 'Stop generating');
      document.body.append(stop);
    });
    assert.equal((await gemini.progress()).generating, true);
    await p.evaluate(() => {
      const error = document.createElement('div'); error.setAttribute('role', 'alert');
      error.textContent = 'Quota limit reached'; document.body.append(error);
    });
    await assert.rejects(gemini.progress(), { code: 'QUOTA_REACHED' });
  } finally { await ctx.close(); }
});

test('account restrictions come from service UI and completion requires response actions and idle content', async () => {
  const ctx = await context();
  try {
    const p = await page(ctx);
    const gemini = new Gemini(p);
    await p.locator('body').evaluate(body => body.insertAdjacentHTML('beforeend',
      '<user-query><h3>无法访问</h3></user-query><model-response><div class="markdown" aria-busy="true">'
      + '<h2>暂不支持的文件格式</h2><code-block><button aria-label="Copy code">Copy</button></code-block>'
      + '<button data-test-id="copy-button">复制</button></div></model-response>'));
    assert.equal((await gemini.auth()).status, 'logged_in');
    assert.equal((await gemini.progress()).done, false);
    await p.locator('.markdown').evaluate(body => body.setAttribute('aria-busy', 'false'));
    assert.equal((await gemini.progress()).done, false);
    await p.locator('model-response').evaluate(response => response.insertAdjacentHTML('beforeend', '<button aria-label="Copy response">Copy</button>'));
    await p.locator('.markdown').evaluate(body => body.setAttribute('aria-busy', 'true'));
    const busy = await gemini.progress();
    assert.equal(busy.generating, true);
    assert.equal(busy.done, false);
    await p.locator('.markdown').evaluate(body => body.setAttribute('aria-busy', 'false'));
    assert.equal((await gemini.progress()).done, true);
    await p.locator('body').evaluate(body => body.insertAdjacentHTML('beforeend', '<h1>服务暂不支持此地区</h1>'));
    assert.equal((await gemini.auth()).status, 'restricted');
  } finally { await ctx.close(); }
});

test('pre-click failure resumes the same job, including older SEND_UNAVAILABLE records', async () => {
  const ctx = await context(fixture.replace('<button data-test-id="send-button"', '<button disabled data-test-id="send-button"'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'gemini-pre-click-'));
  try {
    const cfg = settings({ home });
    const store = new RunStore(cfg);
    const job = await compileJob({ prompt: '青竹' });
    const userTab = await page(ctx);
    await assert.rejects(execute(cfg, job, () => {}, factory(ctx)), { code: 'SEND_UNAVAILABLE' });
    const [id] = await readdir(cfg.runs);
    assert.equal((await store.read(id)).state, 'prepared');
    assert.equal(ctx.pages().length, 2);
    assert.equal(await ctx.pages()[1].evaluate(() => (window as any).sendCount), 0);
    await ctx.unroute('**/*');
    await ctx.route('**/*', route => route.fulfill({ contentType: 'text/html', body: fixture }));
    const legacy = await store.create(job);
    legacy.state = 'submit_intent';
    legacy.lastError = { code: 'SEND_UNAVAILABLE', message: '发送按钮未就绪，未尝试发送。' };
    await store.save(legacy);
    for (const runId of [id, legacy.id]) {
      const result = await resume(cfg, runId, () => {}, factory(ctx));
      assert.equal(result.state, 'complete');
      assert.equal(result.id, runId);
      assert.deepEqual(ctx.pages(), [userTab]);
      assert.equal(await userTab.evaluate(() => localStorage.getItem('totalSends')), runId === id ? '1' : '2');
    }
  } finally { await ctx.close(); await rm(home, { recursive: true, force: true, maxRetries: 5 }); }
});

test('upgrade-only model entry is unavailable even if technically enabled', async () => {
  const ctx = await context();
  try {
    const p = await page(ctx); const gemini = new Gemini(p);
    await p.locator('[aria-disabled]').evaluate(element => element.removeAttribute('aria-disabled'));
    assert.equal((await gemini.models()).models[2].availability, 'unavailable');
    await assert.rejects(gemini.selectModel('Test Premium'), { code: 'MODEL_UNAVAILABLE' });
    assert.equal(await p.evaluate(() => (window as any).sendCount), 0);
  } finally { await ctx.close(); }
});

test('model selection is rejected when the webpage ignores the click', async () => {
  const ctx = await context();
  try {
    const p = await page(ctx); const gemini = new Gemini(p);
    await p.locator('[role="menuitemradio"]').nth(1).evaluate(element => {
      (element as HTMLButtonElement).onclick = () => {
        (document.querySelector('#model-menu') as HTMLElement).hidden = true;
        document.querySelector('[data-test-id="bard-mode-menu-button"]')!.setAttribute('aria-expanded', 'false');
      };
    });
    await assert.rejects(gemini.selectModel('Test Reasoning'), { code: 'MODEL_SELECTION_UNVERIFIED' });
    assert.equal(await p.evaluate(() => (window as any).sendCount), 0);
  } finally { await ctx.close(); }
});

test('submission collects Markdown and completed resume never sends again', async () => {
  const ctx = await context();
  const home = await mkdtemp(path.join(os.tmpdir(), 'ask-gemini-web-e2e-'));
  try {
    const filename = path.join(home, 'job.yaml');
    await writeFile(filename, 'prompt: Write an article\nmodel: Test Reasoning');
    const config = settings({ home });
    const userTab = await page(ctx, GEMINI + '/offline-conversation');
    const run = await execute(config, await loadJob(filename), () => {}, factory(ctx));
    assert.equal(run.state, 'complete');
    assert.match(await readFile(run.result!, 'utf8'), /# Fixture draft/);
    assert.equal(run.chosenModel?.name, 'Test Reasoning');
    assert.equal((await resume(config, run.id, () => {}, factory(ctx))).state, 'complete');
    assert.deepEqual(ctx.pages(), [userTab]);
    assert.equal(await userTab.evaluate(() => localStorage.getItem('totalSends')), '1');
  } finally { await ctx.close(); await rm(home, { recursive: true, force: true, maxRetries: 5 }); }
});

test('lost click acknowledgement resumes original response without duplicate submission', async () => {
  const ctx = await context();
  const home = await mkdtemp(path.join(os.tmpdir(), 'ask-gemini-web-resume-'));
  const original = Gemini.prototype.submit;
  try {
    const filename = path.join(home, 'job.yaml');
    await writeFile(filename, 'prompt: Recover this article\nmodel: Test Fast');
    const config = settings({ home });
    const userTab = await page(ctx, GEMINI + '/offline-conversation');
    Gemini.prototype.submit = async function (send) { await original.call(this, send); throw new Error('Simulated lost acknowledgement'); };
    await assert.rejects(execute(config, await loadJob(filename), () => {}, factory(ctx)), /Simulated lost acknowledgement/);
    Gemini.prototype.submit = original;
    const id = (await readdir(config.runs))[0];
    const store = new RunStore(config);
    assert.equal((await store.read(id)).state, 'submit_intent');
    assert.equal(ctx.pages().length, 2);
    const result = await resume(config, id, () => {}, factory(ctx));
    assert.equal(result.state, 'complete');
    assert.deepEqual(ctx.pages(), [userTab]);
    assert.equal(await userTab.evaluate(() => localStorage.getItem('totalSends')), '1');
  } finally { Gemini.prototype.submit = original; await ctx.close(); await rm(home, { recursive: true, force: true, maxRetries: 5 }); }
});

test('resume opens and closes its own recovery tab when the original target is gone', async () => {
  const ctx = await context();
  const home = await mkdtemp(path.join(os.tmpdir(), 'gemini-reopen-'));
  try {
    const cfg = settings({ home });
    const store = new RunStore(cfg);
    const run = await store.create(await compileJob({ prompt: 'Recover saved conversation' }));
    run.state = 'collecting';
    run.targetId = 'closed';
    run.conversationUrl = GEMINI + '/offline-conversation';
    await store.save(run);
    const savedChat = fixture.replace('<rich-textarea>',
      '<user-query><div class="query-text">Recover saved conversation</div></user-query>'
      + '<model-response><div class="markdown">Saved answer</div><button aria-label="Copy">Copy</button></model-response><rich-textarea>');
    await ctx.route(run.conversationUrl, route => route.fulfill({ contentType: 'text/html', body: savedChat }));
    const userTab = await page(ctx, run.conversationUrl);
    const result = await resume(cfg, run.id, () => {}, factory(ctx));
    assert.match(await readFile(result.result!, 'utf8'), /Saved answer/);
    assert.deepEqual(ctx.pages(), [userTab]);
    assert.equal(await userTab.evaluate(() => localStorage.getItem('totalSends')), null);
  } finally { await ctx.close(); await rm(home, { recursive: true, force: true, maxRetries: 5 }); }
});

test('ambiguous submission with no original page cannot resend', async () => {
  const ctx = await context();
  const home = await mkdtemp(path.join(os.tmpdir(), 'ask-gemini-web-uncertain-'));
  try {
    const filename = path.join(home, 'job.yaml');
    await writeFile(filename, 'prompt: Never duplicate');
    const config = settings({ home }); const store = new RunStore(config);
    const run = await store.create(await loadJob(filename));
    run.state = 'submit_intent'; run.targetId = 'gone'; await store.save(run);
    await assert.rejects(resume(config, run.id, () => {}, factory(ctx)), { code: 'SUBMISSION_UNCERTAIN' });
    assert.equal(ctx.pages().length, 0);
  } finally { await ctx.close(); await rm(home, { recursive: true, force: true, maxRetries: 5 }); }
});

test('existing output is rejected before creating a task tab or submitting', async () => {
  const ctx = await context();
  const home = await mkdtemp(path.join(os.tmpdir(), 'ask-gemini-web-existing-'));
  try {
    const filename = path.join(home, 'job.yaml');
    await writeFile(filename, 'prompt: Preserve my file\noutput: draft.md');
    await writeFile(path.join(home, 'draft.md'), 'existing article');
    await assert.rejects(execute(settings({ home }), await loadJob(filename), () => {}, factory(ctx)), { code: 'OUTPUT_EXISTS' });
    assert.equal(await readFile(path.join(home, 'draft.md'), 'utf8'), 'existing article');
    assert.equal(ctx.pages().length, 0);
  } finally { await ctx.close(); await rm(home, { recursive: true, force: true, maxRetries: 5 }); }
});

test('export failure after generation leaves a collected result for browser-free recovery', async () => {
  const ctx = await context();
  const home = await mkdtemp(path.join(os.tmpdir(), 'gemini-export-race-'));
  const original = Gemini.prototype.submit;
  try {
    const cfg = settings({ home });
    const output = path.join(home, 'draft.md');
    Gemini.prototype.submit = async function (send) {
      await original.call(this, send);
      await writeFile(output, 'Concurrent user file');
    };
    await assert.rejects(execute(cfg, await compileJob({ prompt: 'Write an article', output }), () => {}, factory(ctx)), { code: 'OUTPUT_EXISTS' });
    const [id] = await readdir(cfg.runs);
    const saved = await new RunStore(cfg).read(id);
    assert.equal(saved.state, 'collected');
    assert.match(await readFile(saved.result!, 'utf8'), /Fixture draft/);
    assert.equal(await readFile(output, 'utf8'), 'Concurrent user file');
    await rm(output);
    const noBrowser = async (): Promise<never> => { throw new Error('Must not reconnect'); };
    assert.equal((await resume(cfg, id, () => {}, noBrowser)).state, 'complete');
    assert.match(await readFile(output, 'utf8'), /Fixture draft/);
    assert.equal(await ctx.pages()[0].evaluate(() => (window as any).sendCount), 1);
  } finally { Gemini.prototype.submit = original; await ctx.close(); await rm(home, { recursive: true, force: true, maxRetries: 5 }); }
});

test('restored old conversation after model selection is rejected before submit', async () => {
  const ctx = await context();
  const home = await mkdtemp(path.join(os.tmpdir(), 'ask-gemini-web-drift-'));
  const original = Gemini.prototype.selectThinking;
  try {
    const filename = path.join(home, 'job.yaml');
    await writeFile(filename, 'prompt: Never send into an old conversation\nmodel: Test Fast');
    Gemini.prototype.selectThinking = async function (level) {
      const result = await original.call(this, level);
      await this.page.evaluate(() => history.pushState({}, '', '/app/unrelated'));
      return result;
    };
    await assert.rejects(execute(settings({ home }), await loadJob(filename), () => {}, factory(ctx)), { code: 'EXPECTED_NEW_CHAT' });
    assert.equal(await ctx.pages()[0].evaluate(() => (window as any).sendCount), 0);
  } finally { Gemini.prototype.selectThinking = original; await ctx.close(); await rm(home, { recursive: true, force: true, maxRetries: 5 }); }
});
