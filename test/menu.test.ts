import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Gemini, parseModeLabel } from '../src/gemini.js';
import { selectForTask } from '../src/selection.js';
import { domPage } from './support/dom-page.js';

const fixture = await readFile(new URL('./fixtures/gemini-gem-menu.html', import.meta.url), 'utf8');
const oldFixture = await readFile(new URL('./fixtures/gemini.html', import.meta.url), 'utf8');
function setup(html = fixture) {
  const driver = domPage(html);
  const gemini = new Gemini(driver.page);
  // Authentication has separate browser coverage; these unit tests isolate the menu adapter.
  gemini.requireLogin = async () => ({ status: 'logged_in', reason: 'offline fixture', url: 'https://gemini.google.com/app' });
  return { ...driver, gemini };
}

test('combined mode labels parse model and localized effort from text or aria-label', () => {
  assert.deepEqual(parseModeLabel('Hydrogen\n中'), { model: 'Hydrogen', thinking: 'medium' });
  assert.deepEqual(parseModeLabel('', '打开模式选择器，当前模式为“Hydrogen 中”'), { model: 'Hydrogen', thinking: 'medium' });
  assert.deepEqual(parseModeLabel('4 Hydrogen 高'), { model: '4 Hydrogen', thinking: 'high' });
  assert.deepEqual(parseModeLabel('Test Fast'), { model: 'Test Fast', thinking: undefined });
});

test('Chinese mode label and parent data-test-id each find the new trigger without aria-controls', async () => {
  for (const via of ['label', 'parent']) {
    const { document, gemini } = setup();
    if (via === 'label') document.querySelector('gem-button')!.removeAttribute('data-test-id');
    else document.querySelector('gem-button button')!.removeAttribute('aria-label');
    const models = await gemini.models();
    assert.equal(models.current, '4 Hydrogen');
    assert.deepEqual(models.models.map(model => model.id), ['3-5-flash-lite', '4-hydrogen', '3-1-pro', '4-argon', '4-carbon']);
    assert.equal(models.models[1].mode, '日常帮助');
    assert.equal(models.models[4].availability, 'unavailable');
  }
});

test('new menu selects and verifies models and excludes nested thinking radios even when expanded', async () => {
  const { document, gemini, window } = setup();
  assert.equal((await gemini.selectModel('4-argon')).name, '4 Argon');
  assert.equal((await gemini.models()).current, '4 Argon');
  await assert.rejects(gemini.selectModel('4-carbon'), { code: 'MODEL_UNAVAILABLE' });
  await assert.rejects(gemini.selectModel('absent'), { code: 'MODEL_NOT_FOUND' });
  document.querySelector('.thinking-levels')!.removeAttribute('hidden');
  document.querySelector('[value="thinking_level"]')!.setAttribute('aria-expanded', 'true');
  assert.equal((await gemini.models()).models.length, 5);
  assert.equal((window as any).sendCount, 0);
});

test('repeated discovery and task selection work with or without Escape dismissal', async () => {
  for (const ignoreEscape of [false, true]) {
    const { document, gemini, window } = setup();
    const state = window as any;
    state.ignoreMenuEscape = ignoreEscape;
    const trigger = document.querySelector('gem-button button')!;
    assert.equal(trigger.getAttribute('aria-expanded'), null);
    assert.equal(trigger.getAttribute('aria-controls'), null);
    assert.equal((await gemini.models()).current, '4 Hydrogen');
    assert.equal((await gemini.models()).current, '4 Hydrogen');
    assert.equal(state.modelTriggerClicks, ignoreEscape ? 1 : 2);
    assert.equal((await gemini.selectModel('4 Argon')).name, '4 Argon');
    assert.equal((await gemini.models()).current, '4 Argon');
    const selected = await selectForTask(gemini, {
      taskText: 'Write a short article', model: '4 Hydrogen', thinking: 'high',
    });
    assert.equal(selected.model.name, '4 Hydrogen');
    assert.equal(selected.thinking.id, 'high');
    assert.equal(state.sendCount, 0);
  }
});

