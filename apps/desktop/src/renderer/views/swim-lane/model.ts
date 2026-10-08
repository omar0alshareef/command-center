import type { Milestone, Phase, Task, TrackerState } from '@command-center/core';
import { domainColor } from '../../lib/status';
import {
  HEADER_H,
  KEY_ROW_H,
  NODE_PITCH,
  PHASE_H,
  actualCenter,
  assignTracks,
  laneHeight,
  localIsoDate,
  nodeY,
  nowPos,
  plannedCenter,
  posToX,
  totalWeeks,
  weekStartIso,
  type Edge,
} from './layout';

// Turns TrackerState into drawable geometry. Pure: given the same data, zoom and "now" it always
// produces the same model, so placement is testable without rendering.

export type NodeStatus = 'done' | 'blocked' | 'review' | 'normal';

export interface SwimNode {
  id: string;
  title: string;
  domain: string;
  lane: number;
  track: number;
  /** Forecast position (planned + drift): where the solid node is drawn. */
  x: number;
  /** Planned position: where the drift ghost is drawn. */
  plannedX: number;
  y: number;
  drift: number;
  week: number;
  plannedStart: string | null;
  plannedEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  phase: string | null;
  dependencies: string[];
  keyLabel: string | null;
  done: number;
  total: number;
  status: NodeStatus;
  /** Task counts that drive the node styling. */
  blocked: number;
  review: number;
}

export interface SwimLaneRow {
  domain: string;
  color: string;
  top: number;
  height: number;
  tracks: number;
  done: number;
  total: number;
}

export interface SwimModel {
  weekW: number;
  weeks: { n: number; x: number; startIso: string }[];
  totalW: number;
  headerH: number;
  keyRowH: number;
  lanes: SwimLaneRow[];
  bodyH: number;
  phases: (Phase & { x: number; w: number })[];
  nodes: SwimNode[];
  keyNodes: SwimNode[];
  edges: Edge[];
  /** Unique id pairs of consecutive milestones in a lane (the subtle solid line). */
  adjacent: Edge[];
  todayIso: string;
  nowX: number;
  nowPos: number;
}

const byWeekThenId = (a: Milestone, b: Milestone) => a.week - b.week || a.id.localeCompare(b.id);

export function buildSwimModel(tracker: TrackerState, weekW: number, now: Date): SwimModel {
  const { project, phases } = tracker;
  const milestones = [...tracker.milestones].sort(byWeekThenId);
  const startIso = project.start_date;
  const todayIso = localIsoDate(now);

  const tasksByMs = new Map<string, Task[]>();
  for (const t of tracker.subtasks) {
    const list = tasksByMs.get(t.milestone_id);
    if (list) list.push(t);
    else tasksByMs.set(t.milestone_id, [t]);
  }

  const domains = [...new Set(milestones.map((m) => m.domain))];
  const weeksN = totalWeeks(startIso, project.target_date, milestones, phases);

  // Position + progress for every milestone, then lane/track layout.
  const base = milestones.map((m) => {
    const tasks = tasksByMs.get(m.id) ?? [];
    const done = tasks.filter((t) => t.status === 'done').length;
    const blocked = tasks.filter((t) => t.status === 'blocked').length;
    const review = tasks.filter((t) => t.status === 'review').length;
    const planned = plannedCenter(m, startIso);
    const status: NodeStatus =
      tasks.length > 0 && done === tasks.length
        ? 'done'
        : blocked > 0
          ? 'blocked'
          : review > 0
            ? 'review'
            : 'normal';
    return {
      m,
      tasks,
      done,
      blocked,
      review,
      status,
      planned,
      actual: actualCenter(planned, m.drift_days),
    };
  });

  // Body coordinates: the Key row occupies [0, KEY_ROW_H); lanes stack below it.
  let cursor = KEY_ROW_H;
  const lanes: SwimLaneRow[] = [];
  const placed = new Map<string, Pick<SwimNode, 'lane' | 'track' | 'y'>>();
  domains.forEach((domain, lane) => {
    const members = base.filter((b) => b.m.domain === domain);
    const { track, tracks } = assignTracks(
      members.map((b) => ({ id: b.m.id, x: posToX(b.actual, weekW) })),
      NODE_PITCH,
    );
    const height = laneHeight(tracks);
    for (const b of members) {
      const t = track.get(b.m.id) ?? 0;
      placed.set(b.m.id, { lane, track: t, y: nodeY(cursor, height, tracks, t) });
    }
    lanes.push({
      domain,
      color: domainColor(domain, domains),
      top: cursor,
      height,
      tracks,
      done: members.reduce((n, b) => n + b.done, 0),
      total: members.reduce((n, b) => n + b.tasks.length, 0),
    });
    cursor += height;
  });

  const nodes: SwimNode[] = base.map(
    ({ m, done, blocked, review, status, planned, actual, tasks }) => {
      const p = placed.get(m.id) as Pick<SwimNode, 'lane' | 'track' | 'y'>;
      return {
        id: m.id,
        title: m.title,
        domain: m.domain,
        lane: p.lane,
        track: p.track,
        x: posToX(actual, weekW),
        plannedX: posToX(planned, weekW),
        y: p.y,
        drift: m.drift_days,
        week: m.week,
        plannedStart: m.planned_start,
        plannedEnd: m.planned_end,
        actualStart: m.actual_start,
        actualEnd: m.actual_end,
        phase: m.phase,
        dependencies: m.dependencies,
        keyLabel: m.is_key_milestone ? (m.key_milestone_label ?? m.title) : null,
        done,
        total: tasks.length,
        status,
        blocked,
        review,
      };
    },
  );

  const ids = new Set(nodes.map((n) => n.id));
  const edges: Edge[] = nodes.flatMap((n) =>
    n.dependencies.filter((d) => ids.has(d)).map((d) => ({ from: d, to: n.id })),
  );
  const adjacent: Edge[] = lanes.flatMap((_, lane) => {
    const row = nodes.filter((n) => n.lane === lane).sort((a, b) => a.x - b.x);
    return row.slice(1).map((n, i) => ({ from: (row[i] as SwimNode).id, to: n.id }));
  });

  const bodyH = cursor;
  const pos = nowPos(todayIso, startIso);
  return {
    weekW,
    weeks: Array.from({ length: weeksN }, (_, i) => ({
      n: i + 1,
      x: posToX(i, weekW),
      startIso: weekStartIso(startIso, i + 1),
    })),
    totalW: weeksN * weekW,
    headerH: HEADER_H + PHASE_H,
    keyRowH: KEY_ROW_H,
    lanes,
    bodyH,
    phases: phases.map((p) => ({
      ...p,
      x: posToX(p.start_week - 1, weekW),
      w: (p.end_week - p.start_week + 1) * weekW,
    })),
    nodes,
    keyNodes: nodes.filter((n) => n.keyLabel !== null),
    edges,
    adjacent,
    todayIso,
    nowX: posToX(pos, weekW),
    nowPos: pos,
  };
}
