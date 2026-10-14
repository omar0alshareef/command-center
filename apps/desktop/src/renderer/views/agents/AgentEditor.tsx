import { useEffect, useState } from 'react';
import type { AgentTemplate, AgentVersion } from '@command-center/core';
import type { LibraryAgentView } from '../../../shared/ipc';
import { Button } from '../../components/ui/button';
import { Modal } from '../../components/ui/overlays';
import { PROVIDER_ORDER, providerLabel, useProviderModels } from '../../lib/orchestrator';
import { formatDate } from '../../lib/time';
import { toast } from '../../toast';

const field =
  'mt-0.5 w-full rounded-md border border-border-strong bg-surface px-2 py-1 text-[12px] text-text';

interface Draft {
  name: string;
  role: string;
  type: 'orchestrator' | 'sub-agent' | 'human' | 'external';
  executor: 'agent' | 'external' | 'human';
  tool: string;
  provider: string;
  model: string;
  color: string;
  base_instructions: string;
  permissions: string;
}

const blank: Draft = {
  name: '',
  role: 'general',
  type: 'sub-agent',
  executor: 'agent',
  tool: '',
  provider: 'claude-code',
  model: '',
  color: '#6b7bd6',
  base_instructions: '',
  permissions: 'read, write',
};

const fromAgent = (a: LibraryAgentView): Draft => ({
  name: a.name,
  role: a.role,
  type: a.type,
  executor: a.executor,
  tool: a.tool ?? '',
  provider: a.provider ?? 'claude-code',
  model: a.model ?? '',
  color: a.color,
  base_instructions: a.base_instructions,
  permissions: a.default_permissions.join(', '),
});

/** Create or edit one library agent (M15). This dialog and the Agents page are the only place agents are made or changed. */
export function AgentEditor({
  open,
  agent,
  templates,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** The agent being edited, or null to create. */
  agent: LibraryAgentView | null;
  templates: readonly AgentTemplate[];
  onClose: () => void;
  onSaved: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      label={agent ? `Edit ${agent.name}` : 'New agent'}
      className="max-h-[88vh] w-[640px] overflow-auto p-5"
    >
      <EditorBody agent={agent} templates={templates} onClose={onClose} onSaved={onSaved} />
    </Modal>
  );
}

