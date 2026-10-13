# Command Center

Desktop cockpit for steering a project worked on by AI agents. Single source of truth: SQLite (`command-center.db`) in the project root.

Read the docs in this order: `COMMAND_CENTER_BLUEPRINT.md` → `UI_UX_SPEC.md` → `ROADMAP.md`.

## Prerequisites (Windows)

- Node.js 22+
- `node-pty` (the Terminal tab) 1.1 ships prebuilt Windows and macOS binaries, loaded as-is by Electron: no compiler is needed there. On Linux, or if the prebuilt binary fails to load, install the Visual Studio Build Tools (Windows, "Desktop development with C++") or `build-essential` and run `npm rebuild node-pty`. `better-sqlite3` ships a prebuilt N-API binary too.
- Python 3 (node-gyp)

## Quick start

```bash
npm install
npm run dev
```

Set `PROJECT_ROOT` to the project folder to open; otherwise the app asks for one on first run.

## Connect an agent (MCP)

Agents drive the board through the `command-center` MCP server (stdio). The app's **Agent Hub** shows the exact commands below with your real paths filled in.

1. **Open the project in the app once.** The server refuses to start in a folder with no `command-center.db` (so a typo in `PROJECT_ROOT` can't silently create an empty board).
2. **Build the server** (one bundled file, `packages/mcp-server/dist/index.js`):

   ```bash
   npm run build -w packages/mcp-server
   ```

3. **Add it to Claude Code** (one line; use your own paths):

   ```bash
   claude mcp add command-center node /path/to/command-center/packages/mcp-server/dist/index.js -e PROJECT_ROOT=/path/to/project
   ```

   or paste this into `.mcp.json` / your client's MCP config:

   ```json
   {
     "mcpServers": {
       "command-center": {
         "command": "node",
         "args": ["/path/to/command-center/packages/mcp-server/dist/index.js"],
         "env": { "PROJECT_ROOT": "/path/to/project" }
       }
     }
   }
   ```

4. **Optional: global command.** `npm install -g ./packages/mcp-server` puts `command-center-mcp` on your PATH; then use `"command": "command-center-mcp"` and drop `args`.

### Who is the caller?

The server registers the calling agent automatically on its first call, named after the client (`claude-code` for Claude Code). Override with `COMMAND_CENTER_AGENT_ID`, `COMMAND_CENTER_AGENT_NAME`, `COMMAND_CENTER_AGENT_TYPE` (`orchestrator` | `sub-agent` | `external`) and `COMMAND_CENTER_AGENT_MODEL` in the config's `env`. A tool call can never act as `operator`, `system` or a human agent, and can act only as the session agent or sub-agents registered under it (`register_agent` it, then pass its id as `agent_id`). Review is independent: an agent cannot approve work submitted by itself or by its own parent or sub-agents; the operator or an unrelated agent must.

### The 30 tools

| Group | Tools |
|---|---|
| Read (11) | `get_task_context` (≤ ~8K tokens), `get_task_summary` (≤ ~500), `get_project_status`, `get_milestone_overview`, `list_tasks`, `get_task_history`, `list_agents`, `get_activity_feed`, `get_lessons_learned`, `get_planning_documents`, `get_planning_session` |
| Task (11) | `start_task`, `complete_task`, `approve_task`, `reject_task`, `reset_task`, `delete_task`, `block_task`, `unblock_task`, `update_task`, `log_action`, `enrich_task` |
| Milestone (5) | `add_milestone_note`, `set_milestone_dates`, `update_drift`, `create_milestone`, `add_milestone_task` |
| Agent (1) | `register_agent` |
| Runs (2) | `list_runs` (provider runs with usage and cost), `cancel_run` (stop a run; it can never approve or complete work) |

Typical loop: `get_project_status` → `list_tasks` → `get_task_context` → `start_task` → work (`log_action`) → `complete_task`. The task then waits in **Review** for the human. Errors name the tool to call next, and unknown parameters are rejected rather than ignored.

## Operator CLI

`command-center` works on the same board as the app and the MCP server. It finds the project from `--root`, `$PROJECT_ROOT`, or the nearest parent folder with a `command-center.db` (it never creates a board).

```bash
npm run build -w packages/cli                     # builds packages/cli/dist/index.js
npm install -g ./packages/cli                     # optional: puts `command-center` on your PATH
# The app's Terminal tab already has `command-center` on PATH (no install needed).

command-center status                  # week, phase, progress, what needs review / is blocked   (--json)
command-center agents                  # agents, nesting, ACTIVE / IDLE                           (--json)
command-center log --task TASK-001     # a task's history, newest first (--agent, --limit, --json)
command-center prepare --id TASK-001   # Research Explorer -> Token Compressor -> Prompt Optimizer -> .claude/TASK_CONTEXT.md
command-center start   --id TASK-001   # start_task, dispatch the agent with the context, run checks, complete_task
command-center audit   --id TASK-001   # Code Quality -> Security -> Final Validator; FAIL sends a reviewed task back
command-center orchestrate --status    # the orchestrator: mode, runs, caps, spend (--pause / --resume; the app does the running)
command-center runs --task TASK-001    # provider runs: provider/model, time, tokens, cost (an estimate unless reported)
command-center lessons --task TASK-001 # lessons from past rejections that apply (or --query text; no flag = latest)
command-center hydrate --plan plan.json # create phases, agents, milestones and tasks from a plan (see Hydrate below)
```

- Every stage is a sub-agent (`research_explorer`, `token_compressor`, `prompt_optimizer`, `code_quality`, `security_auditor`, `final_validator`, under `operator-cli`) and writes its result to the Agent Hub activity feed.
- `--dry-run` prints each stage's prompt and what would happen, and changes nothing.
- `--runner claude` shells out to the Claude Code CLI (`claude -p`, prompt on stdin, read-only tools for analysis stages, edit tools only for the build stage); it needs `claude` on PATH (or `COMMAND_CENTER_CLAUDE`) and a logged-in session. `--runner local` is an offline fallback with real file search, check runs and secret scanning but no model; `auto` (default) picks `claude` when it finds it. `--timeout <minutes>` bounds one stage.
- `start` and `audit` run `npm run typecheck` and `npm run lint` when the project defines them; use `--check "<command>"` (repeatable) to choose your own. `start --no-dispatch` skips the agent (work already built) and only checks and completes.
- An audit **FAIL** on a task in Review moves it back to In Progress, records the reason and a lesson. A PASS leaves it in Review for you to approve in the app. Exit codes: 0 ok, 1 failed/refused, 2 a stage could not run.

## Lessons learned

Rejecting a task (in the app, over MCP `reject_task`, or a failed `audit`) saves **what went wrong** in the `lessons_learned` table and rewrites `.claude/LESSONS_LEARNED.md` (a generated view: edit lessons in the app's Agent Hub, not in the file). When the task is completed again, the `complete_task` summary is recorded as **the fix**; a rejection may also carry a **prevention** note. Similar new tasks are handed the most relevant lessons (FTS5 search over reason, fix and prevention) in `get_task_context`, in the `enrich_task` reply, in `TASK_CONTEXT.md` (`## Relevant lessons`) and in `command-center prepare`. The Agent Hub's Lessons list lets you search, edit and delete them.

## Plan a project (Planning tab)

`Ctrl/Cmd+6` (or "Plan a project" on any empty view). Describe the idea in a paragraph; the planner asks at least three questions, then drafts a manifesto, a roadmap, milestones with dates and the capabilities each needs, tasks with due dates and dependencies, and a team (one agent per role, derived from the capabilities). Every draft is editable in place and lists what the planner assumed. Nothing reaches the board until **Approve plan**, which writes it all in one transaction (or nothing, if any task has no milestone, a dependency is missing, or there is a cycle). Sessions survive a restart; Cancel kills the planner's process tree.

The planner runs Claude Code (`claude -p`, as a child process, never in the terminal) or the Anthropic API with a key (Settings → Planner; the key is encrypted with the OS keychain and never shown). The approved manifesto and roadmap are under Settings → Planner, and each milestone's roadmap entry shows in its panel. Agents can read plans (`get_planning_documents`, `get_planning_session`) but cannot approve them.

## Run approved tasks automatically (orchestrator)

Agent Hub → **Orchestrator** (or the status bar) switches the orchestrator on. It is plain code, never a model: every 5 seconds (and straight after a change to the board) it starts the tasks that are ready, in order of milestone start, priority and due date. A task is ready when it is To Do, assigned to a text agent, every task it depends on is done, and its provider is detected. A run is `start_task`, one call to the agent's provider with the task's context, then `complete_task` with the agent's `SUMMARY:` line; the task then waits in **Review**. A failed run is retried once, then the task is **blocked** with the error text; the orchestrator carries on with other tasks. Manual **Run with agent** in a task uses the same path.

- **Providers** (Settings → Providers): Claude Code (`claude -p` in the project folder), Anthropic API, OpenAI API, Gemini (CLI if installed, else API key), and a local Ollama / LM Studio server. Each shows detected / not detected; a provider that is not detected cannot be chosen. Keys are encrypted with the OS keychain, never shown again, never written to a log, the database or a task file. **Test connection** makes one live round trip.
- **Routing:** each agent has a provider and model (Agent Hub); a task can override its agent's provider (task → Details → Provider).
- **Limits (D28):** runs at once (default 2, and 1 per agent), runs per hour (20), estimated spend per day ($5) and a per-run timeout (15 min). Reaching the hourly or daily cap pauses dispatch ("Paused by cap" in the status bar) until the window clears or you raise it. Pause asks whether to let running runs finish or cancel them; "Stop after current" lets the current runs end, then pauses.
- **Reviews:** a task an agent finished is reviewed by a different agent (never the same agent or its family) or by you. Automatic review by another agent is off by default (Settings → Providers).
- **Visibility:** each run is one activity-feed entry (provider, model, duration; **Output** opens its last lines), a row in the task's History, and a count in the status bar (running, queued, today's spend against the ceiling). Costs are labelled **estimate** unless the provider reported them (Claude Code does).
- **Risk:** agents run on your computer with the permissions their provider already grants (Claude Code may edit files and run `npm run` scripts in the project folder). Command Center does not sandbox anything beyond that.

## Choose a model per agent

Agent Hub → each text-runner agent has **Provider** and **Model** dropdowns. For Claude Code the options come from Settings → Providers, an editable JSON list of `{ "id", "label" }` that starts with the aliases `haiku`, `sonnet` and `opus` (checked against the installed `claude` CLI; `id` is what is passed to `claude --model`, so a full model name works too). "CLI default" passes no flag. The operator CLI (`prepare`, `start`, `audit`) runs each stage on its agent's model (the builder on the task's assignee), writes the model into the run's activity entry, and warns, then uses the CLI default, if an agent's model has been removed from the list. The old `COMMAND_CENTER_MODEL` variable is no longer read: the agent decides.

