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
const calm = { ...dark, ...tokens(":root[data-theme='calm']") };

describe.each([
  ['dark', dark],
  ['light', light],
  ['calm', calm],
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

describe('calm theme (UI/UX §4.8)', () => {
  it('defines every token the other themes define', () => {
    const own = tokens(":root[data-theme='calm']");
    for (const k of Object.keys(dark)) expect(own[k], `--${k}`).toBeDefined();
    expect(own['accent-soft']).toBe('#b7d9c1');
    expect(own['accent']).toBe('#0f5132');
    expect(own['bg']).toBe('#faf9f4');
  });
  it('the primary button label (bg on accent) and text on the mint tint are >= 4.5:1', () => {
    expect(ratio(calm['bg'] ?? '', calm['accent'] ?? '')).toBeGreaterThanOrEqual(4.5);
    expect(ratio(calm['text'] ?? '', calm['accent-soft'] ?? '')).toBeGreaterThanOrEqual(4.5);
    expect(ratio(calm['accent'] ?? '', calm['surface-3'] ?? '')).toBeGreaterThanOrEqual(4.5);
  });
  it('status text colours are >= 4.5:1 on ivory and white, and accent-soft is never a text colour', () => {
    for (const k of ['success', 'warning', 'danger'])
      for (const s of ['bg', 'surface'])
        expect(ratio(calm[k] ?? '', calm[s] ?? ''), `${k} on ${s}`).toBeGreaterThanOrEqual(4.5);
    // Tags and chips tint their own colour ~10% over the surface they sit on: text must survive that too.
    const mix = (a: string, b: string, p: number) =>
      '#' +
      [1, 3, 5]
        .map((i) =>
          Math.round(
            parseInt(a.slice(i, i + 2), 16) * p + parseInt(b.slice(i, i + 2), 16) * (1 - p),
          )
            .toString(16)
            .padStart(2, '0'),
        )
        .join('');
    for (const k of ['success', 'warning', 'danger', 'accent'])
      for (const s of ['surface', 'surface-2'])
        expect(
          ratio(calm[k] ?? '', mix(calm[k] ?? '', calm[s] ?? '', 0.1)),
          `${k} tag on ${s}`,
        ).toBeGreaterThanOrEqual(4.5);
    const used = [...css.matchAll(/color:\s*var\(--accent-soft\)/g)];
    expect(used).toHaveLength(0);
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
