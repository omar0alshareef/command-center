import { MotionConfig } from 'framer-motion';
import { useEffect } from 'react';
import { StatusBar } from './components/shell/StatusBar';
import { TabBar } from './components/shell/TabBar';
import { TitleBar } from './components/shell/TitleBar';
import { useHotkeys } from './components/shell/useHotkeys';
import { Button } from './components/ui/button';
import { ToastHost } from './components/ui/feedback';
import { FatalError, ViewSkeleton, Welcome } from './screens';
import { useApp } from './store';
import { ActiveView } from './views';

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
            ) : (
              <ViewSkeleton />
            )}
          </main>
          <StatusBar />
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
