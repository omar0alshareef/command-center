import type { ReactNode } from 'react';
import type { TrackerState } from '@command-center/core';
import type { TabId } from '../store';
import { AgentHub } from './agent-hub/AgentHub';
import { Agents } from './agents/Agents';
import { Calendar } from './calendar/Calendar';
import { Planning } from './planning/Planning';
import { SwimLane } from './swim-lane/SwimLane';
import { TaskBoard } from './task-board/TaskBoard';

// The Terminal tab is not here: its sessions must outlive tab switches, so App keeps `TerminalPanel` mounted.
const VIEWS: Record<TabId, ((t: TrackerState) => ReactNode) | null> = {
  'swim-lane': (t) => <SwimLane tracker={t} />,
  'task-board': (t) => <TaskBoard tracker={t} />,
  'agent-hub': (t) => <AgentHub tracker={t} />,
  calendar: (t) => <Calendar tracker={t} />,
  terminal: null,
  planning: () => <Planning />,
  agents: () => <Agents />,
};

export function ActiveView({ tab, tracker }: { tab: TabId; tracker: TrackerState }) {
  return <>{VIEWS[tab]?.(tracker) ?? null}</>;
}
