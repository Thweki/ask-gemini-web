import { Gemini, type Model, type ThinkingOption } from './gemini.js';
import { chooseModel, chooseThinking, type Task } from './routing.js';
import { DraftError } from './errors.js';

export type SelectionInput = { taskText: string; task?: Task | 'auto'; model?: string; thinking?: string };
export async function selectForTask(gemini: Gemini, input: SelectionInput) {
  const models = await gemini.models();
  const model = chooseModel(models.models, input.taskText, input.model, input.task);
  const chosenModel = await gemini.selectModel(model.model.id);
  // Model changes can change the offered levels; always discover after selecting the model.
  const thinking = chooseThinking((await gemini.thinking()).levels, model.task, input.thinking);
  const chosenThinking = await gemini.selectThinking(thinking.option.id);
  return {
    task: model.task, model: chosenModel, thinking: chosenThinking,
    source: { model: model.source, thinking: thinking.source }, policy: model.policy,
    reason: `${model.task}: ${model.source === 'explicit' ? '用户指定模型' : '按任务与 benchmark 快照匹配可用模型'}; ${thinking.source === 'explicit' ? '用户指定等级' : `目标思考等级 ${thinking.requested}`}`,
    warnings: [...model.warnings, ...thinking.warnings],
  };
}
export type Selection = Awaited<ReturnType<typeof selectForTask>>;

export async function previewSelection(gemini: Gemini, input: SelectionInput) {
  const original = (await gemini.models()).models.filter(model => model.selected);
  const originalThinking = (await gemini.thinking()).levels.filter(level => level.selected);
  if (original.length !== 1 || originalThinking.length !== 1) throw new DraftError('PLAN_RESTORE_UNKNOWN', '无法确认原模型和思考等级，不修改页面以进行预览。');
  try { return await selectForTask(gemini, input); }
  finally {
    await gemini.selectModel(original[0].id);
    await gemini.selectThinking(originalThinking[0].id);
  }
}

export function selectionSummary(selection?: Selection) {
  // Read records saved before model names and localized mode labels were separated.
  const legacyModel = selection && !selection.model.mode && /^(?:gemini\s+\S|\d+(?:\.\d+)*[\s-]+\p{L})/iu.test(selection.model.description);
  return selection ? {
    task: selection.task, model: legacyModel ? selection.model.description : selection.model.name,
    mode: selection.model.mode || selection.model.name, thinking: selection.thinking.id,
    source: selection.source, policy: selection.policy,
    ...(selection.warnings.length ? { warnings: selection.warnings } : {}),
  } : undefined;
}
