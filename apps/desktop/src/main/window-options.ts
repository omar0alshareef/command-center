import type { BrowserWindowConstructorOptions } from 'electron';

// UI/UX §3.1. Background set on the window itself so there is no white flash.
export const APP_BG = '#0A0A10';

export function buildWindowOptions(platform: NodeJS.Platform): BrowserWindowConstructorOptions {
  return {
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 800,
    backgroundColor: APP_BG,
    show: false,
    // macOS: frameless with inset traffic lights. Windows/Linux keep the native frame.
    ...(platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 16, y: 12 } }
      : {}),
  };
}
