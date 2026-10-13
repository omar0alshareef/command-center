import { useEffect } from 'react';
import { useApp } from '../../store';
import { TABS } from './tabs';

/** Ctrl/Cmd+1…6 jump to a tab; Ctrl/Cmd+Tab cycles (Shift reverses); Ctrl/Cmd+K palette; Ctrl/Cmd+, settings; ? cheat-sheet. */
export function useHotkeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const el = e.target as HTMLElement | null;
        const typing = el?.closest('input, textarea, select, [contenteditable=true], .xterm');
        if (!typing && !document.querySelector('dialog[open]')) {
          e.preventDefault();
          useApp.getState().setShortcutsOpen(true);
        }
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === 'k' || e.key === ',') {
        e.preventDefault();
        const st = useApp.getState();
        if (e.key === 'k') st.setPaletteOpen(!st.paletteOpen);
        else st.setSettingsOpen(true);
        return;
      }
      const { activeTab, setActiveTab } = useApp.getState();
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= TABS.length) {
        e.preventDefault();
        const tab = TABS[n - 1];
        if (tab) setActiveTab(tab.id);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const i = TABS.findIndex((t) => t.id === activeTab);
        const next = TABS[(i + (e.shiftKey ? -1 : 1) + TABS.length) % TABS.length];
        if (next) setActiveTab(next.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
