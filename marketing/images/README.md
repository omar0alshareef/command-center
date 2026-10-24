# Marketing images

Images for sharing Command Center: a feature sheet, a square card, theme and tab overviews, and the copy behind them. PNG files are the deliverables; `src/` has the HTML they were rendered from.

## Images

| File | Size | What it shows |
|---|---|---|
| `sheet.png` | 1600×1180 | English feature sheet: headline, four features, two app screenshots, the USP bar. |
| `sheet_ar.png` | 1600×1180 | Same layout in Levantine Arabic. The app screenshots stay in English because they are the real UI. |
| `card.png` | 1080×1080 | Square social card: headline, four bullet points, platform line. |
| `card_ar.png` | 1080×1080 | Levantine Arabic version of the square card. |
| `themes.png` | 1600×1500 | The same board in the four themes: Dark (default), Light, Calm, Calm Dark. |
| `tabs.png` | 1600×2600 | All seven tabs with a one-line description each. |
| `app/` | 1440×787 each | Raw app screenshots behind `themes.png` (theme swim lanes) and `tabs.png` (one per tab). |

The two app screenshots used in the sheet (`swim-lane.png`, `approve-dialog.png`) are in `marketing/video/public/shots/`.

## Per-feature copy

Each feature has a short title and a description. Use them as they are, or cut them down for a caption.

1. **One board, one truth.** Milestones, tasks and runs live in a single SQLite file in your project. The swim lane, task board and calendar all read the same data.
2. **Agents plug in via MCP.** Claude and other agents read the project, start tasks, log every action and submit work through the MCP tools.
3. **Human approval gate.** Finished work waits in Review. The agent that did the work can never approve it. You approve, or send it back with a reason.
4. **Learns from rejections.** Each rejection becomes a lesson. Future tasks get the relevant lessons in their context, and you decide which ones stick.

The USP line used in the sheet: "Your project. Your database. Your call on every result." It is supported by: local-first storage, no hosted dashboard, every action logged, and cost per run tracked.

## Per-image notes

- **sheet / sheet_ar**: best at 1600 px wide on a website or a launch post. The Arabic version uses Cairo for text; the English version uses Lora for headings and Inter for body text.
- **card / card_ar**: built for a 1:1 post. The Arabic headline is "المساعدين بيشتغلوا. إنت بتوافق عليه."
- **themes**: captions say Dark is the default, Calm is beige and warm, and Calm Dark is the dark variant of Calm. Themes are set under Settings → Theme, or with the "Toggle theme" command.
- **tabs**: one caption per tab, in the order of the app's tab bar. Descriptions are based on the tab names and the blueprint, not on user testing.

## Regenerating

Open an HTML file in `src/` in Chrome or Edge and take a screenshot at the size above, or render headless:

```bash
chrome --headless=new --disable-gpu --hide-scrollbars --window-size=1600,1180 --screenshot=sheet.png file:///ABS/PATH/src/sheet.html
```

The demo data behind `themes.png` and `tabs.png` comes from a temporary copy of `sample-projects/demo-project` with a plan of four milestones in four domains (frontend, content, review, backend). The original folder is not changed.
