# TASK-001: اختيار اسم القناة والتحقق من توفره وكتابة شعار نصي قصير

_WEEK 41, Phase: none, Progress: 0%, Schedule: on_track, Blocked: 0_

## Task description
### TASK-001: Choose the channel name, verify it is available, record a one-line tagline

### Goal
Pick one YouTube channel name that fits the project's niche and audience. Confirm it is free (no exact title match, @handle unused). Record a one-line text tagline in the plan. No application code changes.

### Steps
1. `get_task_context` for TASK-001, then `start_task`.
2. Read `.claude/TASK_CONTEXT.md` and `sample-projects/demo-project/details/brief.md`, `project.json`, `README.md` and `AGENTS.md`. Take the niche, audience and language from them. The task is written in Arabic, so default to an Arabic or bilingual name if the brief states no language, and note that assumption.
3. Draft 5 candidate names that fit the niche. Prefer short ones that are easy to spell and give a clean @handle.
4. Check each candidate with the vidIQ tools, in this order, and stop at the first one that passes:
   - `vidiq_channel_search` with `handle` set and `handleMatch: "exact"`. An empty result means the handle is free.
   - `vidiq_channel_search` with `channelTitle` set and `channelTitleMatch: "exact"`.
   - `vidiq_youtube_search` with `type: ["channel"]` and the name as the query. Look for lookalike titles.
5. Write the tagline as one line, Arabic or in the channel's language, with no line break.
6. Record the result with `enrich_task` (`notes`) in this form:
   `Channel: <name> | Handle: @<handle> | Tagline: <one line> | Checks: <what was run and found>`.
   Add the same line as a dated entry in `PROGRESS.md`, including the decision, the rejected candidates and the assumptions. Add it to the plan with `add_milestone_note` only if the task's milestone is clear from `get_task_context`.
7. Tick the acceptance criteria with `update_task`, using `done: true` only for criteria you actually verified. Then `log_action` and `complete_task` with a summary. State plainly that the check ran through vidIQ's index and still needs a manual look at youtube.com.

### Files
- Read: `.claude/TASK_CONTEXT.md`, `sample-projects/demo-project/details/brief.md`, `project.json`, `README.md`, `AGENTS.md`.
- Write: `PROGRESS.md`, plus the task `notes` and optionally one milestone note via MCP.
- Do not touch: `packages/core/src/planning.ts`, `apps/desktop/src/main/planner.ts`, `packages/mcp-server/src/tools/read.ts` or any other source file. Do not touch the uncommitted changes already in the working tree.

### Constraints
- This is research and content work. Add no code, tests or dependencies.
- Do not hand-edit the manifesto or roadmap planning documents. Only the operator approves plans.
- Never write supervisor verdict files, and do not approve your own task.
- If no candidate passes the checks, say so in `PROGRESS.md` and in the summary. Do not claim availability you did not see.
- Run `graphify update .` only if you changed code, which this task should not.

### Lessons from past rejections
None recorded. Treat the following as rules until real lessons exist:
- Do not report the name as available without citing the exact checks you ran and what they returned.
- Do not leave the tagline out of the plan or task notes. It must be one line.

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

## Reference docs
_None._

## Constraints
_None._

## Relevant lessons
_None._