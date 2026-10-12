# Command Center — Build Roadmap

> For Claude Code. Read in this order: `COMMAND_CENTER_BLUEPRINT.md` (what to build) → `UI_UX_SPEC.md` (how it looks/behaves) → this file (what order to build it in).
> The blueprint's 13 phases are preserved, but **resequenced into vertical slices** so the app is demoable end-to-end early (agent writes → app updates live) instead of finishing every layer before anything works.

---

## 0. How to use this roadmap

1. Work **one milestone at a time**, in order. Do not start a milestone until the previous one's **Exit criteria** pass.
2. At the start of each milestone: restate the goal, list the files you'll touch, then build.
3. At the end of each: run the exit checks, fix failures, commit (`feat(M3): …`), and report what passed.
4. Keep a `PROGRESS.md` at repo root: milestone → status → notes → known issues. Update it every milestone.
5. When the blueprint and the UI/UX spec disagree: visuals/interaction → UI/UX spec; data/API/schema → blueprint. If something is ambiguous, pick the simplest option, note it in `PROGRESS.md`, and continue.
6. Tests: write unit tests for `core` (state machine, queries, lessons retrieval) from M1 onward. UI gets manual checklists from the UI/UX spec §9 plus a few Playwright-for-Electron smoke tests (M11).

**Definition of Done (every milestone):** typecheck clean (`tsc --noEmit`, strict) · lint clean · app launches with `npm run dev` · exit criteria verified · `PROGRESS.md` updated · committed.

---

## 1. Decisions & Fixes to Blueprint (apply from the start)

These are gaps or risks found while reading the blueprint. They are decisions, not questions — implement as written.

| # | Issue in blueprint | Decision |
|---|---|---|
| D1 | Three deliverables (app, MCP server, CLI) each need the DB, but the blueprint's folder tree only covers the app. | **npm workspaces monorepo**: `packages/core` (schema, migrations, queries, state machine, lessons, types), `apps/desktop` (Electron), `packages/mcp-server`, `packages/cli`. All three import `core`. One implementation of every transition. |
| D2 | `db:query` / `db:run` IPC lets the renderer run arbitrary SQL. | Replace with **named, typed IPC methods** (`tasks.move`, `tasks.update`, `milestones.get`, …). Renderer never sends SQL. Keep `db:getAll`. |
| D3 | `fs.watch` on a WAL database misses changes (writes go to `-wal`). | Detect via `PRAGMA data_version` polling (500ms) + watch `.db`/`-wal` as a hint; debounce 100ms. |
| D4 | Several processes write the same DB (app, MCP server, CLI, webhook). | WAL mode + `busy_timeout = 5000` + `foreign_keys = ON` in a shared `openDb()`. Writes wrapped in short transactions. |
| D5 | State machine says blocked "returns to previous state", schema has no place to remember it. | Add `blocked_from TEXT` to `subtasks`. `block_task` stores current status; `unblock_task` restores it. |
| D6 | Webhook server is open on a port with no auth. | Bind to `127.0.0.1` only. Generate a random token on first run (stored in settings), require `Authorization: Bearer`. Validate payloads (zod). Add the missing `POST /webhook/agent-action` handler. Validate `status` against the allowed enum. |
| D7 | `lessons_learned` retrieval uses `LIKE %taskLabel%` (poor recall). | Use SQLite **FTS5** over `rejection_reason + fix_applied` and match on task label/keywords; fall back to LIKE. |
| D8 | Terminal cwd defaults to home dir. | Default to `PROJECT_ROOT`. Default shell: PowerShell on Windows, `$SHELL` elsewhere. |
| D9 | Light theme not specified. | Use the light tokens in UI/UX spec §4.2. |
| D10 | Tool count inconsistency (“24+” vs 25 listed). | Implement all 25 listed tools; update docs to say 25. |
| D11 | No migration story. | `schema_version` table + ordered migration files in `core/migrations`. Schema in blueprint Phase 1 = migration `001`; D5 and D6 additions = `002`. |
| D12 | `Electron 41+`, `Tailwind 4`, `React 19` — versions drift. | Run `npm view electron version` etc. and use the **latest stable** that electron-vite supports; pin exact versions in `package-lock`. Note choices in `PROGRESS.md`. |
| D13 | Primary dev machine is **Windows**; `node-pty` and `better-sqlite3` are native modules. | Use `electron-rebuild` (postinstall), document Windows build-tools prerequisites in README, test M7 on Windows first. Ship prebuilds where available. |
| D14 | JSON-in-TEXT columns (`dependencies`, `notes`, …). | Keep per blueprint, but access only through typed `core` mappers (`parse/serialize`) so shape is validated in one place. |

