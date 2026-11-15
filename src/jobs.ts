import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, open, unlink, access } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { jobSchema, type Settings } from './config.js';
import { DraftError, errorInfo } from './errors.js';
import { Connection, isGemini, pause, shutdown } from './browser.js';
import { Gemini, type Model, type ThinkingOption } from './gemini.js';
import { selectForTask, selectionSummary, type Selection } from './selection.js';
import type { Task } from './routing.js';
import type { Page } from 'playwright-core';
import { toMarkdown } from './markdown.js';

const hash = (input: string) => createHash('sha256').update(input).digest('hex');
export function parseJobJson(raw: string): unknown {
  try { return JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch { throw new DraftError('INVALID_JSON', '任务输入不是有效的 JSON。'); }
}
export async function loadJob(filename: string) {
  const absolute = path.resolve(filename);
  const base = path.dirname(absolute);
  const raw = await readFile(absolute, 'utf8');
  if (/\.json$/i.test(filename)) return compileJob(parseJobJson(raw), base, absolute);
  let input: unknown;
  try { input = parse(raw); }
  catch { throw new DraftError('INVALID_YAML', '任务文件不是有效的 YAML。'); }
  return compileJob(input, base, absolute);
}

export async function compileJob(input: unknown, base = process.cwd(), source = 'stdin') {
  const parsed = jobSchema.safeParse(input);
  if (!parsed.success) throw new DraftError('INVALID_JOB', parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('\n'));
  const job = parsed.data;
  let prompt = job.prompt ?? await readFile(path.resolve(base, job.promptFile!), 'utf8');
  // Single replacement pass: user values are data, never executable code or recursive templates.
  prompt = prompt.replace(/(\\?)\{\{\s*([\p{L}\p{M}\p{N}_.-]+)\s*\}\}/gu, (match, escape: string, key: string) => {
    if (escape) return match.slice(1);
    if (!Object.hasOwn(job.variables, key)) throw new DraftError('MISSING_VARIABLE', `模板变量缺失：${key}`);
    return String(job.variables[key]);
  });
  const taskText = prompt;
  if (!prompt.trim()) throw new DraftError('EMPTY_PROMPT', '提示词不能为空。');
  const materials: { path: string; sha256: string }[] = [];
  for (const relative of job.materials) {
    const materialPath = path.resolve(base, relative);
    if (!/\.(md|txt|csv|json|ya?ml)$/i.test(materialPath)) throw new DraftError('UNSUPPORTED_MATERIAL', '第一版仅支持 UTF-8 文本素材：md/txt/csv/json/yaml。');
    const text = await readFile(materialPath, 'utf8');
    materials.push({ path: materialPath, sha256: hash(text) });
    prompt += `\n\n--- 素材：${path.basename(materialPath)} ---\n${text}\n--- 素材结束 ---`;
  }
  if (Buffer.byteLength(prompt, 'utf8') > 2 * 1024 * 1024) throw new DraftError('PROMPT_TOO_LARGE', '文本超过本工具 2 MiB 提交上限，请精简素材。该上限不代表 Gemini 上下文容量。');
  return { ...job, taskText, prompt, source, materials, sha256: hash(prompt), output: job.output ? path.resolve(base, job.output) : undefined };
}
export type Job = Awaited<ReturnType<typeof loadJob>>;
export type Run = {
  version: 1; id: string; createdAt: string; updatedAt: string;
  state: 'prepared' | 'submit_intent' | 'submitted' | 'collecting' | 'complete';
  source: string; promptHash: string; materials: Job['materials']; requestedModel?: string;
  taskText?: string; task?: Task | 'auto'; requestedThinking?: string;
  chosenThinking?: ThinkingOption; selection?: Selection;
  chosenModel?: Model; timeoutSeconds: number; output?: string;
  environment?: { node: string; platform: string; chrome: string; adapter: string; language: string };
  conversationUrl?: string; targetId?: string; submittedAt?: string; lastError?: ReturnType<typeof errorInfo>;
  result?: string;
};

export class RunStore {
  constructor(public config: Settings) {}
  directory(id: string) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) throw new DraftError('INVALID_RUN_ID', '任务 ID 必须是本工具生成的 UUID。');
    return path.join(this.config.runs, id);
  }
  async save(run: Run) {
    run.updatedAt = new Date().toISOString();
    const file = path.join(this.directory(run.id), 'run.json');
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(run, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, file);
  }
  async read(id: string): Promise<Run> {
    const run = JSON.parse(await readFile(path.join(this.directory(id), 'run.json'), 'utf8')) as Run;
    if (run.id !== id || run.version !== 1) throw new DraftError('INVALID_RUN', '任务记录不匹配或版本不受支持。');
    return run;
  }
  async create(job: Job): Promise<Run> {
    const run: Run = { version: 1, id: randomUUID(), createdAt: new Date().toISOString(), updatedAt: '', state: 'prepared',
      source: job.source, promptHash: job.sha256, materials: job.materials, requestedModel: job.model,
      taskText: job.taskText, task: job.task, requestedThinking: job.thinking,
      timeoutSeconds: job.timeoutSeconds, output: job.output };
    await mkdir(this.directory(run.id), { recursive: true, mode: 0o700 });
    await writeFile(path.join(this.directory(run.id), 'prompt.txt'), job.prompt, { mode: 0o600 });
    await this.save(run);
    return run;
  }
  async prompt(run: Run) {
    const prompt = await readFile(path.join(this.directory(run.id), 'prompt.txt'), 'utf8');
    if (hash(prompt) !== run.promptHash) throw new DraftError('PROMPT_CHANGED', '已保存提示词的哈希不匹配，停止恢复。');
    return prompt;
  }
  async lock<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(this.config.home, { recursive: true, mode: 0o700 });
    const lockfile = path.join(this.config.home, 'browser.lock');
    const token = JSON.stringify({ pid: process.pid, token: randomUUID() });
    let handle;
    try { handle = await open(lockfile, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Serialize stale-lock recovery so two recovering processes cannot delete each other's new lock.
      const recoveryPath = path.join(this.config.home, 'browser-recovery.lock');
      let recovery;
      try { recovery = await open(recoveryPath, 'wx', 0o600); }
      catch { throw new DraftError('BROWSER_BUSY', '另一个命令正在检查浏览器锁，请稍后重试。'); }
      try {
        let previous: string;
        try {
          previous = await readFile(lockfile, 'utf8');
          const owner = JSON.parse(previous) as { pid: number };
          if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid lock');
          let alive = true;
          try { process.kill(owner.pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
          if (alive) throw new Error('Alive');
        } catch { throw new DraftError('BROWSER_BUSY', '浏览器正被另一个命令占用，或锁状态无法确认。等待命令退出后重试。'); }
        if (await readFile(lockfile, 'utf8') !== previous) throw new DraftError('BROWSER_BUSY', '浏览器锁已变化，请重试。');
        await unlink(lockfile);
        try { handle = await open(lockfile, 'wx', 0o600); }
        catch { throw new DraftError('BROWSER_BUSY', '另一个命令已取得浏览器锁。'); }
      } finally { await recovery.close(); await unlink(recoveryPath); }
    }
    try { await handle.writeFile(token); return await action(); }
    finally {
      await handle.close();
      if (await readFile(lockfile, 'utf8').catch(() => '') === token) await unlink(lockfile);
    }
  }
}

async function targetId(connection: Connection, page: Page) {
  const session = await connection.context.newCDPSession(page);
  try { return (await session.send('Target.getTargetInfo')).targetInfo.targetId; }
  finally { await session.detach(); }
}

function conversation(url: string) {
  if (!isGemini(url)) return undefined;
  return /^\/app\/[a-zA-Z0-9_-]+$/.test(new URL(url).pathname) ? url : undefined;
}

async function checkOutput(output?: string) {
  if (!output) return;
  let exists = false;
  try { await access(output); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (exists) throw new DraftError('OUTPUT_EXISTS', `输出文件已存在，不覆盖：${output}`);
  await mkdir(path.dirname(output), { recursive: true });
}

async function submit(connection: Connection, store: RunStore, run: Run, prompt: string, notify: (message: string) => void) {
  await checkOutput(run.output);
  const page = await connection.page(true);
  const gemini = new Gemini(page);
  run.targetId = await targetId(connection, page);
  await store.save(run);
  await gemini.requireLogin();
  await gemini.newConversation();
  if ((await gemini.userPrompts()).length) throw new DraftError('EXPECTED_NEW_CHAT', '新标签页出现已有对话内容，停止发送；请检查 Gemini 的默认导航行为。');
  run.environment = { node: process.version, platform: process.platform, chrome: await connection.browser.version(),
    adapter: 'gemini-dom-v1', language: await page.locator('html').getAttribute('lang') || 'unknown' };
  run.selection = await selectForTask(gemini, { taskText: run.taskText || prompt, task: run.task, model: run.requestedModel, thinking: run.requestedThinking });
  run.chosenModel = run.selection.model;
  run.chosenThinking = run.selection.thinking;
  if (new URL(page.url()).pathname !== '/app' || (await gemini.userPrompts()).length) {
    throw new DraftError('EXPECTED_NEW_CHAT', '选择模型后网页恢复了已有会话，停止发送。请检查任务页面。');
  }
  await gemini.fill(prompt);
  const send = await gemini.sendButton();
  if (new URL(page.url()).pathname !== '/app' || (await gemini.userPrompts()).length) throw new DraftError('EXPECTED_NEW_CHAT', '输入期间会话发生变化，任务未发送。');
  shutdown.signal.throwIfAborted();
  // Persist intent before clicking. Any uncertainty after this point must never auto-resend.
  run.state = 'submit_intent';
  run.lastError = undefined;
  await store.save(run);
  notify(`任务 ${run.id}：${run.chosenModel.name} / ${run.chosenThinking.id} (${run.selection.task})`);
  await gemini.submit(send);
  run.state = 'submitted';
  run.submittedAt = new Date().toISOString();
  await store.save(run);
  return gemini;
}

async function collect(gemini: Gemini, store: RunStore, run: Run, prompt: string) {
  const deadline = Date.now() + run.timeoutSeconds * 1000;
  let previous = '', stableSince = Date.now(), lastAuthCheck = 0;
  while (Date.now() < deadline) {
    if (Date.now() - lastAuthCheck > 10000) { await gemini.requireLogin(); lastAuthCheck = Date.now(); }
    const url = conversation(gemini.page.url());
    if (url && run.conversationUrl !== url) {
      if (run.conversationUrl) throw new DraftError('CONVERSATION_NAVIGATED', '任务标签页切换了对话。请 resume 从已记录的原对话继续，不会重新发送。');
      const messages = await gemini.userPrompts();
      if (messages.length === 1 && normalizePrompt(messages[0]) === normalizePrompt(prompt)) { run.conversationUrl = url; await store.save(run); }
    }
    const progress = await gemini.progress();
    if (progress.text !== previous || progress.generating) { previous = progress.text; stableSince = Date.now(); }
    if (progress.text.trim() && progress.done && !progress.generating && Date.now() - stableSince >= 3000) {
      const messages = await gemini.userPrompts();
      if (messages.length !== 1 || normalizePrompt(messages[0]) !== normalizePrompt(prompt) || progress.count !== 1) {
        throw new DraftError('CONVERSATION_CHANGED', '对话内容与任务不唯一匹配，可能被人工修改。停止提取，请手动检查原对话。');
      }
      const directory = store.directory(run.id);
      const markdown = toMarkdown(progress.html);
      await writeFile(path.join(directory, 'response.txt'), progress.text, { mode: 0o600 });
      await writeFile(path.join(directory, 'response.html'), progress.html, { mode: 0o600 });
      await writeFile(path.join(directory, 'draft.md'), markdown + '\n', { mode: 0o600 });
      // Save a durable result before exporting: an export failure never needs another generation.
      run.state = 'complete'; run.result = path.join(directory, 'draft.md'); run.lastError = undefined;
      await store.save(run);
      if (run.output) await writeFile(run.output, markdown + '\n', { flag: 'wx', mode: 0o600 });
      return run;
    }
    if (run.state !== 'collecting') { run.state = 'collecting'; await store.save(run); }
    await pause(750);
  }
  throw new DraftError('GENERATION_TIMEOUT', `等待生成超时。运行 resume ${run.id} 继续读取原对话，不会重新发送。`);
}

const normalizePrompt = (text: string) => text.replace(/\s+/g, ' ').trim();

export async function execute(config: Settings, job: Job, notify: (message: string) => void, connect = Connection.ensure) {
  const store = new RunStore(config);
  return store.lock(async () => {
    const run = await store.create(job);
    notify(`已创建任务 ${run.id}`);
    return work(config, store, run, notify, connect);
  });
}

export async function resume(config: Settings, id: string, notify: (message: string) => void, connect = Connection.ensure) {
  const store = new RunStore(config);
  return store.lock(async () => work(config, store, await store.read(id), notify, connect));
}

async function work(config: Settings, store: RunStore, run: Run, notify: (message: string) => void, connect = Connection.ensure): Promise<Run> {
  if (run.state === 'complete') return run;
  let connection: Connection | undefined;
  try {
    const prompt = await store.prompt(run);
    connection = await connect(config);
    let gemini: Gemini;
    // Older versions persisted intent before checking the button. This particular
    // error was only raised before click(), so the original job can safely resume.
    if (run.state === 'submit_intent' && run.lastError?.code === 'SEND_UNAVAILABLE') {
      run.state = 'prepared';
      await store.save(run);
    }
    if (run.state === 'prepared') gemini = await submit(connection, store, run, prompt, notify);
    else {
      let page: Page | undefined;
      for (const candidate of connection.context.pages()) {
        if (isGemini(candidate.url()) && await targetId(connection, candidate) === run.targetId
          && (!run.conversationUrl || candidate.url() === run.conversationUrl)) { page = candidate; break; }
      }
      if (!page && run.conversationUrl && conversation(run.conversationUrl)) {
        page = await connection.context.newPage();
        await page.goto(run.conversationUrl, { waitUntil: 'domcontentloaded' });
      }
      if (!page) throw new DraftError('SUBMISSION_UNCERTAIN', '无法找到原任务标签页或对话地址。请手动检查 Chrome；为避免重复提交，本工具不会重新发送。');
      gemini = new Gemini(page);
      await gemini.requireLogin();
      // Let a restored conversation load, but never press Send during recovery.
      const deadline = Date.now() + 15000;
      let prompts: string[];
      do {
        prompts = await gemini.userPrompts();
        if (prompts.length) break;
        await pause(400);
      } while (Date.now() < deadline);
      if (prompts!.length !== 1 || normalizePrompt(prompts![0]) !== normalizePrompt(prompt)) {
        throw new DraftError('SUBMISSION_UNCERTAIN', '原对话未显示唯一匹配的提示词。请手动检查；不会重新发送。');
      }
    }
    return await collect(gemini, store, run, prompt);
  } catch (error) {
    run.lastError = errorInfo(error);
    await store.save(run);
    throw new DraftError(run.lastError.code, `${run.lastError.message}\n任务 ID：${run.id}`, error instanceof DraftError ? error.exitCode : 1);
  } finally { await connection?.disconnect(); }
}

export function runSummary(run: Run) {
  return { id: run.id, state: run.state, result: run.result, selection: selectionSummary(run.selection) };
}
