import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { DraftError } from './errors.js';

export function localEndpoint(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new DraftError('INVALID_CDP', 'CDP 地址必须是本机 HTTP 地址。'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new DraftError('INVALID_CDP', '仅允许 http://127.0.0.1:端口 等本机 CDP 地址，不允许远程地址或凭证。');
  }
  return url.origin;
}

export function settings(options: { cdp?: string; home?: string }) {
  const projectFile = path.resolve('gemini-draft.config.json');
  let project: { home?: string; cdp?: string } = {};
  if (existsSync(projectFile)) {
    try { project = z.object({ home: z.string().min(1).optional(), cdp: z.string().optional() }).strict().parse(JSON.parse(readFileSync(projectFile, 'utf8'))); }
    catch { throw new DraftError('INVALID_CONFIG', `无法解析项目配置：${projectFile}`); }
  }
  const base = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'gemini-draft')
    : path.join(os.homedir(), '.local', 'share', 'gemini-draft');
  const home = path.resolve(options.home || process.env.GEMINI_DRAFT_HOME || project.home || base);
  let remembered: { endpoint?: string } = {};
  const connectionFile = path.join(home, 'connection.json');
  if (existsSync(connectionFile)) {
    try { remembered = z.object({ endpoint: z.string() }).strict().parse(JSON.parse(readFileSync(connectionFile, 'utf8'))); }
    catch { throw new DraftError('INVALID_CONFIG', `无法解析已保存连接：${connectionFile}`); }
  }
  return {
    home,
    profile: path.join(home, 'chrome-profile'),
    runs: path.join(home, 'runs'),
    endpoint: localEndpoint(options.cdp || process.env.GEMINI_DRAFT_CDP || remembered.endpoint || project.cdp || 'http://127.0.0.1:9222'),
  };
}
export type Settings = ReturnType<typeof settings>;

export const jobSchema = z.object({
  prompt: z.string().min(1).optional(),
  promptFile: z.string().min(1).optional(),
  variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  materials: z.array(z.string()).default([]),
  model: z.string().min(1).optional(),
  thinking: z.string().min(1).optional(),
  task: z.enum(['auto', 'quick', 'writing', 'analysis', 'coding', 'hard']).default('auto'),
  output: z.string().min(1).optional(),
  timeoutSeconds: z.number().int().min(10).max(7200).default(600),
}).strict().refine(job => Boolean(job.prompt) !== Boolean(job.promptFile), {
  message: '必须且只能提供 prompt 或 promptFile 其中一个。',
});
