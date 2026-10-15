import React from 'react';
import { spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { colors, fonts } from '../theme';

export interface Word {
  text: string;
  accent: boolean;
}

/** "Tell it what you *want.*" -> words, with the starred ones flagged as the accent. */
export function parseWords(src: string): Word[] {
  const out: Word[] = [];
  src.split('*').forEach((chunk, i) => {
    for (const w of chunk.split(/\s+/).filter(Boolean)) out.push({ text: w, accent: i % 2 === 1 });
  });
  return out;
}

export const STAGGER = 2;
/** Frames after the first word starts until the last English word has landed (the Arabic line starts then). */
export const headlineSettle = (src: string): number => (parseWords(src).length - 1) * STAGGER + 12;

/** Headline split by word, each word rising out of its own mask with a spring and a slight rotation. */
export const Headline: React.FC<{
  text: string;
  start?: number;
  size?: number;
  align?: 'left' | 'center';
  visible: boolean;
}> = ({ text, start = 4, size = 96, align = 'left', visible }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const words = parseWords(text);
  return (
    <div
      aria-label={visible ? text.replace(/\*/g, '') : undefined}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: align === 'center' ? 'center' : 'flex-start',
        columnGap: size * 0.26,
        rowGap: 0,
        fontFamily: fonts.serif,
        fontWeight: 600,
        fontSize: size,
        lineHeight: 1.08,
        letterSpacing: '-0.015em',
        color: colors.ink,
        visibility: visible ? 'visible' : 'hidden',
      }}
    >
      {words.map((w, i) => {
        const p = spring({ frame: frame - start - i * STAGGER, fps, config: { damping: 18, stiffness: 140 } });
        return (
          <span
            key={`${w.text}-${i}`}
            style={{ display: 'inline-block', overflow: 'hidden', padding: '0.06em 0.04em 0.2em', margin: '-0.06em -0.04em -0.2em' }}
          >
            <span
              style={{
                display: 'inline-block',
                transform: `translateY(${(1 - p) * 110}%) rotate(${(1 - p) * 4}deg)`,
                transformOrigin: 'left bottom',
                fontStyle: w.accent ? 'italic' : 'normal',
                color: w.accent ? colors.olive : colors.ink,
              }}
            >
              {w.text}
            </span>
          </span>
        );
      })}
    </div>
  );
};
