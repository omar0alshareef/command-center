// Blueprint Phase 1 schema, verbatim, plus the seed project row.
export const sql001 = `
CREATE TABLE project (
  id INTEGER PRIMARY KEY DEFAULT 1,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  target_date TEXT NOT NULL,
  schedule_status TEXT DEFAULT 'on_track',
  overall_progress REAL DEFAULT 0
);

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
  dependencies TEXT DEFAULT '[]',
  notes TEXT DEFAULT '[]',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

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
  context_files TEXT DEFAULT '[]',
  reference_docs TEXT DEFAULT '[]',
  acceptance_criteria TEXT DEFAULT '[]',
  constraints TEXT DEFAULT '[]',
  agent_target TEXT,
  execution_mode TEXT DEFAULT 'agent',
  depends_on TEXT DEFAULT '[]',
  last_run_id TEXT,
  builder_prompt TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (milestone_id) REFERENCES milestones(id)
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('orchestrator','sub-agent','human','external')),
  parent_id TEXT,
  color TEXT DEFAULT '#9B9BAA',
  status TEXT DEFAULT 'idle',
  permissions TEXT DEFAULT '[]',
  last_action_at TEXT,
  session_action_count INTEGER DEFAULT 0,
  source_model TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (parent_id) REFERENCES agents(id)
);

CREATE TABLE agent_log (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  description TEXT,
  timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
  tags TEXT DEFAULT '[]',
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE TABLE phases (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  start_week INTEGER NOT NULL,
  end_week INTEGER NOT NULL,
  color TEXT DEFAULT '#585CF0'
);

CREATE TABLE lessons_learned (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subtask_id TEXT NOT NULL,
  rejection_reason TEXT NOT NULL,
  fix_applied TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (subtask_id) REFERENCES subtasks(id)
);

CREATE INDEX idx_subtasks_milestone ON subtasks(milestone_id);
CREATE INDEX idx_subtasks_status ON subtasks(status);
CREATE INDEX idx_agent_log_agent ON agent_log(agent_id);
CREATE INDEX idx_agent_log_timestamp ON agent_log(timestamp DESC);

INSERT INTO project (id, name, start_date, target_date)
VALUES (1, 'My Project', '2026-01-01', '2026-06-30');
`;
