import type { Task } from '@command-center/core';

// Calendar math. Completion times are stored in UTC; every day boundary here is the viewer's local midnight.
// Weeks start on Monday by default (UI/UX §6.4); Settings can switch to Sunday.

const pad = (n: number) => String(n).padStart(2, '0');
export const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Local midnight `n` days from `d` (calendar arithmetic, safe across DST changes). */
export const addDays = (d: Date, n: number): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

export const mondayOf = (d: Date): Date => addDays(d, -((d.getDay() + 6) % 7));

/** Parse `YYYY-MM-DD` as a local date, or null if it is not a real date. */
export function parseDayKey(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return dayKey(d) === s ? d : null;
}

/** ISO-8601 week number (Monday start; week 1 contains the first Thursday). */
export function isoWeek(d: Date): number {
  const thursday = addDays(mondayOf(d), 3);
  const jan1 = new Date(thursday.getFullYear(), 0, 1);
  const days = Math.round((thursday.getTime() - jan1.getTime()) / 86_400_000);
  return Math.floor(days / 7) + 1;
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const DOW_SUN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const monthDay = (d: Date): string => `${MON[d.getMonth()]} ${d.getDate()}`;

export interface CalendarDay {
  date: Date;
  key: string;
  dow: (typeof DOW)[number] | (typeof DOW_SUN)[number];
  isToday: boolean;
  isWeekend: boolean;
  tasks: Task[];
}

export interface CalendarWeek {
  monday: Date;
  sunday: Date;
  week: number;
  label: string;
  total: number;
  days: CalendarDay[];
}

/** Seven Monday-to-Sunday columns holding the done tasks completed on each local day, earliest first. */
export function buildWeek(
  tasks: readonly Task[],
  anchor: Date,
  now = new Date(),
  weekStart: 'mon' | 'sun' = 'mon',
  projectStart?: string,
): CalendarWeek {
  // `monday` / `sunday` are the first and last day of the shown week (named for the default).
  const monday = weekStart === 'sun' ? addDays(anchor, -anchor.getDay()) : mondayOf(anchor);
  const names = weekStart === 'sun' ? DOW_SUN : DOW;
  const today = dayKey(now);
  const days: CalendarDay[] = names.map((dow, i) => {
    const date = addDays(monday, i);
    return {
      date,
      key: dayKey(date),
      dow,
      isToday: dayKey(date) === today,
      isWeekend: dow === 'Sat' || dow === 'Sun',
      tasks: [],
    };
  });
  const byKey = new Map(days.map((d) => [d.key, d]));
  for (const t of tasks) {
    if (t.status !== 'done' || !t.completed_at) continue;
    const when = new Date(t.completed_at);
    if (Number.isNaN(when.getTime())) continue;
    byKey.get(dayKey(when))?.tasks.push(t);
  }
  for (const d of days)
    d.tasks.sort(
      (a, b) =>
        Date.parse(a.completed_at ?? '') - Date.parse(b.completed_at ?? '') ||
        a.id.localeCompare(b.id),
    );
  const sunday = addDays(monday, 6);
  // Week 1 is the week the project began in (its day 0), not the calendar year's week.
  const origin = projectStart ? parseDayKey(projectStart.slice(0, 10)) : null;
  const week = origin
    ? Math.round(
        (monday.getTime() - (weekStart === 'sun' ? addDays(origin, -origin.getDay()) : mondayOf(origin)).getTime()) /
          604_800_000,
      ) + 1
    : isoWeek(weekStart === 'sun' ? addDays(monday, 1) : monday);
  return {
    monday,
    sunday,
    week,
    label: `Week ${week} · ${monthDay(monday)} – ${monthDay(sunday)}`,
    total: days.reduce((n, d) => n + d.tasks.length, 0),
    days,
  };
}

export const clock = (iso: string): string => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
