import { describe, expect, it } from 'vitest';
import { APP_BG, buildWindowOptions } from '../src/main/window-options';
import { resolveProjectRoot } from '../src/main/config';

describe('buildWindowOptions', () => {
  it('uses UI/UX §3.1 size and background', () => {
    const opts = buildWindowOptions('win32');
    expect(opts.width).toBe(1400);
    expect(opts.height).toBe(900);
    expect(opts.minWidth).toBe(1200);
    expect(opts.minHeight).toBe(800);
    expect(opts.backgroundColor).toBe('#0A0A10');
    expect(APP_BG).toBe('#0A0A10');
  });

  it('is frameless only on macOS', () => {
    expect(buildWindowOptions('darwin').titleBarStyle).toBe('hidden');
    expect(buildWindowOptions('win32').titleBarStyle).toBeUndefined();
    expect(buildWindowOptions('linux').titleBarStyle).toBeUndefined();
  });
});

describe('resolveProjectRoot', () => {
  it('reads PROJECT_ROOT and ignores blank values', () => {
    expect(resolveProjectRoot({ PROJECT_ROOT: ' /x ' })).toBe('/x');
    expect(resolveProjectRoot({ PROJECT_ROOT: '  ' })).toBeNull();
    expect(resolveProjectRoot({})).toBeNull();
  });
});
