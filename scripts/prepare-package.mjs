import { access, copyFile } from 'node:fs/promises';
// Both the canonical runner and the deprecated forwarding runner ship in packages.
for (const runner of ['ask-gemini-web', 'gemini-draft']) {
  await access(new URL(`../skills/ask-gemini-web/scripts/${runner}.mjs`, import.meta.url));
}
// npm excludes package-lock.json from packages; shrinkwrap carries the same pinned tree.
await copyFile(new URL('../package-lock.json', import.meta.url), new URL('../npm-shrinkwrap.json', import.meta.url));
