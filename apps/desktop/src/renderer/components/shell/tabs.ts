import {
  CalendarDays,
  ClipboardList,
  Cpu,
  GanttChart,
  LayoutGrid,
  Terminal,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { TabId } from '../../store';

export const TABS: readonly { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: 'swim-lane', label: 'Swim Lane', icon: GanttChart },
  { id: 'task-board', label: 'Task Board', icon: LayoutGrid },
  { id: 'agent-hub', label: 'Agent Hub', icon: Cpu },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays },
  { id: 'terminal', label: 'Terminal', icon: Terminal },
  { id: 'planning', label: 'Planning', icon: ClipboardList },
  { id: 'agents', label: 'Agents', icon: Users },
];
