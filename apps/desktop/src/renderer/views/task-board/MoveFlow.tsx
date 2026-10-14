import { useCallback, useState, type ReactNode } from 'react';
import type { Task, TaskStatus } from '@command-center/core';
import type { RendererTransitionPayload } from '../../../shared/ipc';
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

const CHECK_FORMS =
  'file-exists <path> | file-missing <path> | no-match <glob> /<regex>/ | must-match <glob> /<regex>/ | command npm run <script>';

/**
 * Rejecting a task (M15): the reason is required; the reviewer may also give a prevention check, which makes the lesson
 * active at once (without one it stays a draft), and may say the mistake was already written down, which counts a repeat
 * on that lesson instead of making a new one.
 */
function RejectDialog({
  open,
  title,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  onSubmit: (reason: string, extra: RendererTransitionPayload) => void;
  onClose: () => void;
}) {
  const lessons = useApp((s) => s.tracker?.lessons_learned ?? []);
  const [reason, setReason] = useState('');
  const [check, setCheck] = useState('');
  const [checkType, setCheckType] = useState<'manual' | 'automatic'>('manual');
  const [keywords, setKeywords] = useState('');
  const [sameAs, setSameAs] = useState('');
  const repeatable = lessons.filter((l) => l.status !== 'retired' && !l.promoted_to);
  const ok = reason.trim().length > 0;
  const reset = () => {
    setReason('');
    setCheck('');
    setCheckType('manual');
    setKeywords('');
    setSameAs('');
  };
  const submit = () => {
    if (!ok) return;
    const extra: RendererTransitionPayload = {};
    if (sameAs) extra.sameAs = Number(sameAs);
    else {
      if (check.trim()) {
        extra.check = check.trim();
        extra.checkType = checkType;
      }
      if (keywords.trim()) extra.triggerKeywords = keywords.trim();
    }
    onSubmit(reason.trim(), extra);
    reset();
  };
  const area = 'mt-1 w-full rounded-md border border-border-strong bg-surface-2 p-2 text-text';
  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      label={title}
      className="max-h-[88vh] w-[520px] overflow-auto p-5"
    >
      <h2 className="text-[14px] font-semibold">{title}</h2>
      <label className="mt-3 block text-muted" htmlFor="reject-reason">
        What is wrong (required)
      </label>
      <textarea
        id="reject-reason"
        autoFocus
        rows={3}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        className={area}
      />
      <label className="mt-3 block text-muted" htmlFor="reject-same">
        Same mistake as an earlier lesson? (optional)
      </label>
      <select
        id="reject-same"
        value={sameAs}
        onChange={(e) => setSameAs(e.target.value)}
        className={area}
      >
        <option value="">No, this is a new mistake</option>
        {repeatable.map((l) => (
          <option key={l.id} value={l.id}>
            #{l.id}: {l.rejection_reason.slice(0, 70)}
          </option>
        ))}
      </select>
      {sameAs ? (
        <p className="mt-2 text-[11px] text-muted">
          No new lesson is made. A repeat is counted on lesson #{sameAs}; at two repeats it is
          marked as needing a rewrite.
        </p>
      ) : (
        <>
          <label className="mt-3 block text-muted" htmlFor="reject-check">
            Prevention check (optional: without one the lesson stays a draft and applies only here)
          </label>
          <input
            id="reject-check"
            value={check}
            onChange={(e) => setCheck(e.target.value)}
            className={area}
            placeholder="A statement to verify, or an automatic check"
          />
          <div className="mt-1 flex items-center gap-3 text-[11px] text-muted">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="reject-check-type"
                checked={checkType === 'manual'}
                onChange={() => setCheckType('manual')}
              />
              Manual (a reviewer checks it)
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="reject-check-type"
                checked={checkType === 'automatic'}
                onChange={() => setCheckType('automatic')}
              />
              Automatic (runs when a task reaches Review)
            </label>
          </div>
          {checkType === 'automatic' ? (
            <p className="mt-1 font-mono text-[10px] text-muted">{CHECK_FORMS}</p>
          ) : null}
          <label className="mt-3 block text-muted" htmlFor="reject-kw">
            Trigger keywords (optional, so similar tasks find this lesson)
          </label>
          <input
            id="reject-kw"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            className={area}
          />
        </>
      )}
      <div className="mt-4 flex items-center justify-end gap-2">
        <Button
          onClick={() => {
            reset();
            onClose();
          }}
        >
          Cancel
        </Button>
        <Button variant="primary" disabled={!ok} onClick={submit}>
          Reject
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
      <RejectDialog
        open={p?.plan.kind === 'reason' && p.plan.trigger === 'reject'}
        title={p?.plan.kind === 'reason' ? p.plan.title : ''}
        onClose={close}
        onSubmit={(reason, extra) => {
          if (p?.plan.kind === 'reason')
            run(p.task, { trigger: p.plan.trigger, payload: { reason, ...extra } });
        }}
      />
      <TextPromptDialog
        open={p?.plan.kind === 'reason' && p.plan.trigger !== 'reject'}
        title={p?.plan.kind === 'reason' ? p.plan.title : ''}
        prompt={p?.plan.kind === 'reason' ? p.plan.prompt : ''}
        required
        submitLabel="Block"
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
