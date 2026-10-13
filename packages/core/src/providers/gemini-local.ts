import { chatCompletions, geminiApi } from './api';
import { num, postJson } from './http';
import { runProcess } from './spawn';
import {
  capText,
  ProviderError,
  type Detection,
  type ModelChoice,
  type ProviderAdapter,
  type ProviderEnv,
  type ProviderRunResult,
} from './types';

const trim = (u: string) => u.replace(/\/+$/, '');

async function quickTest(adapter: ProviderAdapter, signal: AbortSignal) {
  try {
    const r = await adapter.run({
      prompt: 'Reply with the single word ok.',
      workdir: process.cwd(),
      model: null,
      timeoutMs: 60_000,
      signal,
      maxOutputChars: 2000,
    });
    return { ok: true, detail: `Replied "${r.output.trim().slice(0, 40)}"` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Gemini: the CLI when it is installed (prompt on stdin), else the REST API with a key. Detected at startup. */
export function geminiAdapter(env: ProviderEnv): ProviderAdapter {
  const adapter: ProviderAdapter = {
    id: 'gemini',
    label: 'Gemini (CLI or API)',
    kind: 'cli',
    needsKey: false,
    defaultModel: 'gemini-2.5-flash',
    detect() {
      const bin = env.findBinary('gemini');
      if (bin) return Promise.resolve({ available: true, detail: `gemini CLI found: ${bin}` });
      if (env.apiKey('gemini'))
        return Promise.resolve({ available: true, detail: 'Using the Gemini API (key set)' });
      return Promise.resolve({
        available: false,
        detail: 'Neither the `gemini` CLI nor an API key was found.',
      });
    },
    test: (signal) => quickTest(adapter, signal),
    async run(input): Promise<ProviderRunResult> {
      const bin = env.findBinary('gemini');
      if (!bin) return geminiApi(env, input.model ?? (adapter.defaultModel as string), input);
      const args = ['-p', 'Follow the instructions given on standard input.'];
      if (input.model) args.push('-m', input.model);
      const prompt = input.system ? `${input.system}\n\n${input.prompt}` : input.prompt;
      const p = await runProcess(bin, args, input, prompt);
      if (p.code !== 0)
        throw new ProviderError(
          'failed',
          `gemini exited with code ${p.code}: ${(p.stderr || p.stdout).trim().slice(0, 500)}`,
          p.code,
        );
      const c = capText(p.stdout.trim(), input.maxOutputChars);
      return {
        output: c.text,
        truncated: c.truncated || p.truncated,
        exitCode: p.code,
        usage: { inputTokens: null, outputTokens: null, costUsd: null },
      };
    },
  };
  return adapter;
}

type Flavor = 'ollama' | 'lmstudio';
interface Found {
  flavor: Flavor;
  base: string;
  models: ModelChoice[];
}

/**
 * A model server on this computer: Ollama (`:11434`, `/api/tags`) or LM Studio (`:1234`, OpenAI-compatible `/v1/models`).
 * Models are whatever the server reports. A settings URL override is tried first.
 */
export function localAdapter(env: ProviderEnv): ProviderAdapter {
  let found: Found | null = null;

  const get = async (url: string): Promise<unknown | null> => {
    try {
      const r = await env.fetch(url, { signal: AbortSignal.timeout(1500) });
      return r.ok ? ((await r.json()) as unknown) : null;
    } catch {
      return null;
    }
  };

  async function probe(): Promise<Found | null> {
    const override = env.baseUrl('local');
    const candidates: { flavor: Flavor; base: string }[] = override
      ? [
          { flavor: 'ollama', base: trim(override) },
          { flavor: 'lmstudio', base: trim(override) },
        ]
      : [
          { flavor: 'ollama', base: 'http://localhost:11434' },
          { flavor: 'lmstudio', base: 'http://localhost:1234' },
        ];
    for (const c of candidates) {
      if (c.flavor === 'ollama') {
        const j = (await get(`${c.base}/api/tags`)) as { models?: { name?: string }[] } | null;
        if (j && Array.isArray(j.models))
          return {
            ...c,
            models: j.models
              .filter((m) => m.name)
              .map((m) => ({ id: m.name as string, label: m.name as string })),
          };
      } else {
        const j = (await get(`${c.base}/v1/models`)) as { data?: { id?: string }[] } | null;
        if (j && Array.isArray(j.data))
          return {
            ...c,
            models: j.data
              .filter((m) => m.id)
              .map((m) => ({ id: m.id as string, label: m.id as string })),
          };
      }
    }
    return null;
  }

  const adapter: ProviderAdapter = {
    id: 'local',
    label: 'Local model (Ollama / LM Studio)',
    kind: 'local',
    needsKey: false,
    defaultModel: null,
    async detect(): Promise<Detection> {
      found = await probe();
      return found
        ? {
            available: true,
            detail: `${found.flavor === 'ollama' ? 'Ollama' : 'LM Studio'} at ${found.base} (${found.models.length} model${found.models.length === 1 ? '' : 's'})`,
          }
        : { available: false, detail: 'No Ollama (:11434) or LM Studio (:1234) server answered.' };
    },
    test: (signal) => quickTest(adapter, signal),
    async listModels() {
      found = (await probe()) ?? found;
      return found?.models ?? [];
    },
    async run(input): Promise<ProviderRunResult> {
      found = found ?? (await probe());
      if (!found) throw new ProviderError('not_available', 'No local model server is running.');
      const model = input.model ?? found.models[0]?.id;
      if (!model) throw new ProviderError('failed', 'The local server has no models installed.');
      if (found.flavor === 'lmstudio') return chatCompletions(env, found.base, null, model, input);
      const { status, json } = await postJson(env, `${found.base}/api/chat`, {
        headers: {},
        body: {
          model,
          stream: false,
          messages: [
            ...(input.system ? [{ role: 'system', content: input.system }] : []),
            { role: 'user', content: input.prompt },
          ],
        },
        input,
      });
      const content = (json['message'] as { content?: unknown } | undefined)?.content;
      if (typeof content !== 'string')
        throw new ProviderError('bad_response', 'The reply had no message content.', status);
      const c = capText(content.trim(), input.maxOutputChars);
      input.onChunk?.(c.text);
      return {
        output: c.text,
        truncated: c.truncated,
        exitCode: status,
        usage: {
          inputTokens: num(json['prompt_eval_count']),
          outputTokens: num(json['eval_count']),
          costUsd: 0,
        },
        model,
      };
    },
  };
  return adapter;
}
