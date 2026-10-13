import type { TrackerState } from '@command-center/core';

// Structural sharing for refetches. IPC hands back fresh objects every time; if every row were a new
// reference, one external write would re-render every memoized card. Rows that did not change keep
// their previous reference, and an entirely unchanged snapshot returns the previous object, so
// subscribers are not even notified.

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function reuse<T extends { id: string | number }>(
  prev: readonly T[],
  next: readonly T[],
): readonly T[] {
  const byId = new Map(prev.map((p) => [p.id, p]));
  const out = next.map((n) => {
    const p = byId.get(n.id);
    return p !== undefined && same(p, n) ? p : n;
  });
  const identical = out.length === prev.length && out.every((row, i) => row === prev[i]);
  return identical ? prev : out;
}

export function mergeTracker(prev: TrackerState, next: TrackerState): TrackerState {
  const merged: TrackerState = {
    project: same(prev.project, next.project) ? prev.project : next.project,
    milestones: reuse(prev.milestones, next.milestones) as TrackerState['milestones'],
    subtasks: reuse(prev.subtasks, next.subtasks) as TrackerState['subtasks'],
    agents: reuse(prev.agents, next.agents) as TrackerState['agents'],
    agent_log: reuse(prev.agent_log, next.agent_log) as TrackerState['agent_log'],
    phases: reuse(prev.phases, next.phases) as TrackerState['phases'],
    lessons_learned: reuse(
      prev.lessons_learned,
      next.lessons_learned,
    ) as TrackerState['lessons_learned'],
    runs: reuse(prev.runs, next.runs) as TrackerState['runs'],
  };
  const unchanged = (Object.keys(merged) as (keyof TrackerState)[]).every(
    (k) => merged[k] === prev[k],
  );
  return unchanged ? prev : merged;
}
