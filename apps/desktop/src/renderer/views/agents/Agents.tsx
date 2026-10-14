import { Archive, ArchiveRestore, Pencil, Plus, Search, Trash2, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { AgentTemplate } from '@command-center/core';
import type { LibraryAgentView } from '../../../shared/ipc';
import { AgentAvatar } from '../../components/ui/agent';
import { Tag } from '../../components/ui/badges';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/feedback';
import { ConfirmDialog } from '../../components/ui/overlays';
import { ROLE_LABEL, useLibrary } from '../../lib/library';
import { providerLabel } from '../../lib/orchestrator';
import { toast } from '../../toast';
import { AgentEditor } from './AgentEditor';

type StatusFilter = 'active' | 'archived' | 'all';

const unused = (a: LibraryAgentView) => a.usage.links === 0 && a.usage.runs === 0;

/** What deleting would do (D35), said before the operator confirms. */
function deleteBody(a: LibraryAgentView): string {
  const { links, runs, projects } = a.usage;
  if (unused(a))
    return `${a.name} is in no project and has no runs, so it will be deleted for good.`;
  const where = projects.length ? ` (${projects.join(', ')})` : '';
  return `${a.name} is used${where}: ${links} project link${links === 1 ? '' : 's'} and ${runs} recorded run${runs === 1 ? '' : 's'}. It will be archived instead of deleted, so history stays readable. It stops receiving tasks and disappears from pickers.`;
}

/**
 * The Agents page (UI/UX §6.3, M15): the app-wide library. Agents are created and edited only here, then assigned to a
 * project from the Agent Hub. The list is sorted by role; archived agents stay readable.
 */
export function Agents() {
  const agents = useLibrary((s) => s.agents);
  const refresh = useLibrary((s) => s.refresh);
  const [templates, setTemplates] = useState<readonly AgentTemplate[]>([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('active');
  const [role, setRole] = useState('');
  const [editing, setEditing] = useState<LibraryAgentView | 'new' | null>(null);
  const [deleting, setDeleting] = useState<LibraryAgentView | null>(null);

  useEffect(() => {
    void refresh();
    void window.api.library.templates().then((r) => {
      if (r.ok) setTemplates(r.value);
    });
    return window.api.onDbChanged(() => void refresh());
  }, [refresh]);

  const roles = useMemo(
    () => [...new Set((agents ?? []).map((a) => a.role))].sort((a, b) => a.localeCompare(b)),
    [agents],
  );
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const shown = (agents ?? []).filter(
      (a) =>
        (status === 'all' || a.status === status) &&
        (!role || a.role === role) &&
        (!needle ||
          [a.name, a.role, a.id, a.base_instructions].some((f) =>
            f.toLowerCase().includes(needle),
          )),
    );
    const by = new Map<string, LibraryAgentView[]>();
    for (const a of shown) by.set(a.role, [...(by.get(a.role) ?? []), a]);
    return [...by.entries()].sort(([x], [y]) => x.localeCompare(y));
  }, [agents, q, status, role]);

  const act = async (p: Promise<{ ok: boolean; error?: { message: string } }>, done?: string) => {
    const r = await p;
    if (!r.ok) return toast.error(r.error?.message ?? 'Failed.');
    if (done) toast.info(done);
    void refresh();
  };

  const remove = async (a: LibraryAgentView) => {
    setDeleting(null);
    const r = await window.api.library.remove(a.id);
    if (!r.ok) return toast.error(r.error.message);
    toast.info(
      r.value.result === 'deleted'
        ? `${a.name} was deleted.`
        : `${a.name} was archived (it has history).`,
    );
    void refresh();
  };

  return (
    <section aria-label="Agents" className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-6">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto font-display text-[18px] font-semibold">Agents</h1>
        <label className="relative">
          <Search
            size={13}
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted"
          />
          <input
            aria-label="Search agents"
            placeholder="Search agents"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-52 rounded-md border border-border-strong bg-surface py-1 pr-2 pl-7 text-[12px]"
          />
        </label>
        <select
          aria-label="Filter by role"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="rounded-md border border-border-strong bg-surface px-2 py-1 text-[12px]"
        >
          <option value="">All roles</option>
          {roles.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL(r)}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by status"
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusFilter)}
          className="rounded-md border border-border-strong bg-surface px-2 py-1 text-[12px]"
        >
          <option value="active">Active</option>
          <option value="archived">Archived</option>
          <option value="all">All</option>
        </select>
        <Button variant="primary" data-new-agent onClick={() => setEditing('new')}>
          <Plus size={14} aria-hidden /> New agent
        </Button>
      </div>
      <p className="text-[12px] text-muted">
        Agents live here once and can be added to any project from its Agent Hub. Edit an agent here
        and every project follows from its next run.
      </p>

      {agents === null ? (
        <p className="text-muted">Loading…</p>
      ) : groups.length === 0 ? (
        <EmptyState
          icon={Users}
          title={agents.length === 0 ? 'The library is empty' : 'No agents match'}
          help={
            agents.length === 0
              ? 'Create an agent from a template (frontend, backend, reviewer…) or from scratch.'
              : 'Change the search or the filters.'
          }
          {...(agents.length === 0
            ? { action: <Button onClick={() => setEditing('new')}>New agent</Button> }
            : {})}
        />
      ) : (
        groups.map(([r, list]) => (
          <section key={r} aria-label={`${ROLE_LABEL(r)} agents`} data-role-group={r}>
            <h2 className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">
              {ROLE_LABEL(r)}
            </h2>
            <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
              {list.map((a) => (
                <li key={a.id} data-library-agent={a.id} className="flex items-center gap-3 p-3">
                  <AgentAvatar agent={a} />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 font-semibold">
                      <span className="truncate">{a.name}</span>
                      {a.status === 'archived' ? <Tag>Archived</Tag> : null}
                    </p>
                    <p className="truncate text-[11px] text-muted">
                      {a.executor === 'agent'
                        ? `${providerLabel(a.provider)} · ${a.model ?? 'default model'}`
                        : a.executor === 'external'
                          ? `External: ${a.tool ?? 'tool'}`
                          : 'Done by a person'}
                      {' · '}
                      {a.usage.links} project{a.usage.links === 1 ? '' : 's'} · {a.usage.runs} run
                      {a.usage.runs === 1 ? '' : 's'}
                    </p>
                  </div>
                  <Button aria-label={`Edit ${a.name}`} onClick={() => setEditing(a)}>
                    <Pencil size={13} aria-hidden /> Edit
                  </Button>
                  {a.status === 'active' ? (
                    <Button
                      variant="ghost"
                      aria-label={`Archive ${a.name}`}
                      title="Archive"
                      onClick={() =>
                        void act(window.api.library.archive(a.id), `${a.name} archived.`)
                      }
                    >
                      <Archive size={14} aria-hidden />
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      aria-label={`Restore ${a.name}`}
                      title="Restore"
                      onClick={() =>
                        void act(window.api.library.restore(a.id), `${a.name} restored.`)
                      }
                    >
                      <ArchiveRestore size={14} aria-hidden />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    aria-label={`Delete ${a.name}`}
                    title="Delete"
                    onClick={() => setDeleting(a)}
                  >
                    <Trash2 size={14} aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      <AgentEditor
        open={editing !== null}
        agent={editing === 'new' ? null : editing}
        templates={templates}
        onClose={() => setEditing(null)}
        onSaved={() => void refresh()}
      />
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${deleting?.name ?? ''}?`}
        body={deleting ? deleteBody(deleting) : ''}
        confirmLabel={deleting && unused(deleting) ? 'Delete' : 'Archive'}
        onConfirm={() => deleting && void remove(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </section>
  );
}
