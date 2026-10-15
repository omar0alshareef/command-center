# Stage M16 — "How to use" video in Remotion

**Goal:** a 32-second vertical (1080×1920, 30 fps) tutorial video for ads that shows only *how to use the app*, six steps, built as code in Remotion so every text, font and colour can be changed and re-rendered without redesign.

**Hard rules (from the owner)**

1. **No logo and no product name anywhere** — not in the intro, not in the end card, not in a corner mark, not in file names inside the video. Only the how-to.
2. **Beige leads.** About 80 % of every frame is beige/paper/ink. Green is only a small accent (step dots, one underline, one ring, the active word). No full-green scenes, no green backgrounds.
3. Bilingual: English headline + Levantine Arabic line under it, every step.
4. Fast, eased motion. Nothing sits still for more than ~0.4 s. No slow fades as the main transition.
5. Real app screenshots only (supplied in `public/shots/`), no invented UI, no invented numbers.

---

## Setup

- Create `marketing/video/` (or `apps/promo-video/`) as an isolated Remotion project. It must not be imported by the app and must not touch the app's build.
- `npx create-video@latest` (TypeScript, blank, Tailwind off — keep plain CSS/inline styles).
- If the Remotion agent skill / best-practices is available to you, use it. Otherwise follow the official docs (`useCurrentFrame`, `interpolate`, `spring`, `Sequence`, `AbsoluteFill`, `@remotion/transitions`, `@remotion/google-fonts`).
- Check the Remotion license terms for your use before using it commercially.
- Copy the screenshots into `public/shots/`: `planning.png`, `approve-dialog.png`, `agent-hub.png`, `task-board.png` (all 1384×787).

## Design tokens (`src/theme.ts`)

| token | value | use |
|---|---|---|
| beige | `#EFE8D7` | main background |
| beige-deep | `#E4DAC2` | secondary background blobs, back card |
| paper | `#FAF6EA` | cards, chips |
| ink | `#252E1B` | headlines |
| muted | `#6B6F55` | secondary text |
| clay | `#B8693C` | tiny warm detail (one dot, one underline) |
| olive | `#59692B` | **accent only** (≤10 % of the frame) |
| mint | `#D5DDB8` | very soft highlight behind one word, optional |

- Background: beige with two soft, slowly drifting radial blobs in *beige-deep* and a faint warm tan — not green. Add subtle paper grain (SVG noise, ~8 % opacity, multiply).
- Fonts via `@remotion/google-fonts`: **Lora** (headlines, accent word in italic), **Inter** (labels), **Cairo** (Arabic, bold). Load them with `delayRender`-safe loaders.
- Small details: thin corner tick marks, a six-dot step tracker, hairline progress bar at the bottom (olive, 6 px).

## Composition

- One composition `HowTo` (1080×1920, 30 fps, 960 frames), with a prop `showText: boolean` (default true).
- A second composition `HowToNoText` = same component with `showText=false`: hides all headline, Arabic, tag and callout text but keeps screenshots, rings, dots and motion. This is the file the owner edits in VN/CapCut.
- All copy lives in `src/copy.ts` (one object per scene) so edits are one-line changes.
- Also export `scenes.srt` (EN and AR) from the same timing data with a small script `npm run srt`.

## Timeline (seconds)

| # | time | scene | EN headline | AR line | screenshot / camera |
|---|---|---|---|---|---|
| 0 | 0.0–2.0 | Hook (no brand) | Here’s how it works. | هيك بيشتغل | beige card sliding in, six empty step dots draw themselves |
| 1 | 2.0–6.6 | Step 1 | Tell it what you *want.* | احكي شو بدك بكلمات عادية | `planning.png`, start on the chat bubble (460,150) z2.0 → (460,310) z1.9 |
| 2 | 6.6–11.0 | Step 2 | Review the plan and the *team.* | راجع الخطة والفريق | `planning.png`, (1000,245) z1.6 → 1.75 |
| 3 | 11.0–15.0 | Step 3 | Approve it. *One click.* | وافق بضغطة وحدة | `approve-dialog.png`, (692,395) z1.35 → 2.3, pulse ring on “Approve plan” (826,454) |
| 4 | 15.0–19.2 | Step 4 | Helpers get to *work.* | المساعدين بيشتغلوا عنك | `agent-hub.png`, (170,300) z1.5 → (860,300) |
| 5 | 19.2–23.6 | Step 5 | Follow progress on your *board.* | تابع التقدم على اللوحة | `task-board.png`, (690,420) z1.1 → (330,330) z1.9 |
| 6 | 23.6–27.6 | Step 6 | You approve every *result.* | وإنت بتوافق على كل نتيجة | `task-board.png`, (690,420) z1.2 → (680,350) z2.1, ring at the review ✓ (766,321) |
| 7 | 27.6–32.0 | Close (no brand) | Get your life and projects *in order.* | رتّب حياتك ومشاريعك | beige background, six dots all filled, the six step headlines listed small, then a plain closing line. **No logo, no name.** |

