import { useEffect } from 'react';
import { FONT_MAX, FONT_MIN, useTerminal } from '../lib/terminal';
import { useApp, type ThemePref, type WeekStart } from '../store';
import { McpConnect } from './McpConnect';
import { PlannerSettings } from './PlannerSettings';
import { Button } from './ui/button';
import { Modal } from './ui/overlays';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-4 py-1.5">
      <span>{label}</span>
      {children}
    </label>
  );
}

const field =
  'min-h-7 rounded-md border border-border-strong bg-surface-2 px-2 text-[12px] text-text';

/** UI/UX §7.4. Preferences persist in the renderer (localStorage); the webhook and MCP blocks are live. */
export function SettingsModal() {
  const open = useApp((s) => s.settingsOpen);
  const set = useApp((s) => s.setSettingsOpen);
  const project = useApp((s) => s.project);
  const chooseProject = useApp((s) => s.chooseProject);
  const themePref = useApp((s) => s.themePref);
  const setThemePref = useApp((s) => s.setThemePref);
  const weekStart = useApp((s) => s.weekStart);
  const setWeekStart = useApp((s) => s.setWeekStart);
  const notifications = useApp((s) => s.notifications);
  const setNotifications = useApp((s) => s.setNotifications);
  const t = useTerminal();

  useEffect(() => {
    if (open) void t.init();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- init is idempotent; run on open only
  }, [open]);

  return (
    <Modal open={open} onClose={() => set(false)} label="Settings" className="w-[640px] p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display text-[16px] font-semibold">Settings</h2>
        <Button variant="ghost" onClick={() => set(false)}>
          Close
        </Button>
      </div>
      <div className="flex max-h-[70vh] flex-col gap-4 overflow-auto pr-1 text-[13px]">
        <section aria-label="General">
          <div className="flex items-center justify-between gap-3 py-1.5">
            <span className="font-mono text-[12px] break-all">
              Project folder: {project?.root ?? 'none'}
            </span>
            <Button onClick={() => void chooseProject()}>Change…</Button>
          </div>
          <Row label="Theme">
            <select
              className={field}
              value={themePref}
              onChange={(e) => setThemePref(e.target.value as ThemePref)}
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="calm">Calm</option>
              <option value="system">System</option>
            </select>
          </Row>
          <Row label="Week starts on">
            <select
              className={field}
              value={weekStart}
              onChange={(e) => setWeekStart(e.target.value as WeekStart)}
            >
              <option value="mon">Monday</option>
              <option value="sun">Sunday</option>
            </select>
          </Row>
          <Row label="Notify when a task enters Review or Blocked (window unfocused)">
            <input
              type="checkbox"
              className="switch"
              checked={notifications}
              onChange={(e) => setNotifications(e.target.checked)}
            />
          </Row>
        </section>
        <section aria-label="Terminal">
          <Row label="Default shell">
            <select
              className={field}
              value={t.defaultShell ?? ''}
              onChange={(e) => t.setDefaultShell(e.target.value || null)}
            >
              <option value="">Detected default</option>
              {t.shells.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Terminal font size">
            <input
              type="number"
              className={`${field} w-20`}
              min={FONT_MIN}
              max={FONT_MAX}
              value={t.fontSize}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) t.changeFont(Math.round(n) - t.fontSize);
              }}
            />
          </Row>
        </section>
        <PlannerSettings open={open} />
        <section aria-label="Connections">
          <McpConnect showFolder={false} />
        </section>
      </div>
    </Modal>
  );
}
