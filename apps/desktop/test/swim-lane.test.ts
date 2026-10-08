import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { getAllTrackerState, openDb, type TrackerState } from '@command-center/core';
import { seedDb } from '../../../packages/core/src/seed';
import {
  KEY_ROW_H,
  LANE_H,
  NODE_PITCH,
  ZOOM_MAX,
  ZOOM_MIN,
  addDaysIso,
  assignTracks,
  clampZoom,
  connectorPath,
  dayNumber,
  dependencyChain,
  laneHeight,
  localIsoDate,
  nodeY,
  nowPos,
  plannedCenter,
  scrollLeftAfterZoom,
  scrollLeftToPlace,
  totalWeeks,
  visibleXRange,
  weekPos,
  zoomStep,
} from '../src/renderer/views/swim-lane/layout';
import { buildSwimModel } from '../src/renderer/views/swim-lane/model';
import { formatDate } from '../src/renderer/lib/time';

describe('week math', () => {
  const start = '2026-03-02'; // a Monday

  it('maps dates to fractional week positions', () => {
    expect(weekPos('2026-03-02', start)).toBe(0);
    expect(weekPos('2026-03-09', start)).toBe(1);
    expect(weekPos('2026-03-05', start)).toBeCloseTo(3 / 7, 10);
    expect(weekPos('2026-02-23', start)).toBe(-1);
    expect(Number.isNaN(dayNumber('not-a-date'))).toBe(true);
  });

  it('NOW is accurate to the day: one day moves it exactly 1/7 week, even across a DST change', () => {
    // US clocks changed on 2026-03-08: UTC-based day numbers must not lose or gain a day.
    const days = Array.from({ length: 10 }, (_, i) => addDaysIso('2026-03-04', i));
    expect(days[4]).toBe('2026-03-08');
    for (let i = 1; i < days.length; i++) {
      expect(nowPos(days[i] as string, start) - nowPos(days[i - 1] as string, start)).toBeCloseTo(
        1 / 7,
        10,
      );
    }
    // At 100px per week a day is ~14.29px, and NOW sits mid-day.
    expect(nowPos('2026-03-02', start) * 100).toBeCloseTo(0.5 * (100 / 7), 6);
    expect(nowPos('2026-03-05', start)).toBeCloseTo(3.5 / 7, 10);
  });

  it('localIsoDate uses the local calendar day', () => {
    expect(localIsoDate(new Date(2026, 2, 12, 23, 59))).toBe('2026-03-12');
    expect(localIsoDate(new Date(2026, 0, 5, 0, 1))).toBe('2026-01-05');
  });

  it('totalWeeks covers the plan, milestones and phases, with a spare week and a 12-week floor', () => {
    expect(totalWeeks(start, '2026-03-09', [], [])).toBe(13);
    expect(totalWeeks(start, '2026-12-31', [], [])).toBe(
      Math.ceil(weekPos('2026-12-31', start)) + 1,
    );
    expect(totalWeeks(start, '2026-03-09', [{ week: 20, planned_end: null }], [])).toBe(21);
    expect(totalWeeks(start, '2026-03-09', [], [{ end_week: 30 }])).toBe(31);
    // 2026-09-01 is 183 days after the start: 26.14 weeks -> 27, +1 because planned_end is inclusive, +1 spare.
    expect(totalWeeks(start, '2026-03-09', [{ week: 1, planned_end: '2026-09-01' }], [])).toBe(29);
  });

  it('plannedCenter uses the date range when valid, else the week column', () => {
    expect(
      plannedCenter({ week: 3, planned_start: '2026-03-16', planned_end: '2026-03-22' }, start),
    ).toBeCloseTo(2.5, 10);
    expect(plannedCenter({ week: 3, planned_start: null, planned_end: null }, start)).toBe(2.5);
    expect(
      plannedCenter({ week: 3, planned_start: '2026-03-16', planned_end: null }, start),
    ).toBeCloseTo(2.5, 10);
    expect(plannedCenter({ week: 3, planned_start: 'bad', planned_end: 'bad' }, start)).toBe(2.5);
    expect(
      plannedCenter({ week: 1, planned_start: '2026-03-09', planned_end: '2026-03-01' }, start),
    ).toBeCloseTo(1.5, 10);
  });
});

