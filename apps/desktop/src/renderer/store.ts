import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AgentLogEntry, Task, TrackerState } from '@command-center/core';
import type { ProjectInfo } from '../shared/ipc';
import { matchesFilter } from './lib/agent-hub';
import { mergeTracker } from './lib/share';

export type TabId = 'swim-lane' | 'task-board' | 'agent-hub' | 'calendar' | 'terminal';
export type Theme = 'dark' | 'light';

export interface SyncState {
  state: 'live' | 'syncing' | 'disconnected';
  lastSyncAt: number | null;
  error?: string;
}

interface AppState {
  project: ProjectInfo | null;
  tracker: TrackerState | null;
  loading: boolean;
  error: string | null;
  sync: SyncState;
  activeTab: TabId;
  selectedMilestoneId: string | null;
  /** Task shown in the detail modal (global: any view can open it). */
  openTaskId: string | null;
  /** Milestone shown in the 480px panel; selection (`selectedMilestoneId`) is separate and global. */
  openMilestoneId: string | null;
  /** One-shot request for the panel to start in a mode (set by the swim lane's context menu). */
  panelIntent: 'dates' | 'add-task' | null;
  /** One-shot request for the swim lane to scroll a milestone into view. */
  scrollToMilestoneId: string | null;
  theme: Theme;
  /** Agent Hub feed filter: 'all' | 'manual' | 'system' | an agent id. */
  hubFilter: string;
  /** Orchestrator ids whose sub-agents are collapsed in the Agent Hub tree (persisted). */
  hubCollapsed: string[];
  /** Log rows loaded beyond the 500 the tracker carries ("Load older"), newest first. */
  olderLog: AgentLogEntry[];
  /** Filters ('all' or an agent id) for which the log has no more older rows. */
  olderDone: string[];
  olderLoading: boolean;
  /** One-shot: the Task Board starts filtered to this assignee (Agent Hub "View tasks"). */
  boardAssignee: string | null;

