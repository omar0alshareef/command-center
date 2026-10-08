# Command Center Blueprint (Merged & Enhanced)

> A complete build specification for an AI-agent-powered project command center.
> Feed this document to any capable coding agent (Claude Code, Codex, Cursor, etc.)
> and it will build the entire system across multiple phases.

> **Based on:** sha8al Command Center.md + Command Center Hero.md
> **Enhancements:** SQLite, embedded terminal, webhooks, self-improving memory, operator pipeline

---

## About This Document

### What This Builds

Three deliverables:

1. **MCP Server** — A globally-installed Node.js package exposing 24+ tools over stdio. AI agents call these tools to read project state, manage tasks, dispatch sub-agents, and log activity. Also includes a CLI for shell access.

2. **Electron Desktop App** — A cross-platform dashboard with 5 tabs: Swim Lane, Task Board, Agent Hub, Calendar, and **Terminal** (embedded xterm.js). Watches SQLite DB for changes and renders project state in real time.

3. **Operator CLI** — Command-line macros (`prepare`, `run`, `audit`) that automate the sub-agent pipeline: Research Explorer → Token Compressor → Prompt Optimizer → Code Quality → Security → Final Validator.

All three share a single source of truth: a **SQLite database** (`command-center.db`) in the user's project root. This replaces the JSON tracker from the original spec to eliminate race conditions.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Operator (Human)                             │
│                 Electron Desktop App                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────────┐  │
│  │ Swim Lane│  │Task Board│  │Agent Hub │  │  Terminal      │  │
│  │          │  │          │  │          │  │ (xterm.js)     │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───────┬────────┘  │
│       │             │             │                │            │
│       └─────────────┴─────────────┴────────────────┘            │
│                           │                                      │
│                    IPC + fs.watch                               │
└───────────────────────────┼─────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────────┐
│               SQLite DB (command-center.db)                      │
│         Tasks | Milestones | Agents | Logs | Memory             │
└───────────────────────────┬─────────────────────────────────────┘
                            │
            ┌───────────────┼───────────────┐
            │               │               │
    ┌───────▼───────┐ ┌─────▼──────┐ ┌──────▼──────┐
    │   MCP Server  │ │   Webhook  │ │  Operator   │
    │  (stdio)      │ │  (:38120)  │ │  CLI macros │
    └───────┬───────┘ └────────────┘ └─────────────┘
            │
    ┌───────▼───────┐
    │ Claude Code   │
    │ (or any agent)│
    └───────────────┘
```

---

## Stack

| Layer | Technology |
|-------|------------|
| Desktop App | Electron 41+ with electron-vite |
| UI Framework | React 19 |
| State Management | Zustand 5 |
| Styling | Tailwind CSS v4 + shadcn/ui + Framer Motion |
| Terminal | xterm.js + @xterm/addon-fit + node-pty |
| Database | better-sqlite3 |
| MCP Server | Node.js + @modelcontextprotocol/sdk |
| Webhook Server | Express on localhost:38120 |
| Icons | Lucide React |
| Fonts | Inter (UI) + JetBrains Mono (code/numbers) |
| Language | TypeScript (strict mode, ES modules) |

---

## PHASE 1: DATABASE SCHEMA

### SQLite Tables

```sql
-- Project metadata (single row)
CREATE TABLE project (
  id INTEGER PRIMARY KEY DEFAULT 1,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  target_date TEXT NOT NULL,
  schedule_status TEXT DEFAULT 'on_track',
  overall_progress REAL DEFAULT 0
);

