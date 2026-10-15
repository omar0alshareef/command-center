import {
  cancelRun,
  getModelList,
  isProviderId,
  setAgentMaxConcurrent,
  setAgentModel,
  setAgentProvider,
  setModelList,
  type Agent,
  type Db,
  type ModelOption,
  type ProviderId,
} from '@command-center/core';
import { z } from 'zod';
import type { OrchestratorView, ProviderInfo, Result } from '../shared/ipc';
import type { OrchestratorLoop } from './orchestrator-loop';
import { readBaseUrl, readProviderKey, writeBaseUrl, writeProviderKey } from './provider-settings';
import { safeStorage } from 'electron';
import { run } from './task-api';

// IPC for routing, providers and the orchestrator (M14). Everything is validated here and goes through core; the renderer
// is the human operator, so the actor is fixed. Provider keys are written here and never returned.

const Provider = z
  .string()
  .refine(isProviderId, 'unknown provider')
  .transform((s) => s as ProviderId);
const AgentId = z.string().min(1).max(64);

function needOrch(loop: OrchestratorLoop) {
  const o = loop.get();
  if (!o) throw new Error('No project is open.');
  return o;
}

export function orchestratorApi(getDb: () => Db, loop: OrchestratorLoop) {
  const info = (id: ProviderId): ProviderInfo => {
    const o = needOrch(loop);
    const a = loop.adapters()?.[id];
    const det = o.status().providers.find((p) => p.id === id);
    const key = readProviderKey(getDb(), id);
    return {
      id,
      label: a?.label ?? id,
      kind: a?.kind ?? 'api',
      needsKey: a?.needsKey ?? false,
      keyOptional: id === 'gemini',
      defaultModel: a?.defaultModel ?? null,
      available: det?.available ?? false,
      detail: det?.detail ?? 'Not checked yet',
      keySet: key !== null,
      keySuffix: key ? key.slice(-4) : null,
      baseUrl: readBaseUrl(getDb(), id) ?? null,
      encrypted: safeStorage.isEncryptionAvailable(),
    };
  };

  return {
    status: (): Result<OrchestratorView | null> => run(() => loop.view()),
    resume: (): Result<OrchestratorView | null> =>
      run(() => {
        needOrch(loop).resume();
        loop.push();
        return loop.view();
      }),
    pause: (req: unknown): Result<OrchestratorView | null> =>
      run(() => {
        const r = z.object({ cancelRunning: z.boolean() }).strict().parse(req);
        needOrch(loop).pause({ cancelRunning: r.cancelRunning });
        loop.push();
        return loop.view();
      }),
    stopAfterCurrent: (): Result<OrchestratorView | null> =>
      run(() => {
        needOrch(loop).stopAfterCurrent();
        loop.push();
        return loop.view();
      }),
    start: (req: unknown): Result<{ runId: string }> =>
      run(() => {
        const r = z
          .object({ taskId: z.string().min(1).max(64), force: z.boolean().optional() })
          .strict()
          .parse(req);
        const runId = needOrch(loop).dispatch(r.taskId, r.force ? { force: true } : {});
        loop.push();
        return { runId };
      }),
    cancelRun: (runId: unknown): Result<null> =>
      run(() => {
        const id = z.string().min(1).max(64).parse(runId);
        cancelRun(getDb(), id, 'operator');
        needOrch(loop).cancel(id);
        return null;
      }),
    setConfig: (patch: unknown): Result<OrchestratorView | null> =>
      run(() => {
        loop.setConfig(patch);
        return loop.view();
      }),

    providers: async (refresh: unknown): Promise<Result<ProviderInfo[]>> => {
      try {
        const o = needOrch(loop);
        if (refresh === true) await o.refreshProviders();
        return { ok: true, value: (loop.ids() as ProviderId[]).map(info) };
      } catch (e) {
        return {
          ok: false,
          error: { code: 'ERROR', message: e instanceof Error ? e.message : String(e) },
        };
      }
    },
    setKey: async (req: unknown): Promise<Result<ProviderInfo>> => {
      try {
        const r = z
          .object({ id: Provider, key: z.string().max(400).nullable() })
          .strict()
          .parse(req);
        writeProviderKey(getDb(), r.id, r.key);
        await needOrch(loop).refreshProviders();
        loop.push();
        return { ok: true, value: info(r.id) };
      } catch (e) {
        return {
          ok: false,
          error: { code: 'ERROR', message: e instanceof Error ? e.message : String(e) },
        };
      }
    },
    setBaseUrl: async (req: unknown): Promise<Result<ProviderInfo>> => {
      try {
        const r = z
          .object({ id: Provider, url: z.string().max(300).nullable() })
          .strict()
          .parse(req);
        writeBaseUrl(getDb(), r.id, r.url);
        await needOrch(loop).refreshProviders();
        loop.push();
        return { ok: true, value: info(r.id) };
      } catch (e) {
        return {
          ok: false,
          error: { code: 'ERROR', message: e instanceof Error ? e.message : String(e) },
        };
      }
    },
    test: async (id: unknown): Promise<Result<{ ok: boolean; detail: string }>> => {
      try {
        const pid = Provider.parse(id);
        const adapter = loop.adapters()?.[pid];
        if (!adapter) throw new Error('No project is open.');
        const t = await adapter.test(AbortSignal.timeout(65_000));
        // The detail comes from the provider; keys are redacted by the adapters, and checked once more here.
        const key = readProviderKey(getDb(), pid);
        const detail = key ? t.detail.split(key).join('***') : t.detail;
        return { ok: true, value: { ok: t.ok, detail } };
      } catch (e) {
        return {
          ok: false,
          error: { code: 'ERROR', message: e instanceof Error ? e.message : String(e) },
        };
      }
    },
    models: async (id: unknown): Promise<Result<ModelOption[]>> => {
      try {
        const pid = Provider.parse(id);
        if (pid === 'local') {
          const found = await loop.adapters()?.local.listModels?.();
          return { ok: true, value: found ?? [] };
        }
        // Providers with a key report what that key can use; the saved list is the fallback (offline, no key, CLI providers).
        const live = await loop.adapters()?.[pid].listModels?.();
        return { ok: true, value: live?.length ? live : getModelList(getDb(), pid) };
      } catch (e) {
        return {
          ok: false,
          error: { code: 'ERROR', message: e instanceof Error ? e.message : String(e) },
        };
      }
    },
    setModels: (req: unknown): Result<ModelOption[]> =>
      run(() => {
        const r = z.object({ provider: Provider, list: z.unknown() }).strict().parse(req);
        return setModelList(getDb(), r.provider, r.list);
      }),
    setAgentModel: (req: unknown): Result<Agent> =>
      run(() => {
        const r = z
          .object({ agentId: AgentId, model: z.string().max(100).nullable() })
          .strict()
          .parse(req);
        return setAgentModel(getDb(), r.agentId, r.model);
      }),
    setAgentProvider: (req: unknown): Result<Agent> =>
      run(() => {
        const r = z
          .object({ agentId: AgentId, provider: z.string().max(40).nullable() })
          .strict()
          .parse(req);
        return setAgentProvider(getDb(), r.agentId, r.provider);
      }),
    setAgentConcurrency: (req: unknown): Result<Agent> =>
      run(() => {
        const r = z.object({ agentId: AgentId, max: z.number().int() }).strict().parse(req);
        return setAgentMaxConcurrent(getDb(), r.agentId, r.max);
      }),
  };
}
