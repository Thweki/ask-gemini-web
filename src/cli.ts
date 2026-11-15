#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import { copyFile, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { settings } from './config.js';
import { Connection, findChrome, pause, shutdown, startChrome } from './browser.js';
import { Gemini } from './gemini.js';
import { previewSelection } from './selection.js';
import { DraftError, errorInfo } from './errors.js';
import { compileJob, decodeUtf8, execute, loadJob, parseJobJson, resume, runSummary, RunStore } from './jobs.js';

const program = new Command();
program.exitOverride().configureOutput({
  outputError: (message, write) => { if (!machineOutput()) write(message); },
});
process.once('SIGINT', () => shutdown.abort(new DraftError('INTERRUPTED', '操作已中断，Chrome 与任务记录已保留。', 130)));
process.once('SIGTERM', () => shutdown.abort(new DraftError('INTERRUPTED', '操作已中断，Chrome 与任务记录已保留。', 143)));
if (/^gemini-draft(?:\.(?:mjs|js|cmd|exe))?$/.test(path.basename(process.argv[1] || ''))) {
  console.error('[deprecated] gemini-draft is deprecated; use ask-gemini-web.');
}
program.name('ask-gemini-web').version('0.2.1')
  .description('通过本机 Chrome CDP 复现 Gemini 网页写稿流程；运行时不调用额外模型 API。')
  .option('--cdp <url>', '本机 Chrome CDP 地址（默认使用保存的配置）')
  .option('--home <path>', '专用配置与任务数据目录')
  .option('--compact', '单行 JSON，适合 agent 调用')
  .option('--quiet', '隐藏进度信息（仍报告错误）')
  .option('--json', '错误也以 JSON 输出（成功结果始终为 JSON）');

function machineOutput() { return !!(program.opts().json || program.opts().compact); }
const config = () => settings(program.opts());
const info = (message: string) => { if (!machineOutput() && !program.opts().quiet) console.error(message); };
function report(data: unknown) { console.log(JSON.stringify(data, null, program.opts().compact ? undefined : 2)); }
async function connected<T>(action: (connection: Connection) => Promise<T>) {
  const connection = await Connection.ensure(config());
  try { return await action(connection); } finally { await connection.disconnect(); }
}
async function locked<T>(action: () => Promise<T>) { return new RunStore(config()).lock(action); }
function seconds(value: string) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 7200) throw new DraftError('INVALID_TIMEOUT', '超时秒数必须为 1–7200 的整数。');
  return number;
}

const browser = program.command('browser').description('复用或启动本机 Chrome');
browser.command('start').option('--chrome <path>', 'Chrome 可执行文件').action(async options => {
  report(await locked(() => startChrome(config(), options.chrome)));
});
browser.command('path').description('显示 Chrome、profile 和 CDP 配置').action(async () => {
  report({ ...config(), chrome: await findChrome() });
});

program.command('ready').description('按保存的配置启动 Chrome，检查登录与可用模型；不发送提示词')
  .action(async () => locked(async () => {
    const cfg = config();
    await connected(async connection => {
      const gemini = new Gemini(await connection.page());
      const auth = await gemini.waitForAuth();
      if (auth.status !== 'logged_in') {
        report({ ready: false, code: `AUTH_${auth.status.toUpperCase()}`, auth, endpoint: connection.endpoint, profile: cfg.profile, browser: connection.browserInfo, next: 'ask-gemini-web login' });
        process.exitCode = 3;
        return;
      }
      report({ ready: true, auth: auth.status, model: (await gemini.models()).current, thinking: (await gemini.thinking()).current });
    });
  }));

program.command('login').description('复用或启动 Chrome，由用户在 Google 官方页面手动登录')
  .option('--chrome <path>', 'Chrome 可执行文件')
  .option('--timeout <seconds>', '等待手动登录的秒数', seconds, 300)
  .option('--no-wait', '打开浏览器并显示登录指引后立即返回')
  .action(async options => locked(async () => {
    const cfg = config();
    const connection = await Connection.ensure(cfg, options.chrome);
    try {
      const started = connection.browserInfo;
      const page = await connection.page();
      info('请在本次打开的 Gemini / accounts.google.com 标签页手动登录。');
      info('本工具不会索取、输入或导出密码、验证码、通行密钥或 Cookie，也不会自动同意条款。');
      info(`配置的 Chrome 专用目录：${cfg.profile}`);
      if (!started.started) info('正在复用已有 CDP 浏览器，实际登录态目录由该 Chrome 的启动配置决定。');
      info('登录完成后可关闭 CLI，保留 Chrome 供后续命令复用。');
      if (!options.wait) { report({ ...started, next: 'ask-gemini-web auth status' }); return; }
      await page.bringToFront();
      const gemini = new Gemini(page);
      const deadline = Date.now() + options.timeout * 1000;
      let previous = '';
      while (Date.now() < deadline) {
        const auth = await gemini.auth();
        if (auth.status === 'logged_in') { report(auth); return; }
        if (auth.status !== previous) { info(`${auth.status}：${auth.reason}`); previous = auth.status; }
        await pause(1000);
      }
      throw new DraftError('LOGIN_TIMEOUT', '等待登录超时，Chrome 已保留。完成登录后运行 auth status。', 3);
    } finally { await connection.disconnect(!options.wait); }
  }));

program.command('auth').description('登录状态').command('status').action(async () => locked(async () => {
  const auth = await connected(async connection => ({ ...await new Gemini(await connection.page()).waitForAuth(), endpoint: connection.endpoint }));
  report({ ...auth, ...(auth.status !== 'logged_in' ? { code: `AUTH_${auth.status.toUpperCase()}`, next: 'ask-gemini-web login' } : {}) });
  if (auth.status !== 'logged_in') process.exitCode = 3;
}));