## Hydrate a project from your docs

Fresh clone to a populated board in a few minutes:

1. `npm install`, `npm run dev`, and pick (or create) a project folder.
2. Connect Claude Code (see above), or just use the CLI below.
3. Turn your manifesto and roadmap into a prompt, give it to any agent, and save its JSON reply:

   ```bash
   command-center hydrate --manifesto manifesto.md --roadmap roadmap.md --out prompt.txt
   # paste prompt.txt into your agent; save the JSON it returns as plan.json
   command-center hydrate --plan plan.json --dry-run   # validate, nothing is written
   command-center hydrate --plan plan.json             # phases, agents, milestones and tasks, in one transaction
   ```

The plan holds `project`, `phases`, `agents` and `milestones` (each with its `tasks`); the prompt spells out the exact shape. A bad reference (unknown phase, dependency on a later milestone) rolls the whole import back. The Swim Lane, Task Board, Agent Hub and Calendar fill in live. The Swim Lane's getting-started card tracks the four setup steps.

## Webhooks

The app listens on `127.0.0.1:38120` with a per-project bearer token (Settings or Agent Hub shows it, with a copy-ready `curl`; Regenerate replaces it). Details, `curl`, git post-commit hook and n8n examples: [docs/WEBHOOKS.md](docs/WEBHOOKS.md).

