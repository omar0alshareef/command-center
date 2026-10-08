// Pure layout math for the Swim Lane (UI/UX §6.1). No React, no DOM: everything here is unit-tested.
// Time model: week n spans [start + (n-1)*7d, start + n*7d). A "week position" is a fractional week
// count from the project start (0 = start of week 1), so x = position * weekW.

export const LANE_H = 200;
export const LABEL_W = 140;
export const HEADER_H = 44;
export const PHASE_H = 20;
export const KEY_ROW_H = 96;
export const NODE_R = 20;
export const KEY_NODE_R = 26;
export const PANEL_W = 480;
export const WEEK_W_DEFAULT = 100;
export const ZOOM_MIN = 60;
export const ZOOM_MAX = 160;
/** Width of a node's label box: the minimum horizontal pitch between nodes sharing a track. */
export const NODE_PITCH = 112;
/** Vertical room for one node + its 2-line label + date. */
export const TRACK_H = 96;

const DAY_MS = 86_400_000;

/** Days since the epoch for a `YYYY-MM-DD` string (UTC, so DST can't shift a day). NaN if invalid. */
export function dayNumber(iso: string): number {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(t) ? NaN : Math.round(t / DAY_MS);
}

/** Today's calendar day in the viewer's local time as `YYYY-MM-DD`. */
export function localIsoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addDaysIso(iso: string, days: number): string {
  return new Date((dayNumber(iso) + days) * DAY_MS).toISOString().slice(0, 10);
}

/** Fractional weeks from the project start (week 1 begins at 0). */
export function weekPos(iso: string, startIso: string): number {
  return (dayNumber(iso) - dayNumber(startIso)) / 7;
}

/** The NOW marker sits in the middle of today's day column, so it moves one day-width per day. */
export function nowPos(todayIso: string, startIso: string): number {
  return weekPos(todayIso, startIso) + 0.5 / 7;
}

export const weekStartIso = (startIso: string, week: number): string =>
  addDaysIso(startIso, (week - 1) * 7);

/** `MM-DD` of an ISO date (header cells). */
export const monthDay = (iso: string): string => iso.slice(5);

export const posToX = (pos: number, weekW: number): number => pos * weekW;

export function clampZoom(weekW: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(weekW)));
}

/** One zoom step (x1.25), clamped. */
export const zoomStep = (weekW: number, dir: 1 | -1): number =>
  clampZoom(dir === 1 ? weekW * 1.25 : weekW / 1.25);

/**
 * New scrollLeft after a zoom so that the anchor (a week position, normally NOW) stays at the same
 * screen x: screenX = anchor*weekW - scrollLeft must be unchanged.
 */
export function scrollLeftAfterZoom(
  scrollLeft: number,
  oldW: number,
  newW: number,
  anchorPos: number,
): number {
  const screenX = anchorPos * oldW - scrollLeft;
  return Math.max(0, anchorPos * newW - screenX);
}

/** Scroll position that puts `pos` at `fraction` of the visible canvas width (NOW at 30% on load). */
export const scrollLeftToPlace = (
  pos: number,
  weekW: number,
  viewW: number,
  fraction = 0.3,
): number => Math.max(0, pos * weekW - viewW * fraction);

/** Number of week columns to draw: covers the plan, every milestone and phase, plus one spare week. */
export function totalWeeks(
  startIso: string,
  targetIso: string,
  milestones: readonly { week: number; planned_end: string | null }[],
  phases: readonly { end_week: number }[],
): number {
  const targetWeeks = Number.isNaN(dayNumber(targetIso))
    ? 0
    : Math.ceil(weekPos(targetIso, startIso));
  const endWeeks = milestones.map((m) =>
    m.planned_end && !Number.isNaN(dayNumber(m.planned_end))
      ? Math.ceil(weekPos(m.planned_end, startIso)) + 1
      : 0,
  );
  return (
    Math.max(
      12,
      targetWeeks,
      ...milestones.map((m) => m.week),
      ...phases.map((p) => p.end_week),
      ...endWeeks,
    ) + 1
  );
}

/**
 * Center of a milestone in week positions. Uses the planned date range when present and valid
 * (centered on the middle of [start, end]), else the middle of its `week` column.
 */
export function plannedCenter(
  m: { week: number; planned_start: string | null; planned_end: string | null },
  startIso: string,
): number {
  const s =
    m.planned_start && !Number.isNaN(dayNumber(m.planned_start))
      ? weekPos(m.planned_start, startIso)
      : null;
  const e =
    m.planned_end && !Number.isNaN(dayNumber(m.planned_end))
      ? weekPos(m.planned_end, startIso) + 1 / 7
      : null;
  if (s !== null && e !== null && e > s) return (s + e) / 2;
  if (s !== null) return s + 0.5;
  return m.week - 1 + 0.5;
}

/** Where the milestone is forecast to land: planned center shifted by its drift. */
export const actualCenter = (planned: number, driftDays: number): number => planned + driftDays / 7;

/**
 * Greedy track assignment: items (sorted by x) go on the first track whose previous item is at least
 * `minGap` away, so labels in one lane never overlap. Returns track index per id and the track count.
 */
export function assignTracks(
  items: readonly { id: string; x: number }[],
  minGap: number,
): { track: Map<string, number>; tracks: number } {
  const lastX: number[] = [];
  const track = new Map<string, number>();
  for (const it of [...items].sort((a, b) => a.x - b.x || a.id.localeCompare(b.id))) {
    let t = lastX.findIndex((x) => it.x - x >= minGap);
    if (t === -1) {
      t = lastX.length;
      lastX.push(it.x);
    } else {
      lastX[t] = it.x;
    }
    track.set(it.id, t);
  }
  return { track, tracks: Math.max(1, lastX.length) };
}

/** A lane is LANE_H tall, growing only when it needs more than two label tracks. */
export const laneHeight = (tracks: number): number => Math.max(LANE_H, tracks * TRACK_H + 8);

/** y of a node's center within its lane: tracks are centered vertically; one track sits mid-lane. */
export function nodeY(laneTop: number, laneH: number, tracks: number, track: number): number {
  return laneTop + (laneH - tracks * TRACK_H) / 2 + track * TRACK_H + 36;
}

export interface Edge {
  from: string;
  to: string;
}

/**
 * Full upstream and downstream chain of `id` through the dependency graph, plus the edges that lie on
 * a path through it (these get highlighted on hover). `edges` are dependency -> dependent.
 */
export function dependencyChain(
  id: string,
  edges: readonly Edge[],
): { upstream: Set<string>; downstream: Set<string>; edges: Edge[] } {
  const walk = (start: string, next: (e: Edge) => [string, string]): Set<string> => {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      for (const e of edges) {
        const [a, b] = next(e);
        if (a === cur && !seen.has(b) && b !== start) {
          seen.add(b);
          stack.push(b);
        }
      }
    }
    return seen;
  };
  const upstream = walk(id, (e) => [e.to, e.from]);
  const downstream = walk(id, (e) => [e.from, e.to]);
  const up = new Set([id, ...upstream]);
  const down = new Set([id, ...downstream]);
  return { upstream, downstream, edges: edges.filter((e) => up.has(e.to) || down.has(e.from)) };
}

/** Horizontal window to render when the plan is large: the viewport plus a margin on each side. */
export const visibleXRange = (
  scrollLeft: number,
  viewW: number,
  margin = 400,
): [number, number] => [scrollLeft - margin, scrollLeft + viewW + margin];

/** Cubic path between two points with horizontal tangents (dependency connectors). */
export function connectorPath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(24, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}