const models = program.command('models').description('动态检测和选择网页当前提供的模型/模式');
models.command('list').action(async () => locked(async () => {
  report(await connected(async connection => new Gemini(await connection.page()).models()));
}));
models.command('select <name-or-id>').action(async name => locked(async () => {
  report(await connected(async connection => new Gemini(await connection.page()).selectModel(name)));
}));

const thinking = program.command('thinking').description('读取或选择当前模型的思考等级');
thinking.command('list').action(async () => locked(async () => {
  report(await connected(async connection => new Gemini(await connection.page()).thinking()));
}));
thinking.command('select <level>').action(async level => locked(async () => {
  report(await connected(async connection => new Gemini(await connection.page()).selectThinking(level)));
}));

program.command('doctor').description('检测 CDP、登录状态和页面适配，不读取凭证或聊天正文')
  .action(async () => locked(async () => {
    const cfg = config();
    let chrome: string | undefined;
    try { chrome = await findChrome(); } catch { /* Connecting to an existing Chrome can still work. */ }
    report(await connected(async connection => {
      const gemini = new Gemini(await connection.page());
      const diagnostics = await gemini.diagnostics();
      let modelDetection: unknown = { status: 'skipped', reason: diagnostics.auth.status };
      if (diagnostics.auth.status === 'logged_in') {
        try { modelDetection = { status: 'ok', ...await gemini.models() }; }
        catch (error) { modelDetection = { status: 'failed', error: errorInfo(error) }; process.exitCode = 4; }
      }
      if (diagnostics.auth.status !== 'logged_in') process.exitCode = 3;
      return { endpoint: connection.endpoint, chrome, profile: cfg.profile, ...diagnostics, modelDetection, next: diagnostics.auth.status !== 'logged_in' ? 'ask-gemini-web login' : undefined };
    }));
  }));

async function inputJob(filename: string | undefined, options: { stdin?: boolean; model?: string; thinking?: string; task?: string }) {
  if (!!filename === !!options.stdin) throw new DraftError('INVALID_INPUT', '提供任务文件或 --stdin JSON，二选一。');
  let job;
  if (options.stdin) {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) throw new DraftError('INPUT_TOO_LARGE', 'stdin JSON 超过 2 MiB。');
      chunks.push(chunk);
    }
    const raw = decodeUtf8(Buffer.concat(chunks, bytes));
    job = await compileJob(parseJobJson(raw));
  } else job = await loadJob(filename!);
  if (options.model) job.model = options.model;
  if (options.thinking) job.thinking = options.thinking;
  if (options.task) {
    if (!['auto', 'quick', 'writing', 'analysis', 'coding', 'hard'].includes(options.task)) throw new DraftError('INVALID_TASK', 'task 必须为 auto/quick/writing/analysis/coding/hard。');
    job.task = options.task as typeof job.task;
  }
  return job;
}

program.command('plan [job]').description('预览任务的模型与思考等级；不发送，完成后还原网页设置')
  .option('--stdin', '从 stdin 读取 JSON 任务')
  .option('--model <name-or-id>', '指定模型')
  .option('--thinking <level>', '指定思考等级')
  .option('--task <type>', '指定任务类型')
  .action(async (filename, options) => {
    const job = await inputJob(filename, options);
    report(await locked(() => connected(async connection => previewSelection(new Gemini(await connection.page()), job))));
  });

program.command('run [job]').description('一次调用完成自动选择、写稿与保存；默认新建对话')
  .option('--stdin', '从 stdin 读取 JSON 任务')
  .option('--dry-run', '仅渲染完整提示词与配置，不连接浏览器、不发送')
  .option('--model <name-or-id>', '覆盖任务模型')
  .option('--thinking <level>', '覆盖思考等级')
  .option('--task <type>', '覆盖任务类型')
  .action(async (filename, options) => {
    const job = await inputJob(filename, options);
    if (options.dryRun) { report({ dryRun: true, ...job, promptSha256: job.sha256 }); return; }
    report(runSummary(await execute(config(), job, info)));
  });

program.command('status <id>').description('读取本地任务记录，不连接浏览器').action(async id => {
  report(await new RunStore(config()).read(id));
});
program.command('resume <id>').description('继续提取原对话；已尝试发送的任务绝不自动重发').action(async id => {
  report(runSummary(await resume(config(), id, info)));
});
program.command('export <id>').description('导出已完成任务的稿件，不覆盖已有文件')
  .requiredOption('--output <file>', '输出 Markdown 路径')
  .action(async (id, options) => {
    const store = new RunStore(config());
    const run = await store.read(id);
    if (run.state !== 'complete' && run.state !== 'collected') throw new DraftError('RUN_INCOMPLETE', '任务尚未采集完成，请先 resume。');
    const output = path.resolve(options.output);
    await mkdir(path.dirname(output), { recursive: true });
    await copyFile(path.join(store.directory(id), 'draft.md'), output, constants.COPYFILE_EXCL);
    report({ id, output });
  });

try { await program.parseAsync(); }
catch (error) {
  if (error instanceof CommanderError) {
    if (error.exitCode !== 0 && machineOutput()) report({ ok: false, error: { code: 'INVALID_ARGUMENT', message: error.message } });
    process.exitCode = error.exitCode;
  } else {
    const detail = errorInfo(error);
    if (machineOutput()) report({ ok: false, error: detail });
    else console.error(`${detail.code}：${detail.message}`);
    process.exitCode = error instanceof DraftError ? error.exitCode : 1;
  }
}
