import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { settings, localEndpoint } from '../src/config.js';
import { compileJob, loadJob, resume, runSummary, RunStore } from '../src/jobs.js';

test('Unicode variables expand once and escaped placeholders stay literal', async () => {
  const job = await compileJob({ prompt: '{{城市}} / \\{{name}} / \\{{ 城市 }}', variables: { 城市: '{{杭州}}' } });
  assert.equal(job.prompt, '{{杭州}} / {{name}} / {{ 城市 }}');
  await assert.rejects(compileJob({ prompt: '{{缺失}}' }), { code: 'MISSING_VARIABLE' });
  await assert.rejects(compileJob({ prompt: '  ', materials: ['examples/notes.md'] }), { code: 'EMPTY_PROMPT' });
});

test('JSON job files accept BOM and report malformed syntax', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gemini-json-'));
  try {
    const file = path.join(dir, 'job.json');
    await writeFile(file, '\uFEFF{"prompt":"青竹"}');
    assert.equal((await loadJob(file)).prompt, '青竹');
    const store = new RunStore(settings({ home: dir }));
    const run = await store.create(await loadJob(file));
    assert.equal(runSummary(run).promptSha256, createHash('sha256').update('青竹').digest('hex'));
    await writeFile(file, Buffer.from([0xff]));
    await assert.rejects(loadJob(file), { code: 'INVALID_UTF8' });
    await writeFile(file, '{"prompt":}');
    await assert.rejects(loadJob(file), { code: 'INVALID_JSON' });
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test('collected jobs retry exports locally and never overwrite unrelated files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gemini-export-'));
  try {
    const cfg = settings({ home: dir });
    const store = new RunStore(cfg);
    const output = path.join(dir, 'output.md');
    const run = await store.create(await compileJob({ prompt: '稿件', output }));
    run.state = 'collected';
    run.result = path.join(store.directory(run.id), 'draft.md');
    await writeFile(run.result, '已保存的稿件\n');
    await store.save(run);
    await writeFile(output, '用户的文件');
    const noBrowser = async (): Promise<never> => { throw new Error('Must not connect to Chrome'); };
    await assert.rejects(resume(cfg, run.id, () => {}, noBrowser), { code: 'OUTPUT_EXISTS' });
    assert.equal((await store.read(run.id)).state, 'collected');
    assert.equal(await readFile(output, 'utf8'), '用户的文件');
    await rm(output);
    assert.equal((await resume(cfg, run.id, () => {}, noBrowser)).state, 'complete');
    assert.equal(await readFile(output, 'utf8'), '已保存的稿件\n');
    assert.equal((await resume(cfg, run.id, () => {}, noBrowser)).state, 'complete');
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test('export recovery handles publication before completion and legacy failed exports', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gemini-publish-'));
  try {
    const cfg = settings({ home: dir });
    const store = new RunStore(cfg);
    const noBrowser = async (): Promise<never> => { throw new Error('Must not connect to Chrome'); };
    for (const legacy of [false, true]) {
      const output = path.join(dir, legacy ? 'legacy.md' : 'published.md');
      const run = await store.create(await compileJob({ prompt: '稿件', output }));
      run.result = path.join(store.directory(run.id), 'draft.md');
      await writeFile(run.result, 'Recovered export\n');
      run.state = legacy ? 'complete' : 'collected';
      if (legacy) run.lastError = { code: 'UNEXPECTED', message: 'Old export failed' };
      else {
        const staging = `${output}.${run.id}.tmp`;
        await writeFile(staging, 'Recovered export\n');
        await link(staging, output);
      }
      await store.save(run);
      const result = await resume(cfg, run.id, () => {}, noBrowser);
      assert.equal(result.state, 'complete');
      assert.equal(result.lastError, undefined);
      assert.equal(await readFile(output, 'utf8'), 'Recovered export\n');
    }
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test('CDP only accepts credential-free local endpoints', () => {
  assert.equal(localEndpoint('http://127.0.0.1:9222'), 'http://127.0.0.1:9222');
  assert.equal(localEndpoint('http://[::1]:9222'), 'http://[::1]:9222');
  for (const url of ['https://127.0.0.1:9222', 'http://example.com:9222', 'http://user:pass@localhost:9222', 'http://localhost:9222/private', 'http://localhost:9222/?token=x', 'file:///x']) {
    assert.throws(() => localEndpoint(url), { code: 'INVALID_CDP' });
  }
});

test('saved CDP address survives later processes and explicit settings override it', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ask-gemini-web-config-'));
  try {
    await writeFile(path.join(home, 'connection.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:9444' }));
    assert.equal(settings({ home }).endpoint, 'http://127.0.0.1:9444');
    assert.equal(settings({ home, cdp: 'http://127.0.0.1:9555' }).endpoint, 'http://127.0.0.1:9555');
    await writeFile(path.join(home, 'connection.json'), '{broken');
    assert.throws(() => settings({ home }), { code: 'INVALID_CONFIG' });
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 5 }); }
});

