import { useState } from 'react';
import { Pause, Play, SquareStop } from 'lucide-react';
import { MODE_LABEL, money, useOrch } from '../../lib/orchestrator';
import { toast } from '../../toast';
import { Button } from '../ui/button';
import { Modal } from '../ui/overlays';

/** Why nothing new is starting, in words (the status bar uses the short form). */
export function capText(
  v: NonNullable<ReturnType<typeof useOrch.getState>['view']>,
): string | null {
  if (v.pausedByCap === 'hourly')
    return `Paused by cap: ${v.startedLastHour} of ${v.maxPerHour} runs started in the last hour`;
  if (v.pausedByCap === 'daily')
    return `Paused by cap: ${money(v.spendToday)} of the ${money(v.dailyCeiling)} daily ceiling spent`;
  return null;
}

/**
 * Switch the orchestrator on, pause it or stop after the current run. Pausing asks what to do with runs in flight: let
 * them finish, or cancel them now (their tasks are blocked as cancelled).
 */
export function OrchestratorControls() {
  const view = useOrch((s) => s.view);
  const [askPause, setAskPause] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!view)
    return <p className="text-[12px] text-muted">The orchestrator starts with a project.</p>;
  const act = async (fn: () => Promise<{ ok: boolean; error?: { message: string } }>) => {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    if (!r.ok) toast.error(r.error?.message ?? 'Could not change the orchestrator.');
  };
  const on = view.mode === 'running';
  const cap = capText(view);
  return (
    <div className="flex flex-col gap-2" data-orchestrator>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
        <span className="font-semibold" data-orch-mode={view.mode}>
          {MODE_LABEL[view.mode]}
        </span>
        <span className="font-mono text-muted">
          {view.running} running · {view.queued} queued
        </span>
        <span className="font-mono text-muted">
          {money(view.spendToday)}
          {view.dailyCeiling > 0 ? ` / ${money(view.dailyCeiling)}` : ''} today (estimate)
        </span>
      </div>
      {cap ? (
        <p role="status" className="text-[12px] text-warning">
          {cap}. Nothing new starts until the window clears or you raise the cap in Settings →
          Providers.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {!on ? (
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void act(() => window.api.orchestrator.resume())}
          >
            <Play size={13} aria-hidden /> {view.mode === 'off' ? 'Start orchestrator' : 'Resume'}
          </Button>
        ) : (
          <>
            <Button disabled={busy} onClick={() => setAskPause(true)}>
              <Pause size={13} aria-hidden /> Pause
            </Button>
            <Button
              disabled={busy}
              onClick={() => void act(() => window.api.orchestrator.stopAfterCurrent())}
            >
              <SquareStop size={13} aria-hidden /> Stop after current
            </Button>
          </>
        )}
        {view.mode === 'draining' ? (
          <Button disabled={busy} onClick={() => void act(() => window.api.orchestrator.resume())}>
            <Play size={13} aria-hidden /> Resume
          </Button>
        ) : null}
      </div>
      <Modal
        open={askPause}
        onClose={() => setAskPause(false)}
        label="Pause the orchestrator"
        className="w-[460px] p-5"
      >
        <h2 className="text-[14px] font-semibold">Pause the orchestrator?</h2>
        <p className="mt-2 text-muted">
          No new runs will start.
          {view.running > 0
            ? ` ${view.running} run${view.running === 1 ? ' is' : 's are'} in progress: let ${view.running === 1 ? 'it' : 'them'} finish, or cancel now (the task is blocked as cancelled).`
            : ''}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button autoFocus onClick={() => setAskPause(false)}>
            Keep running
          </Button>
          <Button
            variant={view.running > 0 ? 'default' : 'primary'}
            onClick={() => {
              setAskPause(false);
              void act(() => window.api.orchestrator.pause({ cancelRunning: false }));
            }}
          >
            {view.running > 0 ? 'Pause, let runs finish' : 'Pause'}
          </Button>
          {view.running > 0 ? (
            <Button
              variant="primary"
              onClick={() => {
                setAskPause(false);
                void act(() => window.api.orchestrator.pause({ cancelRunning: true }));
              }}
            >
              Pause and cancel runs
            </Button>
          ) : null}
        </div>
      </Modal>
    </div>
  );
}
