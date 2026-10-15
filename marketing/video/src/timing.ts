import { FPS } from './theme';

// The one timeline. The video, the subtitles (`npm run srt`) and the tracker all read it. Seconds, from the stage file.
export type SceneKey = 'hook' | 's1' | 's2' | 's3' | 's4' | 's5' | 's6' | 'close';

export interface SceneTime {
  key: SceneKey;
  start: number;
  end: number;
}

export const SCENES: readonly SceneTime[] = [
  { key: 'hook', start: 0.0, end: 2.0 },
  { key: 's1', start: 2.0, end: 6.6 },
  { key: 's2', start: 6.6, end: 11.0 },
  { key: 's3', start: 11.0, end: 15.0 },
  { key: 's4', start: 15.0, end: 19.2 },
  { key: 's5', start: 19.2, end: 23.6 },
  { key: 's6', start: 23.6, end: 27.6 },
  { key: 'close', start: 27.6, end: 32.0 },
];

export const toFrame = (seconds: number): number => Math.round(seconds * FPS);

/** How long one scene change takes (0.6 s): the incoming scene is revealed while the outgoing one scales back and darkens. */
export const TRANSITION_FRAMES = 18;

/** The way each scene is revealed, alternating, never the same twice in a row. The hook has none. */
export type Wipe = 'up' | 'left' | 'down' | 'iris';
export const WIPES: readonly Wipe[] = ['up', 'left', 'down', 'iris', 'up', 'left', 'down'];
