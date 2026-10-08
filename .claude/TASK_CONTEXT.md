# TASK-001: Test task

_WEEK 41, Phase: none, Progress: 0%, Schedule: on_track, Blocked: 0_

## Task description
Created as a test of the Command Center tools.

**Goal:** Complete TASK-001 ("Test task") in `command-center/`. The task has no recorded requirements, acceptance criteria, context files or constraints. Do not invent a feature. Find out what is actually required first. If nothing is, report that and stop.

**Steps, in order**
1. Call `get_task_context` for TASK-001, then `get_task_history` and `get_lessons_learned` with `task_id` TASK-001. If `get_task_context` is denied again, use `get_task_summary` instead.
2. If graphify-out/graph.json exists, run `graphify query "<question>"` before grepping raw source, as the root CLAUDE.md requires. Read `command-center/CLAUDE.md`, then the sections of `COMMAND_CENTER_BLUEPRINT.md`, `UI_UX_SPEC.md` and `ROADMAP.md` that the task touches. Check `PROGRESS.md` for the current milestone.
3. Decide whether the task has real work:
   - If the task, its notes or its history give a concrete change, continue with step 4.
   - If they give none, call `block_task` on TASK-001 with the reason "No requirements or acceptance criteria recorded; operator must specify." Add a `log_action` entry saying the same. Stop here and make no code changes.
4. Call `start_task` for TASK-001. State the goal and the files you will change before editing.
5. Make the smallest change that meets the stated requirement. Put logic in `packages/core`, and keep the MCP server, CLI and desktop app as thin wrappers.
6. Add or update one focused test for any non-trivial logic.
7. Run `tsc --noEmit` (strict), lint and the tests. Run `npm run dev` only if the change touches the desktop app. Report the real output.
8. Run `graphify update .` after code changes.
9. Log progress with `log_action` as you go. Call `complete_task` with a summary of what changed and the commands you ran. Do not approve your own work.

**Files you may touch** (only the ones the requirement actually needs)
- `packages/core/src/tasks.ts`: `TaskPatchSchema` (zod, `.strict()`), `applyPatch`
- `packages/core/src/state-machine.ts`: `transition()`
- `packages/core/src/types.ts`
- `packages/core/src/queries/index.ts`
- `packages/core/src/migrations/`: add a new numbered file after 004 and register it in `index.ts` only if the schema must change
- `packages/mcp-server/src/tools/task.ts`, `packages/mcp-server/src/tools/shared.ts`, `packages/mcp-server/src/results.ts`
- `packages/cli/src/commands.ts`
- `PROGRESS.md`: record any ambiguity you resolved

**Constraints**
- Never write task status directly. Use `transition()` (todo → in_progress → review → done, plus blocked).
- Validate input with zod. Throw typed errors from `errors.ts`, for example `TaskNotFoundError`.
- Wrap MCP handlers in `guard(() => ok(...))`. Resolve the actor with `session.resolveActor(agent_id)`. Log every write with `logAction`.
- No raw SQL over IPC. Keep contextIsolation on and nodeIntegration off. Render agent text as text only.
- Windows is the primary target, but keep macOS and Linux working.
- The blueprint wins on data and API conflicts. The UI spec wins on UI conflicts. Where an ambiguity remains, pick the simplest option and record it in `PROGRESS.md`.
- Do not add dependencies, abstractions or scaffolding the task does not need.
- Commit with `feat(Mx): ...` only if the work belongs to a roadmap milestone. Never write supervisor verdict files.

**Lessons from past rejections**
- None recorded for similar tasks. Re-check `get_lessons_learned` for TASK-001 in step 1 and add each lesson found there to this list as a rule.
- Do not guess scope when the task is empty. Block it or ask the operator.
- Do not claim checks passed without showing the actual command output.

## Acceptance criteria
_None._

## Context files
- command-center/packages/core/src/tasks.ts
- command-center/packages/core/src/state-machine.ts
- command-center/packages/core/src/types.ts
- command-center/packages/core/src/queries/index.ts
- command-center/packages/core/src/migrations/
- command-center/packages/mcp-server/src/tools/task.ts
- command-center/packages/mcp-server/src/tools/shared.ts
- command-center/packages/mcp-server/src/results.ts
- command-center/packages/cli/src/commands.ts
- command-center/CLAUDE.md
- get_task_context

## Reference docs
_None._

## Constraints
_None._

## Relevant lessons
_None._