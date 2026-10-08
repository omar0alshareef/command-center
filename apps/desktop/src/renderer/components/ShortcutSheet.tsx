import { useApp } from '../store';
import { Modal } from './ui/overlays';

const MOD = window.api.platform === 'darwin' ? 'Cmd' : 'Ctrl';

export const SHORTCUTS: readonly [string, string][] = [
  [`${MOD}+K`, 'Command palette'],
  [`${MOD}+1 … 5`, 'Switch tab'],
  [`${MOD}+Tab`, 'Next tab (Shift: previous)'],
  [`${MOD}+,`, 'Settings'],
  ['/', 'Focus search in the current view'],
  ['T', 'Today (Swim Lane / Calendar)'],
  ['[  ]', 'Previous / next milestone'],
  ['← →', 'Previous / next week (Calendar)'],
  ['Space, arrows, Space', 'Lift, move and drop a card (Task Board)'],
  ['Esc', 'Close the top-most overlay'],
  ['?', 'This sheet'],
];

export function ShortcutSheet() {
  const open = useApp((s) => s.shortcutsOpen);
  const set = useApp((s) => s.setShortcutsOpen);
  return (
    <Modal
      open={open}
      onClose={() => set(false)}
      label="Keyboard shortcuts"
      className="w-[480px] p-5"
    >
      <h2 className="mb-3 text-[16px] font-semibold">Keyboard shortcuts</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-[13px]">
        {SHORTCUTS.map(([keys, what]) => (
          <div key={keys} className="contents">
            <dt className="font-mono text-[12px] text-accent-light">{keys}</dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}