## Keyboard

`Ctrl/Cmd+K` command palette (tabs, tasks, milestones, settings), `Ctrl/Cmd+1…6` tabs, `Ctrl/Cmd+,` Settings, `?` shortcut sheet, `/` search, `T` today, `[` `]` milestones, `Esc` closes the top overlay. Card drag works from the keyboard (Space, arrows, Space) with screen-reader announcements.

## Settings

Theme (dark / light / system), week start (Mon / Sun), planner runner / model / API key and the approved plan, OS notifications when a task newly enters Review or Blocked while the window is unfocused, default terminal shell and font size, project folder, webhook port/token, and the copy-ready MCP command and config. Preferences live in the app's local storage; the project data lives only in `command-center.db`.

## Install as an app

```bash
npm run dist            # Windows NSIS installer in release/ (macOS: dmg, Linux: AppImage when run there)
npm run pack            # unpacked app in release/win-unpacked, no installer
npm run install:global  # puts `command-center` and `command-center-mcp` on your PATH
```

The installer ships the MCP server and CLI inside the app and runs them with the app's own Electron, so a packaged install needs no Node: Settings shows the exact `claude mcp add` command for it. The native modules (`node-pty`, `better-sqlite3`) use their prebuilt binaries, so packaging needs no compiler on Windows or macOS. The installer is unsigned (SmartScreen will warn); code signing needs your own certificate.

## Testing

`npm test` (unit and integration), `npm run smoke -w apps/desktop` (Playwright-for-Electron against the built app, or `-- --exe "<path>"` against a packaged one: launch, hydrate through the CLI, tabs, drag a card, modal, palette, settings, terminal, webhook status, MCP over stdio), `node apps/desktop/smoke/perf.mjs` (500 tasks and 5,000 log rows).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Launch the Electron app with hot reload |
| `npm run build -w apps/desktop` | Production build of the app |
| `npm run build -w packages/mcp-server` | Bundle the MCP server |
| `npm run pack` / `npm run dist` | Unpacked app / installer into `release/` |
| `npm run install:global` | Link `command-center` and `command-center-mcp` globally |
| `npm run smoke -w apps/desktop` | Electron smoke test |
| `npm run typecheck` | `tsc --noEmit` (strict) in every workspace |
| `npm run lint` | ESLint over the repo |
| `npm test` | Vitest unit and integration tests |
| `npm run format` | Prettier write |
