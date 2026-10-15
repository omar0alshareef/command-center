import React from 'react';
import { Easing, interpolate, useCurrentFrame } from 'remotion';
import { colors } from '../theme';
import { TRANSITION_FRAMES, type Wipe } from '../timing';
import { Background } from './Background';

const reveal = Easing.bezier(0.7, 0, 0.2, 1);

/** clip-path of the incoming scene at progress p (0 = nothing, 1 = everything). */
function clip(wipe: Wipe | null, p: number): string | undefined {
  if (!wipe || p >= 1) return undefined;
  const r = (1 - p) * 100;
  switch (wipe) {
    case 'up':
      return `inset(${r}% 0 0 0)`; // revealed from the bottom edge upwards
    case 'down':
      return `inset(0 0 ${r}% 0)`; // revealed from the top edge downwards
    case 'left':
      return `inset(0 0 0 ${r}%)`; // revealed from the right edge leftwards
    case 'iris':
      return `circle(${p * 150}% at 50% 52%)`;
  }
}

/**
 * One scene's layer: its own beige (so the incoming scene hides the outgoing text behind the wipe), a clip-path reveal on the
 * way in, and on the way out the content scales to 0.95 and the layer darkens by 15 % underneath the next scene.
 */
export const SceneShell: React.FC<{
  wipe: Wipe | null;
  /** Global frame at which this layer's frame 0 sits (keeps the background drifting without a jump). */
  offset: number;
  duration: number;
  hasNext: boolean;
  children: React.ReactNode;
}> = ({ wipe, offset, duration, hasNext, children }) => {
  const frame = useCurrentFrame();
  const inP = wipe ? interpolate(frame, [0, TRANSITION_FRAMES], [0, 1], { extrapolateRight: 'clamp', easing: reveal }) : 1;
  const out = hasNext
    ? interpolate(frame, [duration - TRANSITION_FRAMES, duration], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: reveal })
    : 0;
  return (
    <div style={{ position: 'absolute', inset: 0, clipPath: clip(wipe, inP) }}>
      <Background t={frame + offset} />
      <div style={{ position: 'absolute', inset: 0, transform: `scale(${1 - 0.05 * out})`, transformOrigin: '50% 50%' }}>{children}</div>
      <div style={{ position: 'absolute', inset: 0, background: colors.ink, opacity: 0.15 * out, pointerEvents: 'none' }} />
    </div>
  );
};
