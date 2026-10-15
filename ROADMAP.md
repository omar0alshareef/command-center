# Command Center — Build Roadmap

> For Claude Code. Read in this order: `COMMAND_CENTER_BLUEPRINT.md` (what to build) → `UI_UX_SPEC.md` (how it looks/behaves) → this file (what order to build it in).
> The blueprint's 13 phases are preserved, but **resequenced into vertical slices** so the app is demoable end-to-end early (agent writes → app updates live) instead of finishing every layer before anything works.
> **Status:** M0–M12 are complete and approved. Do not redo them. M13 (Planning Workspace), M14 (Orchestrator & Multi-Provider Runners, starting with a Claude Code model-per-agent slice) and M15 (Agent Library, Project Workspaces, Lessons) are the remaining work. Check `PROGRESS.md` for the current position before starting anything.

---

## 0. How to use this roadmap

1. Work **one milestone at a time**, in order. Do not start a milestone until the previous one's **Exit criteria** pass and the operator has said "continue".
2. At the start of each milestone: restate the goal, list the files you'll touch, then build.
3. At the end of each: run the exit checks, fix failures, commit (`feat(M3): …`), and report what passed.
4. Keep a `PROGRESS.md` at repo root: milestone → status → notes → known issues. Update it every milestone. It is the source of truth for what is already done.
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
| D10 | Tool count inconsistency ("24+" vs 25 listed). | Implement all 25 listed tools; update docs to say 25. |
| D11 | No migration story. | `schema_version` table + ordered migration files in `core/migrations`. Schema in blueprint Phase 1 = migration `001`; D5 and D6 additions = `002`. |
| D12 | `Electron 41+`, `Tailwind 4`, `React 19` — versions drift. | Run `npm view electron version` etc. and use the **latest stable** that electron-vite supports; pin exact versions in `package-lock`. Note choices in `PROGRESS.md`. |
| D13 | Primary dev machine is **Windows**; `node-pty` and `better-sqlite3` are native modules. | Use `electron-rebuild` (postinstall), document Windows build-tools prerequisites in README, test M7 on Windows first. Ship prebuilds where available. |
| D14 | JSON-in-TEXT columns (`dependencies`, `notes`, …). | Keep per blueprint, but access only through typed `core` mappers (`parse/serialize`) so shape is validated in one place. |

### Decisions for M13 (Planning Workspace)

| # | Decision |
|---|---|
| D15 | **The planner never writes to the board until the operator approves.** Drafts live in a separate planning store. Approval is a single explicit action that writes everything in one transaction. |
| D16 | **Deadlines live at two levels.** Milestones keep `planned_start` / `planned_end` (existing). Tasks get a new optional `due_date` column (migration `003`), and the planner must set it when the requirements give one. |
| D17 | **Teams are agents.** A team (Frontend, Backend, Marketing, Design) is an `agents` row with a role and permissions. Each task's `assignee` points to one of them. The planner proposes the roster; the operator confirms it. |
| D18 | **The planner runs outside the terminal.** It calls the chosen runner as a child process (`claude -p` or an API call) and streams output into the planning panel. It never runs inside the PTY, because the PTY path is where `claude -p` hung in earlier testing. |
| D19 | **Runner is pluggable and chosen by the operator in Settings.** Default: Claude Code CLI in non-interactive mode. Alternative: direct API key, stored in `settings`, never printed in logs. |
| D20 | **The planner's output is validated before it is shown.** It must match zod schemas for manifesto, roadmap, milestones, tasks and agents. Invalid output is shown to the operator as an error with the failing field, not silently dropped. |
| D21 | **The team is derived from the roadmap, up front.** The planner reads the requirements and, for each milestone, lists the capabilities it needs (for example frontend, backend, database, security, design, marketing, or none for design). Those capabilities map to team roles. The operator confirms the roster before the plan is approved. Not every milestone needs every role. |

### Decisions for M14 (Orchestrator & Multi-Provider Runners)

| # | Decision |
|---|---|
| D22 | **Dispatch is code, not an LLM.** The orchestrator is a deterministic scheduler in the main process (or a `command-center orchestrate` daemon). It decides which task is ready (all `depends_on` done, status `todo`, assignee set, not blocked) using plain rules. An LLM is used only for judgment work inside a task (research, writing, review summaries), never to decide what runs next. Reason: an LLM deciding dispatch can skip or repeat tasks silently. |
| D23 | **Providers are adapters behind one interface.** Each adapter implements `run({prompt, workdir, model, timeout, signal}) → {output, usage, exitCode}`. Adapters in v1: `claude-code` (CLI, `claude -p`), `anthropic-api`, `openai-api`, `gemini` (CLI or API, whichever is installed), `local` (Ollama or LM Studio over localhost HTTP). Adding a provider means adding one adapter file. |
| D24 | **Routing is per agent, with a per-task override.** Each agent row gets `provider` and `model` (the existing `source_model` column holds the model name). The planner proposes a provider for each team role during M13 approval; the operator can change it. A task can override its agent's provider in the task modal. |
| D25 | **Keys are stored locally and never shown.** Provider keys go in the `settings` table, encrypted with Electron `safeStorage` (OS keychain on Windows/macOS). The renderer sees only "key set / not set" and a masked suffix. Keys are never written to logs, `agent_log`, `TASK_CONTEXT.md` or the MCP output. |
| D26 | **Every run is recorded.** Each run writes one `agent_log` row with provider, model, duration, exit code and token counts when the provider reports them. Estimated cost is shown per task and per milestone in the Agent Hub, labelled "estimate" unless the provider returns exact usage. |
| D27 | **Local providers are first-class but optional.** The app detects installed local tools at startup (Ollama, LM Studio, Gemini CLI, Claude Code) and lists only the ones it finds. Nothing is required to be installed except the adapters the operator actually routes to. |
| D28 | **Unattended runs need an explicit ceiling.** The orchestrator has a settings-level cap: max concurrent runs (default 2), max runs per hour, and a spend ceiling per day (estimate). When a cap is hit it pauses and raises a Review-style notification instead of continuing. |
| D29 | **The reviewer is never the executor.** When a task finishes, the orchestrator moves it to Review and dispatches a *different* agent (or the human) for review. The same agent and provider cannot approve its own run. The existing 409 self-approval rule still applies. |