---

## 2. Target Repo Layout

```
command-center/
├── package.json                 # workspaces
├── tsconfig.base.json
├── PROGRESS.md
├── README.md
├── packages/
│   ├── core/
│   │   ├── src/{db.ts, schema.ts, migrations/, queries/, state-machine.ts,
│   │   │        lessons.ts, context.ts, types.ts, seed.ts}
│   │   └── test/
│   ├── mcp-server/              # bin: command-center-mcp
│   │   └── src/{index.ts, tools/{read,task,milestone,agent}.ts}
│   └── cli/                     # bin: command-center
│       └── src/{index.ts, commands/, pipeline/}
└── apps/
    └── desktop/
        ├── electron.vite.config.ts
        └── src/
            ├── main/{index.ts, config.ts, ipc-handlers.ts, pty.ts,
            │         webhook.ts, watcher.ts, notifications.ts}
            ├── preload/index.ts
            └── renderer/
                ├── main.tsx, App.tsx, store.ts, styles.css
                ├── components/ui/…        # shared components (UI/UX §5)
                ├── components/shell/…     # title bar, tab bar, status bar
                └── views/{swim-lane, task-board, agent-hub, calendar, terminal}/
```

---

## 3. Milestones

Legend: **Maps to** = blueprint phase. **Exit criteria** are the gate.

### M0 — Foundation & Tooling  *(0.5 day)*
**Maps to:** Phase 2 (partial)
**Goal:** Empty-but-correct monorepo that builds and launches an Electron window.

Tasks
- Init npm workspaces, `tsconfig.base.json` (strict, ES modules), ESLint + Prettier, Vitest.
- Scaffold `apps/desktop` with electron-vite + React 19 + Tailwind v4 + shadcn/ui init.
- Window per UI/UX §3.1 (1400×900, min 1200×800, bg `#0A0A10`, frameless on macOS only).
- `.env` / config: `PROJECT_ROOT` resolution (env → saved setting → folder picker later).
- Bundle Inter + JetBrains Mono locally.
- `PROGRESS.md`, `README.md` (with Windows native-module prerequisites).

Exit criteria
- `npm install && npm run dev` opens a dark window with no white flash.
- `npm run typecheck && npm run lint && npm test` pass.

---

### M1 — Core: Schema, DB, State Machine  *(1–1.5 days)*
**Maps to:** Phase 1, state machine, Phase 12 (data layer)
**Goal:** `packages/core` is the single, tested source of truth.

Tasks
- `openDb(projectRoot)`: WAL, `busy_timeout`, `foreign_keys`, runs migrations (D4, D11).
- Migration `001`: blueprint Phase 1 SQL verbatim + indexes + seed `project` row.
- Migration `002`: `subtasks.blocked_from`, `settings` table (key/value: webhook token, theme, etc.), `schema_version`, FTS5 table for lessons (D5, D6, D7).
- Types + zod schemas for every row; JSON-column mappers (D14).
- Query modules: `getAllTrackerState()`, `getTask`, `listTasks(filters)`, `getMilestone`, `listAgents`, `getActivityFeed(page)`, `logAction`.
- `state-machine.ts`: `transition(taskId, trigger, payload)` implementing the blueprint table + D5; throws typed errors for illegal moves. Every transition writes an `agent_log` row and updates `updated_at`.
- `context.ts`: builds the one-line context string (`WEEK n, Phase…`) and the `TASK_CONTEXT.md` content.
- `seed.ts`: dev-only fixture generator (3 domains, 3 phases, 8 milestones, 60 tasks, 4 agents, 200 log rows, some drift, some blocked) — used to develop every view.
- `data_version` helper for change detection (D3).

