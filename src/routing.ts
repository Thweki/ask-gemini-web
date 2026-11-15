import type { Model, ThinkingOption } from './gemini.js';
import { DraftError } from './errors.js';

export const POLICY_VERSION = '2026-11-16';
export type Task = 'quick' | 'writing' | 'analysis' | 'coding' | 'hard';
export type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
type Family = 'lite' | 'hydrogen' | 'argon' | 'carbon' | 'pro' | 'flash' | 'unknown';
const normalized = (text: string) => text.trim().toLowerCase().replace(/^gemini\s*/i, '').replace(/\s+/g, ' ');

export function family(model: Pick<Model, 'name' | 'description'>): Family {
  const text = `${model.name} ${model.description}`.toLowerCase();
  if (/flash[\s-]*lite/.test(text)) return 'lite';
  for (const name of ['hydrogen', 'argon', 'carbon'] as const) if (text.includes(name)) return name;
  if (/\bpro\b/.test(text)) return 'pro';
  if (/\bflash\b/.test(text)) return 'flash';
  return 'unknown';
}

export function classify(text: string, hint?: Task | 'auto'): Task {
  if (hint && hint !== 'auto') return hint;
  if (/数学证明|形式化证明|复杂推理|多步推理|严密论证|竞赛难题|formal proof|multi.step reasoning|olympiad/i.test(text)) return 'hard';
  if (/代码|编程|调试|算法|并发|debug|\b(code|coding|sql|python|typescript|javascript|algorithm)\b/i.test(text)) return 'coding';
  if (/分析|对比|比较|研究|调研|报告|论证|analy[sz]|compar|research|trade.?off|evidence/i.test(text)) return 'analysis';
  if (/润色|改写|翻译|摘要|总结|提取|纠错|translate|rewrit|summari[sz]|extract|proofread|polish/i.test(text)) return 'quick';
  if (/(?:整理|转换|转|输出|列)(?:为|成|一个|以下)?[^。.!?\n]{0,8}(?:表格|列表)|\b(?:format|convert)\b.{0,30}\b(?:table|list|csv|json)\b/i.test(text)) return 'quick';
  if (/写一篇|撰写|创作|短文|故事|文案|\b(draft|write|article|story|poem)\b/i.test(text)) return 'writing';
  if (/标题|一句话|只(?:输出|返回|回答)|headline|\b(?:output|return|reply with) (?:only|exactly)\b/i.test(text)) return 'quick';
  if (text.trim().length <= 120 && /[?？]\s*$|什么是|是什么|是多少|有多少|^(\s*(what|when|where|who|how many)\b)/i.test(text)) return 'quick';
  return 'writing';
}

// Dated policy informed by the linked benchmark snapshot. Orders are task-specific
// engineering choices, not a claim that different benchmark scores are interchangeable.
const orders: Record<Task, Family[]> = {
  quick: ['lite', 'hydrogen', 'flash', 'argon', 'pro', 'carbon'],
  writing: ['hydrogen', 'argon', 'carbon', 'pro', 'flash', 'lite'],
  analysis: ['carbon', 'hydrogen', 'argon', 'pro', 'flash', 'lite'],
  coding: ['carbon', 'hydrogen', 'argon', 'pro', 'flash', 'lite'],
  hard: ['carbon', 'hydrogen', 'argon', 'pro', 'flash', 'lite'],
};
export const taskEffort: Record<Task, Effort> = { quick: 'low', writing: 'medium', analysis: 'high', coding: 'high', hard: 'high' };

export function resolveModel(models: Model[], requested: string) {
  const request = normalized(requested);
  const matched = models.filter(model => [model.id, model.name, model.description, family(model)]
    .some(value => value && normalized(value).replace(/[\s_-]/g, '') === request.replace(/[\s_-]/g, '') && value !== 'unknown'));
  if (matched.length !== 1) throw new DraftError('MODEL_NOT_FOUND', `未找到唯一模型“${requested}”，请使用 models list 返回的名称、ID 或完整型号。`);
  if (matched[0].availability !== 'available') throw new DraftError('MODEL_UNAVAILABLE', `模型“${matched[0].name}”不可用：${matched[0].reason}`);
  return matched[0];
}