test('job paths resolve relative to job; materials are hashed; variables do not execute or recurse', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ask-gemini-web-core-'));
  try {
    await mkdir(path.join(home, 'jobs'));
    await writeFile(path.join(home, 'jobs', 'prompt.txt'), '{{topic}} / {{length}}');
    await writeFile(path.join(home, 'jobs', 'notes.md'), 'source text');
    const filename = path.join(home, 'jobs', 'job.yaml');
    await writeFile(filename, 'promptFile: prompt.txt\nvariables:\n  topic: "{{literal}} $(echo secret)"\n  length: 10\nmaterials: [notes.md]\noutput: ../draft.md\n');
    const job = await loadJob(filename);
    assert.ok(job.prompt.startsWith('{{literal}} $(echo secret) / 10'));
    assert.match(job.materials[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(job.output, path.join(home, 'draft.md'));
    await writeFile(filename, 'prompt: "{{missing}}"');
    await assert.rejects(loadJob(filename), { code: 'MISSING_VARIABLE' });
    await writeFile(filename, 'prompt: "{{toString}}"');
    await assert.rejects(loadJob(filename), { code: 'MISSING_VARIABLE' });
    await writeFile(filename, 'prompt: hi\npromptFile: prompt.txt');
    await assert.rejects(loadJob(filename), { code: 'INVALID_JOB' });
    await writeFile(filename, 'prompt: hi\npassword: nope');
    await assert.rejects(loadJob(filename), { code: 'INVALID_JOB' });
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 5 }); }
});

test('run store guards IDs, prompt integrity, and concurrent browser access', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ask-gemini-web-store-'));
  try {
    const store = new RunStore(settings({ home }));
    assert.throws(() => store.directory('../escape'), { code: 'INVALID_RUN_ID' });
    const filename = path.join(home, 'job.yaml');
    await writeFile(filename, 'prompt: hello');
    const run = await store.create(await loadJob(filename));
    assert.equal(await store.prompt(run), 'hello');
    await writeFile(path.join(store.directory(run.id), 'prompt.txt'), 'tampered');
    await assert.rejects(store.prompt(run), { code: 'PROMPT_CHANGED' });
    await store.lock(async () => { await assert.rejects(store.lock(async () => {}), { code: 'BROWSER_BUSY' }); });
    assert.equal(await store.lock(async () => 'released'), 'released');
    assert.equal((await store.read(run.id)).state, 'prepared');
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 5 }); }
});

test('CDP settings precedence is CLI, environment, remembered, project, default', async () => {
  const cwd = process.cwd(), env = process.env.ASK_GEMINI_WEB_CDP;
  const home = await mkdtemp(path.join(os.tmpdir(), 'gemini-precedence-'));
  try {
    process.chdir(home);
    const config = path.join(home, 'ask-gemini-web.config.json');
    await writeFile(config, JSON.stringify({ cdp: 'http://127.0.0.1:9666' }));
    delete process.env.ASK_GEMINI_WEB_CDP;
    assert.equal(settings({ home }).endpoint, 'http://127.0.0.1:9666');
    const connection = path.join(home, 'connection.json');
    await writeFile(connection, JSON.stringify({ endpoint: 'http://127.0.0.1:9555' }));
    assert.equal(settings({ home }).endpoint, 'http://127.0.0.1:9555');
    process.env.ASK_GEMINI_WEB_CDP = 'http://127.0.0.1:9444';
    assert.equal(settings({ home }).endpoint, 'http://127.0.0.1:9444');
    assert.equal(settings({ home, cdp: 'http://127.0.0.1:9777' }).endpoint, 'http://127.0.0.1:9777');
    delete process.env.ASK_GEMINI_WEB_CDP;
    await rm(config); await rm(connection);
    assert.equal(settings({ home }).endpoint, 'http://127.0.0.1:9222');
  } finally {
    process.chdir(cwd);
    if (env === undefined) delete process.env.ASK_GEMINI_WEB_CDP; else process.env.ASK_GEMINI_WEB_CDP = env;
    await rm(home, { recursive: true, force: true });
  }
});
