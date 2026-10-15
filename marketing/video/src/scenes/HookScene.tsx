import React from 'react';
import { Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { copy } from '../copy';
import { ArabicLine } from '../components/ArabicLine';
import { Headline, headlineSettle } from '../components/Headline';
import { colors, H, W } from '../theme';

/** The hook: a paper card slides in with the line, and the clay underline draws. No name, no mark. */
export const HookScene: React.FC<{ showText: boolean }> = ({ showText }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame: frame - 2, fps, config: { damping: 17, stiffness: 120 } });
  const float = Math.sin((frame / 45) * Math.PI) * 6;
  const under = interpolate(frame, [18, 38], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  const cardW = 900;
  const cardH = 640;
  const settle = 8 + headlineSettle(copy.hook.en);
  return (
    <div
      style={{
        position: 'absolute',
        left: (W - cardW) / 2,
        top: (H - cardH) / 2 + 10,
        width: cardW,
        height: cardH,
        borderRadius: 44,
        background: colors.paper,
        border: '1px solid rgba(37,46,27,0.14)',
        boxShadow: '0 40px 90px rgba(37,46,27,0.18), 0 6px 18px rgba(37,46,27,0.10)',
        transform: `translateY(${(1 - enter) * 520 + float}px) rotate(${(1 - enter) * -4}deg)`,
        opacity: Math.min(1, enter * 2),
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 26,
        padding: 40,
      }}
    >
      <Headline text={copy.hook.en} start={8} size={118} align="center" visible={showText} />
      <div style={{ width: 220 * under, height: 6, borderRadius: 3, background: colors.clay }} />
      <ArabicLine text={copy.hook.ar} start={settle} size={70} align="center" visible={showText} />
    </div>
  );
};
