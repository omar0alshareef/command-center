# Command Center

Desktop cockpit for steering a project worked on by AI agents. Single source of truth: SQLite (`command-center.db`) in the project root.

Read the docs in this order: `COMMAND_CENTER_BLUEPRINT.md` → `UI_UX_SPEC.md` → `ROADMAP.md`.

## Prerequisites (Windows)

- Node.js 22+
- Visual Studio Build Tools with the "Desktop development with C++" workload (needed by `node-pty` in M8). `better-sqlite3` ships a prebuilt N-API binary, so it needs no compiler.
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

The server registers the calling agent automatically on its first call, named after the client (`claude-code` for Claude Code). Override with `COMMAND_CENTER_AGENT_ID`, `COMMAND_CENTER_AGENT_NAME`, `COMMAND_CENTER_AGENT_TYPE` (`orchestrator` | `sub-agent` | `external`) and `COMMAND_CENTER_AGENT_MODEL` in the config's `env`. A tool call can never act as `operator`, `system` or a human agent; to act for a sub-agent, `register_agent` it and pass its id as `agent_id`.

### The 25 tools

| Group | Tools |
|---|---|
| Read (9) | `get_task_context` (≤ ~8K tokens), `get_task_summary` (≤ ~500), `get_project_status`, `get_milestone_overview`, `list_tasks`, `get_task_history`, `list_agents`, `get_activity_feed`, `get_lessons_learned` |
| Task (10) | `start_task`, `complete_task`, `approve_task`, `reject_task`, `reset_task`, `block_task`, `unblock_task`, `update_task`, `log_action`, `enrich_task` |
| Milestone (5) | `add_milestone_note`, `set_milestone_dates`, `update_drift`, `create_milestone`, `add_milestone_task` |
| Agent (1) | `register_agent` |

Typical loop: `get_project_status` → `list_tasks` → `get_task_context` → `start_task` → work (`log_action`) → `complete_task`. The task then waits in **Review** for the human. Errors name the tool to call next, and unknown parameters are rejected rather than ignored.

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