Exit criteria
- Vitest: all legal transitions pass, every illegal transition throws, block/unblock restores previous status, concurrent write from two connections does not throw `SQLITE_BUSY`.
- `npx tsx packages/core/src/seed.ts` produces a DB that opens in any SQLite browser.

---

### M2 — App Shell, IPC, Store, Live Sync  *(1.5 days)*
**Maps to:** Phases 2, 3
**Goal:** The shell from UI/UX §3 with real data flowing and live refresh.

Tasks
- Main: `db.ts` wrapper over `core`, typed IPC handlers (D2), preload `contextBridge` API (`window.api`), `watcher.ts` (D3) emitting `db:changed`.
- Renderer: Zustand store per blueprint (`tracker`, `loading`, `error`, `synced`, `activeTab`, `selectedMilestoneId`, `theme`) + selectors; persisted `activeTab`/`theme`.
- Shell components: title bar (schedule pill, progress, sync indicator, theme toggle), tab bar with sliding underline + badges, status bar, toast system, `Ctrl+1…5`.
- Design tokens (dark + light) in CSS variables → Tailwind `@theme`; shared components from UI/UX §5 (Tag, StatusDot, ProgressRing, AgentAvatar, AssigneeChip, DomainTag, PriorityPill, EmptyState, Skeleton, Modal, SlidePanel, ConfirmDialog, Tooltip).
- Loading skeleton, fatal DB error screen, first-run folder picker + hydration empty-state.
- Placeholder content in each of the 5 tabs showing counts from the store.

Exit criteria
- With seed data: all 5 tabs render, theme toggle works in both themes, tab badges show real counts.
- Run `sqlite3 command-center.db "UPDATE subtasks SET status='review' WHERE id='…'"` externally → Review badge updates in ≤ 1s with no refresh.
- Renderer has no way to send raw SQL (grep for `db:query`/`db:run` returns nothing).

---

### M3 — Task Board  *(2 days)*
**Maps to:** Phase 5
**Goal:** The most-used view, complete, with all state-machine UX.

Tasks
- ContextBar (milestone carousel + ring), FilterBar (All/My/Agent/Blocked + search + priority/assignee filters).
- Five `KanbanColumn`s, `TaskCard` (all variants: in-progress timer, blocked reason, review actions, dependency lock).
- @dnd-kit: PointerSensor(5px) + KeyboardSensor, drag overlay, illegal-drop handling, optimistic updates with rollback, reason popovers for Block / Reject, skip-review confirmation.
- `TaskDetailModal`: Details / History / Context tabs, autosave, acceptance-criteria checklist persistence, status-aware footer actions (all call `core.transition`).
- Wire tab badges and status-bar counts.

Exit criteria
- Every row of the UI/UX §6.2 state-machine table behaves as specified, including required reasons.
- Reject writes a `lessons_learned` row (and FTS entry).
- Keyboard-only: move a card across all 5 columns and open/close the modal.
- Modal closes on backdrop click and Esc.
- UI/UX §9 checklist passes for this view.

---

### M4 — MCP Server (the Core Loop)  *(2 days)*
**Maps to:** Phase 10
**Goal:** An agent can drive the board and the user sees it move live. **This is the product's core demo.**

Tasks
- `packages/mcp-server` with `@modelcontextprotocol/sdk`, stdio transport, bin `command-center-mcp`, reads `PROJECT_ROOT`.
- Implement all 25 tools (D10), grouped: read (9), task write (10), milestone write (5), agent (1). All writes go through `core` (no duplicate logic). Zod input schemas with clear descriptions — these are what agents read.
- `get_task_context` (~8K tokens cap) vs `get_task_summary` (~500): enforce size limits with truncation + notice.
- Auto-register calling agent if `register_agent` hasn't been called (name from client info).
- Structured errors with a message the agent can act on ("TASK-014 is blocked by TASK-009; call unblock_task…").
- Install docs: `npm i -g`, MCP config JSON, `claude mcp add` command; surface the snippet in the app (Agent Hub empty state + Settings).
- Integration test: spawn the server over stdio, run a full lifecycle (`start → complete → reject → complete → approve`) and assert DB + log state.

