import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseModel, chooseThinking, classify, effortId, resolveModel } from '../src/routing.js';
import { compileJob } from '../src/jobs.js';
import type { Model, ThinkingOption } from '../src/gemini.js';

const make = (name: string, description: string, available = true): Model => ({ id: name.toLowerCase(), name, description, selected: false, availability: available ? 'available' : 'unavailable' });
const models = [make('Quick', '3.5 Flash-Lite'), make('Everyday', '4 Hydrogen'), make('Code', '4 Argon'), make('Hard', '4 Carbon', false), make('Research', '3.1 Pro')];
const levels: ThinkingOption[] = ['low', 'medium', 'high'].map(id => ({ ...make(id, ''), id }));

test('task routing balances simple transformations, prose quality, and complex work', () => {
  for (const prompt of ['请只输出两行。第一行写青竹。', '法国的首都是哪里？', 'What is the capital of France?', '把以下数据整理成表格']) {
    assert.equal(classify(prompt), 'quick');
  }
  assert.equal(classify('请只输出两行', 'analysis'), 'analysis');
  assert.equal(chooseModel(models, '翻译这段文字').model.name, 'Quick');
  assert.equal(chooseModel(models, '写一篇关于城市花园的文章').model.name, 'Everyday');
  assert.equal(chooseModel(models, '写一篇文学故事').model.name, 'Code');
  assert.equal(chooseModel(models, '比较两个方案并分析证据').model.name, 'Everyday');
  assert.equal(chooseModel(models, 'Debug this Python function').model.name, 'Everyday');
  assert.equal(classify('写代码审查报告'), 'coding');
  assert.equal(classify('写一篇文章', 'hard'), 'hard');
  assert.equal(classify('请写一篇180字短文，标题为城市花园'), 'writing');
});
test('explicit models and family aliases override heuristics without fallback', () => {
  assert.equal(chooseModel(models, '翻译', 'Gemini 4 Hydrogen').model.name, 'Everyday');
  assert.equal(resolveModel(models, 'argon').name, 'Code');
  assert.equal(resolveModel(models, 'gemini4hydrogen').name, 'Everyday');
  assert.throws(() => chooseModel(models, '翻译', 'Hard'), { code: 'MODEL_UNAVAILABLE' });
  assert.throws(() => resolveModel(models, 'arbitrary-model'), { code: 'MODEL_NOT_FOUND' });
  assert.throws(() => chooseModel([...models, make('Another', '4 Hydrogen')], '分析'), { code: 'AUTO_MODEL_AMBIGUOUS' });
});
test('thinking uses observed levels, preserves explicit constraints, and accepts mid', () => {
  assert.equal(chooseThinking(levels, 'quick').option.id, 'low');
  assert.equal(chooseThinking(levels, 'writing').option.id, 'medium');
  assert.equal(chooseThinking(levels, 'hard').option.id, 'high');
  assert.equal(chooseThinking(levels, 'hard', 'mid').option.id, 'medium');
  assert.throws(() => chooseThinking(levels, 'hard', 'xhigh'), { code: 'THINKING_UNAVAILABLE' });
  const limited = levels.filter(level => level.id !== 'high');
  assert.equal(chooseThinking(limited, 'hard').option.id, 'medium');
  assert.equal(chooseThinking(limited, 'hard').warnings.length, 1);
});
test('thinking recognizes English labels and descriptions but refuses unknown IDs', () => {
  assert.equal(effortId('Standard'), 'medium');
  assert.equal(effortId('Extended'), 'high');
  assert.equal(effortId('深度模式', 'Extended thinking'), 'high');
  assert.equal(effortId('Mystery', 'Medium or high'), undefined);
  const unknown = [{ ...levels[0], id: 'Mystery', selected: true }];
  assert.throws(() => chooseThinking(unknown, 'quick'), { code: 'THINKING_UNKNOWN' });
});
test('stdin job compilation supports optional auto settings and never classifies appended sources', async () => {
  const job = await compileJob({ prompt: '请改写这段文字', thinking: 'auto' });
  assert.equal(job.taskText, '请改写这段文字');
  assert.equal(job.source, 'stdin');
  assert.equal(job.task, 'auto');
  await assert.rejects(compileJob({ prompt: 'hi', task: 'invented' }), { code: 'INVALID_JOB' });
});
