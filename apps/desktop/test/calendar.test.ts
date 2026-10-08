import type { Task } from '@command-center/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addDays,
  buildWeek,
  dayKey,
  isoWeek,
  mondayOf,
  parseDayKey,
} from '../src/renderer/lib/calendar';

const done = (id: string, at: Date, status: Task['status'] = 'done') =>
  ({ id, status, completed_at: at.toISOString() }) as Task;

// The TZ environment variable is ignored on Windows, but assigning it at runtime resets the zone everywhere.
const ZONES = [
  ['Pacific/Kiritimati', -840],
  ['America/Los_Angeles', 420],
  ['Asia/Kolkata', -330],
  ['UTC', 0],
] as const;
const original = process.env.TZ;
afterAll(() => {
  if (original === undefined) delete process.env.TZ;
  else process.env.TZ = original;
});

describe.each(ZONES)('in %s', (zone, offset) => {
  beforeAll(() => {
    process.env.TZ = zone;
  });
  it('is really running in that zone', () => {
    expect(new Date(2026, 9, 8, 12).getTimezoneOffset()).toBe(offset);
  });
  describe('calendar math (local time)', () => {
    it('starts weeks on Monday, including for a Sunday', () => {
      expect(dayKey(mondayOf(new Date(2026, 9, 11)))).toBe('2026-10-05'); // Sun
      expect(dayKey(mondayOf(new Date(2026, 9, 5, 0, 1)))).toBe('2026-10-05'); // Mon
      expect(dayKey(mondayOf(new Date(2026, 9, 8)))).toBe('2026-10-05'); // Thu
    });
    it('numbers ISO weeks, including year boundaries', () => {
      expect(isoWeek(new Date(2026, 9, 5))).toBe(41);
      expect(isoWeek(new Date(2026, 0, 1))).toBe(1); // Thu
      expect(isoWeek(new Date(2027, 0, 1))).toBe(53); // Fri belongs to 2026-W53
      expect(isoWeek(new Date(2024, 11, 30))).toBe(1); // Mon of 2025-W01
    });
    it('adds days across month ends and DST', () => {
      expect(dayKey(addDays(new Date(2026, 9, 31), 1))).toBe('2026-11-01');
      expect(dayKey(addDays(new Date(2026, 2, 28), 2))).toBe('2026-03-30');
      expect(dayKey(addDays(new Date(2026, 10, 1), -1))).toBe('2026-10-31');
    });
    it('rejects impossible day keys', () => {
      expect(parseDayKey('2026-02-30')).toBeNull();
      expect(parseDayKey('nope')).toBeNull();
      expect(dayKey(parseDayKey('2026-10-08') as Date)).toBe('2026-10-08');
    });
  });

  describe('buildWeek', () => {
    const nowLocal = () => new Date(2026, 9, 8, 15, 0);
    it('puts each done task on the local day it was completed, ordered by time', () => {
      const now = nowLocal();
      const w = buildWeek(
        [
          done('B', new Date(2026, 9, 8, 14, 30)),
          done('A', new Date(2026, 9, 8, 9, 5)),
          done('MON', new Date(2026, 9, 5, 0, 1)), // first minute of the week
          done('SUN', new Date(2026, 9, 11, 23, 59)), // last minute of the week
          done('PREV', new Date(2026, 9, 4, 23, 59)), // previous Sunday: excluded
          done('NEXT', new Date(2026, 9, 12, 0, 0)), // next Monday: excluded
        ],
        now,
        now,
      );
      expect(w.days.map((d) => d.tasks.map((t) => t.id))).toEqual([
        ['MON'],
        [],
        [],
        ['A', 'B'],
        [],
        [],
        ['SUN'],
      ]);
      expect(w.total).toBe(4);
      expect(w.label).toBe('Week 41 · Oct 5 – Oct 11');
      expect(w.days.find((d) => d.isToday)?.dow).toBe('Thu');
      expect(w.days.filter((d) => d.isWeekend).map((d) => d.dow)).toEqual(['Sat', 'Sun']);
    });
    it('ignores tasks that are not done or have no/invalid completion time', () => {
      const now = nowLocal();
      const w = buildWeek(
        [
          done('R', new Date(2026, 9, 8, 9), 'review'),
          { id: 'N', status: 'done', completed_at: null } as Task,
          { id: 'X', status: 'done', completed_at: 'garbage' } as Task,
        ],
        now,
        now,
      );
      expect(w.total).toBe(0);
    });
    it('is timezone-safe: a UTC instant lands on the viewer’s local day', () => {
      const now = nowLocal();
      // 23:30 local and 00:30 local the next day are different local days whatever the machine's offset is.
      const late = new Date(2026, 9, 7, 23, 30);
      const early = new Date(2026, 9, 8, 0, 30);
      const w = buildWeek([done('LATE', late), done('EARLY', early)], now, now);
      expect(w.days.find((d) => d.key === '2026-10-07')?.tasks.map((t) => t.id)).toEqual(['LATE']);
      expect(w.days.find((d) => d.key === '2026-10-08')?.tasks.map((t) => t.id)).toEqual(['EARLY']);
    });
  });
});
