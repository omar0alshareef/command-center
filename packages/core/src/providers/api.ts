import { num, postJson } from './http';
import {
  capText,
  ProviderError,
  type ProviderAdapter,
  type ProviderEnv,
  type ModelChoice,
  type ProviderId,
  type ProviderRunInput,
  type ProviderRunResult,
} from './types';

// Anthropic Messages API, OpenAI Chat Completions and Gemini generateContent. Keys travel in headers only; any text
// that reaches an error message is redacted first. Base URLs can be overridden in settings (proxies, tests).

const trim = (u: string) => u.replace(/\/+$/, '');

function keyOf(env: ProviderEnv, id: ProviderId, input: ProviderRunInput): string {
  const key = input.apiKey ?? env.apiKey(id);
  if (!key)
    throw new ProviderError(
      'no_key',
      'No API key is set for this provider (Settings → Providers).',
    );
  return key;
}

async function smokeTest(adapter: ProviderAdapter, signal: AbortSignal) {
  try {
    const r = await adapter.run({
      prompt: 'Reply with the single word ok.',
      workdir: process.cwd(),
      model: null,
      timeoutMs: 30_000,
      signal,
      maxOutputChars: 2000,
    });
    return { ok: true, detail: `Replied "${r.output.trim().slice(0, 40)}"` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Ask the provider which models this key can use (GET /models). Empty when there is no key or the call fails. */
export async function fetchModelList(
  env: ProviderEnv,
  id: ProviderId,
  url: string,
  headers: Record<string, string>,
  pick: (json: Record<string, unknown>) => ModelChoice[],
): Promise<ModelChoice[]> {
  if (!env.apiKey(id)) return [];
  try {
    const res = await env.fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return [];
    return pick((await res.json()) as Record<string, unknown>);
  } catch {
    return [];
  }
}

const rows = (json: Record<string, unknown>, key: string) =>
  (Array.isArray(json[key]) ? json[key] : []) as Record<string, unknown>[];

export const geminiModels = (env: ProviderEnv) =>
  fetchModelList(
    env,
    'gemini',
    `${trim(env.baseUrl('gemini') ?? 'https://generativelanguage.googleapis.com')}/v1beta/models?pageSize=200`,
    { 'x-goog-api-key': env.apiKey('gemini') ?? '' },
    (j) =>
      rows(j, 'models')
        .filter((m) => (m['supportedGenerationMethods'] as string[] | undefined)?.includes('generateContent'))
        .map((m) => ({
          id: String(m['name']).replace(/^models\//, ''),
          label: String(m['displayName'] ?? m['name']),
        })),
  );

const keyDetection = (env: ProviderEnv, id: ProviderId) => {
  const has = env.apiKey(id) !== null;
  return Promise.resolve({ available: has, detail: has ? 'API key set' : 'No API key set' });
};

export function anthropicAdapter(env: ProviderEnv): ProviderAdapter {
  const adapter: ProviderAdapter = {
    id: 'anthropic-api',
    label: 'Anthropic API',
    kind: 'api',
    needsKey: true,
    defaultModel: 'claude-sonnet-5-5',
    detect: () => keyDetection(env, 'anthropic-api'),
    listModels: () =>
      fetchModelList(
        env,
        'anthropic-api',
        `${trim(env.baseUrl('anthropic-api') ?? 'https://api.anthropic.com')}/v1/models?limit=100`,
        { 'x-api-key': env.apiKey('anthropic-api') ?? '', 'anthropic-version': '2023-06-01' },
        (j) =>
          rows(j, 'data').map((m) => ({ id: String(m['id']), label: String(m['display_name'] ?? m['id']) })),
      ),
    test: (signal) => smokeTest(adapter, signal),
    async run(input): Promise<ProviderRunResult> {
      const key = keyOf(env, 'anthropic-api', input);
      const model = input.model ?? adapter.defaultModel;
      const base = trim(env.baseUrl('anthropic-api') ?? 'https://api.anthropic.com');
      const { status, json } = await postJson(env, `${base}/v1/messages`, {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: {
          model,
          max_tokens: 8192,
          ...(input.system ? { system: input.system } : {}),
          messages: [{ role: 'user', content: input.prompt }],
        },
        input,
        secrets: [key],
      });
      const content = Array.isArray(json['content'])
        ? (json['content'] as { type?: string; text?: string }[])
        : [];
      const text = content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('');
      const u = (json['usage'] ?? {}) as Record<string, unknown>;
      const c = capText(text.trim(), input.maxOutputChars);
      input.onChunk?.(c.text);
      return {
        output: c.text,
        truncated: c.truncated,
        exitCode: status,
        usage: {
          inputTokens: num(u['input_tokens']),
          outputTokens: num(u['output_tokens']),
          costUsd: null,
        },
        model: typeof json['model'] === 'string' ? json['model'] : model,
      };
    },
  };
  return adapter;
}

/** OpenAI-compatible chat completions; also used by the local adapter for LM Studio. */
export async function chatCompletions(
  env: ProviderEnv,
  base: string,
  key: string | null,
  model: string,
  input: ProviderRunInput,
): Promise<ProviderRunResult> {
  const { status, json } = await postJson(env, `${trim(base)}/v1/chat/completions`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    body: {
      model,
      messages: [
        ...(input.system ? [{ role: 'system', content: input.system }] : []),
        { role: 'user', content: input.prompt },
      ],
    },
    input,
    secrets: [key],
  });
  const choices = Array.isArray(json['choices'])
    ? (json['choices'] as { message?: { content?: unknown } }[])
    : [];
  const content = choices[0]?.message?.content;
  if (typeof content !== 'string')
    throw new ProviderError('bad_response', 'The reply had no message content.', status);
  const u = (json['usage'] ?? {}) as Record<string, unknown>;
  const c = capText(content.trim(), input.maxOutputChars);
  input.onChunk?.(c.text);
  return {
    output: c.text,
    truncated: c.truncated,
    exitCode: status,
    usage: {
      inputTokens: num(u['prompt_tokens']),
      outputTokens: num(u['completion_tokens']),
      costUsd: null,
    },
    model: typeof json['model'] === 'string' ? json['model'] : model,
  };
}

export function openaiAdapter(env: ProviderEnv): ProviderAdapter {
  const adapter: ProviderAdapter = {
    id: 'openai-api',
    label: 'OpenAI API',
    kind: 'api',
    needsKey: true,
    defaultModel: 'gpt-4o-mini',
    detect: () => keyDetection(env, 'openai-api'),
    listModels: () =>
      fetchModelList(
        env,
        'openai-api',
        `${trim(env.baseUrl('openai-api') ?? 'https://api.openai.com')}/v1/models`,
        { authorization: `Bearer ${env.apiKey('openai-api') ?? ''}` },
        (j) =>
          rows(j, 'data')
            .map((m) => String(m['id']))
            .filter((id) => /^(gpt|o\d|chatgpt)/.test(id) && !/(embed|audio|tts|whisper|image|realtime|transcribe|moderation)/.test(id))
            .sort()
            .map((id) => ({ id, label: id })),
      ),
    test: (signal) => smokeTest(adapter, signal),
    run(input) {
      const key = keyOf(env, 'openai-api', input);
      return chatCompletions(
        env,
        env.baseUrl('openai-api') ?? 'https://api.openai.com',
        key,
        input.model ?? (adapter.defaultModel as string),
        input,
      );
    },
  };
  return adapter;
}

/** Gemini's REST API; the Gemini CLI, when installed, is preferred by the `gemini` adapter (see gemini.ts). */
export async function geminiApi(
  env: ProviderEnv,
  model: string,
  input: ProviderRunInput,
): Promise<ProviderRunResult> {
  const key = keyOf(env, 'gemini', input);
  const base = trim(env.baseUrl('gemini') ?? 'https://generativelanguage.googleapis.com');
  const { status, json } = await postJson(
    env,
    `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      headers: { 'x-goog-api-key': key },
      body: {
        ...(input.system ? { systemInstruction: { parts: [{ text: input.system }] } } : {}),
        contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
      },
      input,
      secrets: [key],
    },
  );
  const candidates = Array.isArray(json['candidates'])
    ? (json['candidates'] as { content?: { parts?: { text?: string }[] } }[])
    : [];
  const text = (candidates[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  if (!text) throw new ProviderError('bad_response', 'The reply had no text.', status);
  const u = (json['usageMetadata'] ?? {}) as Record<string, unknown>;
  const c = capText(text.trim(), input.maxOutputChars);
  input.onChunk?.(c.text);
  return {
    output: c.text,
    truncated: c.truncated,
    exitCode: status,
    usage: {
      inputTokens: num(u['promptTokenCount']),
      outputTokens: num(u['candidatesTokenCount']),
      costUsd: null,
    },
    model,
  };
}
