import React from 'react';
import { AbsoluteFill, Sequence, useCurrentFrame } from 'remotion';
import './fonts';
import { copy, type SceneCopy } from './copy';
import { Background } from './components/Background';
import { Corners, ProgressBar, StepTracker } from './components/Chrome';
import { SceneShell } from './components/SceneShell';
import { CloseScene } from './scenes/CloseScene';
import { HookScene } from './scenes/HookScene';
import { StepScene, type StepShot } from './scenes/StepScene';
import { SCENES, toFrame, TRANSITION_FRAMES, WIPES } from './timing';

// Camera keyframes per step, in screenshot pixels (1384 x 787), from the stage file. The view is clamped so no edge is blank.
const SHOTS: StepShot[] = [
  { file: 'planning.png', from: { x: 460, y: 150, z: 2.0 }, to: { x: 460, y: 310, z: 1.9 } },
  { file: 'planning.png', from: { x: 1000, y: 245, z: 1.6 }, to: { x: 1000, y: 245, z: 1.75 } },
  {
    file: 'approve-dialog.png',
    from: { x: 692, y: 395, z: 1.35 },
    to: { x: 760, y: 420, z: 2.3 },
    rings: [{ x: 826, y: 454, size: 170 }],
  },
  { file: 'agent-hub.png', from: { x: 170, y: 300, z: 1.5 }, to: { x: 860, y: 300, z: 1.5 } },
  { file: 'task-board.png', from: { x: 690, y: 420, z: 1.1 }, to: { x: 330, y: 330, z: 1.9 } },
  {
    file: 'task-board.png',
    from: { x: 690, y: 420, z: 1.2 },
    to: { x: 680, y: 350, z: 2.1 },
    rings: [{ x: 766, y: 321, size: 130 }],
  },
];

const stepCopy = (n: number): SceneCopy => {
  const c = copy.steps[n];
  if (!c) throw new Error(`No copy for step ${n + 1}`);
  return c;
};

export interface HowToProps {
  /** false = the no-text version: every headline, Arabic line, tag and chip is hidden; shots, rings, dots and motion stay. */
  showText: boolean;
}

export const HowTo: React.FC<HowToProps> = ({ showText }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: '#EFE8D7' }}>
      <Background t={frame} />
      {SCENES.map((scene, i) => {
        const start = toFrame(scene.start);
        const end = toFrame(scene.end);
        // Scene i (i >= 1) begins one transition early, so its reveal finishes exactly when its own time starts.
        const from = i === 0 ? 0 : start - TRANSITION_FRAMES;
        const duration = end - from;
        const wipe = i === 0 ? null : (WIPES[i - 1] ?? 'up');
        return (
          <Sequence key={scene.key} from={from} durationInFrames={duration} name={scene.key}>
            <SceneShell wipe={wipe} offset={from} duration={duration} hasNext={i < SCENES.length - 1}>
              {scene.key === 'hook' ? (
                <HookScene showText={showText} />
              ) : scene.key === 'close' ? (
                <CloseScene showText={showText} />
              ) : (
                <StepScene
                  copy={stepCopy(i - 1)}
                  shot={SHOTS[i - 1] ?? SHOTS[0] ?? { file: '', from: { x: 0, y: 0, z: 1 }, to: { x: 0, y: 0, z: 1 } }}
                  duration={duration}
                  chipSide={i % 2 === 1 ? 'right' : 'left'}
                  showText={showText}
                />
              )}
            </SceneShell>
          </Sequence>
        );
      })}
      <Corners />
      <StepTracker />
      <ProgressBar />
    </AbsoluteFill>
  );
};
