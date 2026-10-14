import { useEffect } from 'react';
import { create } from 'zustand';
import type { LibraryAgentView, ProjectAgentView } from '../../shared/ipc';

// The agents assigned to the open project (M15), read from the main process. Refetched on every database change, so an
// assignment made from another window or the CLI shows up. The renderer never edits the library files itself.

interface PagState {
  items: ProjectAgentView[] | null;
  refresh: () => Promise<void>;
}

export const useProjectAgents = create<PagState>((set) => ({
  items: null,
  refresh: async () => {
    const r = await window.api.projectAgents.list();
    if (r.ok) set({ items: r.value });
  },
}));

/** Keep the store current while a component that needs it is mounted. */
export function useProjectAgentsLive(): ProjectAgentView[] | null {
  const items = useProjectAgents((s) => s.items);
  const refresh = useProjectAgents((s) => s.refresh);
  useEffect(() => {
    void refresh();
    return window.api.onDbChanged(() => void refresh());
  }, [refresh]);
  return items;
}

interface LibState {
  agents: LibraryAgentView[] | null;
  refresh: () => Promise<void>;
}

/** The whole library (active and archived), used by pickers and the Agents page. */
export const useLibrary = create<LibState>((set) => ({
  agents: null,
  refresh: async () => {
    const r = await window.api.library.agents({ status: 'all' });
    if (r.ok) set({ agents: r.value });
  },
}));

export const ROLE_LABEL = (r: string) => r.charAt(0).toUpperCase() + r.slice(1);
