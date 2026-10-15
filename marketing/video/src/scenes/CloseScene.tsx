import React from 'react';
import { Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { copy } from '../copy';
import { ArabicLine } from '../components/ArabicLine';
import { Headline, headlineSettle } from '../components/Headline';
import { colors, fonts } from '../theme';

const MARGIN = 90;
const plain = (s: string) => s.replace(/\*/g, '');

/** The close: the final line, the six steps listed small, then a plain closing line. Still no name, no mark. */
export const CloseScene: React.FC<{ showText: boolean }> = ({ showText }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const settle = 6 + headlineSettle(copy.close.en);
  const cardP = spring({ frame: frame - 26, fps, config: { damping: 17, stiffness: 120 } });
  const lineP = interpolate(frame, [92, 112], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  return (
    <>
      <div style={{ position: 'absolute', left: MARGIN, right: MARGIN, top: 200 }}>
        <Headline text={copy.close.en} start={6} size={100} visible={showText} />
        <div style={{ marginTop: 22 }}>
          <ArabicLine text={copy.close.ar} start={settle} size={60} visible={showText} />
        </div>
      </div>
      <div
        style={{
          position: 'absolute',
          left: MARGIN,
          right: MARGIN,
          top: 780,
          padding: '46px 54px',
          borderRadius: 38,
          background: colors.paper,
          border: '1px solid rgba(37,46,27,0.14)',
          boxShadow: '0 30px 70px rgba(37,46,27,0.16)',
          transform: `translateY(${(1 - cardP) * 220}px)`,
          opacity: Math.min(1, cardP * 2),
          display: 'flex',
          flexDirection: 'column',
          gap: 22,
          minHeight: 520,
        }}
      >
        {copy.steps.map((s, i) => {
          const p = spring({ frame: frame - 40 - i * 5, fps, config: { damping: 16, stiffness: 150 } });
          return (
            <div
              key={s.en}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 24,
                fontFamily: fonts.sans,
                fontWeight: 500,
                fontSize: 40,
                color: colors.ink,
                opacity: showText ? p : 0,
                transform: `translateX(${(1 - p) * 60}px)`,
              }}
            >
              <span style={{ width: 36, fontWeight: 600, color: colors.muted }}>{i + 1}</span>
              {plain(s.en)}
            </div>
          );
        })}
      </div>
      <div
        style={{
          position: 'absolute',
          left: MARGIN,
          right: MARGIN,
          top: 1440,
          textAlign: 'center',
          opacity: showText ? lineP : 0,
          transform: `translateY(${(1 - lineP) * 30}px)`,
        }}
      >
        <div style={{ fontFamily: fonts.serif, fontStyle: 'italic', fontWeight: 500, fontSize: 64, color: colors.ink }}>
          {copy.close.line.en}
        </div>
        <div dir="rtl" lang="ar" style={{ marginTop: 10, fontFamily: fonts.arabic, fontWeight: 700, fontSize: 52, color: colors.ink }}>
          {copy.close.line.ar}
        </div>
      </div>
    </>
  );
};