describe('zoom', () => {
  it('clamps to 60..160 and steps by x1.25', () => {
    expect(clampZoom(10)).toBe(ZOOM_MIN);
    expect(clampZoom(1000)).toBe(ZOOM_MAX);
    expect(zoomStep(100, 1)).toBe(125);
    expect(zoomStep(100, -1)).toBe(80);
    expect(zoomStep(ZOOM_MAX, 1)).toBe(ZOOM_MAX);
    expect(zoomStep(ZOOM_MIN, -1)).toBe(ZOOM_MIN);
  });

  it('keeps the anchor (NOW) at the same screen x across zoom levels', () => {
    for (const [oldW, newW, scroll] of [
      [100, 125, 300],
      [125, 80, 900],
      [60, 160, 50],
      [160, 60, 2000],
    ] as const) {
      const anchor = 6.5;
      const before = anchor * oldW - scroll;
      const next = scrollLeftAfterZoom(scroll, oldW, newW, anchor);
      if (next > 0) expect(anchor * newW - next).toBeCloseTo(before, 6);
    }
    expect(scrollLeftAfterZoom(0, 100, 160, 0.2)).toBeGreaterThanOrEqual(0);
  });

  it('places NOW at 30% of the visible canvas, never negative', () => {
    expect(scrollLeftToPlace(6.5, 100, 1000)).toBe(650 - 300);
    expect(scrollLeftToPlace(0.5, 100, 1000)).toBe(0);
  });
});

describe('tracks and lanes', () => {
  it('puts nodes on one track when far apart and stacks overlapping ones', () => {
    const far = assignTracks(
      [
        { id: 'a', x: 0 },
        { id: 'b', x: NODE_PITCH },
        { id: 'c', x: NODE_PITCH * 2 },
      ],
      NODE_PITCH,
    );
    expect(far.tracks).toBe(1);
    // a(0), b(50), c(100) are all closer than the pitch to each other: three tracks. d(300) is clear of a.
    const close = assignTracks(
      [
        { id: 'a', x: 0 },
        { id: 'b', x: 50 },
        { id: 'c', x: 100 },
        { id: 'd', x: 300 },
      ],
      NODE_PITCH,
    );
    expect(close.tracks).toBe(3);
    expect([...'abcd'].map((id) => close.track.get(id))).toEqual([0, 1, 2, 0]);
  });

  it('is deterministic for ties and sorts by x', () => {
    const r1 = assignTracks(
      [
        { id: 'b', x: 10 },
        { id: 'a', x: 10 },
      ],
      NODE_PITCH,
    );
    expect(r1.track.get('a')).toBe(0);
    expect(r1.track.get('b')).toBe(1);
    expect(assignTracks([], NODE_PITCH)).toEqual({ track: new Map(), tracks: 1 });
  });

  it('lane height is 200 for up to two tracks, then grows; node y keeps tracks inside the lane', () => {
    expect(laneHeight(1)).toBe(LANE_H);
    expect(laneHeight(2)).toBe(LANE_H);
    expect(laneHeight(4)).toBeGreaterThan(LANE_H);
    const h2 = laneHeight(2);
    const y0 = nodeY(0, h2, 2, 0);
    const y1 = nodeY(0, h2, 2, 1);
    expect(y1 - y0).toBe(96);
    expect(y0 - 20).toBeGreaterThanOrEqual(0); // node top inside lane
    expect(y1 + 96 - 36 + 0).toBeLessThanOrEqual(h2 + 1); // label bottom inside lane
    expect(nodeY(0, LANE_H, 1, 0)).toBe(88); // single track is vertically centered
  });
});

