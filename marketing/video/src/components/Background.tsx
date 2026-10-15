import React from 'react';
import { AbsoluteFill } from 'remotion';
import { colors, H, W } from '../theme';

// A small static noise tile (SVG turbulence as a data URI), multiplied over the beige at ~8 %. Static on purpose: grain that
// moves reads as a filter, grain that stays reads as paper.
const GRAIN =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.25  0 0 0 0 0.2  0 0 0 0 0.12  0 0 0 0.9 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")";

/** Beige with two soft blobs (beige-deep and a faint warm tan) on slow sine paths, and paper grain. No green. */
export const Background: React.FC<{ t: number }> = ({ t }) => {
  const s = t / 30;
  const blob = (size: number, x: number, y: number, color: string, alpha: string): React.CSSProperties => ({
    position: 'absolute',
    width: size,
    height: size,
    left: x - size / 2,
    top: y - size / 2,
    borderRadius: '50%',
    background: `radial-gradient(circle at 50% 50%, ${color}${alpha} 0%, ${color}00 68%)`,
  });
  return (
    <AbsoluteFill style={{ background: colors.beige }}>
      <div
        style={blob(1250, W * 0.18 + Math.sin(s * 0.55) * 130, H * 0.2 + Math.cos(s * 0.4) * 160, colors.beigeDeep, 'ff')}
      />
      <div
        style={blob(1100, W * 0.86 + Math.cos(s * 0.5) * 120, H * 0.78 + Math.sin(s * 0.35) * 170, colors.beigeDeep, 'e6')}
      />
      <div
        style={blob(820, W * 0.7 + Math.sin(s * 0.3 + 1) * 140, H * 0.32 + Math.cos(s * 0.45) * 120, colors.tan, '59')}
      />
      <AbsoluteFill style={{ backgroundImage: GRAIN, opacity: 0.08, mixBlendMode: 'multiply' }} />
    </AbsoluteFill>
  );
};
