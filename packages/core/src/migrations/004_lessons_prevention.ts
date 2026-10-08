// M10: a lesson also records how to prevent the mistake (blueprint Phase 12 format), and that text is
// searchable. FTS5 columns cannot be altered, so the index and its triggers are rebuilt over three columns.
export const sql004 = `
ALTER TABLE lessons_learned ADD COLUMN prevention TEXT NOT NULL DEFAULT '';

DROP TRIGGER lessons_ai;
DROP TRIGGER lessons_ad;
DROP TRIGGER lessons_au;
DROP TABLE lessons_fts;

CREATE VIRTUAL TABLE lessons_fts USING fts5(
  rejection_reason,
  fix_applied,
  prevention,
  content='lessons_learned',
  content_rowid='id'
);

CREATE TRIGGER lessons_ai AFTER INSERT ON lessons_learned BEGIN
  INSERT INTO lessons_fts(rowid, rejection_reason, fix_applied, prevention)
  VALUES (new.id, new.rejection_reason, new.fix_applied, new.prevention);
END;

CREATE TRIGGER lessons_ad AFTER DELETE ON lessons_learned BEGIN
  INSERT INTO lessons_fts(lessons_fts, rowid, rejection_reason, fix_applied, prevention)
  VALUES ('delete', old.id, old.rejection_reason, old.fix_applied, old.prevention);
END;

CREATE TRIGGER lessons_au AFTER UPDATE ON lessons_learned BEGIN
  INSERT INTO lessons_fts(lessons_fts, rowid, rejection_reason, fix_applied, prevention)
  VALUES ('delete', old.id, old.rejection_reason, old.fix_applied, old.prevention);
  INSERT INTO lessons_fts(rowid, rejection_reason, fix_applied, prevention)
  VALUES (new.id, new.rejection_reason, new.fix_applied, new.prevention);
END;

INSERT INTO lessons_fts(lessons_fts) VALUES ('rebuild');
`;