-- Milestones
CREATE TABLE milestones (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  domain TEXT NOT NULL DEFAULT 'general',
  week INTEGER NOT NULL DEFAULT 1,
  phase TEXT,
  planned_start TEXT,
  planned_end TEXT,
  actual_start TEXT,
  actual_end TEXT,
  drift_days INTEGER DEFAULT 0,
  is_key_milestone INTEGER DEFAULT 0,
  key_milestone_label TEXT,
  dependencies TEXT DEFAULT '[]',  -- JSON array of milestone IDs
  notes TEXT DEFAULT '[]',          -- JSON array
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Subtasks
CREATE TABLE subtasks (
  id TEXT PRIMARY KEY,
  milestone_id TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT DEFAULT 'todo' CHECK(status IN ('todo','in_progress','review','done','blocked')),
  done INTEGER DEFAULT 0,
  assignee TEXT,
  blocked_by TEXT,
  blocked_reason TEXT,
  completed_at TEXT,
  completed_by TEXT,
  priority TEXT DEFAULT 'P2',
  notes TEXT,
  prompt TEXT,
  context_files TEXT DEFAULT '[]',    -- JSON array
  reference_docs TEXT DEFAULT '[]',   -- JSON array
  acceptance_criteria TEXT DEFAULT '[]',
  constraints TEXT DEFAULT '[]',
  agent_target TEXT,
  execution_mode TEXT DEFAULT 'agent',
  depends_on TEXT DEFAULT '[]',       -- JSON array of task IDs
  last_run_id TEXT,
  builder_prompt TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (milestone_id) REFERENCES milestones(id)
);

-- Agents
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('orchestrator','sub-agent','human','external')),
  parent_id TEXT,
  color TEXT DEFAULT '#9B9BAA',
  status TEXT DEFAULT 'idle',
  permissions TEXT DEFAULT '[]',   -- JSON array
  last_action_at TEXT,
  session_action_count INTEGER DEFAULT 0,
  source_model TEXT,               -- e.g., "claude-sonnet-5-5", "deepseek-r1"
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (parent_id) REFERENCES agents(id)
);