Exit criteria
- Claude Code with the MCP server added can: list tasks, `start_task` → card moves to In Progress live in the app, `complete_task` → card appears in Review with the amber treatment, `log_action` → shows in the DB.
- All 25 tools respond; invalid transitions return actionable errors, never crash the server.

---

### M5 — Swim Lane  *(2.5 days)*
**Maps to:** Phase 4
**Goal:** Strategic timeline per UI/UX §6.1.

Tasks
- Layout math module (pure, unit-tested): week↔x, fractional NOW position, lane heights, zoom scaling (constants from blueprint).
- Sticky header/label axes, phase bands, week grid, NOW marker + auto-scroll.
- Milestone nodes with SVG progress rings, status styling, key-milestone diamonds in the Key row.
- Drift visualization (ghost + actual + badge), dependency connectors with chain highlight, adjacent connections.
- Pan, zoom (Ctrl+scroll, +/−), keyboard focus/navigation, context menu, tooltips.
- Milestone Panel (480px): dates, progress, dependencies, grouped task list, notes (add note → `add_milestone_note` path through core).
- Performance: render only visible weeks if > 40 milestones (simple windowing).

Exit criteria
- With seed data: correct placement, NOW marker accurate to the day, drift ghost shown for drifting milestones.
- Insert a milestone via MCP `create_milestone` → node appears in the right lane/week live.
- Panel opens/closes (Esc, backdrop), task rows open the modal.

---

### M6 — Agent Hub  *(2 days)*
**Maps to:** Phase 6
**Goal:** Per UI/UX §6.3.

Tasks
- Agent tree (orchestrators → sub-agents, collapse state persisted, derived ACTIVE/IDLE).
- Shared State card, Context Injection preview with copy, Today's Summary with contribution bars.
- Activity Feed: tabs, search, day grouping, virtualization (e.g. `@tanstack/react-virtual`), "↑ n new" pill, load-older pagination.
- Weekly Agent Performance cards.
- Register-agent empty state with real MCP config.

Exit criteria
- Calling `log_action` from an agent adds an entry within 1s; scrolled-down feed shows the "new" pill instead of jumping.
- Filtering by agent in the tree filters the feed.
- 5,000 log rows still scroll at 60fps (virtualized).

---

### M7 — Calendar  *(1 day)*
**Maps to:** Phase 7

Tasks: week grid, today bar, task chips by `completed_at` day, navigation (prev/next/today, `T`, arrow keys), week header with count, empty/loading states, chip → modal.

Exit criteria: completing a task (via board or MCP) places a chip on the correct local-time day; week boundaries respect Monday start; timezone-safe (store UTC, render local).

---

### M8 — Terminal  *(1.5 days)*
**Maps to:** Phase 8
**Goal:** Per UI/UX §6.5.

Tasks
- `pty.ts` with spawn/write/resize/kill + exit event; detect available shells per OS (D8, D13).
- xterm.js + FitAddon + WebLinksAddon; sessions stay mounted across tab switches; `fit()` on show/resize.
- Session tabs, new-session split-button, exited-process banner, font size, clear, quick-action chips, "Run prepare for TASK-X here".
- Kill all PTYs on `before-quit`.

Exit criteria
- Windows: PowerShell session runs `dir`, `node -v`, and a full-screen app (e.g. `claude`) renders correctly and resizes.
- Switching tabs and back preserves scrollback and running processes.
- No orphaned processes after quitting the app.

---

### M9 — Operator CLI & Sub-Agent Pipeline  *(3 days)*
**Maps to:** Phase 11
**Goal:** `command-center prepare | start | audit | status | agents | log`.

