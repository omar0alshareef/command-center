// M15: lessons get a scope, keywords, a prevention check, a recurrence counter and a status (D37-D40). Only `project`
// scope lessons live in a project's database; agent and global lessons live in the app-wide library (a second database),
// where every project can read them, and the project row records where it was promoted to. The FTS index is rebuilt over
// the new trigger_keywords column, as in 004. Runs also record which prompt layers, spec hash and lessons they got.
export const sql009 = `
ALTER TABLE lessons_learned ADD COLUMN scope TEXT NOT NULL DEFAULT 'project' CHECK(scope IN ('project','agent','global'));
ALTER TABLE lessons_learned ADD COLUMN agent_id TEXT;
ALTER TABLE lessons_learned ADD COLUMN trigger_keywords TEXT NOT NULL DEFAULT '';
ALTER TABLE lessons_learned ADD COLUMN check_text TEXT NOT NULL DEFAULT '';
ALTER TABLE lessons_learned ADD COLUMN check_type TEXT NOT NULL DEFAULT 'none' CHECK(check_type IN ('automatic','manual','none'));
ALTER TABLE lessons_learned ADD COLUMN occurrences INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lessons_learned ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft','active','needs_rewrite','retired'));
ALTER TABLE lessons_learned ADD COLUMN updated_at TEXT;
ALTER TABLE lessons_learned ADD COLUMN promoted_to TEXT;
ALTER TABLE lessons_learned ADD COLUMN project_id TEXT;
UPDATE lessons_learned SET updated_at = created_at WHERE updated_at IS NULL;

DROP TRIGGER lessons_ai;
DROP TRIGGER lessons_ad;
DROP TRIGGER lessons_au;
DROP TABLE lessons_fts;

CREATE VIRTUAL TABLE lessons_fts USING fts5(
  rejection_reason,
  fix_applied,
  prevention,
  trigger_keywords,
  content='lessons_learned',
  content_rowid='id'
);

CREATE TRIGGER lessons_ai AFTER INSERT ON lessons_learned BEGIN
  INSERT INTO lessons_fts(rowid, rejection_reason, fix_applied, prevention, trigger_keywords)
  VALUES (new.id, new.rejection_reason, new.fix_applied, new.prevention, new.trigger_keywords);
END;

CREATE TRIGGER lessons_ad AFTER DELETE ON lessons_learned BEGIN
  INSERT INTO lessons_fts(lessons_fts, rowid, rejection_reason, fix_applied, prevention, trigger_keywords)
  VALUES ('delete', old.id, old.rejection_reason, old.fix_applied, old.prevention, old.trigger_keywords);
END;

CREATE TRIGGER lessons_au AFTER UPDATE ON lessons_learned BEGIN
  INSERT INTO lessons_fts(lessons_fts, rowid, rejection_reason, fix_applied, prevention, trigger_keywords)
  VALUES ('delete', old.id, old.rejection_reason, old.fix_applied, old.prevention, old.trigger_keywords);
  INSERT INTO lessons_fts(rowid, rejection_reason, fix_applied, prevention, trigger_keywords)
  VALUES (new.id, new.rejection_reason, new.fix_applied, new.prevention, new.trigger_keywords);
END;

INSERT INTO lessons_fts(lessons_fts) VALUES ('rebuild');

-- Which library agents a project uses, with the project's own settings for them (D33). Removing an agent keeps the row
-- (removed_at) so adding it back restores its settings; the library agent itself is never touched.
CREATE TABLE project_agents (
  library_agent_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  allowed_task_types TEXT NOT NULL DEFAULT '[]',
  extra_constraints TEXT NOT NULL DEFAULT '[]',
  assigned_at TEXT NOT NULL,
  removed_at TEXT
);

-- What each run was built from (D34, D38): the prompt layers, the spec file hash, and the lessons injected.
ALTER TABLE runs ADD COLUMN layers TEXT;
ALTER TABLE runs ADD COLUMN spec_hash TEXT;
ALTER TABLE runs ADD COLUMN spec_status TEXT;
ALTER TABLE runs ADD COLUMN lesson_ids TEXT;
`;
