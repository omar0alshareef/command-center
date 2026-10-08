import type {
  AgentLogEntry,
  Lesson,
  Milestone,
  NewTask,
  Task,
  TaskHistory,
  TaskPatch,
  TrackerState,
  TransitionPayload,
  Trigger,
} from '@command-center/core';

// The whole renderer <-> main contract. Named, typed methods only: the renderer never sends SQL (D2).
export const CH = {
  getAll: 'db:getAll',
  projectGet: 'project:get',
  projectChoose: 'project:choose',
  projectRetry: 'project:retry',
  taskTransition: 'tasks:transition',
  taskUpdate: 'tasks:update',
  taskCreate: 'tasks:create',
  taskHistory: 'tasks:history',
  taskContext: 'tasks:context',
  milestoneNote: 'milestones:note',
  milestoneDates: 'milestones:dates',
  activityOlder: 'activity:older',
  lessonUpdate: 'lessons:update',
  lessonRemove: 'lessons:remove',
  termShells: 'terminal:shells',
  termCreate: 'terminal:create',
  termWrite: 'terminal:write',
  termResize: 'terminal:resize',
  termKill: 'terminal:kill',
  webhookStatus: 'webhook:status',
  webhookRegenerate: 'webhook:regenerate',
  termData: 'terminal:data',
  termExit: 'terminal:exit',
  dbChanged: 'db:changed',
  dbStatus: 'db:status',
} as const;

/** How an agent launches the MCP server: the built bundle if present, else the global command. */
export interface McpLaunch {
  command: string;
  args: string[];
  /** Extra environment for the server process (packaged installs run it with Electron as plain node). */
  env?: Record<string, string>;
  /** True when the bundled server file was found next to the app; false means a global install is assumed. */
  bundled: boolean;
}

export interface ProjectInfo {
  root: string | null;
  dbPath: string | null;
  /** Set when the DB could not be opened (missing, locked, corrupt). */
  error: string | null;
  appVersion: string;
  mcp: McpLaunch;
}

export interface WebhookStatus {
  port: number;
  running: boolean;
  error: string | null;
  /** Bearer token; null while no project is open. */
  token: string | null;
}

export type SyncStatus = { state: 'live' } | { state: 'disconnected'; error: string };

/**
 * Mutations return a Result instead of throwing: errors thrown across Electron IPC lose their class
 * and code. `code` is a CoreError code (ILLEGAL_TRANSITION, REASON_REQUIRED, ...) or INVALID_INPUT.
 */
export type Result<T> =
  { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

/** The renderer is always the human operator, so `actor` is not accepted from it. */
export type RendererTransitionPayload = Omit<TransitionPayload, 'actor'>;

export interface TransitionRequest {
  taskId: string;
  trigger: Trigger;
  payload?: RendererTransitionPayload;
}

export interface ShellInfo {
  id: string;
  name: string;
}

export interface TerminalSessionInfo {
  id: string;
  pid: number;
  shellId: string;
  name: string;
  cwd: string;
}

export interface Api {
  platform: string;
  project: {
    get(): Promise<ProjectInfo>;
    /** Opens a folder picker, then opens (creating if needed) the project DB there. */
    choose(): Promise<ProjectInfo>;
    retry(): Promise<ProjectInfo>;
  };
  db: {
    getAll(): Promise<TrackerState>;
  };
  tasks: {
    transition(req: TransitionRequest): Promise<Result<Task>>;
    update(req: { taskId: string; patch: TaskPatch }): Promise<Result<Task>>;
    create(req: NewTask): Promise<Result<Task>>;
    history(taskId: string): Promise<Result<TaskHistory>>;
    /** Rendered TASK_CONTEXT.md for the task, or null if it does not exist. */
    contextMd(taskId: string): Promise<Result<string | null>>;
  };
  milestones: {
    addNote(req: { milestoneId: string; text: string }): Promise<Result<Milestone>>;
    /** Any of planned_start / planned_end / actual_start / actual_end as YYYY-MM-DD, or null to clear. */
    setDates(req: {
      milestoneId: string;
      dates: Record<string, string | null>;
    }): Promise<Result<Milestone>>;
  };
  activity: {
    /** Log rows older than `before` (newest first), optionally for one agent. Read-only. */
    older(req: {
      before: { id: string; timestamp: string };
      agentId?: string;
      limit?: number;
    }): Promise<Result<AgentLogEntry[]>>;
  };
  lessons: {
    update(req: {
      id: number;
      patch: { rejection_reason?: string; fix_applied?: string; prevention?: string };
    }): Promise<Result<Lesson>>;
    remove(id: number): Promise<Result<null>>;
  };
  terminal: {
    shells(): Promise<ShellInfo[]>;
    create(req: {
      shellId?: string;
      cols: number;
      rows: number;
    }): Promise<Result<TerminalSessionInfo>>;
    /** Fire-and-forget: keystrokes must not wait for a round trip. */
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    kill(id: string): Promise<void>;
    onData(cb: (e: { id: string; data: string }) => void): () => void;
    onExit(cb: (e: { id: string; exitCode: number }) => void): () => void;
  };
  webhook: {
    status(): Promise<WebhookStatus>;
    /** Replaces the token; the old one stops working immediately. */
    regenerate(): Promise<Result<WebhookStatus>>;
  };
  onDbChanged(cb: () => void): () => void;
  onDbStatus(cb: (status: SyncStatus) => void): () => void;
}
