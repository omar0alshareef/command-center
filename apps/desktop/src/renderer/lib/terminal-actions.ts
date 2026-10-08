import { useApp } from '../store';
import { useTerminal } from './terminal';

/** Opens the Terminal tab and types `text` into a running session (starting one if needed). It is never executed. */
export async function typeInTerminal(text: string): Promise<void> {
  useApp.getState().setOpenTaskId(null);
  useApp.getState().setActiveTab('terminal');
  const t = useTerminal.getState();
  t.markVisited();
  await t.init();
  const deadline = Date.now() + 5000;
  let started = false;
  while (Date.now() < deadline) {
    const s = useTerminal.getState();
    const active = s.sessions.find((x) => x.id === s.activeId && x.status === 'running');
    if (active) {
      await new Promise((r) => setTimeout(r, 400)); // let the prompt appear before typing
      useTerminal.getState().typeInto(text);
      return;
    }
    if (!started && !s.creating) {
      started = true;
      void s.newSession();
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
