import React from 'react';
import { Composition } from 'remotion';
import { HowTo } from './HowTo';
import { DURATION_FRAMES, FPS, H, W } from './theme';

// Remotion types props loosely; the component itself is strict about `showText`.
const Comp = HowTo as unknown as React.FC<Record<string, unknown>>;

// HowTo has all the text. HowToNoText is the same component with `showText` off: the file to edit in a video editor.
export const Root: React.FC = () => (
  <>
    <Composition
      id="HowTo"
      component={Comp}
      durationInFrames={DURATION_FRAMES}
      fps={FPS}
      width={W}
      height={H}
      defaultProps={{ showText: true }}
    />
    <Composition
      id="HowToNoText"
      component={Comp}
      durationInFrames={DURATION_FRAMES}
      fps={FPS}
      width={W}
      height={H}
      defaultProps={{ showText: false }}
    />
  </>
);