describe('dependency chain', () => {
  //   A -> B -> D -> E
  //   A -> C -> D        X -> C
  const edges = [
    { from: 'A', to: 'B' },
    { from: 'A', to: 'C' },
    { from: 'B', to: 'D' },
    { from: 'C', to: 'D' },
    { from: 'D', to: 'E' },
    { from: 'X', to: 'C' },
  ];
  const key = (e: { from: string; to: string }) => `${e.from}>${e.to}`;

  it('finds full upstream and downstream chains and only the edges on paths through the node', () => {
    const b = dependencyChain('B', edges);
    expect([...b.upstream].sort()).toEqual(['A']);
    expect([...b.downstream].sort()).toEqual(['D', 'E']);
    expect(b.edges.map(key).sort()).toEqual(['A>B', 'B>D', 'D>E']);

    const d = dependencyChain('D', edges);
    expect([...d.upstream].sort()).toEqual(['A', 'B', 'C', 'X']);
    expect([...d.downstream]).toEqual(['E']);
    expect(d.edges).toHaveLength(6);

    expect(dependencyChain('E', edges).downstream.size).toBe(0);
    expect(dependencyChain('Z', edges).edges).toEqual([]);
  });

  it('terminates on cycles', () => {
    const c = dependencyChain('A', [
      { from: 'A', to: 'B' },
      { from: 'B', to: 'A' },
    ]);
    expect([...c.upstream]).toEqual(['B']);
    expect([...c.downstream]).toEqual(['B']);
  });
});

describe('misc', () => {
  it('connector path and visible range', () => {
    expect(connectorPath(0, 0, 100, 50)).toBe('M 0 0 C 50 0, 50 50, 100 50');
    expect(connectorPath(0, 0, 10, 0)).toBe('M 0 0 C 24 0, -14 0, 10 0');
    expect(visibleXRange(1000, 800, 400)).toEqual([600, 2200]);
  });

  it('formatDate follows UI/UX §8', () => {
    const now = new Date(2026, 2, 12);
    expect(formatDate('2026-10-08', now)).toBe('Oct 8');
    expect(formatDate('2025-10-08', now)).toBe('Oct 8, 2025');
    expect(formatDate(null, now)).toBe('—');
  });
});

