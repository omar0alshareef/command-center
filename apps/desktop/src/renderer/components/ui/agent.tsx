import { Globe, User } from 'lucide-react';
import type { Agent } from '@command-center/core';
import { initials } from '../../lib/derive';

/** Initials always shown so two agents sharing a color stay distinguishable (UI/UX §4.4). */
export function AgentAvatar({
  agent,
  size = 24,
}: {
  agent: Pick<Agent, 'name' | 'color' | 'type'>;
  size?: 20 | 24;
}) {
  const Overlay = agent.type === 'human' ? User : agent.type === 'external' ? Globe : null;
  return (
    <span
      className="relative inline-grid shrink-0 place-items-center rounded-full border font-mono font-semibold"
      style={{
        width: size,
        height: size,
        fontSize: size === 20 ? 9 : 10,
        color: agent.color,
        borderColor: agent.color,
        background: `color-mix(in srgb, ${agent.color} 20%, transparent)`,
      }}
      title={agent.name}
    >
      {initials(agent.name)}
      {Overlay ? (
        <Overlay
          aria-hidden
          size={9}
          className="absolute -right-1 -bottom-1 rounded-full bg-surface text-muted"
        />
      ) : null}
    </span>
  );
}

export function AssigneeChip({
  agent,
}: {
  agent: Pick<Agent, 'name' | 'color' | 'type'> | null | undefined;
}) {
  if (!agent) {
    return (
      <span className="inline-flex items-center rounded-md border border-dashed border-border-strong px-1.5 py-0.5 text-[11px] text-muted">
        Unassigned
      </span>
    );
  }
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 text-[11px]">
      <AgentAvatar agent={agent} size={20} />
      <span className="truncate">{agent.name}</span>
    </span>
  );
}
