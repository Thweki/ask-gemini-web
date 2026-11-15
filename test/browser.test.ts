import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { readFile, mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Gemini } from '../src/gemini.js';
import { Connection, GEMINI } from '../src/browser.js';
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
async function page(ctx: BrowserContext) {
  const page = await ctx.newPage(); await page.goto(GEMINI); return page;
}
function factory(ctx: BrowserContext) {
  return async () => ({ browser, context: ctx, page: () => page(ctx), disconnect: async () => {} }) as Connection;
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
    await assert.rejects(execute(cfg, job, () => {}, factory(ctx)), { code: 'SEND_UNAVAILABLE' });
    const [id] = await readdir(cfg.runs);
    assert.equal((await store.read(id)).state, 'prepared');
    assert.equal(await ctx.pages()[0].evaluate(() => (window as any).sendCount), 0);
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
      assert.equal(await ctx.pages().at(-1)!.evaluate(() => (window as any).sendCount), 1);
    }
  } finally { await ctx.close(); await rm(home, { recursive: true, force: true }); }
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
  const home = await mkdtemp(path.join(os.tmpdir(), 'gemini-draft-e2e-'));
  try {
    const filename = path.join(home, 'job.yaml');
    await writeFile(filename, 'prompt: Write an article\nmodel: Test Reasoning');
    const config = settings({ home });
    const run = await execute(config, await loadJob(filename), () => {}, factory(ctx));
    assert.equal(run.state, 'complete');
    assert.match(await readFile(run.result!, 'utf8'), /# Fixture draft/);
    assert.equal(run.chosenModel?.name, 'Test Reasoning');
    assert.equal((await resume(config, run.id, () => {}, factory(ctx))).state, 'complete');
    assert.equal(await ctx.pages()[0].evaluate(() => (window as any).sendCount), 1);
  } finally { await ctx.close(); await rm(home, { recursive: true, force: true }); }
});

test('lost click acknowledgement resumes original response without duplicate submission', async () => {
  const ctx = await context();
  const home = await mkdtemp(path.join(os.tmpdir(), 'gemini-draft-resume-'));
  const original = Gemini.prototype.submit;
  try {
    const filename = path.join(home, 'job.yaml');
    await writeFile(filename, 'prompt: Recover this article\nmodel: Test Fast');
    const config = settings({ home });
    Gemini.prototype.submit = async function (send) { await original.call(this, send); throw new Error('Simulated lost acknowledgement'); };
    await assert.rejects(execute(config, await loadJob(filename), () => {}, factory(ctx)), /Simulated lost acknowledgement/);
    Gemini.prototype.submit = original;
    const id = (await readdir(config.runs))[0];
    const store = new RunStore(config);
    assert.equal((await store.read(id)).state, 'submit_intent');
    const result = await resume(config, id, () => {}, factory(ctx));
    assert.equal(result.state, 'complete');
    assert.equal(await ctx.pages()[0].evaluate(() => (window as any).sendCount), 1);
  } finally { Gemini.prototype.submit = original; await ctx.close(); await rm(home, { recursive: true, force: true }); }
});

test('ambiguous submission with no original page cannot resend', async () => {
  const ctx = await context();
  const home = await mkdtemp(path.join(os.tmpdir(), 'gemini-draft-uncertain-'));
  try {
    const filename = path.join(home, 'job.yaml');
    await writeFile(filename, 'prompt: Never duplicate');
    const config = settings({ home }); const store = new RunStore(config);
    const run = await store.create(await loadJob(filename));
    run.state = 'submit_intent'; run.targetId = 'gone'; await store.save(run);
    await assert.rejects(resume(config, run.id, () => {}, factory(ctx)), { code: 'SUBMISSION_UNCERTAIN' });
    assert.equal(ctx.pages().length, 0);
  } finally { await ctx.close(); await rm(home, { recursive: true, force: true }); }
});

test('existing output is rejected before creating a task tab or submitting', async () => {
  const ctx = await context();
  const home = await mkdtemp(path.join(os.tmpdir(), 'gemini-draft-existing-'));
  try {
    const filename = path.join(home, 'job.yaml');
    await writeFile(filename, 'prompt: Preserve my file\noutput: draft.md');
    await writeFile(path.join(home, 'draft.md'), 'existing article');
    await assert.rejects(execute(settings({ home }), await loadJob(filename), () => {}, factory(ctx)), { code: 'OUTPUT_EXISTS' });
    assert.equal(await readFile(path.join(home, 'draft.md'), 'utf8'), 'existing article');
    assert.equal(ctx.pages().length, 0);
  } finally { await ctx.close(); await rm(home, { recursive: true, force: true }); }
});

test('restored old conversation after model selection is rejected before submit', async () => {
  const ctx = await context();
  const home = await mkdtemp(path.join(os.tmpdir(), 'gemini-draft-drift-'));
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
  } finally { Gemini.prototype.selectThinking = original; await ctx.close(); await rm(home, { recursive: true, force: true }); }
});
