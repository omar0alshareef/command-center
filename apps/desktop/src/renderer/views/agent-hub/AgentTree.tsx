import { ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Agent } from '@command-center/core';
import { AgentAvatar } from '../../components/ui/agent';
import { StatusDot, Tag } from '../../components/ui/badges';
import { ContextMenu } from '../../components/ui/menu';
import { agentState, buildTree, type AgentState } from '../../lib/agent-hub';
import { useNow } from '../../lib/hooks';
import { relativeTime } from '../../lib/time';
import { useApp } from '../../store';
import { toast } from '../../toast';

const STATE_META: Record<AgentState, { label: string; color: string }> = {
  active: { label: 'ACTIVE', color: 'var(--success)' },
  idle: { label: 'IDLE', color: 'var(--muted)' },
  error: { label: 'ERROR', color: 'var(--danger)' },
};

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
        className={`flex min-w-0 flex-1 items-start gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors hover:bg-surface-2 ${selected ? 'border-accent bg-surface-2' : 'border-transparent'}`}
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
