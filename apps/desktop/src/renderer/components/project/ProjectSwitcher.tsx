import { FolderOpen, FolderPlus, Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ProjectEntry, SwitchResult } from '../../../shared/ipc';
import { formatDate } from '../../lib/time';
import { useOrch } from '../../lib/orchestrator';
import { useApp } from '../../store';
import { toast } from '../../toast';
import { Tag } from '../ui/badges';
import { Button } from '../ui/button';
import { ConfirmDialog, Modal } from '../ui/overlays';

/** What the app tells the operator after a switch: dispatch of the project that was open is paused first (M15). */
export function switchNotice(r: SwitchResult): string {
  const name = r.info.projectName ?? 'the project';
  if (!r.paused) return `Opened ${name}.`;
  const from = r.paused.project ?? 'the previous project';
  const ended = r.paused.cancelled
    ? ` ${r.paused.running} run${r.paused.running === 1 ? '' : 's'} in progress ${r.paused.running === 1 ? 'was' : 'were'} cancelled.`
    : '';
  return `Dispatch for ${from} was paused.${ended} Opened ${name}.`;
}

/**
 * The project switcher (UI/UX §3.2, M15). Lists registered projects. A project whose folder is missing or whose database
 * cannot open shows its error and cannot be opened. Removing a project only forgets it; its files are never touched.
 */