### Decisions for M15 (Agent Library, Project Workspaces & Lessons)

| # | Decision |
|---|---|
| D30 | **One global agent library, owned by the Command Center.** It lives in the app's own data folder on the operator's computer, not in any project database. Agents are created, edited, archived and deleted only from the Agent Hub → Agents page. |
| D31 | **Each project is an independent folder.** When the operator opens or creates a project, the app asks where the folder should go (same pattern as Claude's folder picker). The app stores that absolute path. Nothing about a project is stored only inside the app's own database except the pointer and the assignments. |
| D32 | **Project folder layout.** `project.json` (name, slug, status, optional `repo_path`, file pointers), `README.md` (goal, domains, milestones), `LICENSE` (the license for the project's own material), `AGENTS.md` (project spec for agents), `details/` (any extra background files). `LICENSE` is copied from the repo when `repo_path` is set, never duplicated as an independent text. |
| D33 | **Agents are assigned, never copied.** A project's agent list is a set of links to library agents plus per-project settings: enabled, allowed task types, extra constraints. Removing an agent from a project deletes only that link. The library agent stays. |
| D34 | **Instruction precedence.** When an agent works on a task in a project, its prompt is built in this order: the library profile (general role, base instructions, default provider and model), then the project's `AGENTS.md` (project rules), then the lessons that apply (D38), then the task's `TASK_CONTEXT.md`. Later layers add to or override earlier ones only where they explicitly say so. |
| D35 | **Deletion rule.** An agent with no project links and no run history may be deleted. Any other agent is archived: it stops receiving dispatches and disappears from the assign picker, but its history stays readable. |
| D36 | **Missing spec is a warning, not a failure.** If a project has no `AGENTS.md`, dispatch still runs with the library profile alone, and the Agent Hub shows a visible "no project spec" notice on that project. Malformed `project.json` blocks dispatch for that project and says why. |
| D37 | **Lesson scopes.** Every lesson has one scope: `project` (applies only in that project), `agent` (applies to one library agent in every project it is assigned to), or `global` (applies to every agent). A rejection creates a `project` lesson by default. The operator can promote it to `agent` or `global` from the lesson's detail view. Promotion is never automatic. |
| D38 | **Lessons are required reading, not optional context.** Before a run starts, the prompt builder pulls every lesson that matches the agent (agent scope), the project (project scope) or all agents (global scope), using the task's labels and keywords (FTS5). Matched lessons are injected as a numbered "Before you start" block, and the run record stores the ids of the lessons it received. A run with no matched lessons still records that the lookup happened. |
| D39 | **Recurrence counter and lesson status.** Each lesson has `occurrences` (how many rejections or audit failures matched its pattern after the lesson was written) and a status: `active`, `needs_rewrite` (occurrences ≥ 2 after the lesson was written), or `retired` (operator-chosen). A lesson marked `needs_rewrite` appears in the Agent Hub with a warning, because the wording or the check is not working. |
| D40 | **Lessons carry checks.** Each lesson has a prevention check: a short, verifiable statement (for example "the task's diff contains a test file" or "no import from `fs` in renderer code"). Checks marked `automatic` are run by the audit pipeline (M9) when the task reaches Review. Checks marked `manual` appear as a reviewer checklist item. A lesson with neither is saved as a draft and cannot be promoted beyond `project` scope. |

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
│   │   │        lessons.ts, context.ts, types.ts, seed.ts,
│   │   │        planning/, orchestrator.ts, providers/, library/, projects/}
│   │   └── test/
│   ├── mcp-server/              # bin: command-center-mcp
│   │   └── src/{index.ts, tools/{read,task,milestone,agent,planning,runs,library,lessons}.ts}
│   └── cli/                     # bin: command-center
│       └── src/{index.ts, commands/, pipeline/}
└── apps/
    └── desktop/
        ├── electron.vite.config.ts
        └── src/
            ├── main/{index.ts, config.ts, ipc-handlers.ts, pty.ts,
            │         webhook.ts, watcher.ts, notifications.ts, orchestrator-loop.ts}
            ├── preload/index.ts
            └── renderer/
                ├── main.tsx, App.tsx, store.ts, styles.css
                ├── components/ui/…        # shared components (UI/UX §5)
                ├── components/shell/…     # title bar, tab bar, status bar, project switcher
                └── views/{swim-lane, task-board, agent-hub, calendar, terminal, planning, agents-library, lessons}/
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

### M12 — Polish, Settings, Packaging  *(2–3 days)*  — DONE (approved)
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

### M13 — Planning Workspace  *(3–4 days)*
**Maps to:** New (post-blueprint). Builds on M4 (MCP), M9 (runner abstraction), M12 (hydration).
**Goal:** The operator goes from "an idea and some requirements" to an approved manifesto, roadmap, milestones, tasks with deadlines and dependencies, and a team roster, without leaving the app.

**Where it lives.** A new **Planning** view. Open it from the tab bar as a sixth tab, or from the command palette and the empty-state hydration card if the tab bar would get crowded. The implementer picks one and records the choice in `PROGRESS.md`. Keyboard shortcut `Ctrl/Cmd+6` if it is a tab.

Tasks

*Data (migration `003`)*
- `planning_documents` table: `id`, `kind` (`manifesto` | `roadmap`), `version`, `content` (markdown), `status` (`draft` | `approved` | `superseded`), `created_at`, `approved_at`.
- `planning_sessions` table: `id`, `status` (`interviewing` | `drafting` | `review` | `approved` | `abandoned`), `requirements` (JSON array of answered questions), `created_at`.
- `subtasks.due_date TEXT` (ISO date, nullable).
- `planning_proposals` table: staged milestones, tasks, dependencies, capabilities per milestone and agents as JSON, linked to a session, cleared on approve or abandon.
- Typed `core` queries and zod schemas for all of the above. No raw SQL from the renderer (D2 still applies).

*Planner runner (main process)*
- `planner` module with a stage list: `interview` → `draft_manifesto` → `draft_roadmap` → `plan_capabilities` → `plan_tasks` → `propose_team`.
- `plan_capabilities` lists, for each milestone, the capabilities it needs (D21). `propose_team` maps those capabilities to team roles and proposes one agent per role.
- Each stage builds a prompt from the operator's answers and the previous stage's approved output, calls the runner, validates the result with zod, and stores it in `planning_proposals`.
- Runner implementations: Claude Code CLI (`claude -p`, child process, stdin prompt, timeout, output capped) and API key. Both behind one interface (D18, D19).
- Cancel button kills the child process tree (reuse the M8 process-tree kill).

*Planning view (renderer)*
- Left: session list (new session, resume, abandon). Centre: chat-style interview panel, where the planner asks questions and the operator answers. Right: draft panel with tabs for Manifesto, Roadmap, Milestones, Tasks, Team.
- Operator can edit any draft directly in the panel (markdown editor for manifesto and roadmap, tables for tasks and team). Edits save to the draft, never to the board.
- Each draft shows a short note from the planner about what it assumed. Assumptions are highlighted so the operator can correct them.
- Interview stops when the planner has enough to draft. The planner can also ask the operator to confirm a list of open questions before drafting.
- Team tab: roster confirmation (D21). The operator can add, remove or rename roles before approval.

*Approval (D15)*
- One "Approve plan" button, with a confirmation dialog that lists counts: N milestones, N tasks, N with deadlines, N dependencies, N agents.
- On approve, a single transaction: marks the manifesto and roadmap `approved`, creates or updates milestones (with planned dates), creates tasks (with `due_date`, `depends_on`, `assignee`, `priority`, acceptance criteria), registers team agents, and writes one `agent_log` row per batch with the session id.
- Approve is refused if any task has no milestone, any dependency points to a missing task, or any dependency cycle exists. The error names the item.
- After approve, the session is marked `approved` and the proposal is cleared.

*Integration with the rest of the app*
- Approved manifesto and roadmap are viewable from Settings and linked from the Swim Lane empty state, replacing the copy-paste hydration step for new projects. The old hydration prompt stays for existing projects.
- Task Detail modal shows `due_date` and highlights tasks past due.
- Swim Lane milestone panel shows the approved roadmap entry for that milestone.
- MCP: add read tools `get_planning_documents` and `get_planning_session`. Do not add an MCP tool that approves a plan; approval is operator-only in the UI. This matches the rule that an agent cannot approve its own work.

Exit criteria
- **Interview:** starting a session with a one-paragraph idea produces at least three planner questions before any draft is shown. Answers are saved and the session can be resumed after an app restart.
- **Drafts:** manifesto and roadmap render as markdown; milestones and tasks render as editable tables; edits persist to the draft and survive restart.
- **Capabilities and team:** a roadmap with one milestone that needs design and one that does not produces a team roster where only the first milestone lists a design role, and the operator can remove or rename a role before approval.
- **Validation:** feed the runner a deliberately malformed output (missing `due_date` type, dependency to a non-existent task, dependency cycle). The UI shows an error naming the field and does not write to the board.
- **Approval:** approving a seeded plan writes milestones, tasks with `due_date`, dependencies, and team agents in one transaction. A forced failure mid-write rolls back everything (test with a fault injection).
- **Board after approval:** new milestones appear in the Swim Lane at the right dates; tasks appear in To Do with assignees; past-due tasks are flagged in the Task Board.
- **No leak:** planning drafts do not appear in the Task Board, Calendar or Agent Hub until approved.
- **Runner:** cancel kills the child process and leaves no orphans (check Task Manager after cancel). Output over the cap is truncated with a visible notice.
- **Tests:** `core` tests for approval transaction, rollback, dependency validation, cycle detection, capability-to-role mapping, and `due_date` migration. Vitest suite and typecheck and lint pass. `PROGRESS.md` updated, commit `feat(M13): …`.
- **UI/UX §9 checklist** passes for the new view in both themes, including keyboard operation of the interview panel and the approval dialog.

Out of scope for M13 (goes to the backlog)
- Multi-project planning (see the project switcher in M15).
- Automatic re-planning when a milestone slips. Drift is still shown, but the planner is not triggered.
- Gantt-style editing of dates by dragging. Dates are edited in the table.
- Importing an existing manifesto or roadmap from a file. Paste-in is enough for v1 of this milestone.

---

### M13.1 — Stage-based roster (patch to M13)  *(0.5–1 day)*
**Maps to:** Patch to M13. Builds on M13 (planner, `proposeTeam`, Team tab, approval transaction). Done before M14 starts.
**Goal:** Replace the capability-to-job-title roster with a roster built from production stages. Each agent has an executor type, so the planner can route work to a text runner, to an external tool, or to the operator. The planner asks only for decisions, never for skills.

**Decisions applied here (also recorded in §1)**
- **D17 (revised):** an agent is an executor of stages. `executor` is `agent` (a text runner does the work), `external` (a named tool outside the app; the planner writes a brief and checklist, the operator runs the tool and marks the stage done) or `human` (the operator does it in person, for example on-camera recording). `tool` names the external tool when there is one.
- **D21 (revised):** the roster comes from the stages each milestone needs (software: frontend, backend, database, security, design, marketing, or none; video: script, edit, voice-over, thumbnail, publish). The interview asks only for decisions: goal, deadlines, budget, on-camera or own-voice work, content limits. It never asks which roles or skills to use.
- **D41 (new):** text runners do not edit media. Stages that need video, audio or image tools use `external` until a media adapter exists (backlog).

Tasks
- Migration `006` (the next free number after 005): `agents.executor TEXT NOT NULL DEFAULT 'agent'` with a CHECK for `agent` | `external` | `human`, and `agents.tool TEXT` (nullable). Existing agents get `agent`. Built-in `operator` stays `human`, `system` stays `external`.
- Rename `plan_capabilities` to `plan_stages`. The stage output per milestone is a list of `{ stage, executor, tool?, brief?, checklist? }`. The zod schema rejects an unknown executor type.
- `proposeTeam` maps stages to roles (one agent per distinct role) and copies the executor and tool. External and human stages get a brief and checklist written by the planner, stored with the task.
- Interview prompt: replace the capability questions with decision questions (deadlines, budget, on-camera or own-voice work, content limits, target audience). Remove any question about roles or skills.
- Team tab: the operator can add, remove, rename a role, and change its executor type or tool before approval.
- Approval: writes `executor` and `tool` to each agent. The approve dialog counts stages by executor type.
- Fix the migration references in §1 and §3: M13 `due_date` and planning tables are migration `005` in the repo (D16 said `003`; `003` and `004` were already used by M3 and M10).
- Read paths: `listAgents`, the MCP `list_agents` output and the Agent Hub show the executor type and tool. No dispatch changes in this milestone (M14 owns dispatch).

Exit criteria
- **Roster from stages:** a roadmap with a design stage in one milestone and none in another produces a roster where only the first milestone has a design stage.
- **External stage:** a video roadmap with a voice-over stage produces an agent with `executor = external`, `tool` set, and a brief and checklist on the task. No runner call is made for it.
- **Decision-only interview:** a seeded session produces no question about roles or skills. Test with a fixed fake runner output.
- **Migration:** `006` applies on an existing `005` database; existing agents read back as `agent`; the CHECK rejects an unknown executor type.
- **Approval:** approving a plan with mixed executors writes the executor and tool to each agent in the same transaction. The fault-injection test from M13 still rolls back everything.
- **Tests:** `core` tests for stage schema, stage-to-role mapping, executor validation, migration `006`, and approval with mixed executors. Typecheck, lint and Vitest pass. UI/UX §9 checklist for the Team tab in both themes.
- `PROGRESS.md` updated with an M13.1 row and a project-log entry. Commit `feat(M13.1): stage-based roster`.

Out of scope for M13.1
- Dispatch of `agent` tasks (M14).
- Media adapters (backlog, D41).
- Any change to the Task Board, Swim Lane or Calendar.

---

### M13.2 — Calm theme (patch, after M13.1)  *(0.5 day)*
**Maps to:** Patch to the shell and Settings. Builds on M2 (tokens), M12 (Settings → Appearance). Runs after M13.1, before M14.
**Goal:** Add the **Calm** light theme from UI/UX §4.8 as a fourth appearance option. Default stays dark.

Tasks
- `styles.css`: add `[data-theme="calm"]` token block with every token in §4.8. Map them into the Tailwind `@theme` the same way as dark and light.
- Settings → Appearance: fourth option **Calm**. The title bar theme toggle cycles dark → light → calm → system. Persisted in `localStorage` as `themePref` (same as M12).
- Primary and secondary buttons, switch, checkbox, segmented tabs, search input, progress bar and notification card restyled to §4.8 components. Other views inherit the tokens; no per-view colour overrides.
- Load Source Serif 4 via `@fontsource` (offline). Use it only for view titles and display numbers (§4.8).
- Dense surfaces keep `--border`, no `--shadow-card` (§4.8 shape rules).
- `test/a11y-tokens.test.ts`: include the calm theme with the same thresholds as §4.2 (text ≥ 4.5:1, accent and status ≥ 3:1 on bg, surface and surface-2).

Exit criteria
- Calm theme selectable in Settings and the title bar; choice survives restart; system theme still follows the OS.
- Every view renders in Calm with no unreadable text; the UI/UX §9 checklist passes in Calm for Task Board, Swim Lane, Agent Hub, Planning and Settings.
- Contrast test passes for calm tokens.
- Screenshot of Task Board and Planning in Calm saved to `.supervisor/M13.2-calm-*.png` for the reviewer.
- `PROGRESS.md` updated. Commit `feat(M13.2): calm theme`.

Out of scope for M13.2
- Replacing the default theme.
- Per-project or per-agent themes.
- Any change to data, routes or IPC.

---

### M13.3 — Calm Dark (patch, after M13.2)  *(0.5 day)*
**Maps to:** Patch to the shell and Settings. Builds on M13.2. Runs after M13.2, before M14.
**Goal:** Add the dark mode of Calm (UI/UX §4.8, "Calm Dark") so Calm becomes one theme with a light and a dark mode. Default stays dark (the existing theme).

Tasks
- `styles.css`: add the Calm Dark token block with every token in the §4.8 Calm Dark table, selected by `data-theme="calm"` plus `data-mode="dark"`. Light Calm stays as built in M13.2.
- Settings → Appearance: Calm gets a Light / Dark mode choice (Dark, Light, Calm Light, Calm Dark, System is acceptable if simpler). The title-bar cycle includes it. Persisted like M12 and M13.2. `system` maps Calm to light or dark from the OS.
- Components from M13.2 (pill buttons, switch, checkbox, segmented tabs, progress, notification, modal scrim) restyled for dark by tokens only. Active tab and primary button: Mint fill, `--on-accent` text. No per-view colour overrides.
- Domain colours in Calm Dark: amber, violet, blue only (no green), per §4.8. Done cards dimmed with a ✓.
- `color-scheme: dark`; terminal uses the dark ANSI palette; `--tag-ink` 100%.
- `test/a11y-tokens.test.ts`: add Calm Dark with the same thresholds as dark (text ≥ 4.5:1, accent and status ≥ 3:1 on bg, surface and surface-2). Re-run the computed-contrast scan from `M13.2.verify.mjs` in Calm Dark.

Exit criteria
- Calm Dark selectable in Settings and the title bar; survives restart; `system` follows the OS.
- Every view renders in Calm Dark with no text under 4.5:1; UI/UX §9 passes for Task Board, Swim Lane, Agent Hub, Planning and Settings.
- Screenshots of Task Board, Swim Lane and Planning in Calm Dark saved to `.supervisor/M13.3-calm-dark-*.png`.
- `PROGRESS.md` updated. Commit `feat(M13.3): calm dark`.

Out of scope for M13.3
- A beige-heavy variant (considered and dropped by the operator).
- Changing the default theme, per-project themes, any data, route or IPC change.

---

### M14 — Orchestrator & Multi-Provider Runners  *(4–5 days, plus Slice 1 below)*
**Maps to:** New (post-blueprint). Builds on M9 (runner abstraction), M10 (lessons), M11 (webhook), M13 (approved plan, team roster).
**Goal:** Approved tasks run without the operator starting each one, on the provider each one is routed to, with every run recorded and every spend capped.

**Slice 1 — Claude Code model per agent (do this first inside M14)**
Scope: per-agent model selection for the `claude-code` provider only. No other providers yet. This is the first slice of D23 and D24, and can be committed on its own (`feat(M14a): claude-code model per agent`).

Tasks
- Data: add `model TEXT` (nullable) to the `agents` table in a new migration. Empty means "use the CLI default".
- Model list: do not hardcode model names. Store the list of available Claude Code models in the `settings` table as an editable JSON array of `{ id, label }`. Ship it with three starter entries (a fast model, a balanced model, a strongest model) using the aliases the installed `claude` CLI accepts. Verify the aliases against `claude --help` or its docs on this machine and record the exact ones used in `PROGRESS.md`.
- Runner: the `claude-code` adapter passes `--model <id>` to `claude -p` when the agent has a model set. Log the model used in `agent_log` for each run.
- UI: on the Agent Hub agent row, a model dropdown (options from the settings list, plus "CLI default"). Changing it writes to the agents row and logs an `agent_log` entry. The dropdown is disabled for non-claude-code providers (they do not exist yet).
- Tests: a core test that an agent's model is passed to the runner; a test that an empty model passes no `--model` flag; a test that a removed model id in settings does not crash dispatch (falls back to CLI default and shows a warning).

Slice 1 exit criteria
- Two agents with different models: each run's log shows its own model.
- Setting an agent to "CLI default" removes the flag on the next run.
- Typecheck, lint and tests pass. `PROGRESS.md` updated.
- Stop and report. Wait for "continue" before the rest of M14.

**Rest of M14**

Tasks

*Data (next free migration number)*
- `agents`: add `provider TEXT`, `max_concurrent INTEGER DEFAULT 1` (`model` is already added in Slice 1).
- `subtasks`: add `provider_override TEXT` (nullable).
- `runs` table: `id`, `task_id`, `agent_id`, `provider`, `model`, `status` (`queued` | `running` | `succeeded` | `failed` | `cancelled`), `started_at`, `finished_at`, `exit_code`, `input_tokens`, `output_tokens`, `est_cost_usd`, `error`.
- `settings` rows for provider keys (encrypted per D25), concurrency cap, hourly cap, daily spend ceiling.
- Typed `core` functions for all of the above.

*Provider adapters (`packages/core/src/providers/`)*
- Common interface per D23, with timeout, cancellation through `AbortSignal`, and output capped at a set size.
- `claude-code`: child process running `claude -p` in the project folder, prompt on stdin. Reuses M8 process-tree kill. Model per agent from Slice 1.
- `anthropic-api` and `openai-api`: HTTPS calls with the key from `safeStorage`; parse usage from the response.
- `gemini`: adapter for whichever of the CLI or API is installed; detected at startup.
- `local`: HTTP to `localhost` for Ollama (`:11434`) or LM Studio's local server; model list fetched from the server.
- Adapter tests with recorded fixtures; no live network calls in CI.

*Orchestrator (`packages/core/src/orchestrator.ts` + main-process wiring)*
- `readyTasks()`: pure function returning tasks that meet the D22 rules, ordered by milestone planned start, then priority, then `due_date`.
- Dispatch loop: runs every 5 seconds while enabled, respects D28 caps, and calls `prepare` (if `TASK_CONTEXT.md` is missing) then `start_task` then the provider adapter.
- On adapter success: `complete_task` with the output summary. On failure: retry once, then `block_task` with the error as the reason.
- Pause, resume and "stop after current run" controls in the status bar and Agent Hub.
- Triggers: (a) a task becomes ready (dependency completed), (b) a webhook `task-update` sets a task to `todo`, (c) manual Start from the task modal. All three call the same dispatch path.
- Reviewer dispatch per D29 when a task reaches Review.

*Routing UI*
- Agent Hub: each agent shows its provider and model; a provider picker to change them (writes to the agent row).
- Task modal Details tab: provider override dropdown, with "use agent default" as the first option.
- Settings → Providers: list of adapters with detected/not detected status, key entry (masked), test-connection button per provider.

*Run visibility*
- Agent Hub Activity Feed: each run appears as one entry with provider, model and duration; expandable to show the last N lines of output.
- Task History tab lists runs for the task with cost estimate.
- Status bar shows: running count, queued count, today's estimated spend against the ceiling.

*MCP and CLI*
- New read tool `list_runs(task_id?)`. New write tool `cancel_run(run_id)`. Neither can approve work.
- CLI: `command-center orchestrate --status | --pause | --resume` and `command-center runs --task TASK-ID`.

Exit criteria
- **Dispatch rules:** seed a plan with a dependency chain of three tasks. Only the first is dispatched; completing it dispatches the second within 10 seconds; the third waits for both. Unit tests cover `readyTasks()` with cycles rejected at approval (M13) and with blocked tasks excluded.
- **Routing:** two tasks assigned to two agents with different providers each run on their own adapter (verify through `runs.provider`). Task-level override beats the agent default.
- **Providers:** each adapter passes its fixture tests. Live smoke test per provider the operator has installed: one small prompt, run recorded, cost estimate shown. Providers not installed show "not detected" and cannot be routed to.
- **Keys:** a key entered in Settings does not appear in the renderer's state, in any log file, in `agent_log`, or in `TASK_CONTEXT.md`. Grep the DB and logs for the key string after the test: zero matches.
- **Caps:** with the hourly cap set to 2, a third ready task is queued, the status bar shows "paused by cap", and no run starts until the window clears or the operator raises the cap.
- **Failure path:** a provider that times out is retried once, then the task is blocked with the error text as `blocked_reason`. The orchestrator continues with other ready tasks.
- **Reviewer rule:** a task finished by agent A is never approved by agent A. Test with the API and with the UI approve button.
- **Cancel:** cancelling a running `claude-code` run kills the child process tree; Task Manager shows no orphans.
- **Pause:** pause stops new dispatches immediately; in-flight runs finish or are cancelled per the operator's choice in the dialog.
- **Tests and gates:** Vitest for `core`, typecheck and lint clean, UI/UX §9 checklist for Agent Hub and Settings → Providers, `PROGRESS.md` updated, commit `feat(M14): …`.

Out of scope for M14
- Planner-driven re-routing when a provider fails repeatedly (keep the manual override; automatic routing changes go to the backlog).
- Exact cost tracking for providers that do not report usage (label as estimate, that is all).
- Running agents on remote machines or cloud VMs. Everything runs on the operator's computer in M14.
- Sandboxing of arbitrary shell commands an agent might run beyond what its provider already allows. Document the risk in the README and in Settings → Providers.
- Complexity-based routing, budget modes (economy / balanced / speed) and escalation on failure. These go to the backlog until real cost data exists from the first runs.

---

### M15 — Agent Library, Project Workspaces & Lessons  *(4–5 days)*
**Maps to:** New (post-blueprint). Builds on M10 (lessons), M13 (planner reads project spec), M14 (dispatch reads project spec and lessons).
**Goal:** The operator creates agents once, assigns them to any project, and each project's own rules apply automatically, with project folders placed wherever the operator chooses. Mistakes that were caught and corrected stay corrected: lessons reach the right agents before they start, scope correctly, and show when they stop working. The operator can also switch between projects in the app.

Tasks

*Global library (app data folder)*
- Storage: a separate SQLite file in the app's user data folder (not inside any project). Tables: `library_agents` (id, name, role, type `orchestrator` | `sub-agent` | `human` | `external`, parent_id, color, base_instructions, provider, model, default_permissions, status `active` | `archived`, created_at, updated_at) and `library_agent_versions` (append-only edit history).
- Typed `core` functions for create, edit, archive, delete (with the D35 rule) and list with sort and filter by role, status and provider.
- Starter templates by role (frontend, backend, database, security, design, marketing, reviewer) that the create flow offers, editable like any agent.

*Project registry and switcher*
- The app keeps a registry of known projects in the app data folder: name, slug, absolute folder path, last opened. The registry is the only place that lists all projects.
- Switching: the title bar project name (UI/UX §3.2) becomes a button that opens a project switcher listing registered projects. Choosing one closes the current project's database connection, opens the chosen project's `command-center.db`, and reloads the store and every view. Running dispatch loops for the previous project are paused first, and the app says so.
- A project whose folder is missing or whose database cannot open is shown in the switcher with its error and cannot be opened until fixed.
- "Add existing project" registers a folder that already contains `project.json`. "Remove from registry" never deletes files.
- Phase 2 of the switcher (only if the operator asks later, backlog): an overview screen that reads each registered project's database read-only and shows progress, pending work and items needing review across all projects. This is not part of M15.

*Project folders*
- "New project" and "Open project" flows: folder picker, then the app writes `project.json`, `README.md`, `AGENTS.md` and `details/` from templates if they are missing, and copies `LICENSE` from `repo_path` when set. Existing files are never overwritten; the app shows a diff and asks.
- The project's database stays in the project's own `command-center.db`. It records assignments (`project_agents`: library agent id, enabled, allowed task types, extra constraints) and the project's folder path.
- `project.json` is validated with zod on open (D36).

*Lessons (upgrade of M10)*
- Lesson table fields: `id`, `scope` (`project` | `agent` | `global`), `agent_id` (nullable, required when scope is `agent`), `project_id`, `trigger_keywords`, `rejection_reason`, `fix_applied`, `prevention_rule`, `check` (text), `check_type` (`automatic` | `manual` | `none`), `occurrences`, `status` (`draft` | `active` | `needs_rewrite` | `retired`), `created_at`, `updated_at`.
- Rejection flow: the reviewer's rejection reason is saved as a `project` lesson in `draft` if the reviewer did not give a prevention check, and as `active` if they did. The file `.claude/LESSONS_LEARNED.md` is still written for each project, as M10 requires; the file is generated from the table, never edited by hand.
- Promotion UI: from a lesson's detail view, promote to `agent` (pick the library agent) or `global`. Each promotion writes an `agent_log` entry.
- Recurrence: when a later rejection or audit failure matches a lesson's trigger keywords and the reviewer marks it as the same mistake, `occurrences` increases. At two or more after the lesson was written, status becomes `needs_rewrite`.
- Retrieval: FTS5 over `trigger_keywords` plus `rejection_reason` and `prevention_rule`, combined with the scope filter (D38). Results are capped (default 10) and ordered by scope (agent, then project, then global) and then by recency.
- Audit integration (M9): automatic checks run when a task reaches Review. A failed automatic check moves the task back to In Progress with the lesson id in the reason, and increments `occurrences` for that lesson.

*Agent Hub changes*
- Agents page (the library): sorted list grouped by role, search, status filter, create, edit, archive, delete. This is the only place agents are created or edited.
- Per project: a "Project agents" panel listing only assigned agents, with a "+" button that opens the library picker. The picker allows multi-select and shows each agent's role and provider. Removing from the project is one action with a confirm that says the agent stays in the library.
- Per-project settings for an assigned agent: enabled toggle, allowed task types, extra constraints, and an "open project spec" link.
- Lessons panel: lists lessons by scope with filters for `needs_rewrite` and `draft`. Each row shows occurrences and the check type.

*Runtime*
- Prompt builder implements D34: profile → `AGENTS.md` → matched lessons (D38) → `TASK_CONTEXT.md`. The run record stores the layers used, the `AGENTS.md` hash, and the ids of lessons injected.
- The M13 planner and the M14 orchestrator both read the project's `AGENTS.md` and the matched lessons before proposing or dispatching anything.
- Spec file changes are picked up on the next run without restarting the app (file hash checked at dispatch).

*MCP and CLI*
- New read tools: `list_library_agents`, `get_project_spec`, `get_lessons_for_task(task_id)`. Writes to the library and lesson scope promotion stay in the UI; MCP cannot create or delete library agents, promote lessons, or retire them, so an agent cannot widen its own permissions or remove a lesson that constrains it.
- MCP write tool `propose_lesson(task_id, reason, fix, check)`: an agent may propose a lesson after its own mistake is pointed out, but the lesson stays in `draft` until a human promotes it.
- CLI: `command-center project status` (folder, spec status, assigned agents, lessons count), `command-center projects` (registry list), `command-center agents --library`, `command-center lessons --needs-rewrite`.

Exit criteria
- **Library scope:** create an agent in the library; open two different projects; the agent appears in both assign pickers and nowhere is it copied. Edit it once; both projects use the new profile on their next run.
- **Folder placement:** create a project in a folder chosen by the operator outside the Command Center's own folder. Project files are created there; the app's database stays in its own project file; the path is saved and reopens correctly after restart.
- **Switcher:** with two registered projects, switching from one to the other reloads every view with the second project's data, and switching back restores the first. Dispatch for the first project is paused during the switch and the app says so. A project with a missing folder shows its error in the switcher and cannot be opened.
- **Precedence:** run a seeded task in a project whose `AGENTS.md` forbids a specific tool. The run record shows the layers, and the agent does not use the forbidden tool. Repeat with the spec removed: the run still starts and the project shows the "no project spec" notice (D36).
- **Live spec edits:** change one line in `AGENTS.md` between two runs; the second run's record shows the new hash.
- **Assignment:** removing an agent from a project leaves it in the library and removes only the link. Adding it back restores its project settings only if they still exist; otherwise defaults apply and the app says so.
- **Deletion rule:** an unassigned agent with no runs deletes; an agent with runs archives and stays readable in history (D35).
- **Lesson scopes:** a rejected task creates a `project` lesson. Promoting it to `agent` makes it appear in a second project's run for the same library agent, and not for a different agent. Promoting to `global` makes it appear for both agents.
- **Required reading:** a run with a matching lesson shows the "Before you start" block in its prompt and stores the lesson id. A run with no matching lesson stores the lookup with an empty result.
- **Recurrence:** reject the same mistake twice after a lesson is active. The lesson's `occurrences` reaches 2 and its status becomes `needs_rewrite`, and it appears in the Lessons panel with the warning.
- **Automatic check:** a lesson with an automatic check fails on a task that breaks it. The task moves back to In Progress, the reason names the lesson, and `occurrences` increases. The same check passes on a fixed task.
- **Draft rule:** a lesson with no check cannot be promoted beyond `project` scope; the UI explains why.
- **Agent cannot self-promote:** an agent calling `propose_lesson` creates a `draft`; no MCP call can change its scope or status.
- **Malformed project file:** a broken `project.json` blocks dispatch for that project only, names the bad field, and other projects keep running.
- **Tests:** `core` tests for library CRUD, the D35 rule, precedence builder, hash-based reload, missing and malformed spec handling, assignment removal, registry and switch logic, lesson scope filtering, recurrence counting, and automatic check handling. Typecheck, lint and Vitest pass. UI/UX §9 checklist for the Agents page, project agents panel, project switcher and Lessons panel in both themes.
- **Demo project:** the sample project in `sample-projects/demo-project/` (with `AGENTS.md`, `README.md`, `LICENSE`, `details/`, `project.json`) is used as the first fixture for the precedence, switcher and lesson tests.

Out of scope for M15
- Sharing the library or lessons between machines or users (backlog: cloud sync / multi-user).
- Automatic generation of a project's `AGENTS.md` from the M13 planning session. The planner may propose its content, but writing the file is an operator-approved action, the same as plan approval.
- Editing project files from inside the app beyond the spec and README (the operator edits other files in their own editor).
- Machine-learned ranking of lessons. Retrieval uses keywords, scope and recency only.
- Cross-project overview screen (backlog, see the switcher section).

---

### M17 — Operator Fixes & Live Run View  *(2–3 days; the operator will add more features here)*
**Maps to:** New (post-M15), from the operator's first week of real use. M16 is the separate Remotion how-to project. Not started: the standing authorisation ended at M15, so wait for the operator's "continue".
**Goal:** Fix what real use turned up, and let the operator watch what every agent is doing while it runs.

*Fixed on 2026-10-15 (committed with M17; kept here so the milestone's record is complete)*
- Error toasts disappear after 10 s (they used to stay forever).
- A new project starts today (day 0); an old project with the placeholder 2026-01-01 start moves to its first milestone's creation date (migration 010). Calendar "Week N" counts from the project's start (Week 1 = the week it began), not the ISO week.
- Right-click Cut / Copy / Paste / Select all in every text field (API key field).
- Model choices come from the provider (Anthropic API, OpenAI, Gemini: GET /models with the saved key); the saved list is the fallback, and Claude Code CLI keeps the editable list.
- Not verified: live calls to the three providers (no real keys on this machine).

*To build*
- **Live run view:** pass `onChunk` from `Orchestrator.callProvider` to a `run:chunk` IPC channel; a panel (Agent Hub or its own tab, operator to choose) lists every run in flight with agent, task, provider/model, elapsed time, streamed output and Cancel. Finished runs keep their output (RunOutputDialog).
- **Start date control:** a field in Settings or the project header to change the project start (and target) date, since day 0 now drives week numbers and the swim lane.
- **Orchestrator explainer in the app:** a short help text in Settings → Providers: dispatch is plain code (D22), it has no provider; the providers belong to agents (and per-task overrides); how task order, dependencies and the concurrency limits decide what starts next.
- *(The operator adds further features here.)*

**Exit criteria:** `tsc --noEmit` strict, lint, tests pass; a real run's output streams into the live view while it runs; Cancel from the view stops the provider process; a project created today shows Week 1 and opens the swim lane at day 0.

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
| M12 | Polish + packaging + hydration (done) | 2.5d | ~22d |
| M13 | Planning workspace | 3–4d | ~25–26d |
| M14 | Orchestrator + multi-provider runners (Slice 1 first: Claude Code model per agent, 0.5d) | 4–5d | ~30d |
| M15 | Agent library, project workspaces, switcher, lessons | 4–5d | ~34–35d |
| M17 | Operator fixes and live run view (more features to be added) | 2–3d | ~37d |

Estimates are focused-build days for an agent working with review; expect the human to spend most time on reviewing M3, M5, M9, M13, M14 and M15. **Natural demo points:** after M4 (agent drives the board live), after M6 (full observability), after M12 (shippable), after M13 (plans created in-app), after M14 (tasks run without manual starts), after M15 (multi-project, shared agent library).

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
| Planner output invents capabilities, roles or deadlines the operator never gave | Wrong team or dates get approved | Assumptions are highlighted in the draft (M13); nothing reaches the board without approval (D15) |
| Unattended orchestrator spends money or runs too long | Unexpected cost, runaway loops | Concurrency, hourly and daily caps (D28); pause control; per-run cost recorded (D26) |
| Provider keys leak into logs, DB or agent context | Credential exposure | `safeStorage` encryption, no key in renderer state, grep test in M14 exit criteria (D25) |
| Same agent reviews its own work through a different path | Quality gate bypassed | Reviewer-is-not-executor rule (D29) enforced in core, not only in UI |
| Claude Code model aliases change or are unavailable on the operator's machine | Runs fail or use an unexpected model | Model list lives in settings, aliases verified against the installed CLI in Slice 1, removed ids fall back to CLI default with a warning |
| Switching projects leaves dispatch or DB handles from the previous project running | Writes land in the wrong project | Pause dispatch and close the connection before opening the next project; test in M15 switcher exit criteria |
| Lessons never reach an agent that skips the prepare step | Repeated mistakes | Lessons are injected by the prompt builder itself (D38), not only by `prepare`; run record stores the lookup |
| Lessons keep matching but do not prevent the mistake | False sense of learning | Recurrence counter and `needs_rewrite` status (D39); verifiable checks (D40) |

---

## 6. Backlog (post-v1, do not build now)

- Split terminal panes; terminal output → task log capture
- Manual card ordering in columns; swimlane drag-to-reschedule milestones
- Week-over-week agent performance comparison; completion heat-map in Calendar
- Cross-project overview screen (progress, pending work and review items across all registered projects, read-only)
- Export (PDF/Markdown status report); import from Linear/GitHub issues
- Command Center as a tray app with quick-status popup
- Cloud sync / multi-user
- Auto-update channel
- Planner-driven re-planning when milestones slip
- Automatic provider re-routing after repeated failures
- Complexity-based routing and budget modes (economy / balanced / speed) with escalation on failure
- Gantt-style date editing in Swim Lane
- Remote and cloud agent execution

---

## 7. Kickoff Prompt (paste into Claude Code)

```
You are continuing the Command Center desktop app. Read, in order:
1. COMMAND_CENTER_BLUEPRINT.md  — architecture, schema, stack, APIs
2. UI_UX_SPEC.md                — visual design and interaction (wins on UI conflicts)
3. ROADMAP.md                   — build order, decisions D1–D40, milestones M0–M15
4. PROGRESS.md                  — what is already done. Trust it over this file for status.

Rules:
- M0–M12 are complete and approved. Do not rebuild, rewrite or re-run them.
- The next milestone is M13. Do not start it until the operator says "continue".
- After M13: M14 (starting with Slice 1), then M15. Same rule: one at a time, stop and wait for "continue" after each.
- Apply the decisions in ROADMAP §1 (monorepo with a shared `core` package, typed IPC with no raw SQL, WAL + data_version change detection, etc.) even where the blueprint differs.
- At the start of each milestone state the goal and the files you'll create or change. At the end, run the exit criteria, show the results, update PROGRESS.md, and commit.
- Stop and report after each milestone or slice; wait for my "continue" before the next one.
- Target OS is Windows first (also keep macOS/Linux working).
- If something is ambiguous, choose the simplest option, record it in PROGRESS.md, and proceed.
- Before writing any provider adapter in M14, list which providers are detected on the operator's machine and report that list in the handoff. Do not add adapters for providers the operator does not have or has not asked for, except `claude-code`, which is required.
- Before writing the library storage in M15, confirm the app's user data path on Windows and report it in the handoff.

Wait for "continue" before starting M13.
```
