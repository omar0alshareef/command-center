# How-to video (Remotion)

A 32-second, 1080x1920, 30 fps vertical tutorial in six steps, built as code so every word, font and colour can be changed and re-rendered. It shows only how to use the app: no logo and no product name anywhere. It is a standalone project: nothing in the app imports it and it has its own `package.json`.

```bash
cd marketing/video
npm install
npm run studio        # live preview, scrub the timeline
```

## Render

```bash
npx remotion render HowTo out/howto.mp4              # with text (English + Arabic)
npx remotion render HowToNoText out/howto-notext.mp4 # every headline, Arabic line, tag and chip hidden
npm run render                                       # both
npm run srt                                          # out/howto-en.srt and out/howto-ar.srt
```

`HowToNoText` keeps the screenshots, rings, step dots, progress bar and all the motion, so you can lay your own text over it in VN or CapCut. `out/` is git-ignored: renders are not committed.

## Edit the words

All copy is in `src/copy.ts`, one object per scene (`hook`, `steps[0..5]`, `close`). `*word*` makes the accent word (Lora italic, olive). The callout chips and the "Step n" tags are in the same objects. Subtitles read the same file, so `npm run srt` always matches the video.

## Edit the timing

`src/timing.ts` holds the scene start and end in seconds (the timeline from the stage file). The camera moves for each step are in `src/HowTo.tsx` (`SHOTS`, in screenshot pixels, `z` is the zoom; the view is clamped so no edge of a screenshot is ever blank). Scene wipes alternate in `WIPES`. If you change the total length, also change `DURATION_FRAMES` in `src/theme.ts`.

## Edit colours and fonts

- Colours: `src/theme.ts` (`beige` background, `beigeDeep`, `paper`, `ink`, `muted`, `clay`, `olive`, `mint`, `tan`). Olive is an accent only: step dots, one ring, the italic word, the progress bar. Keep it under a tenth of the frame.
- Fonts: `src/fonts.ts` loads Lora, Inter and Cairo (Arabic, bold) through `@remotion/google-fonts`; the loaders hold the render until each font is ready. To swap one, change the import there and the family in `fonts` in `src/theme.ts`.

## Screenshots

`public/shots/*.png` are real screenshots (1384x787). The bottom 24 px (a status bar with a file name) is never shown: the camera is clamped to the top 763 px. To use new screenshots, keep the same names or update `SHOTS` in `src/HowTo.tsx`, and check that no frame shows a local path, an API-key error or a product name.

## Checks used for this version

1080x1920, 30 fps, exactly 32.0 s (960 frames), H.264; headline ink on beige is 11.6:1; nothing readable within 120 px of the top or bottom; about 90 % of each frame is beige or paper and saturated green stays near 1-2 %.

## Licence

Remotion has its own licence terms (free for individuals and small teams, a company licence above that). Check them before using the output commercially: https://www.remotion.dev/license