test('opening reuses visible fallback menus and ignores stale aria-expanded on hidden menus', async () => {
  for (const fallback of ['dedicated', 'gem-menu', 'role-menu']) {
    let html = fixture;
    if (fallback !== 'dedicated') html = html.replace('data-test-id="gem-mode-menu"', '');
    if (fallback === 'role-menu') html = html.replace('<gem-menu ', '<div ').replace('</gem-menu>', '</div>')
      .replace("document.querySelector('gem-menu')", "document.querySelector('[role=menu]')");
    const { document, gemini, window } = setup(html);
    (window as any).ignoreMenuEscape = true;
    document.querySelector('gem-button button')!.setAttribute('aria-expanded', 'true');
    assert.equal((await gemini.models()).current, '4 Hydrogen');
    assert.equal((await gemini.models()).current, '4 Hydrogen');
    assert.equal((window as any).modelTriggerClicks, 1);
  }
});

test('discovery waits for delayed Escape dismissal before returning', async () => {
  const { document, gemini, window } = setup();
  (window as any).menuEscapeDelay = 30;
  assert.equal((await gemini.models()).current, '4 Hydrogen');
  assert.equal(document.querySelector<HTMLElement>('gem-menu')!.hidden, true);
});

test('a delayed menu open is awaited without clicking the toggle again', async () => {
  const { document, gemini } = setup();
  let clicks = 0;
  document.querySelector<HTMLElement>('gem-button button')!.onclick = () => {
    clicks++;
    setTimeout(() => { document.querySelector<HTMLElement>('gem-menu')!.hidden = false; }, 30);
  };
  assert.equal((await gemini.models()).current, '4 Hydrogen');
  assert.equal(clicks, 1);
});

test('same-menu thinking expands and selects low, medium, high without exposing models as levels', async () => {
  const { gemini, window } = setup();
  assert.equal((await gemini.thinking()).current, 'medium');
  assert.deepEqual((await gemini.thinking()).levels.map(level => level.id), ['low', 'medium', 'high']);
  for (const [label, id] of [['低', 'low'], ['高', 'high'], ['中', 'medium']]) {
    assert.equal((await gemini.selectThinking(label)).id, id);
    assert.equal((await gemini.thinking()).current, id);
    assert.equal((await gemini.models()).current, '4 Hydrogen');
  }
  await assert.rejects(gemini.selectThinking('xhigh'), { code: 'THINKING_UNAVAILABLE' });
  assert.equal((window as any).sendCount, 0);
});

test('combined trigger verifies current model and thinking when radio selection markers are absent', async () => {
  for (const ariaOnly of [false, true]) {
    const { document, gemini } = setup();
    document.querySelectorAll('[aria-checked]').forEach(element => element.removeAttribute('aria-checked'));
    if (ariaOnly) document.querySelector('gem-button button')!.textContent = '';
    assert.equal((await gemini.models()).current, '4 Hydrogen');
    assert.equal((await gemini.thinking()).current, 'medium');
    assert.equal((await gemini.thinking()).levels.find(level => level.selected)?.id, 'medium');
  }
});

