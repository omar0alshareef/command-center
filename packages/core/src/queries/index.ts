import { randomUUID } from 'node:crypto';
import { nowIso, write, type Db } from '../db';
import {
  AgentLogSchema,
  AgentSchema,
  LessonSchema,
  MilestoneSchema,
  PhaseSchema,
  ProjectSchema,
  TaskSchema,
  toJson,
  type Agent,
  type AgentLogEntry,
  type Lesson,
  type Milestone,
  type Phase,
  type Project,
  type Task,
  type TaskStatus,
  type TrackerState,
} from '../types';

export const ACTIVITY_FEED_DEFAULT_LIMIT = 500;

export function getProject(db: Db): Project {
  return ProjectSchema.parse(db.prepare('SELECT * FROM project WHERE id = 1').get());
}

export function listMilestones(db: Db): Milestone[] {
  return MilestoneSchema.array().parse(
    db.prepare('SELECT * FROM milestones ORDER BY week, id').all(),
  );
}

export function getMilestone(db: Db, id: string): Milestone | null {
  const row = db.prepare('SELECT * FROM milestones WHERE id = ?').get(id);
  return row ? MilestoneSchema.parse(row) : null;
}

export function getTask(db: Db, id: string): Task | null {
  const row = db.prepare('SELECT * FROM subtasks WHERE id = ?').get(id);
  return row ? TaskSchema.parse(row) : null;
}

export interface TaskFilters {
  milestoneId?: string;
  status?: TaskStatus | TaskStatus[];
  assignee?: string;
  priority?: string;
  /** Matches id or label, case-insensitive. */
  search?: string;
}

export function listTasks(db: Db, f: TaskFilters = {}): Task[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.milestoneId) {
    where.push('milestone_id = ?');
    params.push(f.milestoneId);
  }
  if (f.status) {
    const statuses = Array.isArray(f.status) ? f.status : [f.status];
    where.push(`status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (f.assignee) {
    where.push('assignee = ?');
    params.push(f.assignee);
  }
  if (f.priority) {
    where.push('priority = ?');
    params.push(f.priority);
  }
  if (f.search) {
    where.push('(id LIKE ? OR label LIKE ?)');
    params.push(`%${f.search}%`, `%${f.search}%`);
  }
  const sql = `SELECT * FROM subtasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY milestone_id, id`;
  return TaskSchema.array().parse(db.prepare(sql).all(...params));
}

export function listAgents(db: Db): Agent[] {
  return AgentSchema.array().parse(
    db.prepare('SELECT * FROM agents ORDER BY created_at, id').all(),
  );
}

export function listPhases(db: Db): Phase[] {
  return PhaseSchema.array().parse(db.prepare('SELECT * FROM phases ORDER BY start_week').all());
}

export function listLessons(db: Db): Lesson[] {
  return LessonSchema.array().parse(
    db.prepare('SELECT * FROM lessons_learned ORDER BY created_at DESC, id DESC').all(),
  );
}

export interface FeedCursor {
  timestamp: string;
  id: string;
}

export interface ActivityFeedOptions {
  limit?: number;
  /** Return entries strictly older than this cursor (the last row of the previous page). */
  before?: FeedCursor;
  agentId?: string;
}

export function getActivityFeed(db: Db, o: ActivityFeedOptions = {}): AgentLogEntry[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (o.before) {
    where.push('(timestamp, id) < (?, ?)');
    params.push(o.before.timestamp, o.before.id);
  }
  if (o.agentId) {
    where.push('agent_id = ?');
    params.push(o.agentId);
  }
  const sql = `SELECT * FROM agent_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY timestamp DESC, id DESC LIMIT ?`;
  params.push(o.limit ?? ACTIVITY_FEED_DEFAULT_LIMIT);
  return AgentLogSchema.array().parse(db.prepare(sql).all(...params));
}

export function getAllTrackerState(db: Db): TrackerState {
  return {
    project: getProject(db),
    milestones: listMilestones(db),
    subtasks: listTasks(db),
    agents: listAgents(db),
    agent_log: getActivityFeed(db),
    phases: listPhases(db),
    lessons_learned: listLessons(db),
  };
}

export interface LogActionInput {
  agentId: string;
  action: string;
  targetType?: string;
  targetId?: string;
  description?: string;
  tags?: string[];
  /** ISO timestamp; defaults to now. Seeding and tests override it. */
  at?: string;
}

/** Append an agent_log row and bump the agent's activity counters. The agent must be registered. */
export function logAction(db: Db, input: LogActionInput): string {
  const id = randomUUID();
  const at = input.at ?? nowIso();
  write(db, () => {
    db.prepare(
      `INSERT INTO agent_log (id, agent_id, action, target_type, target_id, description, timestamp, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.agentId,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      input.description ?? null,
      at,
      toJson(input.tags ?? []),
    );
    db.prepare(
      'UPDATE agents SET last_action_at = ?, session_action_count = session_action_count + 1 WHERE id = ?',
    ).run(at, input.agentId);
  });
  return id;
}
