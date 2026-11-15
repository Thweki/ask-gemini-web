import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

function cli(args: string[], input?: string | Buffer) {
  return spawnSync(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), ...args], { encoding: 'utf8', input, timeout: 10000 });
}
test('stdin preserves UTF-8 split across pipe writes and accepts a BOM', async () => {
  const prompt = '一𠮷🚲';
  const raw = Buffer.from('\uFEFF' + JSON.stringify({ prompt }));
  const splits = ['一', '𠮷', '🚲'].map((char, i) => raw.indexOf(Buffer.from(char)) + i + 1);
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--json', 'run', '--stdin', '--dry-run']);
  let out = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { out += chunk; });
  const closed = new Promise(resolve => child.once('close', resolve));
  let start = 0;
  for (const end of splits) {
    child.stdin.write(raw.subarray(start, end));
    await new Promise(resolve => setTimeout(resolve, 450));
    start = end;
  }
  child.stdin.end(raw.subarray(start));
  assert.equal(await closed, 0);
  assert.equal(JSON.parse(out).prompt, prompt);
});

test('CLI JSON errors cover invalid input bytes, syntax and arguments', () => {
  for (const [args, input, code] of [
    [['run', '--stdni'], '', 'INVALID_ARGUMENT'],
    [['export', 'abc'], '', 'INVALID_ARGUMENT'],
    [['run', '--stdin', '--dry-run'], '{"prompt":}', 'INVALID_JSON'],
    [['run', '--stdin', '--dry-run'], Buffer.from([0xff]), 'INVALID_UTF8'],
    [['run', '--stdin', '--dry-run'], Buffer.alloc(2 * 1024 * 1024 + 1, 32), 'INPUT_TOO_LARGE'],
  ] as const) {
    const r = cli(['--json', ...args], input);
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stdout).error.code, code);
    assert.equal(r.stderr, '');
  }
  assert.equal(cli(['--json', '--help']).status, 0);
});
test('CLI dry-run is usable without Chrome and stdout is parseable JSON', () => {
  const result = cli(['run', 'examples/article.yaml', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.dryRun, true);
  assert.match(output.prompt, /独立创作者/);
});
test('CLI rejects remote CDP with structured error and nonzero exit', () => {
  const result = cli(['--json', '--cdp', 'http://example.com:9222', 'auth', 'status']);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_CDP');
});

test('CLI accepts JSON on stdin with compact output and explicit thinking override', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), '--compact', 'run', '--stdin', '--dry-run', '--thinking', 'mid'], {
    input: JSON.stringify({ prompt: 'Write a short article' }), encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.thinking, 'mid');
  assert.equal(result.stdout.trim().split('\n').length, 1);
});
