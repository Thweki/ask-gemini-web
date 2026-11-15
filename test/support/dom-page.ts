import { createWindow } from '@mixmark-io/domino';
import type { Locator, Page } from 'playwright-core';

// A small fixture driver for menu logic when the sandbox cannot launch Chrome.
// Browser tests exercise the same fixtures through Playwright's actual locators.
export function domPage(html: string) {
  const window = createWindow(html);
  const document = window.document;
  // Domino's optimized tag-only collections predate NodeList.forEach.
  const collectionPrototype = Object.getPrototypeOf(document.body.querySelectorAll('button'));
  if (!collectionPrototype.forEach) collectionPrototype.forEach = Array.prototype.forEach;
  function innerText(element: Element): string {
    return Array.from(element.childNodes).map(node => {
      if (node.nodeType === 3) return node.textContent || '';
      if (node.nodeType !== 1) return '';
      const child = node as Element;
      if (!visible(child)) return '';
      return child.tagName === 'BR' ? '\n' : innerText(child) + (/^(DIV|GEM-MENU-ITEM)$/.test(child.tagName) ? '\n' : '');
    }).join('');
  }
  function visible(element: Element): boolean {
    for (let node: Element | null = element; node; node = node.parentElement) {
      if (node.hasAttribute('hidden') || (node as HTMLElement).style?.display === 'none') return false;
    }
    return true;
  }
  function patchText() {
    for (const element of Array.from(document.querySelectorAll('*'))) {
      if (!Object.hasOwn(element, 'innerText')) Object.defineProperty(element, 'innerText', { get: () => innerText(element), configurable: true });
    }
  }
  patchText();
  for (const script of Array.from(document.querySelectorAll('script'))) {
    new Function('window', 'document', script.textContent || '')(window, document);
  }
  class DomLocator {
    constructor(private resolve: () => Element[]) {}
    private one() {
      const elements = this.resolve();
      if (elements.length !== 1) throw new Error(`Fixture locator expected one element, got ${elements.length}`);
      return elements[0];
    }
    locator(selector: string): DomLocator { return locate(this.resolve, selector); }
    filter({ hasText }: { hasText: RegExp }) { return new DomLocator(() => this.resolve().filter(element => hasText.test(innerText(element)))); }
    async count() { return this.resolve().length; }
    nth(index: number) { return new DomLocator(() => this.resolve().slice(index, index + 1)); }
    first() { return this.nth(0); }
    async isVisible() { return visible(this.one()); }
    async getAttribute(name: string) { return this.one().getAttribute(name); }
    async innerText() { return innerText(this.one()); }
    async evaluate(fn: (element: Element) => unknown) { patchText(); return fn(this.one()); }
    async click() { this.one().dispatchEvent(new window.Event('click', { bubbles: true })); patchText(); }
    async hover() {
      const element = this.one() as HTMLElement;
      element.onmouseenter?.call(element, new window.Event('mouseenter') as MouseEvent);
    }
    async waitFor({ state }: { state: string }) {
      if ((this.resolve().length === 1 && visible(this.one())) !== (state === 'visible')) throw new Error('Fixture visibility mismatch');
    }
  }
  function locate(roots: () => ParentNode[], selector: string): DomLocator {
    return new DomLocator(() => [...new Set(roots().flatMap(root => Array.from(root.querySelectorAll(selector.replace(/:visible/g, '')))))]
      .filter(element => !selector.includes(':visible') || visible(element)));
  }
  const page = {
    setDefaultTimeout() {},
    locator: (selector: string) => locate(() => [document], selector),
    keyboard: { press: async (key: string) => {
      const event = new window.Event('keydown');
      Object.defineProperty(event, 'key', { value: key }); document.dispatchEvent(event);
    } },
  } as unknown as Page;
  return { page, document, window };
}
