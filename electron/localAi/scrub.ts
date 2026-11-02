/*
 * The name of the embedded runtime must never reach the UI (issue #276). Errors
 * come straight from it, so anything shown to a person goes through here.
 */
export function scrubRuntimeName(message: string): string {
  return message
  .replace(/\/login\b/g, 'Provider Settings')
  .replace(/\bpi-coding-agent\b/gi, 'the assistant')
  .replace(/@earendil-works\/[\w-]+/g, 'the assistant')
  .replace(/\bPi(?=[\s.,:;!?'")]|$)/g, 'the assistant')
  .replace(/\bpi(?=\s+(?:--|agent|session|model|provider|runtime|sdk))/g, 'the assistant');
}

export function errorText(err: unknown): string {
  return scrubRuntimeName(err instanceof Error ? err.message : String(err)).slice(0, 500);
}