/** Mounted only while the dialog is open, so every opening starts from the agent (or a blank draft). */
function EditorBody({
  agent,
  templates,
  onClose,
  onSaved,
}: {
  agent: LibraryAgentView | null;
  templates: readonly AgentTemplate[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [d, setD] = useState<Draft>(agent ? fromAgent(agent) : blank);
  const [busy, setBusy] = useState(false);
  const [versions, setVersions] = useState<AgentVersion[]>([]);
  const models = useProviderModels(d.provider);

  useEffect(() => {
    if (agent)
      void window.api.library.versions(agent.id).then((r) => {
        if (r.ok) setVersions(r.value);
      });
  }, [agent]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const pickTemplate = (role: string) => {
    const t = templates.find((x) => x.role === role);
    if (!t) return;
    setD((x) => ({
      ...x,
      name: x.name.trim() ? x.name : t.name,
      role: t.role,
      base_instructions: t.instructions,
      permissions: t.permissions.join(', '),
    }));
  };

  const save = async () => {
    if (!d.name.trim()) return toast.error('Give the agent a name.');
    const patch = {
      name: d.name.trim(),
      role: d.role.trim() || 'general',
      type: d.type,
      executor: d.executor,
      tool: d.executor === 'external' ? d.tool.trim() || null : null,
      provider: d.executor === 'agent' && d.provider !== 'claude-code' ? d.provider : null,
      model: d.executor === 'agent' && d.model ? d.model : null,
      color: d.color,
      base_instructions: d.base_instructions,
      default_permissions: d.permissions
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean),
    };
    setBusy(true);
    const res = agent
      ? await window.api.library.update({ id: agent.id, patch })
      : await window.api.library.create(patch);
    setBusy(false);
    if (!res.ok) return toast.error(res.error.message);
    toast.info(
      agent
        ? `${res.value.name} saved. Every project that uses it follows from its next run.`
        : `${res.value.name} added to the library.`,
    );
    onSaved();
    onClose();
  };

  const runs = d.executor === 'agent';
  return (
    <>
      <h2 className="text-[14px] font-semibold">{agent ? `Edit ${agent.name}` : 'New agent'}</h2>
      {!agent ? (
        <label className="mt-3 block text-[11px] text-muted">
          Start from a template (optional)
          <select
            className={field}
            aria-label="Template"
            defaultValue=""
            onChange={(e) => pickTemplate(e.target.value)}
          >
            <option value="">Blank agent</option>
            {templates.map((t) => (
              <option key={t.role} value={t.role}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="block text-[11px] text-muted">
          Name
          <input
            className={field}
            aria-label="Name"
            value={d.name}
            onChange={(e) => set('name', e.target.value)}
          />
        </label>
        <label className="block text-[11px] text-muted">
          Role
          <input
            className={field}
            aria-label="Role"
            list="agent-roles"
            value={d.role}
            onChange={(e) => set('role', e.target.value)}
          />
          <datalist id="agent-roles">
            {templates.map((t) => (
              <option key={t.role} value={t.role} />
            ))}
          </datalist>
        </label>
        <label className="block text-[11px] text-muted">
          Type
          <select
            className={field}
            aria-label="Type"
            value={d.type}
            onChange={(e) => set('type', e.target.value as Draft['type'])}
          >
            <option value="orchestrator">Orchestrator</option>
            <option value="sub-agent">Sub-agent</option>
            <option value="external">External</option>
            <option value="human">Human</option>
          </select>
        </label>
        <label className="block text-[11px] text-muted">
          Who does the work
          <select
            className={field}
            aria-label="Executor"
            value={d.executor}
            onChange={(e) => set('executor', e.target.value as Draft['executor'])}
          >
            <option value="agent">A model (runs automatically)</option>
            <option value="external">An external tool</option>
            <option value="human">A person</option>
          </select>
        </label>
        {d.executor === 'external' ? (
          <label className="col-span-2 block text-[11px] text-muted">
            Tool name
            <input
              className={field}
              aria-label="Tool"
              value={d.tool}
              onChange={(e) => set('tool', e.target.value)}
            />
          </label>
        ) : null}
        {runs ? (
          <>
            <label className="block text-[11px] text-muted">
              Provider
              <select
                className={field}
                aria-label="Provider"
                value={d.provider}
                onChange={(e) => setD((x) => ({ ...x, provider: e.target.value, model: '' }))}
              >
                {PROVIDER_ORDER.map((id) => (
                  <option key={id} value={id}>
                    {providerLabel(id)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[11px] text-muted">
              Model
              <select
                className={field}
                aria-label="Model"
                value={d.model}
                onChange={(e) => set('model', e.target.value)}
              >
                <option value="">Provider default</option>
                {models?.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
                {d.model && !models?.some((m) => m.id === d.model) ? (
                  <option value={d.model}>{d.model} (not on the list)</option>
                ) : null}
              </select>
            </label>
          </>
        ) : null}
        <label className="block text-[11px] text-muted">
          Colour
          <input
            type="color"
            className="mt-0.5 block h-7 w-full rounded-md border border-border-strong bg-surface"
            aria-label="Colour"
            value={d.color}
            onChange={(e) => set('color', e.target.value)}
          />
        </label>
        <label className="block text-[11px] text-muted">
          Default permissions (comma separated)
          <input
            className={field}
            aria-label="Default permissions"
            value={d.permissions}
            onChange={(e) => set('permissions', e.target.value)}
          />
        </label>
      </div>
      <label className="mt-3 block text-[11px] text-muted">
        Base instructions (the agent's profile, read first on every run)
        <textarea
          className={field}
          rows={8}
          aria-label="Base instructions"
          value={d.base_instructions}
          onChange={(e) => set('base_instructions', e.target.value)}
        />
      </label>
      {agent && versions.length > 0 ? (
        <details className="mt-3 text-[12px]">
          <summary className="cursor-pointer text-muted">
            History ({versions.length} versions)
          </summary>
          <ul className="mt-1 space-y-0.5">
            {versions.map((v) => (
              <li key={v.version} className="text-muted">
                v{v.version} · {formatDate(v.created_at)} · {v.changed_by}
                {v.note ? ` · ${v.note}` : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy} onClick={() => void save()}>
          {agent ? 'Save' : 'Create agent'}
        </Button>
      </div>
    </>
  );
}
