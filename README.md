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
   claude mcp add command-center --env PROJECT_ROOT=/path/to/project -- node /path/to/command-center/packages/mcp-server/dist/index.js
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

### The 25 tools

| Group | Tools |
|---|---|
| Read (9) | `get_task_context` (≤ ~8K tokens), `get_task_summary` (≤ ~500), `get_project_status`, `get_milestone_overview`, `list_tasks`, `get_task_history`, `list_agents`, `get_activity_feed`, `get_lessons_learned` |
| Task (10) | `start_task`, `complete_task`, `approve_task`, `reject_task`, `reset_task`, `block_task`, `unblock_task`, `update_task`, `log_action`, `enrich_task` |
| Milestone (5) | `add_milestone_note`, `set_milestone_dates`, `update_drift`, `create_milestone`, `add_milestone_task` |
| Agent (1) | `register_agent` |

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
```

- Every stage is a sub-agent (`research_explorer`, `token_compressor`, `prompt_optimizer`, `code_quality`, `security_auditor`, `final_validator`, under `operator-cli`) and writes its result to the Agent Hub activity feed.
- `--dry-run` prints each stage's prompt and what would happen, and changes nothing.
- `--runner claude` shells out to the Claude Code CLI (`claude -p`, prompt on stdin, read-only tools for analysis stages, edit tools only for the build stage); it needs `claude` on PATH (or `COMMAND_CENTER_CLAUDE`) and a logged-in session. `--runner local` is an offline fallback with real file search, check runs and secret scanning but no model; `auto` (default) picks `claude` when it finds it. `--timeout <minutes>` bounds one stage.
- `start` and `audit` run `npm run typecheck` and `npm run lint` when the project defines them; use `--check "<command>"` (repeatable) to choose your own. `start --no-dispatch` skips the agent (work already built) and only checks and completes.
- An audit **FAIL** on a task in Review moves it back to In Progress, records the reason and a lesson. A PASS leaves it in Review for you to approve in the app. Exit codes: 0 ok, 1 failed/refused, 2 a stage could not run.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Launch the Electron app with hot reload |
| `npm run build -w apps/desktop` | Production build of the app |
| `npm run build -w packages/mcp-server` | Bundle the MCP server |
| `npm run typecheck` | `tsc --noEmit` (strict) in every workspace |
| `npm run lint` | ESLint over the repo |
| `npm test` | Vitest unit and integration tests |
| `npm run format` | Prettier write |
