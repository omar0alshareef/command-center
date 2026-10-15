import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { copy } from '../src/copy';
import { SCENES } from '../src/timing';

// Subtitles from the same timing and copy the video uses. Writes out/howto-en.srt and out/howto-ar.srt.
const plain = (s: string) => s.replace(/\*/g, '');

const stamp = (seconds: number): string => {
  const ms = Math.round(seconds * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

interface Cue {
  start: number;
  end: number;
  en: string;
  ar: string;
}

function cues(): Cue[] {
  const out: Cue[] = [];
  for (const scene of SCENES) {
    if (scene.key === 'hook') out.push({ start: scene.start, end: scene.end, en: plain(copy.hook.en), ar: copy.hook.ar });
    else if (scene.key === 'close') {
      // The headline first, then the plain closing line for the last 1.8 s.
      const split = scene.end - 1.8;
      out.push({ start: scene.start, end: split, en: plain(copy.close.en), ar: copy.close.ar });
      out.push({ start: split, end: scene.end, en: copy.close.line.en, ar: copy.close.line.ar });
    } else {
      const step = copy.steps[Number(scene.key.slice(1)) - 1];
      if (step) out.push({ start: scene.start, end: scene.end, en: plain(step.en), ar: step.ar });
    }
  }
  return out;
}

const srt = (lang: 'en' | 'ar') =>
  cues()
    .map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c[lang]}\n`)
    .join('\n');

mkdirSync('out', { recursive: true });
writeFileSync(join('out', 'howto-en.srt'), srt('en'), 'utf8');
writeFileSync(join('out', 'howto-ar.srt'), srt('ar'), 'utf8');
console.log(`wrote out/howto-en.srt and out/howto-ar.srt (${cues().length} cues each)`);
