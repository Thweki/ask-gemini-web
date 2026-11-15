import type { Locator, Page } from 'playwright-core';
import { DraftError } from './errors.js';
import { isGemini, pageEndpoint, pause } from './browser.js';
import { effortId } from './routing.js';

// Gemini has no public automation contract. Keep fallbacks here and fail closed on ambiguity.
export const selectors = {
  composer: ['rich-textarea .ql-editor[contenteditable="true"]', 'rich-textarea [contenteditable="true"]', '[role="textbox"][contenteditable="true"]', 'textarea[aria-label]'],
  account: ['[aria-label*="Google Account"]', '[aria-label*="Google 账号"]', '[aria-label*="Google 帐号"]', '[aria-label*="Google 帐户"]', '[aria-label*="Google 帳戶"]', '[aria-label*="Google 帳號"]', '[aria-label*="Google アカウント"]'],
  model: ['button[data-test-id="bard-mode-menu-button"]', 'button[data-test-id="model-selector"]', 'button[aria-label*="Choose a model"]', 'button[aria-label*="Open mode picker"]', 'button[aria-label*="选择模型"]', 'button[aria-label*="选择模式"]', '.model-switcher button'],
  overlay: '[role="menu"]:visible, [role="listbox"]:visible, .cdk-overlay-pane:visible',
  options: '[role="menuitemradio"], [role="menuitem"], [role="option"], button[data-test-id*="mode-option"], button.bard-mode-list-button, button[data-test-id*="model-option"], button[data-test-id*="bard-mode-option"]',
  send: ['button[data-test-id="send-button"]', 'button[aria-label="Send message"]', 'button[aria-label="Send"]', 'button[aria-label="发送消息"]', 'button[aria-label="发送"]', 'button.send-button'],
  stop: ['button[aria-label="Stop response"]', 'button[aria-label="Stop generating"]', 'button[aria-label="停止回答"]', 'button[aria-label="停止生成"]', 'button[data-test-id="stop-button"]', 'button.stop-button'],
  responses: 'model-response',
  responseBody: '.markdown, .model-response-text, [data-test-id="response-content"]',
  userMessages: 'user-query',
  userBody: '.query-text, .user-query-content, [data-test-id="user-query"]',
  errors: '[role="alert"]:visible, .error-message:visible, .response-error:visible',
};

export type AuthStatus = 'logged_in' | 'logged_out' | 'challenge' | 'consent_required' | 'restricted' | 'unknown';
export type Auth = { status: AuthStatus; reason: string; url: string };
export type Model = { id: string; name: string; mode?: string; description: string; availability: 'available' | 'unavailable'; selected: boolean; reason?: string };
export type ThinkingOption = Model;
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
export const modelId = (name: string) => normalize(name).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');

async function firstVisible(page: Page, candidates: string[]): Promise<Locator | undefined> {
  for (const selector of candidates) {
    const matches = page.locator(selector);
    const visible: Locator[] = [];
    for (let i = 0; i < await matches.count(); i++) {
      if (await matches.nth(i).isVisible()) visible.push(matches.nth(i));
    }
    if (visible.length > 1) throw new DraftError('AMBIGUOUS_UI', `页面出现多个匹配控件：${selector}`);
    if (visible.length === 1) return visible[0];
  }
}

async function waitVisible(page: Page, candidates: string[], timeout = 15000) {
  const deadline = Date.now() + timeout;
  do {
    const locator = await firstVisible(page, candidates);
    if (locator) return locator;
    await pause(200);
  } while (Date.now() < deadline);
}

export class Gemini {
  constructor(public page: Page) { page.setDefaultTimeout(8000); }

