import { MotionConfig } from 'framer-motion';
import { useEffect } from 'react';
import { StatusBar } from './components/shell/StatusBar';
import { TabBar } from './components/shell/TabBar';
import { TitleBar } from './components/shell/TitleBar';
import { useHotkeys } from './components/shell/useHotkeys';
import { MilestonePanel } from './components/milestone/MilestonePanel';
import { TaskDetailModal } from './components/task/TaskDetailModal';
import { Button } from './components/ui/button';
import { ToastHost } from './components/ui/feedback';
import { FatalError, ViewSkeleton, Welcome } from './screens';
import { useApp } from './store';
import { useTerminal } from './lib/terminal';
import { ActiveView } from './views';
import { TerminalPanel } from './views/terminal/TerminalPanel';

export function App() {
  const project = useApp((s) => s.project);
  const tracker = useApp((s) => s.tracker);
  const loading = useApp((s) => s.loading);
  const error = useApp((s) => s.error);
  const theme = useApp((s) => s.theme);
  const activeTab = useApp((s) => s.activeTab);
  const init = useApp((s) => s.init);
  const refresh = useApp((s) => s.refresh);
  const setSync = useApp((s) => s.setSync);

  useHotkeys();
  const terminalVisited = useTerminal((s) => s.visited);
  const markTerminalVisited = useTerminal((s) => s.markVisited);
  useEffect(() => {
    if (activeTab === 'terminal') markTerminalVisited();
  }, [activeTab, markTerminalVisited]);

  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
  }, [theme]);

  useEffect(() => {
    void init();
    const offChanged = window.api.onDbChanged(() => void refresh());
    const offStatus = window.api.onDbStatus((s) =>
      setSync(s.state === 'live' ? { state: 'live' } : { state: 'disconnected', error: s.error }),
    );
    return () => {
      offChanged();
      offStatus();
    };
  }, [init, refresh, setSync]);

  let body;
  if (!project) body = <ViewSkeleton />;
  else if (!project.root) body = <Welcome />;
  else if (project.error) body = <FatalError path={project.dbPath} message={project.error} />;
  else if (!tracker && error) body = <FatalError path={project.dbPath} message={error} />;
  else {
    return (
      <MotionConfig reducedMotion="user">
        <div className="flex h-screen flex-col bg-bg text-text">
          <TitleBar />
          <TabBar />
          {tracker && error ? (
            <div
              role="alert"
              className="flex items-center gap-3 border-b border-danger bg-surface px-4 py-2 text-danger"
            >
              <span className="flex-1 break-words">{error}</span>
              <Button onClick={() => void refresh()}>Retry</Button>
            </div>
          ) : null}
          <main
            id="view-panel"
            role="tabpanel"
            aria-labelledby={`tab-${activeTab}`}
            className="min-h-0 flex-1"
          >
            {tracker && !loading ? (
              <ActiveView tab={activeTab} tracker={tracker} />
            ) : activeTab === 'terminal' ? null : (
              <ViewSkeleton />
            )}
            {terminalVisited ? (
              <div className={activeTab === 'terminal' ? 'h-full' : 'hidden'}>
                <TerminalPanel visible={activeTab === 'terminal'} />
              </div>
            ) : null}
          </main>
          <StatusBar />
          <MilestonePanel />
          <TaskDetailModal />
          <ToastHost />
        </div>
      </MotionConfig>
    );
  }

  return (
    <MotionConfig reducedMotion="user">
      <div className="h-screen bg-bg text-text">{body}</div>
      <ToastHost />
    </MotionConfig>
  );
}
