import React from 'react';
import { Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { colors, SHOT_H, SHOT_W } from '../theme';

export interface Cam {
  /** Centre of the view, in screenshot pixels (1384 x 787). */
  x: number;
  y: number;
  /** Zoom on top of the cover-fit scale. */
  z: number;
}

export interface RingAt {
  /** Screenshot pixels. */
  x: number;
  y: number;
  size?: number;
}

export const WINDOW = { x: 100, y: 830, w: 880, h: 880 } as const;

/** The camera at a point of its move, with the clamp that keeps every edge of the view inside the screenshot. */
export function camera(from: Cam, to: Cam, k: number, breathe: number, w: number, h: number) {
  const z = (from.z + (to.z - from.z) * k) * breathe;
  const cover = Math.max(w / SHOT_W, h / SHOT_H);
  const s = cover * z;
  const hw = w / (2 * s);
  const hh = h / (2 * s);
  const clamp = (v: number, half: number, max: number) => (half * 2 >= max ? max / 2 : Math.min(max - half, Math.max(half, v)));
  const cx = clamp(from.x + (to.x - from.x) * k, hw, SHOT_W);
  const cy = clamp(from.y + (to.y - from.y) * k, hh, SHOT_H);
  return { s, cx, cy };
}

/** Three concentric pulses (90 % -> 0 opacity, 2 s). The only place olive is drawn large, and it is a thin line. */
const Pulse: React.FC<{ x: number; y: number; size: number; frame: number }> = ({ x, y, size, frame }) => (
  <>
    {[0, 20, 40].map((delay) => {
      const p = (((frame - delay) % 60) + 60) % 60;
      const k = p / 60;
      return (
        <div
          key={delay}
          style={{
            position: 'absolute',
            left: x - size / 2,
            top: y - size / 2,
            width: size,
            height: size,
            borderRadius: '50%',
            border: `6px solid ${colors.olive}`,
            opacity: 0.9 * (1 - k),
            transform: `scale(${0.35 + k * 1.15})`,
          }}
        />
      );
    })}
  </>
);

/**
 * A real screenshot in a rounded window with a rotated beige-deep card behind it. It enters with a spring (rise, un-rotate,
 * scale), then a camera pans and zooms between two keyframes with a cubic ease and a small breathing zoom, so it never freezes.
 */
export const ShotWindow: React.FC<{
  file: string;
  from: Cam;
  to: Cam;
  /** Scene length in frames: the camera move ends with the scene. */
  duration: number;
  rings?: RingAt[];
}> = ({ file, from, to, duration, rings = [] }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { w, h } = WINDOW;
  const enter = spring({ frame: frame - 6, fps, config: { damping: 16, stiffness: 120 } });
  const k = interpolate(frame, [10, duration - 4], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.cubic),
  });
  const breathe = 1 + 0.018 * Math.sin((frame / 90) * Math.PI * 2);
  const { s, cx, cy } = camera(from, to, k, breathe, w, h);
  const toScreen = (x: number, y: number) => ({ x: (x - cx) * s + w / 2, y: (y - cy) * s + h / 2 });
  return (
    <div
      style={{
        position: 'absolute',
        left: WINDOW.x,
        top: WINDOW.y,
        width: w,
        height: h,
        transform: `translateY(${(1 - enter) * 140}px) rotate(${(1 - enter) * -2.4}deg) scale(${0.92 + 0.08 * enter})`,
        opacity: Math.min(1, enter * 2.2),
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 30,
          background: colors.beigeDeep,
          transform: 'rotate(3deg) translate(14px, 18px)',
          boxShadow: '0 18px 40px rgba(37,46,27,0.10)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 26,
          overflow: 'hidden',
          background: colors.paper,
          border: '1px solid rgba(37,46,27,0.16)',
          boxShadow: '0 30px 70px rgba(37,46,27,0.20), 0 4px 14px rgba(37,46,27,0.10)',
        }}
      >
        <Img
          src={staticFile(`shots/${file}`)}
          style={{
            position: 'absolute',
            left: w / 2 - cx * s,
            top: h / 2 - cy * s,
            width: SHOT_W * s,
            maxWidth: 'none',
          }}
        />
        {frame > 14
          ? rings.map((r, i) => {
              const p = toScreen(r.x, r.y);
              return <Pulse key={i} x={p.x} y={p.y} size={r.size ?? 150} frame={frame - 14} />;
            })
          : null}
      </div>
    </div>
  );
};
