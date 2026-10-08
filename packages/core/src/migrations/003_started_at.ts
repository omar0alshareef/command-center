// The Task Board's in-progress card shows elapsed time since the task started (UI/UX §6.2),
// which last_run_id alone cannot give. Backfill from updated_at for tasks already past `todo`.
// The target_id index serves the per-task History tab.
export const sql003 = `
ALTER TABLE subtasks ADD COLUMN started_at TEXT;
UPDATE subtasks SET started_at = updated_at WHERE status IN ('in_progress', 'review', 'done');
CREATE INDEX idx_agent_log_target ON agent_log(target_id);
`;