-- Agent log entries
CREATE TABLE agent_log (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  description TEXT,
  timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
  tags TEXT DEFAULT '[]',  -- JSON array
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

-- Schedule phases
CREATE TABLE phases (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  start_week INTEGER NOT NULL,
  end_week INTEGER NOT NULL,
  color TEXT DEFAULT '#585CF0'
);

-- Self-improving memory (lessons learned)
CREATE TABLE lessons_learned (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subtask_id TEXT NOT NULL,
  rejection_reason TEXT NOT NULL,
  fix_applied TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (subtask_id) REFERENCES subtasks(id)
);

-- Indexes
CREATE INDEX idx_subtasks_milestone ON subtasks(milestone_id);
CREATE INDEX idx_subtasks_status ON subtasks(status);
CREATE INDEX idx_agent_log_agent ON agent_log(agent_id);
CREATE INDEX idx_agent_log_timestamp ON agent_log(timestamp DESC);
```

### Initial Data

```sql
INSERT INTO project (id, name, start_date, target_date)
VALUES (1, 'My Project', '2026-01-01', '2026-06-30');
```

> **Checkpoint:** SQLite DB created with all tables. Schema validated.

---

## PHASE 2: ELECTRON SHELL

### Project Structure

```
command-center/
├── package.json
├── electron.vite.config.ts
├── tsconfig.json
├── .env                          # PROJECT_ROOT path
├── src/
│   ├── main/
│   │   ├── index.ts              # Electron main process
│   │   ├── config.ts             # Project root + DB path
│   │   ├── db.ts                 # SQLite connection + queries
│   │   ├── ipc-handlers.ts       # IPC for renderer
│   │   ├── pty.ts                # node-pty terminal spawning
│   │   ├── webhook.ts            # Express webhook server
│   │   └── preload.ts            # Context bridge
│   └── renderer/
│       ├── index.html
│       ├── main.tsx
│       ├── App.tsx
│       ├── store.ts
│       └── styles.css
```

### Dependencies (package.json)

```json
{
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "zustand": "^5.0.0",
    "@dnd-kit/core": "^6.0.0",
    "@dnd-kit/sortable": "^8.0.0",
    "@dnd-kit/utilities": "^3.0.0",
    "@xterm/xterm": "^5.0.0",
    "@xterm/addon-fit": "^0.8.0",
    "@xterm/addon-web-links": "^0.11.0",
    "node-pty": "^1.0.0",
    "better-sqlite3": "^11.0.0",
    "express": "^4.18.0",
    "lucide-react": "^0.400.0",
    "framer-motion": "^11.0.0",
    "clsx": "^2.1.0",
    "tailwind-merge": "^2.2.0"
  },
  "devDependencies": {
    "electron": "^41.0.0",
    "electron-vite": "^5.0.0",
    "@vitejs/plugin-react": "^4.0.0",
    "tailwindcss": "^4.0.0",
    "@tailwindcss/vite": "^4.0.0",
    "typescript": "^5.7.0"
  }
}
```

### Main Process (src/main/index.ts)

**Window Creation:**
- Size: 1400×900, min 1200×800
- Background: #0A0A10
- Frameless on macOS, native frame on Windows/Linux

**IPC Handlers:**
| Channel | Description |
|---------|-------------|
| `db:query` | Execute read query, return results |
| `db:run` | Execute write (INSERT/UPDATE/DELETE) |
| `db:getAll` | Get all tables as state object |
| `terminal:spawn` | Spawn PTY session |
| `terminal:write` | Write to PTY |
| `terminal:resize` | Resize PTY |
| `terminal:kill` | Kill PTY session |
| `webhook:status` | Get webhook server status |

**App Lifecycle:**
- `app.whenReady()` → create window + init DB + start webhook server
- `app.on('activate')` → recreate window (macOS)
- `app.on('window-all-closed')` → quit
- `app.on('before-quit')` → close DB + webhook server

### SQLite Wrapper (src/main/db.ts)

```typescript
import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(process.env.PROJECT_ROOT || '.', 'command-center.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent access
db.pragma('journal_mode = WAL');

// Query helpers
export function query<T>(sql: string, params: any[] = []): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function run(sql: string, params: any[] = []): Database.RunResult {
  return db.prepare(sql).run(...params);
}

export function get<T>(sql: string, params: any[] = []): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function getAllTrackerState() {
  return {
    project: get('SELECT * FROM project WHERE id = 1'),
    milestones: query('SELECT * FROM milestones ORDER BY week'),
    subtasks: query('SELECT * FROM subtasks ORDER BY milestone_id, id'),
    agents: query('SELECT * FROM agents'),
    agent_log: query('SELECT * FROM agent_log ORDER BY timestamp DESC LIMIT 500'),
    phases: query('SELECT * FROM phases ORDER BY start_week'),
    lessons_learned: query('SELECT * FROM lessons_learned ORDER BY created_at DESC')
  };
}
```

### Webhook Server (src/main/webhook.ts)

```typescript
import express from 'express';
import { run } from './db.js';

const WEBHOOK_PORT = 38120;
const app = express();
app.use(express.json());

// POST /webhook/task-update - external task status change
app.post('/webhook/task-update', (req, res) => {
  const { task_id, status, completed_at, completed_by } = req.body;
  if (!task_id) return res.status(400).json({ error: 'task_id required' });
  
  run('UPDATE subtasks SET status = ?, done = ?, completed_at = ?, completed_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [status, status === 'done' ? 1 : 0, completed_at || null, completed_by || null, task_id]);
  
  res.json({ success: true });
});

// POST /webhook/milestone-update
app.post('/webhook/milestone-update', (req, res) => {
  const { milestone_id, actual_end } = req.body;
  run('UPDATE milestones SET actual_end = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [actual_end, milestone_id]);
  res.json({ success: true });
});

// GET /webhook/status
app.get('/webhook/status', (_, res) => {
  res.json({ port: WEBHOOK_PORT, status: 'running' });
});

export function startWebhookServer() {
  return app.listen(WEBHOOK_PORT, () => {
    console.log(`Webhook server running on localhost:${WEBHOOK_PORT}`);
  });
}
```

### Terminal PTY (src/main/pty.ts)

```typescript
import * as pty from 'node-pty';
import { BrowserWindow } from 'electron';

const terminals = new Map<string, pty.IPty>();

export function spawnTerminal(window: BrowserWindow, id: string, shell?: string) {
  const shellName = shell || (process.platform === 'win32' ? 'powershell.exe' : 'bash');
  
  const term = pty.spawn(shellName, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 30,
    cwd: process.env.HOME || process.env.USERPROFILE,
    env: process.env
  });
  
  terminals.set(id, term);
  
  term.onData((data) => {
    window.webContents.send(`terminal:data:${id}`, data);
  });
  
  return { pid: term.pid };
}

export function writeTerminal(id: string, data: string) {
  terminals.get(id)?.write(data);
}

export function resizeTerminal(id: string, cols: number, rows: number) {
  terminals.get(id)?.resize(cols, rows);
}

export function killTerminal(id: string) {
  terminals.get(id)?.kill();
  terminals.delete(id);
}
```

### Preload Bridge

```typescript
contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  db: {
    getAll: () => ipcRenderer.invoke('db:getAll'),
    query: (sql: string, params: any[]) => ipcRenderer.invoke('db:query', sql, params),
    run: (sql: string, params: any[]) => ipcRenderer.invoke('db:run', sql, params)
  },
  terminal: {
    spawn: (id: string, shell?: string) => ipcRenderer.invoke('terminal:spawn', id, shell),
    write: (id: string, data: string) => ipcRenderer.invoke('terminal:write', id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.invoke('terminal:resize', id, cols, rows),
    kill: (id: string) => ipcRenderer.invoke('terminal:kill', id),
    onData: (id: string, callback: (data: string) => void) => {
      const handler = (_: any, data: string) => callback(data);
      ipcRenderer.on(`terminal:data:${id}`, handler);
      return () => ipcRenderer.removeListener(`terminal:data:${id}`, handler);
    }
  }
});
```

> **Checkpoint:** Electron app launches, shows loading screen, connects to SQLite. Terminal tab shows xterm.js. Webhook server running on :38120.

---

## PHASE 3: STORE & TAB SYSTEM

### Zustand Store (src/renderer/store.ts)

```typescript
interface AppState {
  tracker: TrackerState | null
  loading: boolean
  error: string | null
  synced: boolean
  activeTab: TabId
  selectedMilestoneId: string | null
  theme: 'dark' | 'light'
  
  setTracker: (data: TrackerState) => void
  updateTracker: (updater: (draft: TrackerState) => void) => void
  setActiveTab: (tab: TabId) => void
  setSelectedMilestoneId: (id: string | null) => void
  setLoading: (v: boolean) => void
  setError: (err: string | null) => void
  setSynced: (v: boolean) => void
  toggleTheme: () => void
}


type TabId = 'swim-lane' | 'task-board' | 'agent-hub' | 'calendar' | 'terminal'
```

### Tab Bar

5 tabs with icons:

| Tab | Icon | Description |
|-----|------|-------------|
| Swim Lane | Timeline | Strategic timeline with domain lanes |
| Task Board | LayoutGrid | 5-column Kanban |
| Agent Hub | Cpu | Agent monitoring + activity feed |
| Calendar | CalendarDays | Weekly completion history |
| Terminal | Terminal | xterm.js sessions |

> **Checkpoint:** All 5 tabs render. Theme toggle works. Store syncs with DB.

---

## PHASE 4: SWIM LANE VIEW

### Layout

```
┌──────────┬──────────────────────────────────────────────────────────────┐
│          │  W1    W2    W3    ▎  W4    W5    W6    W7                   │
│          │  01-01  01-08 01-15▎  01-22  01-29  02-05  02-12              │
├──────────┼─ Phase A (tinted) ──▎── Phase B (tinted) ────────────────────┤
│ Domain A │    (●6/11)────(●3/8)  ▎                                       │
│ ████████ │                         ▎                                    │
├──────────┤                         ▎                                    │
│ Domain B │       (●4/4)            ▎     (●2/7)────(●0/5)              │
│ ████████ │                         ▎                                    │
├──────────┤                         ▎                                    │
│          │      ◆ Beta Release    ▎                    ◆ V1.0 Launch  │
└──────────┴─────────────────────────┴────────────────────────────────────┘
                                     ▎
                                   NOW marker
```

### Features

- Phase background bands (translucent rectangles)
- Week grid with date headers
- NOW marker at fractional week position
- Milestone nodes with progress rings (SVG)
- Drift visualization: ghost node (planned) + actual node + drift badge
- Domain color bars on left
- Connection lines between adjacent milestones
- Key milestone markers (diamond shape + label)
- Click to open detail panel (480px slide-out)

### Constants

```typescript
const WEEK_W = 100;
const LANE_H = 200;
const LABEL_W = 140;
const HEADER_H = 44;
const NODE_R = 20;
const KEY_NODE_R = 26;
const PANEL_W = 480;
```

> **Checkpoint:** Swim Lane renders with week grid, NOW marker, domain lanes. Adding milestone to DB shows node in correct position.

---

## PHASE 5: TASK BOARD VIEW

### Column Definitions

| Column | Label | Color |
|--------|-------|-------|
| todo | TO DO | #9B9BAA |
| in_progress | IN PROGRESS | #585CF0 |
| review | REVIEW | #f59e0b |
| done | DONE | #22c55e |
| blocked | BLOCKED | #ef4444 |

### Components

- **ContextBar:** Progress ring + milestone info + navigation
- **FilterBar:** All | My Tasks | Agent Tasks | Blocked
- **KanbanColumn:** Drop zone + sortable task cards
- **TaskCard:** Domain tag + priority badge + title + assignee chip
- **TaskDetailModal:** Full-screen overlay with Details + History tabs

### Drag-Drop

Using @dnd-kit/core with PointerSensor (5px) and KeyboardSensor.

On drop:
- `todo` → status = 'todo', clear blockers
- `in_progress` → status = 'in_progress', set last_run_id
- `review` → status = 'review'
- `done` → status = 'done', set completed_at, completed_by
- `blocked` → status = 'blocked', set blocked_by = 'manual'

> **Checkpoint:** 5 columns render. Drag-drop moves tasks. Click opens modal.

---

## PHASE 6: AGENT HUB VIEW

### Left Column (340px)

1. **Connected Agents Hierarchy**
   - Orchestrators at top level
   - Sub-agents nested under parent
   - Shows: color dot, name, status (ACTIVE/IDLE), time since last action, permission badges, session action count
   - Collapse/expand for orchestrators

2. **Shared State File Info**
   - DB path, watcher status, milestone count, subtask count, log entry count

3. **Context Injection Preview**
   - One-line context string: `WEEK {n}, Phase: {name}, Progress: {pct}%, Schedule: {status}, Blocked: {n}`
   - Copy to clipboard button

4. **Today's Summary**
   - Stats: Completed, In Progress, Blocked
   - Contribution breakdown by agent

### Right Column (flex)

1. **Activity Feed**
   - Filter tabs: All | per-agent | Manual | System
   - Search box
   - Grouped by day (TODAY, YESTERDAY, or date)
   - Tag pills with colors

2. **Agent Performance Stats**
   - This calendar week only
   - Per-agent card with total actions + tag breakdown

> **Checkpoint:** Agent Hub renders with all panels. Adding agent to DB shows in Connected Agents.

---

## PHASE 7: CALENDAR VIEW

### Layout

7-column week grid (Mon–Sun):
- Header: Day abbreviation + date number
- Today indicator: colored bar under today's column
- Task chips stacked by completion date

### Task Chip

- Left border: 3px, domain color
- Label (truncated)
- Domain tag
- Green checkmark

### Navigation

- Prev/Next buttons
- Today button
- Header: "Week {n} · {start} – {end} · {count} completed"

> **Checkpoint:** Calendar renders. Setting subtask.completed_at shows chip in correct day.

---

## PHASE 8: TERMINAL VIEW

### Layout

```
┌────────────────────────────────────────────────────────────┐
│  New Session ▼ │ bash │ powershell │ ██████████████████   │
├────────────────────────────────────────────────────────────┤
│  $ █                                                          │
│                                                              │
│                                                              │
└────────────────────────────────────────────────────────────┘
```

### Features

- **Session tabs:** Multiple PTY sessions
- **Shell selector:** dropdown to choose bash/powershell/zsh
- **xterm.js:** Full terminal emulator with web links
- **Fit addon:** Auto-resize on window change

### IPC Flow

1. User clicks "New Session" → renderer calls `terminal:spawn(id, shell)`
2. Main spawns node-pty → forwards data to renderer via IPC
3. User types → renderer calls `terminal:write(id, data)` → main writes to PTY
4. User closes tab → renderer calls `terminal:kill(id)` → main kills PTY

> **Checkpoint:** Terminal tab opens xterm.js. Spawning a shell works. Commands execute.

---

## PHASE 9: DESIGN SYSTEM

### Colors

**Dark Theme:**
- Background: #0A0A10
- Surface: #111118
- Border: #1a1a2e
- Muted: #9B9BAA
- Primary Text: #FFFFFF

**Accent (fixed):**
- Accent: #585CF0
- Accent Light: #8286FF
- On Track: #22c55e
- Behind: #ef4444
- Review: #f59e0b

**Domain Palette:**
```typescript
const DOMAIN_COLORS = [
  '#f59e0b', '#22c55e', '#8286FF', '#ef4444',
  '#14B8A6', '#EC4899', '#F97316', '#6366F1',
  '#06B6D4', '#9B9BAA'
];
```

### Typography

- UI: Inter (300, 400, 500, 600, 700)
- Code: JetBrains Mono (400, 500)

### Components

- Tags/Badges: 10px, pill shape, 10% opacity background
- Progress Ring: SVG with stroke-dasharray
- Modal: backdrop blur, z-index 50
- Panel Slide-in: CSS transform, 200ms ease-out

> **Checkpoint:** All views use consistent design. Theme toggle works.

---

## PHASE 10: MCP SERVER

### Tools (24+ tools)

**Read Tools:**
1. `get_task_context` - Full context for a task (~8K tokens)
2. `get_task_summary` - Slim summary (~500 tokens)
3. `get_project_status` - Project metadata + progress
4. `get_milestone_overview` - Milestone details
5. `list_tasks` - Filtered task list
6. `get_task_history` - Log entries for task
7. `list_agents` - All agents with stats
8. `get_activity_feed` - Paginated log entries
9. `get_lessons_learned` - Past rejections for a task

**Write Tools (Task):**
10. `start_task` - Begin work
11. `complete_task` - Submit for review
12. `approve_task` - Move to DONE
13. `reject_task` - Return to IN_PROGRESS
14. `reset_task` - Clear all state
15. `block_task` - Mark blocked
16. `unblock_task` - Clear block
17. `update_task` - Update fields
18. `log_action` - Add log entry
19. `enrich_task` - Add prompt/criteria/docs

**Write Tools (Milestone):**
20. `add_milestone_note`
21. `set_milestone_dates`
22. `update_drift`
23. `create_milestone`
24. `add_milestone_task`

**Write Tools (Agent):**
25. `register_agent` - Add/update agent

### MCP Configuration

```json
{
  "command-center": {
    "command": "command-center-mcp",
    "env": {
      "PROJECT_ROOT": "/absolute/path/to/project"
    }
  }
}
```

> **Checkpoint:** MCP server installed globally. `get-project-status` returns valid response.

---

## PHASE 11: OPERATOR CLI & SUB-AGENT PIPELINE

### Operator Commands

```bash
command-center prepare --id TASK-001   # Run prepare pipeline
command-center start --id TASK-001     # Start task execution
command-center audit --id TASK-001     # Run post-build audit
command-center status                  # Project status
command-center agents                  # List agents
command-center log --task TASK-001     # Task history
```

### Prepare Pipeline

When operator runs `prepare --id TASK-001`:

1. **Research Explorer** (`research_explorer`)
   - Scans codebase for relevant files
   - Outputs: file paths + patterns + gaps
   - Must call: `log_action(task_id, "exploration_complete", summary)`

2. **Token Compressor** (`token_compressor`)
   - Compresses explorer output to ~500 tokens
   - Removes redundant detail

3. **Prompt Optimizer** (`prompt_optimizer`)
   - Crafts final prompt from compressed research
   - Incorporates `LESSONS_LEARNED.md` for similar past tasks

4. **Output:** `.claude/TASK_CONTEXT.md` with:
   - Task description
   - Acceptance criteria
   - Context files
   - Reference docs
   - Constraints
   - Relevant lessons from past rejections

### Start Pipeline

When operator runs `start --id TASK-001`:

1. `start_task(task_id)` → status = 'in_progress'
2. Dispatch assigned agent with `TASK_CONTEXT.md`
3. Agent executes work
4. Agent runs build/typecheck/lint
5. If pass → `complete_task(task_id, summary)`

### Audit Pipeline

When operator runs `audit --id TASK-001`:

1. **Code Quality Auditor** (`code_quality`)
   - Run linters
   - Check code patterns
   - Fix issues

2. **Security Auditor** (`security_auditor`)
   - Scan for vulnerabilities
   - Check for hardcoded secrets

3. **Final Validator** (`final_validator`)
   - Verify acceptance criteria met
   - Output: PASS | FAIL

> **Checkpoint:** Operator CLI commands work. Pipeline executes sub-agents.

---

## PHASE 12: SELF-IMPROVING MEMORY

### LESSONS_LEARNED.md

Location: `{PROJECT_ROOT}/.claude/LESSONS_LEARNED.md`

Format:
```markdown
# Lessons Learned

## TASK-001 Rejection (2026-01-15)

**Rejection Reason:**
The modal didn't close on backdrop click.

**Fix Applied:**
Added onClick handler to backdrop div with e.target === e.currentTarget check.

**Prevention:**
Always test modal dismiss behavior in acceptance criteria.
```

### Memory Write-Back

On `reject_task`:
1. Insert into `lessons_learned` table
2. Append to `.claude/LESSONS_LEARNED.md`

On `enrich_task` (prepare phase):
1. Query `lessons_learned` for similar task patterns
2. Include relevant lessons in context

### Memory Retrieval

```typescript
function getRelevantLessons(taskLabel: string): string[] {
  const lessons = query(`
    SELECT * FROM lessons_learned 
    WHERE rejection_reason LIKE ?
    ORDER BY created_at DESC LIMIT 5
  `, [`%${taskLabel}%`]);
  
  return lessons.map(l => `- ${l.rejection_reason}: ${l.fix_applied}`);
}
```

> **Checkpoint:** Rejected tasks add to memory. Prepare phase retrieves relevant lessons.

---

## PHASE 13: WEBHOOK INTEGRATION

### External Events

The webhook server (`:38120`) can receive:

| Endpoint | Payload | Action |
|----------|---------|--------|
| `POST /webhook/task-update` | `{task_id, status, completed_at, completed_by}` | Update task status |
| `POST /webhook/milestone-update` | `{milestone_id, actual_end}` | Update milestone |
| `POST /webhook/agent-action` | `{agent_id, action, target_id, description}` | Log agent action |
| `GET /webhook/status` | - | Server status |

### Integration Examples

**n8n workflow:**
- On GitHub PR merge → call `/webhook/task-update` to mark task done
- On Linear state change → call `/webhook/task-update`

**Git hooks:**
- Post-commit hook → call `/webhook/agent-action`

> **Checkpoint:** Webhook endpoints respond. External POST updates DB.

---

## TASK LIFECYCLE STATE MACHINE

```
                    ┌──────────┐
                    │   TODO   │
                    └────┬─────┘
                         │ start_task()
                    ┌────▼─────┐         block_task()    ┌──────────┐
                    │IN PROGRESS├───────────────────────►│ BLOCKED  │
                    └────┬─────┘                         └────┬─────┘
                         │ complete_task()                     │ unblock_task()
                    ┌────▼─────┐                              │
           ┌────────┤  REVIEW  │◄─────────────────────────────┘
           │        └────┬─────┘         (returns to previous state)
           │             │ approve_task()
           │        ┌────▼─────┐
           │        │   DONE   │
           │        └──────────┘
           │ reject_task()
           │
           └──► back to IN PROGRESS
```

### State Transitions

| Current | Trigger | Next |
|---------|---------|------|
| todo | prepare pipeline | todo (enriched) |
| todo | start_task() | in_progress |
| in_progress | complete_task() | review |
| review | reject_task() | in_progress |
| review | approve_task() | done |
| any | block_task() | blocked |
| blocked | unblock_task() | todo/in_progress |

---

## POST-BUILD: HYDRATION NOTICE

After all phases complete, the implementing agent should tell the user:

---

**The Command Center is built and running.**

All five views render with empty states:
- **Swim Lane** — Week grid with NOW marker, empty domain lanes
- **Task Board** — 5-column Kanban with milestone carousel, no cards
- **Agent Hub** — Connected Agents panel, Activity Feed, Context Injection
- **Calendar** — Week grid with day headers, no completed tasks
- **Terminal** — xterm.js ready to spawn sessions

The MCP server is operational. All 25 tools respond correctly.
The webhook server is running on localhost:38120.
The operator CLI is ready.

**To populate the command center with your project data, provide:**

1. **Your project manifesto** — Product vision, domains, workflows, principles
2. **Your project roadmap** — Timeline with phases, milestones, deliverables, dependencies

I will extract your domains → create swim lane lanes with colors.
I will extract your phases → create schedule phases.
I will extract your milestones → create milestones with planned dates.
I will extract your deliverables → create subtasks.
I will register your agent roster → add agents with source model bindings.

After hydration, all five views will be populated and the task workflow will be ready for use.