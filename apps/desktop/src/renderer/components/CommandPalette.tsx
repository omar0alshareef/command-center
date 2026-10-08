import { useMemo, useState } from 'react';
import { useApp } from '../store';
import { TABS } from './shell/tabs';
import { Modal } from './ui/overlays';

interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

/** Ctrl/Cmd+K: tabs, settings, theme, and any task or milestone by id or title. */
export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const setOpen = useApp((s) => s.setPaletteOpen);
  // The body mounts only while open (Modal renders children only then), so its state starts fresh.
  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      label="Command palette"
      className="w-[560px] p-3"
    >
      <PaletteBody close={() => setOpen(false)} />
    </Modal>
  );
}

function PaletteBody({ close }: { close: () => void }) {
  const tracker = useApp((s) => s.tracker);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);

  const commands = useMemo<Command[]>(() => {
    const s = useApp.getState;
    const list: Command[] = [
      ...TABS.map((t, i) => ({
        id: `tab-${t.id}`,
        label: `Go to ${t.label}`,
        hint: `Ctrl+${i + 1}`,
        run: () => s().setActiveTab(t.id),
      })),
      {
        id: 'settings',
        label: 'Open settings',
        hint: 'Ctrl+,',
        run: () => s().setSettingsOpen(true),
      },
      {
        id: 'shortcuts',
        label: 'Keyboard shortcuts',
        hint: '?',
        run: () => s().setShortcutsOpen(true),
      },
      { id: 'theme', label: 'Toggle theme', run: () => s().toggleTheme() },
      { id: 'project', label: 'Change project folder…', run: () => void s().chooseProject() },
    ];
    for (const m of tracker?.milestones ?? [])
      list.push({
        id: `m-${m.id}`,
        label: `${m.id} ${m.title}`,
        hint: 'Milestone',
        run: () => s().openMilestone(m.id),
      });
    for (const t of tracker?.subtasks ?? [])
      list.push({
        id: `t-${t.id}`,
        label: `${t.id} ${t.label}`,
        hint: t.status,
        run: () => s().setOpenTaskId(t.id),
      });
    return list;
  }, [tracker]);

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return commands
      .filter((c) => words.every((w) => c.label.toLowerCase().includes(w)))
      .slice(0, 50);
  }, [commands, query]);

  const choose = (c: Command | undefined) => {
    if (!c) return;
    close();
    c.run();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = shown.length || 1;
      setIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
    } else if (e.key === 'Enter') choose(shown[index]);
  };

  return (
    <>
      <input
        autoFocus
        role="combobox"
        aria-expanded
        aria-controls="palette-list"
        aria-activedescendant={shown[index] ? `pal-${shown[index].id}` : undefined}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={onKeyDown}
        placeholder="Type a command, task id or milestone…"
        className="mb-2 min-h-9 w-full rounded-md border border-border-strong bg-surface-2 px-3 text-[13px]"
      />
      <ul id="palette-list" role="listbox" className="max-h-80 overflow-auto">
        {shown.map((c, i) => (
          <li
            key={c.id}
            id={`pal-${c.id}`}
            role="option"
            aria-selected={i === index}
            onMouseMove={() => setIndex(i)}
            onClick={() => choose(c)}
            className={`flex cursor-pointer items-center justify-between rounded px-2 py-1.5 text-[13px] ${i === index ? 'bg-surface-3' : ''}`}
          >
            <span className="truncate">{c.label}</span>
            {c.hint ? (
              <span className="ml-3 shrink-0 font-mono text-[11px] text-muted">{c.hint}</span>
            ) : null}
          </li>
        ))}
        {shown.length === 0 ? <li className="px-2 py-3 text-muted">No matches</li> : null}
      </ul>
    </>
  );
}
