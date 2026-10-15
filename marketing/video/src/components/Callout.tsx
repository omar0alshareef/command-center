import React from 'react';
import { spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { colors, fonts } from '../theme';

/** A chip that pops in with overshoot and then bobs +-7 px. Every line is true to the screenshot beside it. */
export const Callout: React.FC<{
  text: string;
  x: number;
  y: number;
  align: 'left' | 'right';
  start?: number;
  visible: boolean;
}> = ({ text, x, y, align, start = 24, visible }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - start, fps, config: { damping: 9, stiffness: 150, mass: 0.8 } });
  const bob = Math.sin((frame / 60) * Math.PI * 2) * 7;
  return (
    <div
      style={{
        position: 'absolute',
        top: y,
        ...(align === 'left' ? { left: x } : { right: x }),
        transform: `translateY(${bob}px) scale(${p})`,
        transformOrigin: align === 'left' ? 'left center' : 'right center',
        visibility: visible ? 'visible' : 'hidden',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '20px 34px',
        borderRadius: 60,
        background: colors.paper,
        border: '1px solid rgba(37,46,27,0.14)',
        boxShadow: '0 14px 34px rgba(37,46,27,0.16)',
        fontFamily: fonts.sans,
        fontWeight: 600,
        fontSize: 36,
        color: colors.ink,
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ width: 16, height: 16, borderRadius: '50%', background: colors.clay }} />
      {text}
    </div>
  );
};