describe('buildSwimModel on the seeded project', () => {
  const root = mkdtempSync(join(tmpdir(), 'cc-swim-'));
  const db = openDb(root);
  seedDb(db, { now: new Date('2026-03-12T10:00:00Z') });
  const tracker = getAllTrackerState(db);
  db.close();
  afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const NOW = new Date(2026, 2, 12, 15, 0); // Thursday of week 7
  const m = buildSwimModel(tracker, 100, NOW);
  const node = (id: string) => {
    const n = m.nodes.find((x) => x.id === id);
    if (!n) throw new Error('missing ' + id);
    return n;
  };

  it('has week columns, three lanes in order of first appearance, and the key row above them', () => {
    expect(tracker.project.start_date).toBe('2026-01-26');
    expect(m.weeks).toHaveLength(14);
    expect(m.weeks[0]).toMatchObject({ n: 1, x: 0, startIso: '2026-01-26' });
    expect(m.weeks[6]).toMatchObject({ n: 7, x: 600, startIso: '2026-03-09' });
    expect(m.lanes.map((l) => l.domain)).toEqual(['Platform', 'Product', 'Infra']);
    expect(m.lanes[0]?.top).toBe(KEY_ROW_H);
    expect(m.lanes.every((l) => l.height >= LANE_H)).toBe(true);
    expect(m.bodyH).toBe(KEY_ROW_H + m.lanes.reduce((s, l) => s + l.height, 0));
    expect(m.totalW).toBe(14 * 100);
  });

  it('places each milestone in its own lane at its planned week (center of the week column)', () => {
    expect(node('M1')).toMatchObject({ lane: 0, x: 50, plannedX: 50, drift: 0 });
    expect(node('M3')).toMatchObject({ lane: 1, week: 3 });
    expect(node('M3').plannedX).toBeCloseTo(250, 6);
    expect(node('M5').lane).toBe(2);
    expect(node('M8').plannedX).toBeCloseTo(1150, 6);
    for (const n of m.nodes) {
      const lane = m.lanes[n.lane];
      expect(n.y).toBeGreaterThan(lane?.top ?? Infinity);
      expect(n.y).toBeLessThan((lane?.top ?? 0) + (lane?.height ?? 0));
    }
  });

  it('shifts drifting milestones by their drift and keeps the ghost at the plan', () => {
    const m4 = node('M4');
    expect(m4.drift).toBe(5);
    expect(m4.x - m4.plannedX).toBeCloseTo((5 / 7) * 100, 6);
    expect(node('M5').drift).toBe(-1);
    expect(node('M5').x).toBeLessThan(node('M5').plannedX);
    expect(
      m.nodes
        .filter((n) => n.drift !== 0)
        .map((n) => n.id)
        .sort(),
    ).toEqual(['M3', 'M4', 'M5']);
  });

  it('puts the NOW marker on today within the day', () => {
    expect(m.todayIso).toBe('2026-03-12');
    expect(m.nowPos).toBeCloseTo(6.5, 10); // Thursday is the middle of week 7
    expect(m.nowX).toBeCloseTo(650, 6);
    const tomorrow = buildSwimModel(tracker, 100, new Date(2026, 2, 13, 9, 0));
    expect(tomorrow.nowX - m.nowX).toBeCloseTo(100 / 7, 6);
  });

  it('derives status, key milestones, dependency edges and adjacent lines', () => {
    expect(['M1', 'M2', 'M3'].map((id) => node(id).status)).toEqual(['done', 'done', 'done']);
    expect(node('M4').status).toBe('blocked');
    expect(node('M6').status).toBe('normal');
    expect(m.keyNodes.map((n) => [n.id, n.keyLabel])).toEqual([
      ['M4', 'Beta Release'],
      ['M8', 'V1.0 Launch'],
    ]);
    expect(m.edges).toHaveLength(8);
    expect(m.edges).toContainEqual({ from: 'M2', to: 'M4' });
    expect(m.edges).toContainEqual({ from: 'M7', to: 'M8' });
    expect(m.adjacent).toContainEqual({ from: 'M1', to: 'M2' }); // Platform lane, consecutive
    expect(m.adjacent).toContainEqual({ from: 'M2', to: 'M8' });
    expect(m.phases.map((p) => [p.title, p.x, p.w])).toEqual([
      ['Foundation', 0, 400],
      ['Build', 400, 500],
      ['Launch', 900, 400],
    ]);
  });

  it('reports per-lane and per-milestone task progress', () => {
    expect(node('M1')).toMatchObject({ done: 8, total: 8 });
    expect(m.lanes.reduce((n, l) => n + l.total, 0)).toBe(60);
    expect(m.lanes.reduce((n, l) => n + l.done, 0)).toBe(
      tracker.subtasks.filter((t) => t.status === 'done').length,
    );
  });

  it('scales every x with the zoom level', () => {
    const z = buildSwimModel(tracker, 160, NOW);
    for (const n of m.nodes)
      expect(node(n.id).x / 100).toBeCloseTo((z.nodes.find((q) => q.id === n.id)?.x ?? 0) / 160, 6);
    expect(z.nowX / 160).toBeCloseTo(m.nowX / 100, 6);
  });

  it('never overlaps two labels on one track, and stacks same-week milestones in a lane', () => {
    const crowded: TrackerState = {
      ...tracker,
      milestones: [
        ...tracker.milestones,
        ...['X1', 'X2', 'X3'].map((id) => ({
          ...(tracker.milestones[0] as TrackerState['milestones'][number]),
          id,
          title: id,
          dependencies: [],
        })),
      ],
    };
    const c = buildSwimModel(crowded, 100, NOW);
    const sameLane = c.nodes.filter((n) => n.lane === 0);
    for (const a of sameLane) {
      for (const b of sameLane) {
        if (a.id < b.id && a.track === b.track)
          expect(Math.abs(a.x - b.x)).toBeGreaterThanOrEqual(NODE_PITCH);
      }
    }
    expect(c.lanes[0]?.tracks).toBeGreaterThan(1);
    expect(c.lanes[0]?.height).toBeGreaterThanOrEqual(LANE_H);
    expect(c.lanes[1]?.top).toBeGreaterThanOrEqual(
      (c.lanes[0]?.top ?? 0) + (c.lanes[0]?.height ?? 0),
    );
  });

  it('handles an empty project', () => {
    const empty = buildSwimModel(
      { ...tracker, milestones: [], subtasks: [], phases: [] },
      100,
      NOW,
    );
    expect(empty.lanes).toEqual([]);
    expect(empty.nodes).toEqual([]);
    expect(empty.bodyH).toBe(KEY_ROW_H);
    expect(empty.weeks.length).toBeGreaterThanOrEqual(13);
  });
});