  async auth(): Promise<Auth> {
    const originalUrl = this.page.url();
    let parsed: URL;
    try { parsed = new URL(originalUrl); } catch { return { status: 'unknown', reason: '页面尚未就绪', url: 'about:blank' }; }
    // Login URLs can carry account hints and redirect tokens in their query string.
    const url = parsed.origin + parsed.pathname;
    const result = (status: AuthStatus, reason: string): Auth => ({ status, reason, url });
    if (parsed.origin === 'https://accounts.google.com') {
      return /challenge|recovery|signin\/v2\/challenge/i.test(parsed.pathname)
        ? result('challenge', '请在 Google 页面手动完成验证')
        : result('logged_out', '请在 Google 官方页面手动登录');
    }
    if (!isGemini(url)) return result('unknown', '当前不是 Gemini 官方页面');
    const captcha = this.page.locator('iframe[src*="recaptcha"][title], iframe[title*="challenge"]');
    for (let i = 0; i < await captcha.count(); i++) {
      if (await captcha.nth(i).isVisible()) return result('challenge', '页面需要人工验证');
    }
    const outsideMessages = this.page.locator(':not(model-response *, user-query *)');
    const dialog = this.page.getByRole('dialog').and(outsideMessages).filter({ hasText: /terms|privacy|consent|条款|隐私|同意/i });
    if (await dialog.count() && await dialog.first().isVisible()) return result('consent_required', '请手动阅读并处理同意或条款弹窗');
    const signIn = this.page.getByRole('link', { name: /^(sign in|log in|登录|登入)$/i })
      .or(this.page.getByRole('button', { name: /^(sign in|log in|登录|登入)$/i })).and(outsideMessages);
    for (let i = 0; i < await signIn.count(); i++) {
      if (await signIn.nth(i).isVisible()) return result('logged_out', '页面显示登录入口');
    }
    const restricted = this.page.getByRole('heading').and(outsideMessages).filter({ hasText: /not available|not supported|无法使用|不受支持|暂不支持|无法访问/i });
    if (await restricted.count() && await restricted.first().isVisible()) return result('restricted', '账号、地区或服务当前不可用');
    const composer = await firstVisible(this.page, selectors.composer);
    const account = await firstVisible(this.page, selectors.account);
    if (account && composer) return result('logged_in', '检测到 Google 账号控件和 Gemini 输入框');
    return result('unknown', '尚未同时检测到账号控件与可用输入框；可能仍在加载或页面结构已变化');
  }

  async waitForAuth(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    let result: Auth;
    do {
      result = await this.auth();
      if (result.status !== 'unknown') return result;
      await pause(400);
    } while (Date.now() < deadline);
    return result!;
  }

  async requireLogin() {
    const auth = await this.waitForAuth();
    if (auth.status !== 'logged_in') throw new DraftError(`AUTH_${auth.status.toUpperCase()}`, `${auth.reason}。CDP：${pageEndpoint(this.page) || '当前连接'}。运行 gemini-draft login，或在同一浏览器完成登录。`, 3);
    return auth;
  }

  async composer() {
    const composer = await waitVisible(this.page, selectors.composer);
    if (!composer) throw new DraftError('UI_CHANGED', '找不到 Gemini 输入框，请运行 doctor 检查页面适配。');
    return composer;
  }

  private async modelTrigger() {
    const trigger = await waitVisible(this.page, selectors.model);
    if (!trigger) throw new DraftError('MODEL_MENU_UNKNOWN', '无法识别模型选择器，不能确认可用模型。请运行 doctor；不会自动改用默认模型。');
    return trigger;
  }

  private async controlledMenu(trigger: Locator): Promise<Locator> {
    const id = await trigger.getAttribute('aria-controls');
    return this.menuById(id);
  }

  private async menuById(id: string | null, code = 'MODEL_MENU_UNKNOWN'): Promise<Locator> {
    if (!id || !/^[\w-]+$/.test(id)) throw new DraftError(code, '菜单缺少有效的 aria-controls，停止选择。');
    const menu = this.page.locator(`#${id}`);
    try { await menu.waitFor({ state: 'visible' }); }
    catch { throw new DraftError(code, 'aria-controls 指向的菜单无法唯一确认，停止选择。'); }
    if (!['menu', 'listbox'].includes(await menu.getAttribute('role') || '')) {
      throw new DraftError(code, 'aria-controls 未指向可识别的菜单，停止选择。');
    }
    return menu;
  }

