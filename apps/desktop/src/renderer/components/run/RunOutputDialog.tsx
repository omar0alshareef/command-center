import { useApp } from '../../store';
import { providerLabel, runCost, runDuration } from '../../lib/orchestrator';
import { toast } from '../../toast';
import { Button } from '../ui/button';
import { Modal } from '../ui/overlays';

const LINES = 60;

/**
 * One run in full: who, where, how long, what it cost (labelled estimate unless the provider reported it) and the last
 * lines of its output. Opened from the Activity Feed and the task's History tab. Agent output is shown as plain text.
 */
export function RunOutputDialog() {
  const id = useApp((s) => s.openRunId);
  const setId = useApp((s) => s.setOpenRunId);
  const run = useApp((s) => s.tracker?.runs.find((r) => r.id === id) ?? null);
  const agent = useApp((s) => s.tracker?.agents.find((a) => a.id === run?.agent_id));
  const lines = run?.output_tail ? run.output_tail.split('\n').slice(-LINES) : [];
  return (
    <Modal
      open={Boolean(id)}
      onClose={() => setId(null)}
      label="Run output"
      className="w-[720px] p-5"
    >
      {run ? (
        <>
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-[14px] font-semibold">
                {run.task_id} · {run.kind} run, attempt {run.attempt}
              </h2>
              <p className="mt-1 text-[12px] text-muted">
                {agent?.name ?? run.agent_id} on {providerLabel(run.provider)}
                {run.model ? ` / ${run.model}` : ' / default model'}
              </p>
            </div>
            <span className="flex gap-2">
              {run.status === 'running' || run.status === 'queued' ? (
                <Button
                  data-cancel-run={run.id}
                  onClick={async () => {
                    const r = await window.api.orchestrator.cancelRun(run.id);
                    if (!r.ok) toast.error(r.error.message);
                    else toast.info('Cancelling: the provider process is being stopped');
                  }}
                >
                  Cancel run
                </Button>
              ) : null}
              <Button variant="ghost" onClick={() => setId(null)}>
                Close
              </Button>
            </span>
          </div>
          <dl className="mb-3 grid grid-cols-4 gap-2 text-[12px]" data-run-facts>
            {(
              [
                ['Status', run.status],
                ['Duration', runDuration(run)],
                [
                  'Tokens',
                  run.input_tokens === null && run.output_tokens === null
                    ? '—'
                    : `${run.input_tokens ?? '?'} in / ${run.output_tokens ?? '?'} out`,
                ],
                ['Cost', runCost(run)],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="rounded-md bg-surface-2 px-2 py-1.5">
                <dt className="text-[11px] text-muted">{k}</dt>
                <dd className="font-mono">{v}</dd>
              </div>
            ))}
          </dl>
          {run.error ? (
            <p role="alert" className="mb-3 rounded-md border border-danger px-3 py-2 text-[12px]">
              {run.error}
            </p>
          ) : null}
          <h3 className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">
            Last {Math.min(lines.length, LINES)} lines of output
          </h3>
          <pre
            aria-label="Run output"
            className="max-h-80 overflow-auto rounded-md bg-surface-3 p-3 font-mono text-[12px] whitespace-pre-wrap"
          >
            {lines.length > 0 ? lines.join('\n') : '(no output was recorded)'}
          </pre>
        </>
      ) : null}
    </Modal>
  );
}
