import { copyFile } from 'node:fs/promises';
// npm excludes package-lock.json from packages; shrinkwrap carries the same pinned tree.
await copyFile(new URL('../package-lock.json', import.meta.url), new URL('../npm-shrinkwrap.json', import.meta.url));
