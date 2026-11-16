import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Connection } from '../src/browser.js';
import { settings } from '../src/config.js';
import { Gemini } from '../src/gemini.js';
import { compileJob, resume, RunStore } from '../src/jobs.js';

test('restored task closes after durable collection before a failed export; incomplete collection keeps it', async () => {
  for (const incomplete of [false, true]) {
    const home = await mkdtemp(path.join(os.tmpdir(), 'gemini-restored-mock-'));
    let closed = 0, keepPages: boolean | undefined;
    const url = 'https://gemini.google.com/app/original';
    const page = { url: () => url, setDefaultTimeout() {}, close: async () => { closed++; } };
    const connection = {
      endpoint: 'http://127.0.0.1:9444',
      context: { pages: () => [page], newCDPSession: async () => ({
        send: async () => ({ targetInfo: { targetId: 'original' } }), detach: async () => {},
      }) },
      newTaskPage: async () => assert.fail('Must restore the recorded target'),
      disconnect: async (keep: boolean) => { keepPages = keep; },
    } as unknown as Connection;
    const mocks = [
      mock.method(Gemini.prototype, 'requireLogin', async () => ({ status: 'logged_in', reason: '', url } as const)),
      mock.method(Gemini.prototype, 'userPrompts', async () => ['Original task']),
      mock.method(Gemini.prototype, 'progress', async () => {
        if (incomplete) throw new Error('Collection interrupted');
        return { text: 'Saved answer', html: '<p>Saved answer</p>', count: 1, done: true, generating: false };
      }),
    ];
    // Advance stability checks without waiting for browser response animations.
    let now = Date.now();
    mocks.push(mock.method(Date, 'now', () => { now += 1000; return now; }) as any);
    try {
      const cfg = settings({ home });
      const store = new RunStore(cfg);
      const output = path.join(home, 'draft.md');
      const run = await store.create(await compileJob({ prompt: 'Original task', output }));
      run.state = 'submitted'; run.targetId = 'original'; run.conversationUrl = url;
      await store.save(run);
      await writeFile(output, 'User-owned file');
      await assert.rejects(resume(cfg, run.id, () => {}, async () => connection), incomplete ? /Collection interrupted/ : { code: 'OUTPUT_EXISTS' });
      const saved = await store.read(run.id);
      assert.equal(saved.state, incomplete ? 'submitted' : 'collected');
      assert.equal(closed, incomplete ? 0 : 1);
      assert.equal(keepPages, incomplete);
      assert.equal(await readFile(output, 'utf8'), 'User-owned file');
      if (!incomplete) assert.match(await readFile(saved.result!, 'utf8'), /Saved answer/);
    } finally {
      for (const mocked of mocks) mocked.mock.restore();
      await rm(home, { recursive: true, force: true });
    }
  }
});
