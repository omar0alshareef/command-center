import { useEffect, useRef } from 'react';
import { useApp } from '../../store';

/**
 * OS notification (UI/UX §7.2) when a task newly enters Review or Blocked while the window is not
 * focused. The first snapshot after load only seeds the "already there" set; clicking focuses the app
 * and opens the task.
 */
export function useNotifications(): void {
  const subtasks = useApp((s) => s.tracker?.subtasks);
  const enabled = useApp((s) => s.notifications);
  const seen = useRef<Map<string, string> | null>(null);

  useEffect(() => {
    if (!subtasks) return;
    const prev = seen.current;
    seen.current = new Map(subtasks.map((t) => [t.id, t.status]));
    if (!prev || !enabled || document.hasFocus() || typeof Notification === 'undefined') return;
    for (const t of subtasks) {
      if (prev.get(t.id) === t.status || (t.status !== 'review' && t.status !== 'blocked'))
        continue;
      const n = new Notification(
        `${t.id} is ${t.status === 'review' ? 'ready for review' : 'blocked'}`,
        { body: t.label, silent: true },
      );
      n.onclick = () => {
        window.focus();
        useApp.getState().setOpenTaskId(t.id);
      };
    }
  }, [subtasks, enabled]);
}