  setHubFilter: (filter: string) => void;
  toggleHubCollapsed: (id: string) => void;
  loadOlder: () => Promise<void>;
  viewAgentTasks: (agentId: string) => void;
  clearBoardAssignee: () => void;
  setActiveTab: (tab: TabId) => void;
  setSelectedMilestoneId: (id: string | null) => void;
  setOpenTaskId: (id: string | null) => void;
  openMilestone: (id: string | null, intent?: 'dates' | 'add-task') => void;
  clearPanelIntent: () => void;
  scrollToMilestone: (id: string | null) => void;
  toggleTheme: () => void;
  setSync: (sync: Pick<SyncState, 'state' | 'error'>) => void;
  /** Optimistic local edit of one task; the server's answer replaces it. */
  patchTask: (id: string, patch: Partial<Task>) => void;
  replaceTask: (task: Task) => void;
  /** While held (mid-drag), refetches are deferred so nothing reorders under the cursor. */
  holdSync: () => void;
  releaseSync: () => void;
  init: () => Promise<void>;
  refresh: () => Promise<void>;
  chooseProject: () => Promise<void>;
  retryProject: () => Promise<void>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const mapTask = (
  t: TrackerState | null,
  id: string,
  fn: (task: Task) => Task,
): TrackerState | null =>
  t ? { ...t, subtasks: t.subtasks.map((s) => (s.id === id ? fn(s) : s)) } : t;

// Coalesce bursts: at most one fetch in flight, plus one queued re-run.
let inflight = false;
let queued = false;
let holds = 0;

export const useApp = create<AppState>()(
  persist(
    (set, get) => ({
      project: null,
      tracker: null,
      loading: true,
      error: null,
      sync: { state: 'live', lastSyncAt: null },
      activeTab: 'swim-lane',
      hubFilter: 'all',
      hubCollapsed: [],
      olderLog: [],
      olderDone: [],
      olderLoading: false,
      boardAssignee: null,
      setHubFilter: (hubFilter) => set({ hubFilter }),
      toggleHubCollapsed: (id) =>
        set((s) => ({
          hubCollapsed: s.hubCollapsed.includes(id)
            ? s.hubCollapsed.filter((x) => x !== id)
            : [...s.hubCollapsed, id],
        })),
      loadOlder: async () => {
        const s = get();
        const key = s.hubFilter;
        if (s.olderLoading || !s.tracker) return;
        // Page back from the oldest row we hold for this filter; agent filters query that agent only.
        const mine = (e: AgentLogEntry) => matchesFilter(e, key);
        const loaded = [...s.tracker.agent_log, ...s.olderLog].filter(mine);
        const oldest = loaded.reduce<AgentLogEntry | null>(
          (a, e) => (!a || e.timestamp < a.timestamp ? e : a),
          null,
        );
        if (!oldest) return;
        const agentId = key === 'all' ? undefined : key === 'manual' ? 'operator' : key;
        set({ olderLoading: true });
        const limit = 500;
        const res = await window.api.activity.older({
          before: { id: oldest.id, timestamp: oldest.timestamp },
          agentId,
          limit,
        });
        set((cur) => {
          if (!res.ok) return { olderLoading: false };
          const have = new Set([...cur.olderLog, ...(cur.tracker?.agent_log ?? [])].map((e) => e.id));
          const fresh = res.value.filter((e) => !have.has(e.id));
          return {
            olderLoading: false,
            olderLog: [...cur.olderLog, ...fresh],
            olderDone: res.value.length < limit ? [...cur.olderDone, key] : cur.olderDone,
          };
        });
      },
      viewAgentTasks: (agentId) => set({ boardAssignee: agentId, activeTab: 'task-board' }),
      clearBoardAssignee: () => set({ boardAssignee: null }),
      selectedMilestoneId: null,
      openTaskId: null,
      openMilestoneId: null,
      panelIntent: null,
      scrollToMilestoneId: null,
      theme: 'dark',

      setActiveTab: (activeTab) => set({ activeTab }),
      setSelectedMilestoneId: (selectedMilestoneId) => set({ selectedMilestoneId }),
      setOpenTaskId: (openTaskId) => set({ openTaskId }),
      openMilestone: (id, intent) =>
        set({
          openMilestoneId: id,
          panelIntent: id ? (intent ?? null) : null,
          ...(id ? { selectedMilestoneId: id } : {}),
        }),
      clearPanelIntent: () => set({ panelIntent: null }),
      scrollToMilestone: (scrollToMilestoneId) => set({ scrollToMilestoneId }),
      toggleTheme: () => set((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' })),
      setSync: (next) => set((s) => ({ sync: { ...s.sync, ...next } })),

      patchTask: (id, patch) =>
        set((s) => ({ tracker: mapTask(s.tracker, id, (t) => ({ ...t, ...patch })) })),
      replaceTask: (task) => set((s) => ({ tracker: mapTask(s.tracker, task.id, () => task) })),

      holdSync: () => {
        holds++;
      },
      releaseSync: () => {
        holds = Math.max(0, holds - 1);
        if (holds === 0 && queued) {
          queued = false;
          void get().refresh();
        }
      },

      init: async () => {
        try {
          const project = await window.api.project.get();
          set({ project });
          if (project.root && !project.error) await get().refresh();
          else set({ loading: false });
        } catch (e) {
          set({ loading: false, error: message(e) });
        }
      },

      refresh: async () => {
        if (inflight || holds > 0) {
          queued = true;
          return;
        }
        inflight = true;
        if (get().tracker) get().setSync({ state: 'syncing' });
        try {
          const fresh = await window.api.db.getAll();
          set((s) => ({
            tracker: s.tracker ? mergeTracker(s.tracker, fresh) : fresh,
            loading: false,
            error: null,
            sync: { state: 'live', lastSyncAt: Date.now() },
          }));
        } catch (e) {
          set((s) => ({
            loading: false,
            error: message(e),
            sync: { state: 'disconnected', lastSyncAt: s.sync.lastSyncAt, error: message(e) },
          }));
        } finally {
          inflight = false;
          if (queued && holds === 0) {
            queued = false;
            void get().refresh();
          }
        }
      },

      chooseProject: async () => {
        const project = await window.api.project.choose();
        set({
          project,
          tracker: null,
          loading: true,
          error: null,
          openTaskId: null,
          openMilestoneId: null,
          olderLog: [],
          olderDone: [],
          hubFilter: 'all',
        });
        if (project.root && !project.error) await get().refresh();
        else set({ loading: false });
      },

      retryProject: async () => {
        const project = await window.api.project.retry();
        set({ project, error: null, loading: true });
        if (project.root && !project.error) await get().refresh();
        else set({ loading: false });
      },
    }),
    {
      name: 'cc-ui',
      partialize: (s) => ({ activeTab: s.activeTab, theme: s.theme, hubCollapsed: s.hubCollapsed }),
    },
  ),
);
