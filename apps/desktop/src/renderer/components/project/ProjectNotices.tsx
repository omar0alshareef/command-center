import { Info, TriangleAlert } from 'lucide-react';
import { useApp } from '../../store';
import { toast } from '../../toast';
import { Button } from '../ui/button';

/** Project-level notices under the tab bar (D36): a missing spec is only a notice, a malformed project.json blocks dispatch. */
export function ProjectNotices() {
  const project = useApp((s) => s.project);
  if (!project?.root) return null;
  const missingSpec = project.spec?.status === 'missing';
  const unreadable = project.spec?.status === 'unreadable';
  if (!project.dispatchBlock && !missingSpec && !unreadable) return null;
  return (
    <div data-project-notices>
      {project.dispatchBlock ? (
        <p
          role="alert"
          data-notice="dispatch-blocked"
          className="flex items-start gap-2 border-b border-border bg-surface px-4 py-2 text-[12px] text-ink-warning"
        >
          <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 break-words">{project.dispatchBlock}</span>
        </p>
      ) : null}
      {missingSpec || unreadable ? (
        <p
          data-notice="no-spec"
          className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2 text-[12px] text-muted"
        >
          <Info size={14} className="shrink-0" aria-hidden />
          <span className="flex-1">
            {missingSpec
              ? 'No project spec. Runs still start, using only each agent’s own profile and the lessons that apply.'
              : 'The project spec cannot be read. Runs start without it.'}{' '}
            <span className="font-mono">{project.spec?.path}</span>
          </span>
          <Button
            variant="ghost"
            onClick={() =>
              void window.api.projectAgents.openSpec().then((r) => {
                if (!r.ok) toast.error(r.error.message);
              })
            }
          >
            Open project spec
          </Button>
        </p>
      ) : null}
    </div>
  );
}
