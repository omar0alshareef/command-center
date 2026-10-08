import { useCallback, useEffect, useState } from 'react';
import type { WebhookStatus } from '../../shared/ipc';
import { useApp } from '../store';
import { toast } from '../toast';
import { CopyBlock } from './McpConnect';
import { Button } from './ui/button';

/** Webhook port, state and token (regenerate invalidates the old token). Settings reuses it in M12. */
export function WebhookCard() {
  const root = useApp((s) => s.project?.root);
  const [status, setStatus] = useState<WebhookStatus | null>(null);
  const load = useCallback(() => void window.api.webhook.status().then(setStatus), []);
  useEffect(load, [load, root]);
  if (!status) return null;

  const regenerate = async () => {
    const r = await window.api.webhook.regenerate();
    if (r.ok) {
      setStatus(r.value);
      toast.info('Webhook token replaced');
    } else toast.error(r.error.message);
  };
  const curl = `curl -X POST http://127.0.0.1:${status.port}/webhook/task-update \\n  -H "Authorization: Bearer ${status.token ?? '<token>'}" \\n  -H "Content-Type: application/json" \\n  -d '{"task_id":"TASK-001","status":"done"}'`;

  return (
    <div className="flex max-w-3xl flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[12px]">
          Webhook 127.0.0.1:{status.port} ·{' '}
          {status.running ? 'running' : (status.error ?? 'stopped')}
        </span>
        <Button onClick={() => void regenerate()} disabled={!status.token}>
          Regenerate token
        </Button>
      </div>
      {status.token ? <CopyBlock label="Webhook example (curl)" text={curl} /> : null}
    </div>
  );
}
