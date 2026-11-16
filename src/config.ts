import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { DraftError } from './errors.js';
import { deprecated, environment } from './deprecation.js';

export function localEndpoint(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new DraftError('INVALID_CDP', 'CDP 地址必须是本机 HTTP 地址。'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new DraftError('INVALID_CDP', '仅允许 http://127.0.0.1:端口 等本机 CDP 地址，不允许远程地址或凭证。');
  }
  return url.origin;
}

export function settings(options: { cdp?: string; rememberedCdp?: string; home?: string }, directory = process.cwd()) {
  const newProjectFile = path.resolve(directory, 'ask-gemini-web.config.json');
  const oldProjectFile = path.resolve(directory, 'gemini-draft.config.json');
  const projectFile = existsSync(newProjectFile) ? newProjectFile : oldProjectFile;
  let project: { home?: string; cdp?: string } = {};
  if (existsSync(projectFile)) {
    if (projectFile === oldProjectFile) deprecated('gemini-draft.config.json', 'ask-gemini-web.config.json');
    try { project = z.object({ home: z.string().min(1).optional(), cdp: z.string().optional() }).strict().parse(JSON.parse(readFileSync(projectFile, 'utf8'))); }
    catch { throw new DraftError('INVALID_CONFIG', `无法解析项目配置：${projectFile}`); }
  }
  const explicitHome = options.home || environment('HOME');
  const home = explicitHome ? path.resolve(directory, explicitHome)
    : project.home ? projectHome(path.resolve(directory, project.home)) : defaultHome(directory);
  let remembered: { endpoint?: string } = {};
  const connectionFile = path.join(home, 'connection.json');
  if (existsSync(connectionFile)) {
    try { remembered = z.object({ endpoint: z.string() }).strict().parse(JSON.parse(readFileSync(connectionFile, 'utf8'))); }
    catch { throw new DraftError('INVALID_CONFIG', `无法解析已保存连接：${connectionFile}`); }
  }
  const environmentCdp = options.cdp ? undefined : environment('CDP');
  const endpointSource: 'cli' | 'environment' | 'remembered' | 'project' | 'default' = options.cdp ? 'cli' : environmentCdp ? 'environment'
    : options.rememberedCdp || remembered.endpoint ? 'remembered' : project.cdp ? 'project' : 'default';
  return {
    home,
    profile: path.join(home, 'chrome-profile'),
    runs: path.join(home, 'runs'),
    endpoint: localEndpoint(options.cdp || environmentCdp || options.rememberedCdp || remembered.endpoint || project.cdp || 'http://127.0.0.1:9222'),
    endpointSource,
  };
}

function projectHome(home: string) {
  const name = path.basename(home);
  if (!existsSync(home) && ['.ask-gemini-web', 'ask-gemini-web'].includes(name)) {
    const legacy = path.join(path.dirname(home), name.replace('ask-gemini-web', 'gemini-draft'));
    if (existsSync(legacy)) { deprecated(legacy, home); return legacy; }
  }
  return home;
}

export function defaultHome(directory = process.cwd(), userHome = os.homedir(), platform = process.platform) {
  const data = platform === 'win32' ? process.env.LOCALAPPDATA || userHome : path.join(userHome, '.local', 'share');
  const current = [path.join(directory, '.ask-gemini-web'), path.join(data, 'ask-gemini-web')];
  const existing = current.find(candidate => existsSync(candidate));
  if (existing) return existing;
  const legacy = [path.join(directory, '.gemini-draft'), path.join(data, 'gemini-draft')].find(candidate => existsSync(candidate));
  if (legacy) { deprecated(legacy, current[1]); return legacy; }
  return current[1];
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
