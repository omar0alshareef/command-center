import { useCallback, useEffect, useState } from 'react';
import type { PlanningDocument } from '@command-center/core';
import type { PlannerSettings as Settings } from '../../shared/ipc';
import { toast } from '../toast';
import { Button } from './ui/button';
import { Markdown } from './ui/markdown';
import { Modal } from './ui/overlays';

const field =
  'min-h-7 rounded-md border border-border-strong bg-surface-2 px-2 text-[12px] text-text';

const fetchAll = () =>
  Promise.all([window.api.planning.settings(), window.api.planning.approvedDocuments()]);

/** Settings → Planner (D19): which runner drafts plans, and the approved manifesto and roadmap. */
export function PlannerSettings({ open }: { open: boolean }) {
  const [s, setS] = useState<Settings | null>(null);
  const [docs, setDocs] = useState<PlanningDocument[]>([]);
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [viewing, setViewing] = useState<PlanningDocument | null>(null);

  const apply = useCallback(([r, d]: Awaited<ReturnType<typeof fetchAll>>) => {
    if (r.ok) {
      setS(r.value);
      setModel(r.value.model ?? '');
    }
    setDocs(d.ok ? d.value : []);
  }, []);
  const load = () => fetchAll().then(apply);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void fetchAll().then((x) => live && apply(x));
    return () => {
      live = false;
    };
  }, [open, apply]);

  const update = async (patch: Parameters<typeof window.api.planning.setSettings>[0]) => {
    const r = await window.api.planning.setSettings(patch);
    if (!r.ok) toast.error(r.error.message);
    await load();
  };
  if (!s) return null;
  const manifesto = docs.find((d) => d.kind === 'manifesto');
  const roadmap = docs.find((d) => d.kind === 'roadmap');

  return (
    <section aria-label="Planner" className="flex flex-col gap-1">
      <h3 className="text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">Planner</h3>
      <label className="flex items-center justify-between gap-4 py-1.5">
        <span>Runner</span>
        <select
          className={field}
          value={s.runner}
          onChange={(e) => void update({ runner: e.target.value as Settings['runner'] })}
        >
          <option value="claude-code">Claude Code CLI{s.claudeFound ? '' : ' (not found)'}</option>
          <option value="anthropic-api">Anthropic API key</option>
        </select>
      </label>
      <label className="flex items-center justify-between gap-4 py-1.5">
        <span>Model (optional)</span>
        <input
          className={`${field} w-56`}
          value={model}
          placeholder="runner default"
          onChange={(e) => setModel(e.target.value)}
          onBlur={() => model !== (s.model ?? '') && void update({ model: model || null })}
        />
      </label>
      {s.runner === 'anthropic-api' ? (
        <form
          className="flex items-center justify-between gap-4 py-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!key.trim()) return;
            void update({ apiKey: key }).then(() => setKey(''));
          }}
        >
          <label htmlFor="planner-key">
            API key{' '}
            <span className="text-muted">
              {s.keySet ? `set (…${s.keySuffix})` : 'not set'}
              {s.encrypted ? '' : ' · OS encryption unavailable'}
            </span>
          </label>
          <span className="flex gap-2">
            <input
              id="planner-key"
              type="password"
              autoComplete="off"
              className={`${field} w-56`}
              value={key}
              placeholder={s.keySet ? 'replace key' : 'sk-ant-…'}
              onChange={(e) => setKey(e.target.value)}
            />
            <Button type="submit" disabled={!key.trim()}>
              Save
            </Button>
            {s.keySet ? <Button onClick={() => void update({ apiKey: null })}>Clear</Button> : null}
          </span>
        </form>
      ) : null}
      <div className="flex items-center justify-between gap-4 py-1.5">
        <span>Approved plan</span>
        <span className="flex gap-2">
          {manifesto || roadmap ? (
            <>
              <Button disabled={!manifesto} onClick={() => setViewing(manifesto ?? null)}>
                Manifesto
              </Button>
              <Button disabled={!roadmap} onClick={() => setViewing(roadmap ?? null)}>
                Roadmap
              </Button>
            </>
          ) : (
            <span className="text-muted">None yet: approve a plan in the Planning tab</span>
          )}
        </span>
      </div>
      <Modal
        open={Boolean(viewing)}
        onClose={() => setViewing(null)}
        label={viewing?.kind ?? 'Document'}
        className="w-[760px] p-5"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[14px] font-semibold capitalize">
            {viewing?.kind}{' '}
            <span className="font-mono text-[12px] text-muted">v{viewing?.version}</span>
          </h2>
          <Button variant="ghost" onClick={() => setViewing(null)}>
            Close
          </Button>
        </div>
        <div className="max-h-[70vh] overflow-auto">
          {viewing ? <Markdown source={viewing.content} /> : null}
        </div>
      </Modal>
    </section>
  );
}