  private async openModels() {
    const trigger = await this.modelTrigger();
    if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
    return { trigger, menu: await this.controlledMenu(trigger) };
  }

  private async closeMenus() {
    // A submenu and its parent can require separate Escape events.
    await this.page.keyboard.press('Escape');
    await this.page.keyboard.press('Escape');
  }

  private async options(root: Locator, kind: 'model' | 'thinking' = 'model') {
    // Only inspect a newly opened model menu, never arbitrary buttons in the chat.
    const candidates = root.locator(selectors.options);
    await candidates.first().waitFor({ state: 'visible' });
    const collected: { model: Model; locator: Locator }[] = [];
    for (let i = 0; i < await candidates.count(); i++) {
      const locator = candidates.nth(i);
      if (!await locator.isVisible()) continue;
      const data = await locator.evaluate(element => ({
        submenu: element.getAttribute('aria-haspopup') === 'true' || element.getAttribute('aria-haspopup') === 'menu',
        text: (element as HTMLElement).innerText,
        label: element.getAttribute('aria-label'),
        disabled: element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true',
        selected: element.getAttribute('aria-checked') === 'true' || element.getAttribute('aria-selected') === 'true'
          || element.classList.contains('selected'),
        upgrade: !!element.querySelector('a[href*="upgrade"], a[href*="subscriptions"]'),
        locked: !!element.querySelector('[data-mat-icon-name="lock"], [aria-label="Locked"], [aria-label="已锁定"]'),
      }));
      if (data.submenu) continue;
      const lines = data.text.split('\n').map(line => line.trim()).filter(line => line && !/^(check|check_circle|lock|expand_more|keyboard_arrow_down|arrow_forward|done)$/i.test(line));
      const label = lines[0] || data.label?.trim();
      if (!label || /^(close|cancel|关闭|取消)$/i.test(label)) continue;
      // Gemini can put a localized use-case label before the actual model name.
      const modelLines = kind === 'model' ? lines.filter(line => /^(?:gemini\s+\S|(?:gemini\s+)?\d+(?:\.\d+)*[\s-]+[\p{L}]|(?:hydrogen|argon|carbon|flash(?:[ -]lite)?|pro)\b)/iu.test(line)) : [];
      if (modelLines.length > 1) throw new DraftError('AMBIGUOUS_MODELS', '同一选项出现多个型号，停止选择。');
      const name = modelLines[0] || label;
      const description = lines.filter((line, index) => line !== name && !(modelLines.length && index === 0)).join(' ');
      const id = kind === 'thinking' ? effortId(name, description) : modelId(name);
      if (!id) throw new DraftError('THINKING_UNKNOWN', `无法归一化思考等级“${name}”，停止选择。`);
      const unavailable = data.disabled || data.upgrade || data.locked || /(^|\n)\s*lock\s*(\n|$)|upgrade|unlock|升级|解锁|达到.*上限|limit reached/i.test(data.text);
      collected.push({ locator, model: {
        id, name, description, ...(kind === 'model' && name !== label ? { mode: label } : {}), selected: data.selected,
        availability: unavailable ? 'unavailable' : 'available',
        ...(unavailable ? { reason: data.disabled ? '页面控件已禁用' : '页面显示升级或额度限制' } : {}),
      } });
    }
    if (!collected.length) throw new DraftError('MODEL_MENU_UNKNOWN', '模型菜单已打开，但无法识别选项；请更新页面适配。');
    const ids = collected.map(item => item.model.id);
    if (new Set(ids).size !== ids.length) throw new DraftError(kind === 'thinking' ? 'AMBIGUOUS_THINKING' : 'AMBIGUOUS_MODELS', '菜单包含重名选项，无法安全选择。');
    return collected;
  }

