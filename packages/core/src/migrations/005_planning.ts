// M13 Planning Workspace. Drafts live here, never on the board, until the operator approves (D15).
// Tasks gain an optional deadline (D16). ROADMAP calls this "migration 003"; 003/004 were already taken.
export const sql005 = `
ALTER TABLE subtasks ADD COLUMN due_date TEXT;

CREATE TABLE planning_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  idea TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'interviewing'
    CHECK(status IN ('interviewing','drafting','review','approved','abandoned')),
  requirements TEXT NOT NULL DEFAULT '[]',
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE planning_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('manifesto','roadmap')),
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','superseded')),
  created_at TEXT NOT NULL,
  approved_at TEXT,
  FOREIGN KEY (session_id) REFERENCES planning_sessions(id)
);
CREATE INDEX idx_planning_documents_session ON planning_documents(session_id, kind);

CREATE TABLE planning_proposals (
  session_id TEXT PRIMARY KEY,
  proposal TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES planning_sessions(id)
);
`;
