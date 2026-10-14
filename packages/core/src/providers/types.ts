// M14 provider adapters (D23). Each adapter turns one prompt into text plus usage, behind one interface, with a
// timeout, cancellation through an AbortSignal and a cap on the output it keeps. Adding a provider means adding
// one adapter file and listing it in `index.ts`.

export const PROVIDER_IDS = [
  'claude-code',
  'anthropic-api',
  'openai-api',
  'gemini',
  'local',
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export const DEFAULT_PROVIDER: ProviderId = 'claude-code';

export const isProviderId = (s: string): s is ProviderId =>
  (PROVIDER_IDS as readonly string[]).includes(s);

export interface ProviderRunInput {
  prompt: string;
  /** Instructions that frame the prompt (the agent's role, the output format). */
  system?: string | null;
  /** The project folder: CLI providers run in it. API providers ignore it. */
  workdir: string;
  /** Model id for this provider; null = the provider's default. */
  model: string | null;
  timeoutMs: number;
  signal: AbortSignal;
  /** Output beyond this many characters is dropped and the result is flagged truncated. */
  maxOutputChars: number;
  /** The provider's key (API providers). Never logged, never written to the database. */
  apiKey?: string | null;
  /** Streams text when the provider can (CLI stdout); optional. */
  onChunk?: (text: string) => void;
  /** CLI providers only: may the agent edit files and run the project's npm scripts. */
  allowEdits?: boolean;
  /** CLI providers only: tools the project spec forbids (`## Forbidden tools` in AGENTS.md). */
  disallowedTools?: string[];
}

export interface ProviderUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  /** Cost the provider itself reported, in USD (claude-code does). */
  costUsd: number | null;
}

export interface ProviderRunResult {
  output: string;
  truncated: boolean;
  /** Process exit code for CLI providers, the HTTP status for API providers. */
  exitCode: number | null;
  usage: ProviderUsage;
  /** The model the provider says it used, when it says. */
  model?: string | null;
}

export type ProviderErrorCode =
  'timeout' | 'cancelled' | 'failed' | 'not_available' | 'no_key' | 'bad_response';

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly exitCode: number | null = null,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface Detection {
  available: boolean;
  /** What was found, or why not: shown in Settings → Providers. */
  detail: string;
}

export interface ModelChoice {
  id: string;
  label: string;
}

/** Everything an adapter needs from its surroundings, injectable so tests never touch the network or spawn. */
export interface ProviderEnv {
  fetch: typeof fetch;
  /** Base URL override for an API or local provider (a settings value); undefined = the provider's own. */
  baseUrl(id: ProviderId): string | undefined;
  /** Path of the `claude` / `gemini` binary, or null when it cannot be found. */
  findBinary(name: 'claude' | 'gemini'): string | null;
  /** The key for an API provider (decrypted by the app), or null. */
  apiKey(id: ProviderId): string | null;
}

export interface ProviderAdapter {
  id: ProviderId;
  label: string;
  kind: 'cli' | 'api' | 'local';
  needsKey: boolean;
  /** Used for the cost estimate when the agent has no model chosen. */
  defaultModel: string | null;
  /** Is it installed / reachable / keyed? Cheap and safe to call at startup. */
  detect(): Promise<Detection>;
  /** A live round trip with a tiny prompt (Settings → Test connection). */
  test(signal: AbortSignal): Promise<{ ok: boolean; detail: string }>;
  run(input: ProviderRunInput): Promise<ProviderRunResult>;
  /** Models the provider itself reports (local servers). Others use the editable list in settings. */
  listModels?(): Promise<ModelChoice[]>;
}

/** Replace every occurrence of every secret with `***`, so a key can never reach a log, the database or the screen. */
export function redact(text: string, secrets: readonly (string | null | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('***');
  return out;
}

export function capText(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max
    ? { text: text.slice(0, max), truncated: true }
    : { text, truncated: false };
}