export function ProjectSwitcher() {
  const open = useApp((s) => s.switcherOpen);
  const setOpen = useApp((s) => s.setSwitcherOpen);
  const setNewOpen = useApp((s) => s.setNewProjectOpen);
  const adopt = useApp((s) => s.adoptProject);
  const running = useOrch((s) => s.view?.running ?? 0);
  const [rows, setRows] = useState<ProjectEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmSwitch, setConfirmSwitch] = useState<ProjectEntry | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<ProjectEntry | null>(null);

  useEffect(() => {
    if (!open) return;
    void window.api.projects.list().then((res) => {
      if (res.ok) setRows(res.value);
      else toast.error(res.error.message);
    });
  }, [open]);

  const doSwitch = async (p: ProjectEntry) => {
    setConfirmSwitch(null);
    setBusy(true);
    const res = await window.api.projects.switchTo({ id: p.id, cancelRunning: running > 0 });
    setBusy(false);
    if (!res.ok) return toast.error(res.error.message);
    toast.info(switchNotice(res.value));
    await adopt(res.value.info);
  };

  const pick = (p: ProjectEntry) => {
    if (p.current || !p.openable) return;
    if (running > 0) setConfirmSwitch(p);
    else void doSwitch(p);
  };

  const addExisting = async () => {
    const picked = await window.api.projects.pick();
    if (!picked.ok) return toast.error(picked.error.message);
    if (!picked.value) return;
    const res = await window.api.projects.addExisting(picked.value);
    if (!res.ok) return toast.error(res.error.message);
    setRows(res.value);
    toast.info('Project added to the list.');
  };

  const locate = async (p: ProjectEntry) => {
    const picked = await window.api.projects.pick();
    if (!picked.ok) return toast.error(picked.error.message);
    if (!picked.value) return;
    const res = await window.api.projects.relocate({ id: p.id, path: picked.value });
    if (!res.ok) return toast.error(res.error.message);
    setRows(res.value);
    toast.info(`${p.name} now points to the new folder.`);
  };

  const remove = async (p: ProjectEntry) => {
    setConfirmRemove(null);
    const res = await window.api.projects.remove(p.id);
    if (!res.ok) return toast.error(res.error.message);
    setRows(res.value);
    toast.info(`${p.name} was removed from the list. Its files were not touched.`);
  };

  return (
    <>
      <Modal open={open} onClose={() => setOpen(false)} label="Projects" className="w-[600px] p-5">
        <div className="flex items-center gap-2">
          <h2 className="flex-1 text-[14px] font-semibold">Projects</h2>
          <Button onClick={() => void addExisting()}>
            <FolderOpen size={14} aria-hidden /> Add existing…
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setOpen(false);
              setNewOpen(true);
            }}
          >
            <FolderPlus size={14} aria-hidden /> New project…
          </Button>
        </div>
        {running > 0 ? (
          <p className="mt-2 text-[12px] text-muted">
            {running} run{running === 1 ? ' is' : 's are'} in progress. Switching pauses dispatch
            and cancels {running === 1 ? 'it' : 'them'}.
          </p>
        ) : null}
        <ul className="mt-3 max-h-[380px] divide-y divide-border overflow-auto rounded-lg border border-border">
          {rows === null ? (
            <li className="p-4 text-muted">Loading…</li>
          ) : rows.length === 0 ? (
            <li className="p-4 text-muted">
              No projects yet. Create one or add an existing folder.
            </li>
          ) : (
            rows.map((p) => (
              <li
                key={p.id}
                data-project={p.id}
                data-openable={p.openable}
                className="flex items-start gap-3 p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 font-semibold">
                    <span className="truncate">{p.name}</span>
                    {p.current ? <Tag color="var(--accent)">Open</Tag> : null}
                    {p.dispatchBlock ? <Tag color="var(--warning)">Dispatch blocked</Tag> : null}
                  </p>
                  <p className="truncate font-mono text-[11px] text-muted" title={p.path}>
                    {p.path}
                  </p>
                  {p.error ? (
                    <p role="alert" className="mt-1 flex items-start gap-1 text-[12px] text-danger">
                      <TriangleAlert size={13} className="mt-0.5 shrink-0" aria-hidden />
                      {p.error}
                    </p>
                  ) : null}
                  {p.dispatchBlock ? (
                    <p className="mt-1 text-[12px] text-muted">{p.dispatchBlock}</p>
                  ) : null}
                  {p.last_opened ? (
                    <p className="mt-0.5 text-[11px] text-muted">
                      Last opened {formatDate(p.last_opened)}
                    </p>
                  ) : null}
                </div>
                {!p.openable ? (
                  <Button
                    onClick={() => void locate(p)}
                    aria-label={`Locate the folder of ${p.name}`}
                  >
                    Locate folder…
                  </Button>
                ) : null}
                <Button
                  disabled={busy || p.current || !p.openable}
                  onClick={() => pick(p)}
                  aria-label={`Open ${p.name}`}
                >
                  Open
                </Button>
                <Button
                  variant="ghost"
                  disabled={p.current}
                  onClick={() => setConfirmRemove(p)}
                  aria-label={`Remove ${p.name} from the list`}
                  title={p.current ? 'Switch to another project first' : 'Remove from the list'}
                >
                  <Trash2 size={14} aria-hidden />
                </Button>
              </li>
            ))
          )}
        </ul>
        <div className="mt-4 flex justify-end">
          <Button onClick={() => setOpen(false)}>Close</Button>
        </div>
      </Modal>
      <ConfirmDialog
        open={confirmSwitch !== null}
        title={`Switch to ${confirmSwitch?.name ?? ''}?`}
        body={`${running} run${running === 1 ? ' is' : 's are'} in progress. Dispatch for this project will be paused and ${running === 1 ? 'the run' : 'the runs'} cancelled. Their tasks are blocked with the reason, and you can start them again later.`}
        confirmLabel="Pause and switch"
        onConfirm={() => confirmSwitch && void doSwitch(confirmSwitch)}
        onCancel={() => setConfirmSwitch(null)}
      />
      <ConfirmDialog
        open={confirmRemove !== null}
        title={`Remove ${confirmRemove?.name ?? ''} from the list?`}
        body="Only the entry is removed. The project folder, its files and its database stay where they are, and you can add the folder again later."
        confirmLabel="Remove from list"
        onConfirm={() => confirmRemove && void remove(confirmRemove)}
        onCancel={() => setConfirmRemove(null)}
      />
    </>
  );
}