  async models(): Promise<{ current: string; models: Model[] }> {
    await this.requireLogin();
    const { trigger, menu } = await this.openModels();
    try {
      const models = (await this.options(menu)).map(item => item.model);
      const selected = models.filter(model => model.selected);
      const triggerLines = (await trigger.innerText()).split('\n').map(normalize);
      const current = selected.length ? selected : models.filter(model => [model.name, model.mode].some(value => value && triggerLines.includes(normalize(value))));
      if (current.length !== 1) throw new DraftError('MODEL_CURRENT_UNKNOWN', '无法唯一确认当前模型。');
      return { current: current[0].name, models };
    } finally { await this.closeMenus(); }
  }

  async selectModel(requested: string): Promise<Model> {
    await this.requireLogin();
    const { trigger, menu } = await this.openModels();
    try {
      const options = await this.options(menu);
      const matched = options.filter(({ model }) => model.id === modelId(requested) || [model.name, model.mode].some(value => value && normalize(value) === normalize(requested)));
      if (matched.length !== 1) throw new DraftError('MODEL_NOT_FOUND', `未找到唯一模型“${requested}”。请先运行 models list 获取实际名称或 ID。`);
      const { model, locator } = matched[0];
      if (model.availability !== 'available') throw new DraftError('MODEL_UNAVAILABLE', `模型“${model.name}”不可用：${model.reason}`);
      await locator.click();
      await menu.waitFor({ state: 'hidden' });
      // Reopen and verify selected state rather than assuming the click succeeded.
      const reopened = await this.openModels();
      const selected = (await this.options(reopened.menu)).filter(item => item.model.selected);
      const triggerLines = (await trigger.innerText()).split('\n').map(normalize);
      if (selected.length ? selected.length !== 1 || selected[0].model.id !== model.id : !triggerLines.includes(normalize(model.name))) {
        throw new DraftError('MODEL_SELECTION_UNVERIFIED', `无法确认模型已切换为“${model.name}”，任务未发送。`);
      }
      return { ...model, selected: true };
    } finally { await this.closeMenus(); }
  }

  private async openThinking() {
    const { menu } = await this.openModels();
    const triggers = menu.locator('[role="menuitem"][aria-haspopup]').filter({ hasText: /thinking|reasoning|思考|推理/i });
    if (await triggers.count() !== 1) throw new DraftError('THINKING_MENU_UNKNOWN', '无法唯一识别思考等级子菜单。');
    const trigger = triggers.first();
    const id = await trigger.getAttribute('aria-controls');
    if (!id || id === await menu.getAttribute('id')) throw new DraftError('THINKING_MENU_UNKNOWN', '无法确认独立的思考等级子菜单，停止选择。');
    // Real Gemini expands this submenu on hover; click alone does not reliably open it.
    await trigger.hover();
    return await this.menuById(id, 'THINKING_MENU_UNKNOWN');
  }

  async thinking(): Promise<{ current: string | null; levels: ThinkingOption[] }> {
    await this.requireLogin();
    try {
      const menu = await this.openThinking();
      const levels = (await this.options(menu, 'thinking')).map(({ model }) => model);
      const selected = levels.filter(level => level.selected);
      return { current: selected.length === 1 ? selected[0].id : null, levels };
    } finally { await this.closeMenus(); }
  }

  async selectThinking(requested: string): Promise<ThinkingOption> {
    await this.requireLogin();
    const wanted = effortId(requested) || requested;
    try {
      const menu = await this.openThinking();
      const items = await this.options(menu, 'thinking');
      const matched = items.filter(({ model }) => model.id === wanted);
      if (matched.length !== 1 || matched[0].model.availability !== 'available') throw new DraftError('THINKING_UNAVAILABLE', `页面未提供可用思考等级“${requested}”。`);
      await matched[0].locator.click();
      await this.closeMenus();
      const verified = (await this.thinking()).levels.filter(option => option.selected);
      if (verified.length !== 1 || verified[0].id !== wanted) throw new DraftError('THINKING_SELECTION_UNVERIFIED', `无法确认思考等级已切换为 ${requested}，任务未发送。`);
      return verified[0];
    } finally { await this.closeMenus(); }
  }