Callout chips (hidden in the no-text version), all true to the screenshots: “Plain words, no setup”, “2 milestones · 4 tasks · 3 helpers”, “You decide”, “Every action logged”, “29 of 60 done”, “Awaiting your review”.

## Motion spec

- Headlines: split by word, each word in an `overflow:hidden` mask rising from 110 % with `spring({damping:18, stiffness:140})`, 2-frame stagger, slight rotate (4°→0). The accent word (marked with `*…*`) is Lora italic in olive.
- Arabic line: fade + 26 px rise, starts after the last English word.
- Screenshot window: rounded 26 px, 1 px border, soft shadow, a *beige-deep* card rotated 3° behind it. Enters with translateY 140 → 0, rotate −2.4° → 0, scale .92 → 1 (spring). Then a camera move inside the window using `interpolate` with `Easing.inOut(Easing.cubic)` between the keyframes in the table (cover-fit scale × z, clamp so no blank edges). Add ±1.8 % “breathing” zoom so it never freezes.
- Rings: three concentric pulses, 90 % → 0 opacity, 2 s.
- Callouts: pop with overshoot spring, bob ±7 px.
- Step dots: active dot stretches 14 → 70 px; passed dots stay at 70 % opacity.
- Scene transitions (0.5–0.7 s, alternate, never the same twice in a row): wipe up, wipe left, wipe down, circle iris, wipe up, wipe left. Implement with `clip-path` on the incoming scene; the outgoing scene scales to 0.95 and darkens 15 % underneath. Use `@remotion/transitions` or hand-rolled `clip-path`.
- Background blobs drift on slow sine paths; grain overlay is static.

## Acceptance criteria

- `npx remotion render HowTo out/howto.mp4` → 1080×1920, 30 fps, exactly 32.0 s, H.264, < 25 MB.
- `npx remotion render HowToNoText out/howto-notext.mp4` has **no text at all** (check frame 0, 100, 400, 700 visually).
- No logo, no product name, no “Hero” anywhere (grep the project and open 8 frames).
- Beige is clearly dominant; open frames 60, 200, 400, 600 and confirm green covers well under a tenth of the frame.
- All text safe-zone: nothing within 120 px of top/bottom (platform UI overlap).
- Contrast of headline on beige ≥ 7:1.
- `npm run srt` writes `howto-en.srt` and `howto-ar.srt` with the same timings as the video.
- Screenshots never show blank areas when zoomed; no screenshot shows local file paths or API-key errors.
- README with: how to edit copy, fonts, colours; how to render both versions.

---

## Prompt to paste into Claude Code

```
Build Stage M16 from the file REMOTION_HOWTO_VIDEO_STAGE.md (same folder as the screenshots). Create an isolated Remotion project in marketing/video/ that does not touch the app.

Goal: a 32-second, 1080x1920, 30fps vertical "how to use" tutorial ad in six steps, bilingual (English headline + Levantine Arabic line), made of the real screenshots in public/shots/.

Non-negotiable:
- NO logo and NO product name anywhere (not in the intro, end card, corner marks, or text). Only the how-to.
- Beige dominates (about 80% of every frame: #EFE8D7 background, #FAF6EA cards, #252E1B ink). Olive green #59692B is a small accent only (step dots, one ring, the italic accent word, progress bar). No green backgrounds or green scenes.
- Fonts: Lora (headlines), Inter (labels), Cairo bold (Arabic) via @remotion/google-fonts.
- Motion must feel fast and professional: word-by-word spring headlines in masks, a screenshot window with a rotated beige-deep card behind it, camera pan/zoom between the keyframes in the table, pulse rings, pop-in callouts, an active step-dot that stretches, alternating clip-path scene transitions (wipe up/left/down/iris), drifting background blobs and paper grain. Nothing idle for more than ~0.4s.
- Two compositions: HowTo (with text) and HowToNoText (same, with every headline/Arabic/tag/callout hidden) so I can add my own text in VN. All copy in src/copy.ts. Add `npm run srt` that writes howto-en.srt and howto-ar.srt from the same timing data.

Follow the timeline, camera keyframes, motion spec and acceptance criteria in the stage file exactly. Use the Remotion agent skill / best practices if available. When done: render both videos, extract frames 60/200/400/600 of each and check them against the acceptance criteria (no brand, beige dominant, no blank zoom edges, no local paths), fix anything that fails, then report the render commands and file sizes. Do not commit large renders (add out/ to .gitignore).
```
