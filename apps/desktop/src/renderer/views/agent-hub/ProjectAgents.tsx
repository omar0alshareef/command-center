import { FileText, Plus, UserMinus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { LibraryAgentView, ProjectAgentView } from '../../../shared/ipc';
import { AgentAvatar } from '../../components/ui/agent';
import { Button } from '../../components/ui/button';
import { ConfirmDialog, Modal } from '../../components/ui/overlays';
import { useLibrary, useProjectAgents, useProjectAgentsLive } from '../../lib/library';
import { providerLabel } from '../../lib/orchestrator';
import { toast } from '../../toast';

const field =
  'mt-0.5 w-full rounded-md border border-border-strong bg-surface px-2 py-1 text-[12px] text-text';

/** The library picker: multi-select, shows each agent's role and provider. Archived agents are not offered. */
function Picker({
  open,
  assigned,
  onClose,
}: {
  open: boolean;
  assigned: ReadonlySet<string>;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      label="Add agents from the library"
      className="w-[520px] p-5"
    >
      <PickerBody assigned={assigned} onClose={onClose} />
    </Modal>
  );
}

/** Mounted only while the dialog is open, so its selection starts empty every time. */
function PickerBody({ assigned, onClose }: { assigned: ReadonlySet<string>; onClose: () => void }) {
  const agents = useLibrary((s) => s.agents);
  const refresh = useLibrary((s) => s.refresh);
  const refreshAssigned = useProjectAgents((s) => s.refresh);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const choices = useMemo(
    () => (agents ?? []).filter((a) => a.status === 'active' && !assigned.has(a.id)),
    [agents, assigned],
  );
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const add = async () => {
    setBusy(true);
    const r = await window.api.projectAgents.assign(picked);
    setBusy(false);
    if (!r.ok) return toast.error(r.error.message);
    for (const n of r.value.notes) toast.info(n);
    void refreshAssigned();
    onClose();
  };
  return (
    <>
      <h2 className="text-[14px] font-semibold">Add agents from the library</h2>
      <ul className="mt-3 max-h-[340px] divide-y divide-border overflow-auto rounded-lg border border-border">
        {choices.length === 0 ? (
          <li className="p-4 text-muted">
            {agents && agents.length > 0
              ? 'Every active library agent is already in this project.'
              : 'The library is empty. Create agents on the Agents page first.'}
          </li>
        ) : (
          choices.map((a: LibraryAgentView) => (
            <li key={a.id}>
              <label className="flex cursor-pointer items-center gap-3 p-2.5 hover:bg-surface-2">
                <input
                  type="checkbox"
                  checked={picked.includes(a.id)}
                  onChange={() => toggle(a.id)}
                  aria-label={`Add ${a.name}`}
                />
                <AgentAvatar agent={a} size={20} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{a.name}</span>
                  <span className="block truncate text-[11px] text-muted">
                    {a.role} ·{' '}
                    {a.executor === 'agent'
                      ? providerLabel(a.provider)
                      : a.executor === 'external'
                        ? `external: ${a.tool ?? 'tool'}`
                        : 'person'}
                  </span>
                </span>
              </label>
            </li>
          ))
        )}
      </ul>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || picked.length === 0} onClick={() => void add()}>
          Add {picked.length > 0 ? picked.length : ''} agent{picked.length === 1 ? '' : 's'}
        </Button>
      </div>
    </>
  );
}

/** Per-project settings of one assigned agent: enabled, allowed task types (swim lanes), extra constraints. */
function Settings({ item }: { item: ProjectAgentView }) {
  const refresh = useProjectAgents((s) => s.refresh);
  const a = item.assignment;
  const [types, setTypes] = useState(a.allowed_task_types.join(', '));
  const [constraints, setConstraints] = useState(a.extra_constraints.join('\n'));
  const save = async (patch: Record<string, unknown>) => {
    const r = await window.api.projectAgents.update({ id: a.library_agent_id, patch });
    if (!r.ok) toast.error(r.error.message);
    void refresh();
  };
  const list = (s: string, sep: RegExp) =>
    s
      .split(sep)
      .map((x) => x.trim())
      .filter(Boolean);
  return (
    <div className="mt-2 space-y-2 border-t border-border pt-2">
      <label className="block text-[11px] text-muted">
        Task types it may take (swim lane names, comma separated; empty means any)
        <input
          className={field}
          aria-label={`${item.library.name} allowed task types`}
          value={types}
          onChange={(e) => setTypes(e.target.value)}
          onBlur={() => void save({ allowed_task_types: list(types, /,/) })}
        />
      </label>
      <label className="block text-[11px] text-muted">
        Extra constraints in this project (one per line)
        <textarea
          rows={3}
          className={field}
          aria-label={`${item.library.name} extra constraints`}
          value={constraints}
          onChange={(e) => setConstraints(e.target.value)}
          onBlur={() => void save({ extra_constraints: list(constraints, /\r?\n/) })}
        />
      </label>
    </div>
  );
}

