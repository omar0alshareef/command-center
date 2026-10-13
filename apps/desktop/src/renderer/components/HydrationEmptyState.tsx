import { Inbox } from 'lucide-react';
import { HYDRATION_PROMPT } from '../lib/status';
import { useApp } from '../store';
import { toast } from '../toast';
import { Button } from './ui/button';
import { EmptyState } from './ui/feedback';

/** Shown by every view when the project has no milestones yet (UI/UX §7.5). */
export function HydrationEmptyState() {
  const setActiveTab = useApp((s) => s.setActiveTab);
  const copyPrompt = () => {
    void navigator.clipboard
      .writeText(HYDRATION_PROMPT)
      .then(() => toast.info('Hydration prompt copied'))
      .catch(() => toast.error('Could not copy to the clipboard'));
  };
  return (
    <EmptyState
      icon={Inbox}
      title="No milestones yet"
      help="Plan it in the Planning tab: the planner interviews you, drafts the roadmap, milestones, tasks and team, and nothing lands here until you approve. Existing manifesto and roadmap? Copy the hydration prompt for an agent."
      action={
        <span className="flex gap-2">
          <Button variant="primary" onClick={() => setActiveTab('planning')}>
            Plan a project
          </Button>
          <Button onClick={copyPrompt}>Copy hydration prompt</Button>
        </span>
      }
    />
  );
}
