import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildWeek } from '../src/renderer/lib/calendar';

// UI/UX §7.7: text >= 4.5:1, UI graphics >= 3:1 in both themes. Reads the real tokens from styles.css.
const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]),
  );
}
const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
};

const dark = tokens(':root');
const light = { ...dark, ...tokens(":root[data-theme='light']") };

describe.each([
  ['dark', dark],
  ['light', light],
])('%s theme contrast', (_name, t) => {
  const surfaces = ['bg', 'surface', 'surface-2'] as const;
  it.each(surfaces)('text and muted text on %s are >= 4.5:1', (s) => {
    expect(ratio(t['text'] ?? '', t[s] ?? '')).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t['muted'] ?? '', t[s] ?? '')).toBeGreaterThanOrEqual(4.5);
  });
  it.each(surfaces)('status colours and the accent on %s are >= 3:1', (s) => {
    for (const k of ['accent', 'success', 'warning', 'danger'])
      expect(ratio(t[k] ?? '', t[s] ?? ''), `${k} on ${s}`).toBeGreaterThanOrEqual(3);
  });
});

describe('week start', () => {
  it('Sunday-start weeks run Sun..Sat and keep the ISO week of their Monday', () => {
    const thu = new Date(2026, 9, 8);
    const sun = buildWeek([], thu, thu, 'sun');
    expect(sun.days.map((d) => d.dow).join()).toBe('Sun,Mon,Tue,Wed,Thu,Fri,Sat');
    expect(sun.days[0]?.key).toBe('2026-10-04');
    expect(sun.week).toBe(buildWeek([], thu, thu, 'mon').week);
    expect(buildWeek([], thu, thu).days[0]?.key).toBe('2026-10-05');
  });
});