Tasks
- CLI skeleton (commander or citty), bin `command-center`, shares `core`.
- Simple commands first: `status`, `agents`, `log --task`.
- **Pipeline runner abstraction:** each stage = `{name, promptTemplate, input, output, runner}`. Runner v1 shells out to the Claude Code CLI in non-interactive mode (`claude -p …`) with a stage-specific system prompt; make the runner pluggable (other agents later). Each stage logs `exploration_complete` / equivalent via `log_action`.
- `prepare`: Research Explorer → Token Compressor (~500 tokens, verify with a rough token estimator) → Prompt Optimizer (injects relevant lessons from M10 when available) → writes `.claude/TASK_CONTEXT.md`.
- `start`: `start_task` → dispatch assigned agent with `TASK_CONTEXT.md` → on build/typecheck/lint pass → `complete_task`.
- `audit`: Code Quality → Security → Final Validator (PASS/FAIL). FAIL → writes a rejection (feeds M10).
- Dry-run flag (`--dry-run`) that prints stage prompts without executing.
- UI hooks: task modal Context tab buttons run these commands in the Terminal (M8).

Exit criteria
- `prepare` on a seeded task produces a valid `TASK_CONTEXT.md` containing all six sections from the blueprint.
- `audit` FAIL moves the task to In Progress with a recorded reason.
- Every stage appears in the Agent Hub activity feed under the right sub-agent.

---

### M10 — Self-Improving Memory  *(1 day)*
**Maps to:** Phase 12

Tasks: on `reject_task` → insert `lessons_learned` + append formatted entry to `.claude/LESSONS_LEARNED.md` (format from blueprint, including a Prevention field); FTS5 retrieval (`getRelevantLessons(label, keywords)`) returning top 5; wire into `get_task_context`, `enrich_task`, and `prepare`; `get_lessons_learned` tool; Task Detail History shows rejection cards; a "Lessons" list in Settings or Agent Hub (browse/search/delete).

Exit criteria: reject a task twice with different reasons → a similar new task's `TASK_CONTEXT.md` includes the relevant lesson; markdown file and table stay in sync (test).

---

### M11 — Webhooks & External Integration  *(1 day)*
**Maps to:** Phase 13

Tasks: harden `webhook.ts` per D6 (localhost bind, bearer token, zod validation); endpoints `task-update`, `milestone-update`, `agent-action`, `status`; route all writes through `core` (so state machine and logging apply); Settings shows port, status, token (regenerate); status-bar indicator; docs with `curl`, git post-commit hook, and n8n examples.

Exit criteria: `curl` with token updates a task and the card moves live; without token → 401; invalid status → 400; non-localhost access refused.

---

### M12 — Polish, Settings, Packaging  *(2–3 days)*
**Maps to:** Phase 9 (final pass), Post-build

Tasks
- Command palette, shortcut cheat-sheet (`?`), Settings modal (UI/UX §7.4), OS notifications for Review/Blocked (§7.2), first-run checklist card (§7.5).
- Light-theme contrast audit, reduced-motion support, focus-ring and ARIA pass (§7.7), keyboard DnD announcements.
- Performance pass: profile with 500 tasks / 5,000 log rows; memoize cards; confirm no re-render storms on `db:changed`.
- Playwright-for-Electron smoke tests: launch, switch tabs, move a card, open modal, spawn terminal.
- Packaging with electron-builder (Windows NSIS first, then macOS dmg / Linux AppImage), auto-rebuild native modules, app icon.
- Install scripts: `npm run install:global` to link `command-center` and `command-center-mcp`.
- Final README: quick start, MCP setup for Claude Code, hydration walkthrough.
- Implement the **Hydration** flow from the blueprint's post-build notice: a `hydrate` helper (CLI `command-center hydrate --manifesto … --roadmap …` or a documented prompt) that lets an agent create domains/phases/milestones/subtasks/agents from the user's docs.

Exit criteria: UI/UX §9 checklist passes for all five views in both themes; a Windows installer launches on a clean machine; a fresh clone → hydrated demo in under 10 minutes following the README.

---

## 4. Timeline Summary

