import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { settings, localEndpoint } from '../src/config.js';
import { compileJob, loadJob, RunStore } from '../src/jobs.js';

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
    await writeFile(file, '{"prompt":}');
    await assert.rejects(loadJob(file), { code: 'INVALID_JSON' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CDP only accepts credential-free local endpoints', () => {
  assert.equal(localEndpoint('http://127.0.0.1:9222'), 'http://127.0.0.1:9222');
  assert.equal(localEndpoint('http://[::1]:9222'), 'http://[::1]:9222');
  for (const url of ['https://127.0.0.1:9222', 'http://example.com:9222', 'http://user:pass@localhost:9222', 'http://localhost:9222/private', 'http://localhost:9222/?token=x', 'file:///x']) {
    assert.throws(() => localEndpoint(url), { code: 'INVALID_CDP' });
  }
});

test('saved CDP address survives later processes and explicit settings override it', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'gemini-draft-config-'));
  try {
    await writeFile(path.join(home, 'connection.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:9444' }));
    assert.equal(settings({ home }).endpoint, 'http://127.0.0.1:9444');
    assert.equal(settings({ home, cdp: 'http://127.0.0.1:9555' }).endpoint, 'http://127.0.0.1:9555');
    await writeFile(path.join(home, 'connection.json'), '{broken');
    assert.throws(() => settings({ home }), { code: 'INVALID_CONFIG' });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('job paths resolve relative to job; materials are hashed; variables do not execute or recurse', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'gemini-draft-core-'));
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
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('run store guards IDs, prompt integrity, and concurrent browser access', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'gemini-draft-store-'));
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
  } finally { await rm(home, { recursive: true, force: true }); }
});
