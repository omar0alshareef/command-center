import { Inbox } from 'lucide-react';
import { HYDRATION_PROMPT } from '../lib/status';
import { toast } from '../toast';
import { Button } from './ui/button';
import { EmptyState } from './ui/feedback';

/** Shown by every view when the project has no milestones yet (UI/UX §7.5). */
export function HydrationEmptyState() {
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
      help="Hydrate this project with a manifesto and roadmap, or ask an agent to call create_milestone."
      action={<Button onClick={copyPrompt}>Copy hydration prompt</Button>}
    />
  );
}
