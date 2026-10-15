import React from 'react';
import { Easing, useCurrentFrame } from 'remotion';
import { colors, DURATION_FRAMES, H, W } from '../theme';
import { SCENES, toFrame } from '../timing';

// The parts that stay across scenes: the six-dot step tracker, the hairline progress bar and the corner tick marks.
// None of them carries a word, so they are the same in the text and no-text versions.

const ease = Easing.inOut(Easing.cubic);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

const DOT_H = 14;
const DOT_W = 14;
const ACTIVE_W = 70;
const DONE_W = 34;

/** Six dots. They draw themselves in the hook, the current step stretches to a pill, finished steps stay at 70 %, and in the close all fill. */
export const StepTracker: React.FC = () => {
  const f = useCurrentFrame();
  const closeStart = toFrame(SCENES[7]?.start ?? 27.6);
  return (
    <div
      style={{
        position: 'absolute',
        top: 133,
        left: 0,
        width: W,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 18,
      }}
    >
      {[0, 1, 2, 3, 4, 5].map((i) => {
        const start = toFrame(SCENES[i + 1]?.start ?? 0);
        const end = toFrame(SCENES[i + 1]?.end ?? 0);
        const draw = ease(clamp01((f - 6 - i * 5) / 24));
        const on = ease(clamp01((f - (start - 4)) / 14));
        const off = ease(clamp01((f - (end - 4)) / 12));
        const active = on * (1 - off);
        const close = ease(clamp01((f - (closeStart + i * 3)) / 14));
        const base = DOT_W + (ACTIVE_W - DOT_W) * active;
        const width = base + (DONE_W - base) * close;
        const fill = on * (0.7 + 0.3 * active) + (1 - on * (0.7 + 0.3 * active)) * close;
        return (
          <svg key={i} width={width} height={DOT_H} viewBox={`0 0 ${width} ${DOT_H}`} style={{ overflow: 'visible' }}>
            <rect
              x={1}
              y={1}
              width={width - 2}
              height={DOT_H - 2}
              rx={(DOT_H - 2) / 2}
              fill="none"
              stroke={colors.ink}
              strokeOpacity={0.32}
              strokeWidth={2}
              pathLength={1}
              strokeDasharray={1}
              strokeDashoffset={1 - draw}
            />
            <rect x={1} y={1} width={width - 2} height={DOT_H - 2} rx={(DOT_H - 2) / 2} fill={colors.olive} opacity={fill} />
          </svg>
        );
      })}
    </div>
  );
};

export const ProgressBar: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <div style={{ position: 'absolute', left: 0, bottom: 0, width: W, height: 6, background: 'rgba(37,46,27,0.08)' }}>
      <div style={{ width: (f / DURATION_FRAMES) * W, height: 6, background: colors.olive }} />
    </div>
  );
};

/** Thin L-shaped tick marks in the four corners, inside the safe margin. */
export const Corners: React.FC = () => {
  const f = useCurrentFrame();
  const o = 0.34 * ease(clamp01(f / 20));
  const tick = (style: React.CSSProperties) => (
    <div style={{ position: 'absolute', width: 46, height: 46, opacity: o, borderColor: colors.ink, borderStyle: 'solid', borderWidth: 0, ...style }} />
  );
  const mx = 56; // horizontal inset: left of the 90 px text margin
  const top = 126; // just inside the platform-UI safe margin
  const bottom = H - 126 - 46;
  return (
    <>
      {tick({ left: mx, top, borderLeftWidth: 3, borderTopWidth: 3 })}
      {tick({ right: mx, top, borderRightWidth: 3, borderTopWidth: 3 })}
      {tick({ left: mx, top: bottom, borderLeftWidth: 3, borderBottomWidth: 3 })}
      {tick({ right: mx, top: bottom, borderRightWidth: 3, borderBottomWidth: 3 })}
    </>
  );
};