  async fill(prompt: string) { await (await this.composer()).fill(prompt); }

  async newConversation() {
    await this.requireLogin();
    const links = this.page.getByRole('link', { name: /^(new chat|start a new chat|发起新对话|新对话|開始新對話)$/i });
    for (let i = 0; i < await links.count(); i++) {
      if (await links.nth(i).isVisible()) { await links.nth(i).click(); break; }
    }
    const deadline = Date.now() + 15000;
    do {
      const url = new URL(this.page.url());
      if (url.pathname === '/app' && !(await this.userPrompts()).length) return;
      await pause(200);
    } while (Date.now() < deadline);
    throw new DraftError('EXPECTED_NEW_CHAT', '无法确认空白新对话，任务未发送。');
  }

  async sendButton() {
    const send = await waitVisible(this.page, selectors.send, 8000);
    if (!send || !await send.isEnabled()) throw new DraftError('SEND_UNAVAILABLE', '发送按钮未就绪，未尝试发送。');
    return send;
  }

  async submit(send: Locator) {
    await send.click();
  }

  async progress() {
    if (!isGemini(this.page.url())) throw new DraftError('UNEXPECTED_NAVIGATION', '任务页面已离开 Gemini。');
    const responses = this.page.locator(selectors.responses);
    const count = await responses.count();
    let text = '', html = '', done = false, busy = false;
    if (count) {
      const response = responses.last();
      const body = response.locator(selectors.responseBody).first();
      if (await body.count()) { text = await body.innerText(); html = await body.innerHTML(); }
      busy = await response.getAttribute('aria-busy') === 'true' || await response.locator('[aria-busy="true"]:visible').count() > 0;
      const actions = response.locator('button:not(.markdown *, .model-response-text *, [data-test-id="response-content"] *, code-block *, inline-preview *)');
      const completion = actions.and(this.page.getByRole('button', { name: /^(copy( response| text)?|复制(回答|回复|文本)?|good response|赞|顶)$/i })
        .or(this.page.locator('[data-test-id="copy-button"]')));
      for (let i = 0; i < await completion.count(); i++) if (await completion.nth(i).isVisible()) done = true;
    }
    const errors = await this.page.locator(selectors.errors).allTextContents();
    const quota = errors.find(text => /limit|quota|too many|上限|额度|过于频繁/i.test(text));
    if (quota) throw new DraftError('QUOTA_REACHED', 'Gemini 页面显示额度或频率限制；保留任务供后续恢复。');
    const failure = errors.find(text => /went wrong|try again|failed|出错|重试|失败/i.test(text));
    if (failure) throw new DraftError('GENERATION_FAILED', 'Gemini 页面显示生成失败；任务不会自动重新发送。');
    return { text, html, done: done && !busy, generating: busy || !!await firstVisible(this.page, selectors.stop), count };
  }

  async userPrompts() {
    const messages = this.page.locator(selectors.userMessages);
    const texts: string[] = [];
    for (let i = 0; i < await messages.count(); i++) {
      const body = messages.nth(i).locator(selectors.userBody).first();
      if (await body.count()) {
        // Gemini includes a clipped screen-reader summary in .query-text. It duplicates and
        // truncates the prompt, so compare the actual paragraph nodes when present.
        const lines = body.locator('.query-text-line');
        texts.push(await lines.count() ? (await lines.allTextContents()).map(line => line.trim()).join('\n') : await body.innerText());
      } else texts.push(await messages.nth(i).innerText());
    }
    return texts;
  }

  async diagnostics() {
    const auth = await this.waitForAuth();
    // Never collect passwords, cookies, account names, page HTML or chat text in doctor.
    const count = async (list: string[]) => {
      for (const selector of list) if (await this.page.locator(selector).count()) return selector;
      return null;
    };
    return { auth, selectors: {
      composer: await count(selectors.composer), account: await count(selectors.account),
      model: await count(selectors.model), send: await count(selectors.send),
    }, adapter: 'gemini-dom-v1' };
  }
}
