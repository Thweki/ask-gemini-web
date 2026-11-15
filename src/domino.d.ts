// The scoped fork ships declarations for the original unscoped module name.
declare module '@mixmark-io/domino' {
  export function createDocument(html?: string): Document;
  export function createWindow(html?: string): Window & typeof globalThis;
}
