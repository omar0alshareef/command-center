// ROADMAP D5 (blocked_from), D6 (settings for the webhook token), D7 (FTS5 for lessons).
// schema_version itself is bootstrapped by the runner (it must exist before any migration runs).
export const sql002 = `
ALTER TABLE subtasks ADD COLUMN blocked_from TEXT;

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE VIRTUAL TABLE lessons_fts USING fts5(
  rejection_reason,
  fix_applied,
  content='lessons_learned',
  content_rowid='id'
);

CREATE TRIGGER lessons_ai AFTER INSERT ON lessons_learned BEGIN
  INSERT INTO lessons_fts(rowid, rejection_reason, fix_applied)
  VALUES (new.id, new.rejection_reason, new.fix_applied);
END;

CREATE TRIGGER lessons_ad AFTER DELETE ON lessons_learned BEGIN
  INSERT INTO lessons_fts(lessons_fts, rowid, rejection_reason, fix_applied)
  VALUES ('delete', old.id, old.rejection_reason, old.fix_applied);
END;

CREATE TRIGGER lessons_au AFTER UPDATE ON lessons_learned BEGIN
  INSERT INTO lessons_fts(lessons_fts, rowid, rejection_reason, fix_applied)
  VALUES ('delete', old.id, old.rejection_reason, old.fix_applied);
  INSERT INTO lessons_fts(rowid, rejection_reason, fix_applied)
  VALUES (new.id, new.rejection_reason, new.fix_applied);
END;

-- Built-in actors so transitions made by the human or the system always have a valid agent_log FK.
INSERT INTO agents (id, name, type, color) VALUES
  ('operator', 'Operator', 'human', '#585CF0'),
  ('system', 'System', 'external', '#9B9BAA');
`;
