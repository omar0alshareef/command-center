import { ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Agent } from '@command-center/core';
import { AgentAvatar } from '../../components/ui/agent';
import { StatusDot, Tag } from '../../components/ui/badges';
import { ContextMenu } from '../../components/ui/menu';
import { agentState, buildTree, type AgentState } from '../../lib/agent-hub';
import { useNow } from '../../lib/hooks';
import {
  canRoute,
  PROVIDER_ORDER,
  providerAvailable,
  providerLabel,
  useOrch,
  useProviderModels,
} from '../../lib/orchestrator';
import { relativeTime } from '../../lib/time';
import { useApp } from '../../store';
import { toast } from '../../toast';

const STATE_META: Record<AgentState, { label: string; color: string }> = {
  active: { label: 'ACTIVE', color: 'var(--success)' },
  idle: { label: 'IDLE', color: 'var(--muted)' },
  error: { label: 'ERROR', color: 'var(--danger)' },
};

/**
 * Routing for one agent (M14): which provider runs its tasks and on which model. Only text-runner agents have either:
 * agents done by an external tool or by a person show nothing. A provider that is not detected cannot be chosen; a model
 * that was removed from its list stays visible, marked, so nothing changes silently (runs use the provider's default).
 */
function AgentRouting({ agent }: { agent: Agent }) {
  const view = useOrch((s) => s.view);
  const [busy, setBusy] = useState(false);
  const provider = agent.provider ?? 'claude-code';
  const models = useProviderModels(provider);
  if (!canRoute(agent)) return null;
  const stale =
    agent.model !== null &&
    provider !== 'local' &&
    models !== null &&
    !models.some((m) => m.id === agent.model);
  const wrap = async (p: Promise<{ ok: boolean; error?: { message: string } }>) => {
    setBusy(true);
    const r = await p;
    setBusy(false);
    if (!r.ok) toast.error(r.error?.message ?? 'Could not save.');
  };
  const sel =
    'min-w-0 flex-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px] text-text';
  return (
    <div className="mt-1 flex flex-col gap-1 text-[11px] text-muted">
      <label className="flex items-center gap-1.5">
        <span className="w-12">Provider</span>
        <select
          aria-label={`${agent.name} provider`}
          data-agent-provider={agent.id}
          disabled={busy}
          value={provider}
          onChange={(e) =>
            void wrap(
              window.api.agents.setProvider({ agentId: agent.id, provider: e.target.value }),
            )
          }
          className={sel}
        >
          {PROVIDER_ORDER.map((id) => (
            <option key={id} value={id} disabled={id !== provider && !providerAvailable(view, id)}>
              {providerLabel(id)}
              {providerAvailable(view, id) ? '' : ' (not detected)'}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1.5">
        <span className="w-12">Model</span>
        <select
          aria-label={`${agent.name} model`}
          data-agent-model={agent.id}
          disabled={busy || models === null}
          value={agent.model ?? ''}
          onChange={(e) =>
            void wrap(
              window.api.models.setAgentModel({ agentId: agent.id, model: e.target.value || null }),
            )
          }
          title={
            stale
              ? `"${agent.model}" is no longer on the ${providerLabel(provider)} model list; runs use the default.`
              : undefined
          }
          className={sel}
        >
          <option value="">
            {provider === 'claude-code' ? 'CLI default' : 'Provider default'}
          </option>
          {models?.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          {stale ||
          (provider === 'local' && agent.model && !models?.some((m) => m.id === agent.model)) ? (
            <option value={agent.model ?? ''}>{agent.model} (not on the list)</option>
          ) : null}
        </select>
      </label>
    </div>
  );
}

function AgentRow({
  agent,
  now,
  nested,
  collapsible,
  collapsed,
  onToggle,
  onMenu,
}: {
  agent: Agent;
  now: number;
  nested: boolean;
  collapsible: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const filter = useApp((s) => s.hubFilter);
  const setFilter = useApp((s) => s.setHubFilter);
  const state = agentState(agent, now);
  const meta = STATE_META[state];
  const selected = filter === agent.id;
  const perms = agent.permissions;
  return (
    <div className={nested ? 'ml-8 border-l border-border pl-2' : 'flex items-start gap-1'}>
      {!nested ? (
        <button
          type="button"
          onClick={onToggle}
          disabled={!collapsible}
          aria-label={collapsed ? `Expand ${agent.name}` : `Collapse ${agent.name}`}
          aria-expanded={collapsible ? !collapsed : undefined}
          className={`mt-2.5 grid size-5 shrink-0 place-items-center rounded text-muted hover:text-text ${collapsible ? '' : 'invisible'}`}
        >
          {collapsed ? (
            <ChevronRight size={14} aria-hidden />
          ) : (
            <ChevronDown size={14} aria-hidden />
          )}
        </button>
      ) : null}
      <div className="min-w-0 flex-1">
        <button
          type="button"
          aria-pressed={selected}
          data-agent-row={agent.id}
          data-agent-state={state}
          onClick={() => setFilter(selected ? 'all' : agent.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            onMenu(e.clientX, e.clientY);
          }}
          className={`flex w-full min-w-0 items-start gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors hover:bg-surface-2 ${selected ? 'border-accent bg-surface-2' : 'border-transparent'}`}
        >
          <AgentAvatar agent={agent} size={24} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[12px] font-semibold">{agent.name}</span>
              <Tag color={meta.color} className="shrink-0">
                <StatusDot color={meta.color} pulse={state === 'active'} />
                {meta.label}
              </Tag>
            </span>
            <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
              <span>
                {agent.last_action_at ? relativeTime(agent.last_action_at, now) : 'no actions yet'}
              </span>
              <span className="font-mono" title="Actions this session">
                · {agent.session_action_count}
              </span>
            </span>
            {agent.source_model ? (
              <span className="block truncate text-[11px] text-muted">{agent.source_model}</span>
            ) : null}
            {agent.type !== 'human' && agent.id !== 'system' ? (
              <span className="mt-1 flex" data-executor={agent.executor}>
                <Tag>
                  {agent.executor === 'agent'
                    ? 'agent'
                    : agent.executor === 'human'
                      ? 'done by you'
                      : `external · ${agent.tool ?? 'no tool set'}`}
                </Tag>
              </span>
            ) : null}
            {perms.length > 0 ? (
              <span className="mt-1 flex flex-wrap gap-1">
                {perms.slice(0, 3).map((p) => (
                  <Tag key={p}>{p}</Tag>
                ))}
                {perms.length > 3 ? (
                  <span title={perms.slice(3).join(', ')}>
                    <Tag>+{perms.length - 3}</Tag>
                  </span>
                ) : null}
              </span>
            ) : null}
          </span>
        </button>
        <div className="px-2 pb-1">
          <AgentRouting agent={agent} />
        </div>
      </div>
    </div>
  );
}

/** Connected Agents card: orchestrators with indented sub-agents, collapse state persisted. */
export function AgentTree({ agents }: { agents: readonly Agent[] }) {
  const collapsedIds = useApp((s) => s.hubCollapsed);
  const toggle = useApp((s) => s.toggleHubCollapsed);
  const viewTasks = useApp((s) => s.viewAgentTasks);
  const now = useNow();
  const tree = useMemo(() => buildTree(agents), [agents]);
  const [menu, setMenu] = useState<{ agent: Agent; x: number; y: number } | null>(null);

  return (
    <section
      aria-label="Connected agents"
      className="rounded-lg border border-border bg-surface p-3"
    >
      <h2 className="mb-2 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">
        Connected agents
      </h2>
      <div className="flex flex-col gap-0.5" data-agent-tree>
        {tree.map(({ agent, children }) => {
          const collapsed = collapsedIds.includes(agent.id);
          return (
            <div key={agent.id}>
              <AgentRow
                agent={agent}
                now={now}
                nested={false}
                collapsible={children.length > 0}
                collapsed={collapsed}
                onToggle={() => toggle(agent.id)}
                onMenu={(x, y) => setMenu({ agent, x, y })}
              />
              {!collapsed
                ? children.map((c) => (
                    <AgentRow
                      key={c.id}
                      agent={c}
                      now={now}
                      nested
                      collapsible={false}
                      collapsed={false}
                      onToggle={() => undefined}
                      onMenu={(x, y) => setMenu({ agent: c, x, y })}
                    />
                  ))
                : null}
            </div>
          );
        })}
      </div>
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={`Actions for ${menu.agent.name}`}
          onClose={() => setMenu(null)}
          items={[
            { label: 'View tasks', onSelect: () => viewTasks(menu.agent.id) },
            {
              label: 'Copy agent id',
              onSelect: () =>
                void navigator.clipboard
                  .writeText(menu.agent.id)
                  .then(() => toast.info('Agent id copied'))
                  .catch(() => toast.error('Could not copy to the clipboard')),
            },
          ]}
        />
      ) : null}
    </section>
  );
}
