import TurndownService from 'turndown';
import { createDocument } from '@mixmark-io/domino';

export function toMarkdown(html: string) {
  const document = createDocument();
  const body = document.body;
  body.innerHTML = html;
  for (const control of body.querySelectorAll('button, [role="button"], [role="toolbar"], [role="tooltip"], [hidden], [aria-hidden="true"], inline-edit-education-tooltip')) {
    control.remove();
  }
  // Gemini renders literal newlines inside its paragraph text. Turndown otherwise
  // collapses them before its replacement rules run.
  for (const paragraph of body.querySelectorAll('p[data-path-to-node]')) {
    const walker = document.createTreeWalker(paragraph, 4 /* SHOW_TEXT */);
    const multiline: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent?.trim() && node.textContent.includes('\n') && !node.parentElement?.closest('pre, code')) multiline.push(node as Text);
    }
    for (const node of multiline) {
      const fragment = document.createDocumentFragment();
      for (const [i, line] of node.data.split(/\r?\n/).entries()) {
        if (i) fragment.appendChild(document.createElement('br'));
        fragment.appendChild(document.createTextNode(line));
      }
      node.parentNode!.replaceChild(fragment, node);
    }
  }
  const converter = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  converter.addRule('table', {
    filter: 'table',
    replacement: (_content, node) => {
      const table = node as HTMLTableElement;
      const rows = Array.from(table.rows);
      if (!rows.length) return '';
      const width = rows[0].cells.length;
      // GFM cannot represent spans, captions or nested tables losslessly.
      if (table.caption || table.querySelector('table, [colspan], [rowspan]') || rows.some(row => row.cells.length !== width)) {
        return '\n\n' + table.outerHTML + '\n\n';
      }
      const lines = rows.map(row => Array.from(row.cells, cell =>
        converter.turndown(cell.innerHTML).replace(/\|/g, '\\|').replace(/ *\n+/g, '<br>')));
      if (!Array.from(rows[0].cells).every(cell => cell.tagName === 'TH')) lines.unshift(Array(width).fill(''));
      lines.splice(1, 0, Array(width).fill('---'));
      return '\n\n' + lines.map(cells => '| ' + cells.join(' | ') + ' |').join('\n') + '\n\n';
    },
  });
  converter.addRule('gemini-code-block', {
    filter: node => node.nodeName.toLowerCase() === 'code-block' && !!node.querySelector('pre'),
    replacement: (_content, node) => {
      const pre = node.querySelector('pre')!;
      const code = pre.querySelector('code') || pre;
      const language = /(?:language|lang)-([\w+-]+)/.exec(code.className)?.[1] || '';
      const text = code.textContent?.replace(/\n$/, '') || '';
      const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), match => match[0].length));
      const fence = '`'.repeat(longest + 1);
      return `\n\n${fence}${language}\n${text}\n${fence}\n\n`;
    },
  });
  return converter.turndown(body);
}
