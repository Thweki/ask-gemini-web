import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMarkdown } from '../src/markdown.js';

test('Gemini paragraph line breaks survive span wrapping', () => {
  assert.equal(toMarkdown('<p data-path-to-node="0"><span>青竹\nGD-816</span></p>'), '青竹  \nGD-816');
});

test('inline preview exports table cells and omits controls and editing hints', () => {
  const html = '<inline-preview><button>导出</button><table><tbody><tr><th><p>颜色</p></th><th><p>数量</p></th></tr>'
    + '<tr><td><p><b>青色</b>|紫色</p></td><td><p>12</p></td></tr></tbody></table>'
    + '<inline-edit-education-tooltip aria-hidden="true">直接修改或使用 Gemini 修改</inline-edit-education-tooltip></inline-preview>';
  assert.equal(toMarkdown(html), '| 颜色 | 数量 |\n| --- | --- |\n| **青色**\\|紫色 | 12 |');
});

test('export keeps Gemini code while omitting copy buttons and language toolbar labels', () => {
  const markdown = toMarkdown('<h1>Example</h1><code-block><div class="code-block-decoration">JSON<button>Copy</button></div><pre><code class="language-json">{"prompt":"hi"}\n</code></pre></code-block>');
  assert.equal(markdown, '# Example\n\n```json\n{"prompt":"hi"}\n```');
});
test('embedded backticks cannot terminate an exported fenced code block early', () => {
  const markdown = toMarkdown('<code-block><div>Plaintext</div><pre><code>```text\nexample\n```</code></pre></code-block>');
  assert.ok(markdown.startsWith('````\n'));
  assert.ok(markdown.endsWith('\n````'));
});