test('visible-menu fallbacks prefer the dedicated gem-menu and reject ambiguity, absence or invalid controls', async () => {
  for (const fallback of ['gem-menu', 'role-menu']) {
    let html = fixture.replace('data-test-id="gem-mode-menu"', '');
    if (fallback === 'role-menu') html = html.replace('<gem-menu ', '<div ').replace('</gem-menu>', '</div>')
      .replace("document.querySelector('gem-menu')", "document.querySelector('[role=menu]')");
    const { gemini } = setup(html);
    assert.equal((await gemini.models()).current, '4 Hydrogen');
  }
  {
    const { document, gemini } = setup();
    const other = document.createElement('div'); other.setAttribute('role', 'menu'); document.body.appendChild(other);
    assert.equal((await gemini.models()).current, '4 Hydrogen');
  }
  {
    const { document, gemini } = setup();
    document.querySelector('gem-menu')!.removeAttribute('hidden');
    const other = document.querySelector('gem-menu')!.cloneNode(true) as Element;
    other.removeAttribute('hidden'); document.body.appendChild(other);
    await assert.rejects(gemini.models(), { code: 'AMBIGUOUS_UI' });
  }
  for (const id of ['', 'invalid id', 'missing-menu']) {
    const { document, gemini } = setup();
    document.querySelector('gem-button button')!.setAttribute('aria-controls', id);
    await assert.rejects(gemini.models(), { code: 'MODEL_MENU_UNKNOWN' });
  }
  {
    const { document, gemini } = setup();
    let clicks = 0;
    document.querySelector<HTMLElement>('gem-button button')!.onclick = () => { clicks++; };
    let now = 0;
    const time = mock.method(Date, 'now', () => { now += 20000; return now; });
    try { await assert.rejects(gemini.models(), { code: 'MODEL_MENU_UNKNOWN' }); }
    finally { time.mock.restore(); }
    assert.equal(clicks, 1);
  }
});

test('inline thinking fails closed on ignored expansion and ignored selection', async () => {
  const { document, gemini } = setup();
  const expander = document.querySelector<HTMLElement>('[value="thinking_level"]')!;
  const original = expander.onclick;
  expander.onclick = () => {};
  await assert.rejects(gemini.thinking(), { code: 'THINKING_MENU_UNKNOWN' });
  expander.onclick = original;
  document.querySelector<HTMLElement>('.thinking-levels gem-menu-item')!.onclick = event => event.stopPropagation();
  await assert.rejects(gemini.selectThinking('low'), { code: 'THINKING_SELECTION_UNVERIFIED' });
});

test('old hover submenu still selects models and thinking, and invalid aria-controls still fail closed', async () => {
  const { document, gemini } = setup(oldFixture);
  assert.equal((await gemini.models()).current, 'Test Fast');
  assert.equal((await gemini.selectModel('Test Reasoning')).name, 'Test Reasoning');
  assert.equal((await gemini.thinking()).current, 'medium');
  assert.equal((await gemini.selectThinking('low')).id, 'low');
  for (const id of [null, 'invalid id', 'model-menu']) {
    const trigger = document.querySelector('#model-menu [aria-haspopup]')!;
    if (id === null) trigger.removeAttribute('aria-controls');
    else trigger.setAttribute('aria-controls', id);
    await assert.rejects(gemini.selectThinking('high'), { code: 'THINKING_MENU_UNKNOWN' });
  }
});

test('sibling thinking radios stay scoped to the expanded section and are excluded from models', async () => {
  const { document, gemini } = setup();
  const menu = document.querySelector('gem-menu')!;
  const expander = document.querySelector<HTMLElement>('[value="thinking_level"]')!;
  const levels = Array.from(document.querySelectorAll<HTMLElement>('.thinking-levels [role="menuitemradio"]'));
  levels.forEach(level => { level.hidden = true; menu.appendChild(level); });
  expander.onclick = () => {
    expander.setAttribute('aria-expanded', 'true'); levels.forEach(level => { level.hidden = false; });
  };
  assert.deepEqual((await gemini.thinking()).levels.map(level => level.id), ['low', 'medium', 'high']);
  assert.equal((await gemini.selectThinking('high')).id, 'high');
  assert.equal((await gemini.models()).models.length, 5);
});

test('new inline levels retain unknown/duplicate fail-closed checks', async () => {
  const { document, gemini } = setup();
  const first = document.querySelector('.thinking-levels gem-menu-item')!;
  first.innerHTML = '<span>Mystery</span><br>Unknown effort';
  await assert.rejects(gemini.thinking(), { code: 'THINKING_UNKNOWN' });
  first.innerHTML = '<span>中</span>';
  await assert.rejects(gemini.thinking(), { code: 'AMBIGUOUS_THINKING' });
});
