import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db';
import { toJson, type TaskStatus } from '../src/types';

export function tmpDb(): { db: Db; root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'cc-core-'));
  const db = openDb(root);
  return {
    db,
    root,
    cleanup: () => {
      db.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

export interface TaskInit {
  label?: string;
  assignee?: string | null;
  depends_on?: string[];
  blocked_from?: TaskStatus | null;
}

export function addTask(
  db: Db,
  id: string,
  status: TaskStatus = 'todo',
  init: TaskInit = {},
): void {
  db.prepare("INSERT OR IGNORE INTO milestones (id, title) VALUES ('M0', 'Test milestone')").run();
  db.prepare(
    `INSERT INTO subtasks (id, milestone_id, label, status, done, assignee, depends_on, blocked_from)
     VALUES (?, 'M0', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    init.label ?? `Label of ${id}`,
    status,
    status === 'done' ? 1 : 0,
    init.assignee ?? null,
    toJson(init.depends_on ?? []),
    init.blocked_from ?? null,
  );
}
