import { FolderOpen } from 'lucide-react';
import { useState } from 'react';
import type { ScaffoldPlan } from '../../../shared/ipc';
import { useApp } from '../../store';
import { toast } from '../../toast';
import { Button } from '../ui/button';
import { Modal } from '../ui/overlays';
import { switchNotice } from './ProjectSwitcher';

const input =
  'mt-0.5 w-full rounded-md border border-border-strong bg-surface px-2 py-1 text-[12px] text-text';

/**
 * New project / Open project (M15): pick a folder anywhere, see what would be written, then confirm. Files that exist are
 * never overwritten; if one differs from the template it is shown as a diff and kept unless the operator ticks "replace".
 */
export function NewProjectDialog() {
  const open = useApp((s) => s.newProjectOpen);
  const setOpen = useApp((s) => s.setNewProjectOpen);
  const adopt = useApp((s) => s.adoptProject);
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [repo, setRepo] = useState('');
  const [plan, setPlan] = useState<ScaffoldPlan | null>(null);
  const [replace, setReplace] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setPath('');
    setName('');
    setRepo('');
    setPlan(null);
    setReplace([]);
  };
  const close = () => {
    setOpen(false);
    reset();
  };

  const choose = async (target: 'path' | 'repo') => {
    const r = await window.api.projects.pick();
    if (!r.ok) return toast.error(r.error.message);
    if (!r.value) return;
    if (target === 'path') {
      setPath(r.value);
      setPlan(null);
    } else setRepo(r.value);
  };

  const preview = async () => {
    setBusy(true);
    const res = await window.api.projects.plan({
      path,
      ...(name.trim() ? { name: name.trim() } : {}),
      repoPath: repo.trim() || null,
    });
    setBusy(false);
    if (!res.ok) return toast.error(res.error.message);
    setPlan(res.value);
    setName(res.value.name);
    setReplace([]);
  };

  const confirm = async () => {
    if (!plan) return;
    setBusy(true);
    const res = await window.api.projects.create({
      path: plan.path,
      name: plan.name,
      repoPath: repo.trim() || null,
      replace,
    });
    setBusy(false);
    if (!res.ok) return toast.error(res.error.message);
    toast.info(switchNotice(res.value));
    close();
    await adopt(res.value.info);
  };

  const toggle = (p: string) =>
    setReplace((r) => (r.includes(p) ? r.filter((x) => x !== p) : [...r, p]));

  return (
    <Modal
      open={open}
      onClose={close}
      label="New or open project"
      className="max-h-[86vh] w-[640px] overflow-auto p-5"
    >
      <h2 className="text-[14px] font-semibold">New or open project</h2>
      <p className="mt-1 text-[12px] text-muted">
        Pick any folder. Missing project files are created there; files that already exist are never
        overwritten. The project's database stays in that folder.
      </p>

      <label className="mt-4 block text-[11px] text-muted">
        Project folder
        <span className="mt-0.5 flex gap-2">
          <input
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              setPlan(null);
            }}
            className={input}
            aria-label="Project folder"
            placeholder="C:\\Projects\\my-project"
          />
          <Button onClick={() => void choose('path')} aria-label="Choose folder">
            <FolderOpen size={14} aria-hidden /> Choose…
          </Button>
        </span>
      </label>
      <label className="mt-3 block text-[11px] text-muted">
        Name (optional, taken from project.json or the folder)
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setPlan(null);
          }}
          className={input}
          aria-label="Project name"
        />
      </label>
      <label className="mt-3 block text-[11px] text-muted">
        Code repository (optional: LICENSE is copied from it)
        <span className="mt-0.5 flex gap-2">
          <input
            value={repo}
            onChange={(e) => {
              setRepo(e.target.value);
              setPlan(null);
            }}
            className={input}
            aria-label="Repository folder"
          />
          <Button onClick={() => void choose('repo')} aria-label="Choose repository">
            <FolderOpen size={14} aria-hidden /> Choose…
          </Button>
        </span>
      </label>

      {plan ? (
        <section aria-label="What will be written" className="mt-4" data-scaffold-plan>
          <h3 className="text-[12px] font-semibold">
            {plan.existing ? 'Opening an existing project' : 'Creating a new project'}: {plan.name}
          </h3>
          <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
            {plan.items.map((i) => (
              <li
                key={i.path}
                className="p-2 text-[12px]"
                data-item={i.path}
                data-action={i.action}
              >
                <p className="flex items-center gap-2">
                  <code className="font-mono">{i.path}</code>
                  <span className="text-muted">
                    {i.action === 'create'
                      ? 'will be created'
                      : i.action === 'same'
                        ? 'already there'
                        : 'already there, different'}
                  </span>
                </p>
                {i.diff ? (
                  <>
                    <pre
                      className="mt-1 max-h-40 overflow-auto rounded-md bg-surface-2 p-2 font-mono text-[11px] whitespace-pre-wrap"
                      aria-label={`Differences for ${i.path}`}
                    >
                      {i.diff}
                    </pre>
                    <label className="mt-1 flex items-center gap-2 text-muted">
                      <input
                        type="checkbox"
                        checked={replace.includes(i.path)}
                        onChange={() => toggle(i.path)}
                      />
                      Replace it with the template (otherwise your file is kept)
                    </label>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={close}>Cancel</Button>
        {plan ? (
          <Button variant="primary" disabled={busy} onClick={() => void confirm()}>
            {plan.existing ? 'Open project' : 'Create project'}
          </Button>
        ) : (
          <Button variant="primary" disabled={busy || !path.trim()} onClick={() => void preview()}>
            Review changes
          </Button>
        )}
      </div>
    </Modal>
  );
}
