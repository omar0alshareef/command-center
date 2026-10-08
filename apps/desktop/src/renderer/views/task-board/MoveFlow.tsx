import { useCallback, useState, type ReactNode } from 'react';
import type { Task, TaskStatus } from '@command-center/core';
import { Button } from '../../components/ui/button';
import { ConfirmDialog, Modal } from '../../components/ui/overlays';
import { transitionTask } from '../../lib/task-actions';
import { useApp } from '../../store';
import { toast } from '../../toast';
import { planMove, type Move, type MovePlan } from './moves';

type Pending = { task: Task; plan: Exclude<MovePlan, { kind: 'noop' | 'illegal' | 'direct' }> };

/** Block / reject (required) and complete (optional) take free text before running. */
function TextPromptDialog({
  open,
  title,
  prompt,
  required,
  submitLabel,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  prompt: string;
  required: boolean;
  submitLabel: string;
  onSubmit: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const ok = !required || text.trim().length > 0;
  const submit = () => {
    if (!ok) return;
    onSubmit(text.trim());
    setText('');
  };
  return (
    <Modal
      open={open}
      onClose={() => {
        setText('');
        onClose();
      }}
      label={title}
      className="w-[460px] p-5"
    >
      <h2 className="text-[14px] font-semibold">{title}</h2>
      <label className="mt-3 block text-muted" htmlFor="move-text">
        {prompt}
        {required ? ' (required)' : ' (optional)'}
      </label>
      <textarea
        id="move-text"
        autoFocus
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
        }}
        className="mt-1 w-full resize-none rounded-md border border-border-strong bg-surface-2 p-2 text-text"
      />
      <div className="mt-4 flex items-center justify-end gap-2">
        <span className="mr-auto text-[11px] text-muted">Ctrl+Enter to submit</span>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!ok} onClick={submit}>
          {submitLabel}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * One entry point for every status change (drag, card buttons, modal buttons): plan -> maybe ask ->
 * run. `request` handles the immediate cases itself and parks the rest in a dialog.
 */
export function useMoveFlow(): {
  request: (task: Task, to: TaskStatus) => void;
  dialogs: ReactNode;
} {
  const [pending, setPending] = useState<Pending | null>(null);

  const request = useCallback((task: Task, to: TaskStatus) => {
    const tracker = useApp.getState().tracker;
    const byId = new Map((tracker?.subtasks ?? []).map((t) => [t.id, t]));
    const plan = planMove(task, to, byId);
    if (plan.kind === 'noop') return;
    if (plan.kind === 'illegal') {
      toast.error(plan.message);
      return;
    }
    if (plan.kind === 'direct') {
      void transitionTask(task, plan.move);
      return;
    }
    setPending({ task, plan });
  }, []);

  const close = () => setPending(null);
  const run = (task: Task, move: Move) => {
    close();
    void transitionTask(task, move);
  };

  const p = pending;
  const dialogs = (
    <>
      <TextPromptDialog
        open={p?.plan.kind === 'reason'}
        title={p?.plan.kind === 'reason' ? p.plan.title : ''}
        prompt={p?.plan.kind === 'reason' ? p.plan.prompt : ''}
        required
        submitLabel={p?.plan.kind === 'reason' && p.plan.trigger === 'reject' ? 'Reject' : 'Block'}
        onClose={close}
        onSubmit={(reason) => {
          if (p?.plan.kind === 'reason')
            run(p.task, { trigger: p.plan.trigger, payload: { reason } });
        }}
      />
      <TextPromptDialog
        open={p?.plan.kind === 'summary'}
        title={p?.plan.kind === 'summary' ? p.plan.title : ''}
        prompt="Summary of what was done"
        required={false}
        submitLabel="Submit for review"
        onClose={close}
        onSubmit={(summary) => {
          if (p?.plan.kind === 'summary') {
            run(p.task, { ...p.plan.move, payload: summary ? { summary } : {} });
          }
        }}
      />
      <ConfirmDialog
        open={p?.plan.kind === 'confirm'}
        title={p?.plan.kind === 'confirm' ? p.plan.title : ''}
        body={p?.plan.kind === 'confirm' ? p.plan.body : ''}
        confirmLabel={p?.plan.kind === 'confirm' ? p.plan.confirmLabel : 'Confirm'}
        onCancel={close}
        onConfirm={() => {
          if (p?.plan.kind === 'confirm') run(p.task, p.plan.move);
        }}
      />
    </>
  );
  return { request, dialogs };
}
