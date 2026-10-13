import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { findClaude } from '../claude-bin';
import { anthropicAdapter, openaiAdapter } from './api';
import { claudeCodeAdapter } from './claude-code';
import { geminiAdapter, localAdapter } from './gemini-local';
import type { ProviderAdapter, ProviderEnv, ProviderId } from './types';

export * from './types';
export * from './pricing';
export { claudeCodeArgs } from './claude-code';

/** Find an executable on PATH (and the CLI installers' usual folder). null when it is not installed. */
export function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): string | null {
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`] : [name];
  const dirs = [
    ...(env['PATH'] ?? env['Path'] ?? '').split(delimiter).filter(Boolean),
    join(homedir(), '.local', 'bin'),
  ];
  for (const d of dirs) for (const n of names) if (exists(join(d, n))) return join(d, n);
  return null;
}

/** The real environment: global fetch, binaries from PATH, settings supplied by the caller. */
export function systemProviderEnv(
  o: Pick<ProviderEnv, 'baseUrl' | 'apiKey'> & { fetch?: typeof fetch },
): ProviderEnv {
  return {
    fetch: o.fetch ?? fetch,
    baseUrl: o.baseUrl,
    apiKey: o.apiKey,
    findBinary: (name) =>
      name === 'claude'
        ? findClaude()
        : process.env['COMMAND_CENTER_GEMINI']?.trim() || findOnPath('gemini'),
  };
}

export function buildProviders(env: ProviderEnv): Record<ProviderId, ProviderAdapter> {
  return {
    'claude-code': claudeCodeAdapter(env),
    'anthropic-api': anthropicAdapter(env),
    'openai-api': openaiAdapter(env),
    gemini: geminiAdapter(env),
    local: localAdapter(env),
  };
}