| Milestone | Focus | Est. effort | Cumulative |
|---|---|---|---|
| M0 | Foundation | 0.5d | 0.5d |
| M1 | Core DB + state machine | 1.5d | 2d |
| M2 | Shell + live sync | 1.5d | 3.5d |
| M3 | Task Board | 2d | 5.5d |
| **M4** | **MCP server — core loop demo** | 2d | 7.5d |
| M5 | Swim Lane | 2.5d | 10d |
| M6 | Agent Hub | 2d | 12d |
| M7 | Calendar | 1d | 13d |
| M8 | Terminal | 1.5d | 14.5d |
| M9 | Operator CLI + pipeline | 3d | 17.5d |
| M10 | Memory | 1d | 18.5d |
| M11 | Webhooks | 1d | 19.5d |
| M12 | Polish + packaging + hydration | 2.5d | **~22d** |

Estimates are focused-build days for an agent working with review; expect the human to spend most time on reviewing M3, M5 and M9. **Natural demo points:** after M4 (agent drives the board live), after M6 (full observability), after M12 (shippable).

---

## 5. Risk Register

| Risk | Impact | Mitigation |
|---|---|---|
| Native modules (`node-pty`, `better-sqlite3`) fail to build for Electron on Windows | Blocks M2 / M8 | `electron-rebuild` in postinstall; document VS Build Tools; verify in M0/M2 not M8; fall back to prebuilt binaries |
| Multi-process DB contention | Lost writes / `SQLITE_BUSY` | WAL + busy_timeout + short transactions; M1 concurrency test |
| Change detection misses updates | UI looks stale — destroys trust | `data_version` polling as authority (D3); sync indicator shows disconnected state honestly |
| Swim Lane complexity balloons (SVG + sticky axes + drift + dependencies) | Schedule slip | Build in sub-steps (grid → nodes → drift → connectors → panel), cut dependency chain highlight to v1.1 if needed |
| Pipeline (M9) depends on non-deterministic sub-agent output | Flaky `prepare`/`audit` | Pluggable runner, `--dry-run`, validate each stage's output shape, retry once, fail loudly with the stage name |
| Token estimate for "~500 tokens" compressor is vague | Inconsistent context size | Use a simple char/4 estimator + hard truncation guard; warn rather than fail |
| Agent-written free text rendered in UI | XSS / injection | Render as text only (no `dangerouslySetInnerHTML`), `contextIsolation: true`, `nodeIntegration: false`, strict CSP |
| Scope creep from "nice to have" items | Never ships | Anything not in an Exit criteria list goes to the Backlog below |

---

## 6. Backlog (post-v1, do not build now)

- Split terminal panes; terminal output → task log capture
- Manual card ordering in columns; swimlane drag-to-reschedule milestones
- Week-over-week agent performance comparison; completion heat-map in Calendar
- Multi-project switcher
- Export (PDF/Markdown status report); import from Linear/GitHub issues
- Command Center as a tray app with quick-status popup
- Cloud sync / multi-user
- Auto-update channel

---

## 7. Kickoff Prompt (paste into Claude Code)

```
You are building the Command Center desktop app. Read, in order:
1. COMMAND_CENTER_BLUEPRINT.md  — architecture, schema, stack, APIs
2. UI_UX_SPEC.md                — visual design and interaction (wins on UI conflicts)
3. ROADMAP.md                   — build order, decisions D1–D14, milestones

Rules:
- Build milestone by milestone starting at M0. Do not skip ahead.
- Apply the decisions in ROADMAP §1 (monorepo with a shared `core` package, typed IPC with no raw SQL, WAL + data_version change detection, etc.) even where the blueprint differs.
- At the start of each milestone state the goal and the files you'll create or change. At the end, run the exit criteria, show the results, update PROGRESS.md, and commit.
- Stop and report after each milestone; wait for my "continue" before the next one.
- Target OS is Windows first (also keep macOS/Linux working).
- If something is ambiguous, choose the simplest option, record it in PROGRESS.md, and proceed.

Begin with M0.
```
