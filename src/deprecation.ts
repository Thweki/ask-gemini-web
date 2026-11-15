export function deprecated(oldName: string, replacement: string) {
  console.error(`[deprecated] ${oldName} is deprecated; use ${replacement}.`);
}

export function environment(suffix: string): string | undefined {
  const name = `ASK_GEMINI_WEB_${suffix}`;
  if (process.env[name] !== undefined) return process.env[name];
  const legacy = `GEMINI_DRAFT_${suffix}`;
  if (process.env[legacy] !== undefined) deprecated(legacy, name);
  return process.env[legacy];
}
