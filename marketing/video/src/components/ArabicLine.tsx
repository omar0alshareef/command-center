import React from 'react';
import { interpolate, Easing, useCurrentFrame } from 'remotion';
import { colors, fonts } from '../theme';

/** The Arabic line: fade and a 26 px rise, starting after the last English word has landed. */
export const ArabicLine: React.FC<{
  text: string;
  start: number;
  size?: number;
  align?: 'left' | 'center';
  visible: boolean;
}> = ({ text, start, size = 58, align = 'left', visible }) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [start, start + 14], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  return (
    <div
      dir="rtl"
      lang="ar"
      style={{
        fontFamily: fonts.arabic,
        fontWeight: 700,
        fontSize: size,
        lineHeight: 1.35,
        color: colors.ink,
        textAlign: align === 'center' ? 'center' : 'right',
        opacity: visible ? p : 0,
        transform: `translateY(${(1 - p) * 26}px)`,
        visibility: visible ? 'visible' : 'hidden',
      }}
    >
      {text}
    </div>
  );
};
