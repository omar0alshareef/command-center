import { FolderOpen, TriangleAlert } from 'lucide-react';
import { Button } from './components/ui/button';
import { EmptyState, Skeleton } from './components/ui/feedback';
import { useApp } from './store';
import { toast } from './toast';

function run(action: () => Promise<void>) {
  void action().catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)));
}

/** First run: no project folder known yet (UI/UX §7.5). */
export function Welcome() {
  const chooseProject = useApp((s) => s.chooseProject);
  return (
    <main className="grid h-full place-items-center">
      <EmptyState
        icon={FolderOpen}
        title="Choose your project folder"
        help="Command Center keeps its database (command-center.db) in your project folder. Pick the folder to track, or a new empty one."
        action={
          <Button variant="primary" onClick={() => run(chooseProject)}>
            Choose folder…
          </Button>
        }
      />
    </main>
  );
}

/** Fatal: the database cannot be opened or read (locked, corrupt, missing permissions). */
export function FatalError({ path, message }: { path: string | null; message: string }) {
  const retryProject = useApp((s) => s.retryProject);
  const chooseProject = useApp((s) => s.chooseProject);
  return (
    <main className="grid h-full place-items-center p-6">
      <div role="alert" className="flex max-w-xl flex-col items-center gap-3 text-center">
        <TriangleAlert size={48} strokeWidth={1.25} className="text-danger" aria-hidden />
        <h1 className="text-[18px] font-semibold">Can’t open the project database</h1>
        {path ? <code className="font-mono text-[12px] break-all text-muted">{path}</code> : null}
        <p className="font-mono text-[12px] break-words text-danger">{message}</p>
        <div className="mt-2 flex gap-2">
          <Button variant="primary" onClick={() => run(retryProject)}>
            Retry
          </Button>
          <Button onClick={() => run(chooseProject)}>Choose another project</Button>
        </div>
      </div>
    </main>
  );
}

/** Skeleton that mirrors the final layout while the first fetch is in flight. */
export function ViewSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-6" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-6 w-48" />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      </div>
    </div>
  );
}
