import { useMemo } from 'react';
import type { Agent, Task } from '@command-center/core';
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
