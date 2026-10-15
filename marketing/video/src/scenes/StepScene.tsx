import React from 'react';
import { Easing, interpolate, useCurrentFrame } from 'remotion';
import type { SceneCopy } from '../copy';
import { ArabicLine } from '../components/ArabicLine';
import { Callout } from '../components/Callout';
import { Headline, headlineSettle } from '../components/Headline';
import { ShotWindow, WINDOW, type Cam, type RingAt } from '../components/ShotWindow';
import { colors, fonts } from '../theme';

export interface StepShot {
  file: string;
  from: Cam;
  to: Cam;
  rings?: RingAt[];
}

const MARGIN = 90;

/** Steps 1-6: the tag, the English headline, the Arabic line, then the screenshot window with its camera move and one chip. */
export const StepScene: React.FC<{
  copy: SceneCopy;
  shot: StepShot;
  duration: number;
  chipSide: 'left' | 'right';
  showText: boolean;
}> = ({ copy, shot, duration, chipSide, showText }) => {
  const frame = useCurrentFrame();
  const settle = 6 + headlineSettle(copy.en);
  const tagP = interpolate(frame, [2, 14], [0, 1], { extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  return (
    <>
      <div style={{ position: 'absolute', left: MARGIN, right: MARGIN, top: 186 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 18,
            marginBottom: 14,
            fontFamily: fonts.sans,
            fontWeight: 600,
            fontSize: 30,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: colors.muted,
            opacity: showText ? tagP : 0,
            transform: `translateX(${(1 - tagP) * -24}px)`,
          }}
        >
          <span style={{ width: 54 * tagP, height: 4, background: colors.clay, borderRadius: 2 }} />
          {copy.tag}
        </div>
        <Headline text={copy.en} start={6} size={92} visible={showText} />
        <div style={{ marginTop: 22 }}>
          <ArabicLine text={copy.ar} start={settle} size={58} visible={showText} />
        </div>
      </div>
      <ShotWindow file={shot.file} from={shot.from} to={shot.to} duration={duration} rings={shot.rings ?? []} />
      {copy.callout ? (
        <Callout
          text={copy.callout}
          x={chipSide === 'left' ? MARGIN : MARGIN}
          y={WINDOW.y - 46}
          align={chipSide}
          start={settle + 4}
          visible={showText}
        />
      ) : null}
    </>
  );
};
