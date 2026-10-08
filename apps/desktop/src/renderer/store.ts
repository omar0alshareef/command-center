import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { TrackerState } from '@command-center/core';
import type { ProjectInfo } from '../shared/ipc';

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
  theme: Theme;

  setActiveTab: (tab: TabId) => void;
  setSelectedMilestoneId: (id: string | null) => void;
  toggleTheme: () => void;
  setSync: (sync: Pick<SyncState, 'state' | 'error'>) => void;
  init: () => Promise<void>;
  refresh: () => Promise<void>;
  chooseProject: () => Promise<void>;
  retryProject: () => Promise<void>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Coalesce bursts: at most one fetch in flight, plus one queued re-run.
let inflight = false;
let queued = false;

export const useApp = create<AppState>()(
  persist(
    (set, get) => ({
      project: null,
      tracker: null,
      loading: true,
      error: null,
      sync: { state: 'live', lastSyncAt: null },
      activeTab: 'swim-lane',
      selectedMilestoneId: null,
      theme: 'dark',

      setActiveTab: (activeTab) => set({ activeTab }),
      setSelectedMilestoneId: (selectedMilestoneId) => set({ selectedMilestoneId }),
      toggleTheme: () => set((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' })),
      setSync: (next) => set((s) => ({ sync: { ...s.sync, ...next } })),

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
        if (inflight) {
          queued = true;
          return;
        }
        inflight = true;
        if (get().tracker) get().setSync({ state: 'syncing' });
        try {
          const tracker = await window.api.db.getAll();
          set({
            tracker,
            loading: false,
            error: null,
            sync: { state: 'live', lastSyncAt: Date.now() },
          });
        } catch (e) {
          set((s) => ({
            loading: false,
            error: message(e),
            sync: { state: 'disconnected', lastSyncAt: s.sync.lastSyncAt, error: message(e) },
          }));
        } finally {
          inflight = false;
          if (queued) {
            queued = false;
            void get().refresh();
          }
        }
      },

      chooseProject: async () => {
        const project = await window.api.project.choose();
        set({ project, tracker: null, loading: true, error: null });
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
      partialize: (s) => ({ activeTab: s.activeTab, theme: s.theme }),
    },
  ),
);
