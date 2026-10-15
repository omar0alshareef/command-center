# TASK-001: اختيار اسم القناة والتحقق من توفره وكتابة شعار نصي قصير

_WEEK 42, Phase: none, Progress: 0%, Schedule: on_track, Blocked: 0_

## Task description
**Goal:** Pick a YouTube channel name for handmade-goods shop owners, verify the name and its @handle are free on YouTube, write a one-line text tagline, and record both in the plan (`PROGRESS.md` and the task notes).

**Steps (in order):**
1. Call `get_task_context` for TASK-001, then `start_task`.
2. Read `sample-projects/demo-project/details/brief.md` and `sample-projects/demo-project/AGENTS.md` for the audience and tone. Audience: handmade-goods shop owners. Tone: friendly, direct, clear. The brief states no language and AGENTS.md says "Arabic first, English second", so make the tagline Arabic. Add an English tagline only if it costs nothing extra.
3. Draft 3–5 candidate names, each with a matching @handle (lowercase letters and digits only, short, easy to say).
4. Check each candidate in this order and stop at the first one that passes:
   a. `vidiq_channel_search` with `handle` set to the candidate and `handleMatch: "exact"`. An empty result means the handle is free.
   b. `vidiq_channel_search` with `channelTitle` set to the candidate and `channelTitleMatch: "exact"`. An empty result means no channel has that name.
   c. `vidiq_youtube_search` with `type: ["channel"]` and the name as the query. Scan the results for a near-identical channel name.
5. Reject any candidate whose handle or name already exists. Keep a note of the checks you ran for every rejected candidate.
6. Write the tagline: one line, no pricing, no shipping promises, no medical or legal claims, no guessed claims.
7. Call `enrich_task` with `notes` set to: chosen name, handle, tagline, the checks run, the rejected candidates, and the assumptions (language, niche).
8. Append one entry at the bottom of the "## Project log" section of `PROGRESS.md` (last entry is on line 204, dated 2026-10-13). Use the format `- 2026-10-15 · TASK-001 channel name. Channel: <name> | Handle: @<handle> | Tagline: <one line> | Checks: <what was run and found>. Rejected: <names and why>. Assumptions: <...>.`
9. Call `update_task` to set an acceptance criterion to `done: true` only if you verified it. The name/handle criterion needs a real passing check. The tagline criterion needs the line to be in `PROGRESS.md`.
10. Call `log_action` (e.g. `channel_name_chosen`) with the task id, then `complete_task` with a summary of the choice and the checks. Do not approve it yourself.

**Files to touch:**
- `PROGRESS.md` (append only).
- Task fields through the MCP tools (notes, acceptance criteria, log, completion).
- Nothing else.

**Constraints:**
- Do not read or edit `packages/core/src/planning.ts` or `packages/mcp-server/src/tools/read.ts`.
- Do not publish, create the channel, or send any message. AGENTS.md says another agent or the operator approves.
- Do not claim availability without a tool result behind it. If the vidIQ tools fail or are unavailable, say so in the notes, leave the availability criterion unchecked, and block the task with a reason instead of guessing.
- The check shows that a name looks free in the search index. It does not reserve it. State this in the notes.
- `add_milestone_note` only if a milestone is clearly tied to the task. None is named ("Phase: none"), so skip it.
- No code changes, so no typecheck, lint or test run is needed. Do not run `graphify update .`.

**Lessons from past rejections:**
- None recorded for this task. Rules to follow anyway:
  - Never mark an acceptance criterion done without a verified result.
  - Never claim a name or handle is available unless a search returned no exact match.
  - Never write verdict files or approve your own work.
  - Record every decision and assumption in `PROGRESS.md`, dated.

## Acceptance criteria
- [ ] الاسم مختار ومتاح على يوتيوب (بحث والمعرّف @handle غير مستخدم)
- [ ] شعار نصي من سطر واحد مسجل في الخطة

## Context files
- .claude/TASK_CONTEXT.md
- sample-projects/demo-project/project.json
- sample-projects/demo-project/details/brief.md
- sample-projects/demo-project/README.md
- packages/core/src/planning.ts
- packages/mcp-server/src/tools/read.ts
- PROGRESS.md
- sample-projects/demo-project/AGENTS.md

## Reference docs
_None._

## Constraints
_None._

## Relevant lessons
_None._