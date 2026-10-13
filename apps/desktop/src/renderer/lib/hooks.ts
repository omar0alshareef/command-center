import { useEffect, useMemo, useState } from 'react';
import type { Agent, ModelOption, Task } from '@command-center/core';
import { useApp } from '../store';

// Zustand selectors must return a stable value for unchanged state. Building a Map or `?? []`
// inside a selector returns a new object on every call and loops forever (React error #185), so
// derived values are memoized from the stable slice instead.

const NO_AGENTS: readonly Agent[] = [];

export function useTasksById(): ReadonlyMap<string, Task> {
  const subtasks = useApp((s) => s.tracker?.subtasks);
  return useMemo(() => new Map((subtasks ?? []).map((t) => [t.id, t])), [subtasks]);
}

export function useAgents(): readonly Agent[] {
  return useApp((s) => s.tracker?.agents) ?? NO_AGENTS;
}

/** `Date.now()` that re-renders its component every `ms` (live "2m ago" labels). */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/**
 * The Claude Code model list (a project setting). Loaded on mount and whenever the database changes, so an edit
 * in Settings reaches every dropdown. Null until the first answer arrives.
 */
export function useClaudeModels(): readonly ModelOption[] | null {
  const [models, setModels] = useState<readonly ModelOption[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      void window.api.models.list().then((r) => {
        if (live && r.ok) setModels(r.value);
      });
    load();
    const off = window.api.onDbChanged(load);
    return () => {
      live = false;
      off();
    };
  }, []);
  return models;
}
