// Design tokens. Beige leads; olive is an accent only (step dots, one ring, the italic accent word, the progress bar).
export const colors = {
  beige: '#EFE8D7', // main background
  beigeDeep: '#E4DAC2', // secondary blobs, back card
  paper: '#FAF6EA', // cards, chips
  ink: '#252E1B', // headlines
  muted: '#6B6F55', // secondary text
  clay: '#B8693C', // one tiny warm detail
  olive: '#59692B', // accent only
  mint: '#D5DDB8', // very soft highlight, optional
  tan: '#D9C7A0', // faint warm tan for the second background blob
} as const;

export const W = 1080;
export const H = 1920;
export const FPS = 30;
export const DURATION_FRAMES = 960; // 32.0 s

/** Nothing readable sits inside this margin at the top or bottom (platform UI overlaps it). */
export const SAFE_Y = 120;

export const fonts = {
  serif: '"Lora", Georgia, serif',
  sans: '"Inter", system-ui, sans-serif',
  arabic: '"Cairo", "Inter", sans-serif',
} as const;

/** The screenshots are 1384 x 787; the bottom 24 px is a status bar that is never shown. */
export const SHOT_W = 1384;
export const SHOT_H = 763;
