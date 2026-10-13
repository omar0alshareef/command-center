// M14: routing and runs. An agent has a provider (NULL = claude-code) and a per-agent concurrency limit; a task can
// override its agent's provider; every provider call is one row in `runs`. Provider keys and the orchestrator
// caps live in `settings` (keys encrypted by the app, D25).
export const sql008 = `
ALTER TABLE agents ADD COLUMN provider TEXT;
ALTER TABLE agents ADD COLUMN max_concurrent INTEGER NOT NULL DEFAULT 1;
ALTER TABLE subtasks ADD COLUMN provider_override TEXT;

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  kind TEXT NOT NULL DEFAULT 'work' CHECK(kind IN ('work','review')),
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  exit_code INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  est_cost_usd REAL,
  cost_basis TEXT CHECK(cost_basis IN ('reported','estimate')),
  error TEXT,
  output_tail TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (task_id) REFERENCES subtasks(id),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);
CREATE INDEX idx_runs_task ON runs(task_id);
CREATE INDEX idx_runs_status ON runs(status);
CREATE INDEX idx_runs_started ON runs(started_at);
`;