export function chooseModel(models: Model[], text: string, requested?: string, hint?: Task | 'auto') {
  const task = classify(text, hint);
  if (requested && requested !== 'auto') return { model: resolveModel(models, requested), task, source: 'explicit' as const, policy: POLICY_VERSION, warnings: [] as string[] };
  const available = models.filter(model => model.availability === 'available');
  if (!available.length) throw new DraftError('NO_AVAILABLE_MODEL', '当前没有可用模型。');
  const preference = task === 'writing' && /小说|诗歌|文学|剧本|故事|创意写作|creative writing|fiction|poetry|story/i.test(text)
    ? ['argon', 'hydrogen', 'carbon', 'pro', 'flash', 'lite'] as Family[] : orders[task];
  for (const candidate of preference) {
    const matched = available.filter(model => family(model) === candidate);
    if (matched.length > 1) throw new DraftError('AUTO_MODEL_AMBIGUOUS', `检测到多个 ${candidate} 型号，请显式指定 model。`);
    if (matched.length === 1) return { model: matched[0], task, source: 'auto' as const, policy: POLICY_VERSION, warnings: [] as string[] };
  }
  const current = available.filter(model => model.selected);
  const fallback = available.length === 1 ? available[0] : current.length === 1 ? current[0] : undefined;
  if (!fallback) throw new DraftError('AUTO_MODEL_UNKNOWN', '没有匹配路由策略的型号，且当前选择不唯一；请显式指定 model。');
  return { model: fallback, task, source: 'auto' as const, policy: POLICY_VERSION, warnings: ['未收录该型号的 benchmark；保留唯一可确认的当前可用模型。'] };
}

export function effortId(input: string): Effort | undefined {
  const value = input.trim().toLowerCase();
  if (/^(minimal|最低|最小)$/.test(value)) return 'minimal';
  if (/^(low|低)$/.test(value)) return 'low';
  if (/^(medium|mid|中|中等)$/.test(value)) return 'medium';
  if (/^(high|高)$/.test(value)) return 'high';
  if (/^(xhigh|extra.high|超高|极高)$/.test(value)) return 'xhigh';
}

export function chooseThinking(options: ThinkingOption[], task: Task, requested?: string) {
  const explicit = !!requested && requested !== 'auto';
  const wanted = explicit ? effortId(requested) || requested : taskEffort[task];
  const available = options.filter(option => option.availability === 'available');
  let matched = available.filter(option => option.id === wanted || normalized(option.name) === normalized(wanted));
  if (matched.length === 1) return { option: matched[0], source: explicit ? 'explicit' as const : 'auto' as const, requested: wanted, warnings: [] as string[] };
  if (explicit) throw new DraftError('THINKING_UNAVAILABLE', `当前模型没有可用思考等级“${requested}”，不会更换模型或静默替代。`);
  const rank: string[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];
  const ranked = available.filter(option => rank.includes(option.id));
  ranked.sort((a, b) => Math.abs(rank.indexOf(a.id) - rank.indexOf(wanted)) - Math.abs(rank.indexOf(b.id) - rank.indexOf(wanted)) || rank.indexOf(a.id) - rank.indexOf(b.id));
  const fallback = ranked[0] || (available.length === 1 ? available[0] : available.find(option => option.selected));
  if (!fallback) throw new DraftError('THINKING_UNKNOWN', '无法确认可用思考等级，请运行 thinking list。');
  return { option: fallback, source: 'auto' as const, requested: wanted, warnings: [`目标等级 ${wanted} 未提供，使用页面实际可用的 ${fallback.id}。`] };
}
