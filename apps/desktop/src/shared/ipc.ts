import type {
  AgentLogEntry,
  Lesson,
  Agent,
  Milestone,
  ModelOption,
  NewTask,
  OrchestratorConfig,
  OrchestratorStatus,
  PlanCounts,
  PlannerStage,
  PlanningDocument,
  PlanningKind,
  PlanningSession,
  PlanningSessionDetail,
  Proposal,
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
  taskDelete: 'tasks:delete',
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
  modelsSet: 'models:set',
  agentSetModel: 'agents:setModel',
  agentSetProvider: 'agents:setProvider',
  agentSetConcurrency: 'agents:setConcurrency',
  orchStatus: 'orchestrator:status',
  orchResume: 'orchestrator:resume',
  orchPause: 'orchestrator:pause',
  orchStopAfter: 'orchestrator:stopAfterCurrent',
  orchStart: 'orchestrator:start',
  orchCancelRun: 'orchestrator:cancelRun',
  orchConfig: 'orchestrator:setConfig',
  orchEvent: 'orchestrator:event',
  provList: 'providers:list',
  provSetKey: 'providers:setKey',
  provSetUrl: 'providers:setBaseUrl',
  provTest: 'providers:test',
  provModels: 'providers:models',
  planList: 'planning:list',
  planGet: 'planning:get',
  planCreate: 'planning:create',
  planAnswer: 'planning:answer',
  planSaveDoc: 'planning:saveDocument',
  planSaveProposal: 'planning:saveProposal',
  planValidate: 'planning:validate',
  planAbandon: 'planning:abandon',
  planApprove: 'planning:approve',
  planInterview: 'planning:interview',
  planDraft: 'planning:draft',
  planCancel: 'planning:cancel',
  planApprovedDocs: 'planning:approvedDocuments',
  planSettings: 'planning:settings',
  planSetSettings: 'planning:setSettings',
  planEvent: 'planning:event',
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

/** Streamed from the planner run (D18): stage changes, output chunks, notices, end of run. */
export type PlannerEvent =
  | { sessionId: string; type: 'stage'; stage: PlannerStage }
  | { sessionId: string; type: 'chunk'; stage: PlannerStage; text: string }
  | { sessionId: string; type: 'notice'; stage: PlannerStage; text: string }
  | { sessionId: string; type: 'done' }
  | { sessionId: string; type: 'error'; text: string };

/** The orchestrator's state plus its limits, as the status bar and Settings show them. */
export type OrchestratorView = OrchestratorStatus & { config: OrchestratorConfig };

/** One provider as Settings → Providers shows it. The key itself never crosses to the renderer. */
export interface ProviderInfo {
  id: string;
  label: string;
  kind: 'cli' | 'api' | 'local';
  needsKey: boolean;
  /** Gemini can use its CLI instead of a key. */
  keyOptional: boolean;
  defaultModel: string | null;
  available: boolean;
  detail: string;
  keySet: boolean;
  keySuffix: string | null;
  baseUrl: string | null;
  encrypted: boolean;
}

/** What the renderer may know about the planner runner: never the key itself (D19). */
export interface PlannerSettings {
  runner: 'claude-code' | 'anthropic-api';
  model: string | null;
  keySet: boolean;
  keySuffix: string | null;
  claudeFound: boolean;
  encrypted: boolean;
}

export type PlanningView = PlanningSessionDetail & { running: PlannerStage | null };

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
    delete(taskId: string): Promise<Result<Task>>;
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
  models: {
    /** Replace one provider's editable model list (settings). */
    setList(req: { provider: string; list: ModelOption[] }): Promise<Result<ModelOption[]>>;
    /** Set an agent's model (null = the provider's default). Logged in the activity feed. */
    setAgentModel(req: { agentId: string; model: string | null }): Promise<Result<Agent>>;
  };
  agents: {
    /** Route an agent to a provider (null = Claude Code). Clears its model. */
    setProvider(req: { agentId: string; provider: string | null }): Promise<Result<Agent>>;
    setConcurrency(req: { agentId: string; max: number }): Promise<Result<Agent>>;
  };
  orchestrator: {
    status(): Promise<Result<OrchestratorView | null>>;
    resume(): Promise<Result<OrchestratorView | null>>;
    /** Pause dispatch; `cancelRunning` also ends the runs in flight. */
    pause(req: { cancelRunning: boolean }): Promise<Result<OrchestratorView | null>>;
    stopAfterCurrent(): Promise<Result<OrchestratorView | null>>;
    /** The manual Start button: same dispatch path as the loop. */
    start(req: { taskId: string; force?: boolean }): Promise<Result<{ runId: string }>>;
    cancelRun(runId: string): Promise<Result<null>>;
    setConfig(patch: Partial<OrchestratorConfig>): Promise<Result<OrchestratorView | null>>;
    onStatus(cb: (v: OrchestratorView) => void): () => void;
  };
  providers: {
    list(refresh?: boolean): Promise<Result<ProviderInfo[]>>;
    /** Store a key (encrypted); null removes it. The key is never sent back. */
    setKey(req: { id: string; key: string | null }): Promise<Result<ProviderInfo>>;
    setBaseUrl(req: { id: string; url: string | null }): Promise<Result<ProviderInfo>>;
    test(id: string): Promise<Result<{ ok: boolean; detail: string }>>;
    /** The models an agent on this provider can pick: the editable list, or what a local server reports. */
    models(id: string): Promise<Result<ModelOption[]>>;
  };
  planning: {
    list(): Promise<Result<PlanningSession[]>>;
    get(id: string): Promise<Result<PlanningView>>;
    /** Creates the session and starts the first interview round. */
    create(req: { idea: string; title?: string }): Promise<Result<PlanningSession>>;
    answer(req: { id: string; index: number; answer: string }): Promise<Result<PlanningSession>>;
    saveDocument(req: {
      id: string;
      kind: PlanningKind;
      content: string;
    }): Promise<Result<PlanningDocument>>;
    saveProposal(req: { id: string; proposal: Proposal }): Promise<Result<Proposal>>;
    /** Problems that would block approval, each naming the item. */
    validate(id: string): Promise<Result<string[]>>;
    abandon(id: string): Promise<Result<PlanningSession>>;
    /** The only call that writes a plan to the board (D15). */
    approve(id: string): Promise<Result<PlanCounts>>;
    /** Start a run; progress arrives through onEvent. */
    interview(id: string): Promise<Result<null>>;
    draft(id: string): Promise<Result<null>>;
    cancel(id: string): Promise<Result<null>>;
    approvedDocuments(): Promise<Result<PlanningDocument[]>>;
    settings(): Promise<Result<PlannerSettings>>;
    setSettings(req: {
      runner?: PlannerSettings['runner'];
      model?: string | null;
      apiKey?: string | null;
    }): Promise<Result<null>>;
    onEvent(cb: (e: PlannerEvent) => void): () => void;
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