/** The agents assigned to the open project (M15). Agents are created in the library; this is where a project takes them. */
export function ProjectAgentsPanel() {
  const items = useProjectAgentsLive();
  const refresh = useProjectAgents((s) => s.refresh);
  const [picking, setPicking] = useState(false);
  const [removing, setRemoving] = useState<ProjectAgentView | null>(null);
  const assigned = useMemo(() => new Set((items ?? []).map((i) => i.library.id)), [items]);

  const remove = async (i: ProjectAgentView) => {
    setRemoving(null);
    const r = await window.api.projectAgents.remove(i.library.id);
    if (!r.ok) return toast.error(r.error.message);
    toast.info(`${i.library.name} was removed from this project. It stays in the library.`);
    void refresh();
  };
  const openSpec = async () => {
    const r = await window.api.projectAgents.openSpec();
    if (!r.ok) toast.error(r.error.message);
  };

  return (
    <section
      aria-label="Project agents"
      className="rounded-lg border border-border bg-surface p-3"
      data-project-agents
    >
      <div className="mb-2 flex items-center gap-2">
        <h2 className="flex-1 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">
          Project agents
        </h2>
        <Button variant="ghost" onClick={() => void openSpec()} aria-label="Open project spec">
          <FileText size={13} aria-hidden /> Project spec
        </Button>
        <Button
          onClick={() => setPicking(true)}
          aria-label="Add agents from the library"
          data-add-agents
        >
          <Plus size={13} aria-hidden /> Add
        </Button>
      </div>
      {items === null ? (
        <p className="text-muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-[12px] text-muted">
          No library agents in this project yet. Use Add to pick from the library; create new agents
          on the Agents page.
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((i) => (
            <li
              key={i.library.id}
              data-project-agent={i.library.id}
              className="rounded-md border border-border p-2"
            >
              <div className="flex items-center gap-2">
                <AgentAvatar agent={i.library} size={20} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{i.library.name}</span>
                  <span className="block truncate text-[11px] text-muted">
                    {i.library.role}
                    {i.library.status === 'archived' ? ' · archived in the library' : ''}
                  </span>
                </span>
                <label className="flex items-center gap-1.5 text-[11px] text-muted">
                  <input
                    type="checkbox"
                    checked={i.assignment.enabled}
                    aria-label={`${i.library.name} enabled in this project`}
                    onChange={(e) =>
                      void window.api.projectAgents
                        .update({ id: i.library.id, patch: { enabled: e.target.checked } })
                        .then((r) => {
                          if (!r.ok) toast.error(r.error.message);
                          void refresh();
                        })
                    }
                  />
                  Enabled
                </label>
                <Button
                  variant="ghost"
                  aria-label={`Remove ${i.library.name} from this project`}
                  title="Remove from this project"
                  onClick={() => setRemoving(i)}
                >
                  <UserMinus size={14} aria-hidden />
                </Button>
              </div>
              <details className="mt-1">
                <summary className="cursor-pointer text-[11px] text-muted">
                  Project settings
                </summary>
                <Settings
                  key={`${i.assignment.allowed_task_types.join()}|${i.assignment.extra_constraints.join()}`}
                  item={i}
                />
              </details>
            </li>
          ))}
        </ul>
      )}
      <Picker open={picking} assigned={assigned} onClose={() => setPicking(false)} />
      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.library.name ?? ''} from this project?`}
        body="Only the link is removed. The agent stays in the library and keeps its history. If you add it back, its project settings are restored."
        confirmLabel="Remove from project"
        onConfirm={() => removing && void remove(removing)}
        onCancel={() => setRemoving(null)}
      />
    </section>
  );
}
