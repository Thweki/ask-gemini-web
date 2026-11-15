export class DraftError extends Error {
  constructor(public code: string, message: string, public exitCode = 1) {
    super(message);
    this.name = 'DraftError';
  }
}

export function errorInfo(error: unknown) {
  return error instanceof DraftError
    ? { code: error.code, message: error.message }
    : { code: 'UNEXPECTED', message: error instanceof Error ? error.message : String(error) };
}
