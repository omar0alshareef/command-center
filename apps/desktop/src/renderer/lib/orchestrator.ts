import { useEffect } from 'react';
import { create } from 'zustand';
import type { Agent, ModelOption, Run } from '@command-center/core';
import type { OrchestratorView } from '../../shared/ipc';

// The orchestrator's live state (mode, counts, caps, which providers are detected), pushed from the main process after
// every scheduling pass. The renderer never decides anything about dispatch: it only shows this and sends commands.

export const PROVIDER_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code',
  'anthropic-api': 'Anthropic API',
  'openai-api': 'OpenAI API',
  gemini: 'Gemini',
  local: 'Local model',
};
export const PROVIDER_ORDER = [
  'claude-code',
  'anthropic-api',
  'openai-api',
  'gemini',
  'local',
] as const;
/** Mirrors core's `canChooseModel` (the renderer imports only types from core): text-runner agents have a provider and a model. */
export const canRoute = (a: Pick<Agent, 'id' | 'type' | 'executor'>): boolean =>
  a.executor === 'agent' && a.type !== 'human' && a.id !== 'operator' && a.id !== 'system';

export const providerLabel = (id: string | null | undefined): string =>
  PROVIDER_LABEL[id ?? 'claude-code'] ?? id ?? 'Claude Code';

interface OrchState {
  view: OrchestratorView | null;
  init: () => () => void;
  set: (v: OrchestratorView | null) => void;
}

export const useOrch = create<OrchState>((set) => ({
  view: null,
  set: (view) => set({ view }),
  init: () => {
    let live = true;
    void window.api.orchestrator.status().then((r) => {
      if (live && r.ok) set({ view: r.value });
    });
    const off = window.api.orchestrator.onStatus((view) => set({ view }));
    const offDb = window.api.onDbChanged(() => useModelLists.getState().refresh());
    return () => {
      live = false;
      off();
      offDb();
    };
  },
}));

export const MODE_LABEL = {
  off: 'Orchestrator off',
  running: 'Running',
  paused: 'Paused',
  draining: 'Stopping after the current run',
} as const;

/** Is this provider detected right now? Unknown until the first status arrives. */
export function providerAvailable(view: OrchestratorView | null, id: string): boolean {
  return view?.providers.find((p) => p.id === id)?.available ?? false;
}

export const money = (n: number): string =>
  `$${n.toFixed(n >= 10 ? 2 : n >= 0.01 || n === 0 ? 2 : 4)}`;

export function runDuration(r: Pick<Run, 'started_at' | 'finished_at'>, now = Date.now()): string {
  if (!r.started_at) return '—';
  const ms = (r.finished_at ? Date.parse(r.finished_at) : now) - Date.parse(r.started_at);
  if (ms < 1000) return '<1 s';
  if (ms < 90_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

/** "$0.0123 (reported)" or "$0.0123 (estimate)"; "—" when nothing is known. Estimates are always labelled as such (D26). */
export function runCost(r: Pick<Run, 'est_cost_usd' | 'cost_basis'>): string {
  if (r.est_cost_usd === null) return '—';
  return `${money(r.est_cost_usd)} (${r.cost_basis === 'reported' ? 'reported' : 'estimate'})`;
}

interface ModelStore {
  lists: Record<string, readonly ModelOption[]>;
  /** Fetch one provider's list the first time it is asked for. */
  load: (provider: string) => void;
  /** Re-fetch every list already loaded (the editable ones; a local server is only asked on first use). */
  refresh: () => void;
}

/**
 * The per-provider model lists, shared by every dropdown on screen. One store and ONE database-change listener (set up in
 * `useOrch.init`), not a listener per agent row: a project with many agents would otherwise leak listeners.
 */
export const useModelLists = create<ModelStore>((set, get) => ({
  lists: {},
  load: (provider) => {
    if (provider in get().lists) return;
    set((s) => ({ lists: { ...s.lists, [provider]: [] } })); // claim it so rows mounting together ask once
    void window.api.providers.models(provider).then((r) => {
      if (r.ok) set((s) => ({ lists: { ...s.lists, [provider]: r.value } }));
    });
  },
  refresh: () => {
    for (const provider of Object.keys(get().lists)) {
      if (provider === 'local') continue;
      void window.api.providers.models(provider).then((r) => {
        if (r.ok && JSON.stringify(get().lists[provider]) !== JSON.stringify(r.value))
          set((s) => ({ lists: { ...s.lists, [provider]: r.value } }));
      });
    }
  },
}));

/** The models an agent on `provider` can pick: the editable list, or what a local server reports. Null until loaded. */
export function useProviderModels(provider: string): readonly ModelOption[] | null {
  const loaded = useModelLists((s) => s.lists[provider]);
  useEffect(() => useModelLists.getState().load(provider), [provider]);
  return loaded ?? null;
}
