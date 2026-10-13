import { describe, expect, it } from 'vitest';
import { nextThemePref, THEME_CYCLE } from '../src/renderer/store';

describe('theme cycle', () => {
  it('goes dark -> light -> calm -> system -> dark', () => {
    expect(THEME_CYCLE).toEqual(['dark', 'light', 'calm', 'system']);
    let p = nextThemePref('dark');
    const seen = [p];
    for (let i = 0; i < 3; i++) seen.push((p = nextThemePref(p)));
    expect(seen).toEqual(['light', 'calm', 'system', 'dark']);
  });
});
