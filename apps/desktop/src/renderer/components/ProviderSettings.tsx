import { useEffect, useState } from 'react';
import type { OrchestratorConfig } from '@command-center/core';
import type { ProviderInfo } from '../../shared/ipc';
import { providerLabel, useOrch, useProviderModels } from '../lib/orchestrator';
import { toast } from '../toast';
import { OrchestratorControls } from './run/OrchestratorControls';
import { Button } from './ui/button';
import { StatusDot } from './ui/badges';

const input =
  'min-h-7 rounded-md border border-border-strong bg-surface-2 px-2 text-[12px] text-text';

/** The editable `{ id, label }` list one provider's agents choose their model from (the id is what the provider is called with). */
function ModelListEditor({ provider }: { provider: string }) {
  const models = useProviderModels(provider);
  const [edit, setEdit] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = models ? JSON.stringify(models, null, 2) : '';
  const text = edit ?? current;
  const dirty = edit !== null && edit !== current;
  const save = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return setError(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    setBusy(true);
    const r = await window.api.models.setList({
      provider,
      list: parsed as { id: string; label: string }[],
    });
    setBusy(false);
    if (!r.ok) return setError(r.error.message);
    setError(null);
    setEdit(JSON.stringify(r.value, null, 2));
    toast.info(`${providerLabel(provider)} model list saved`);
  };
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={`model-list-${provider}`} className="text-[12px] text-muted">
        Models agents can choose. Fetched from the provider when a key is set; this list is the fallback (<code>id</code> is sent to the provider)
      </label>
      <textarea
        id={`model-list-${provider}`}
        rows={4}
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setEdit(e.target.value);
          setError(null);
        }}
        aria-invalid={error ? true : undefined}
        className="w-full rounded-md border border-border bg-surface-2 p-2 font-mono text-[12px]"
      />
      {error ? (
        <p role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button disabled={!dirty || busy} onClick={() => (setEdit(null), setError(null))}>
          Revert
        </Button>
        <Button
          variant="primary"
          disabled={!dirty || busy}
          data-save-models={provider}
          onClick={() => void save()}
        >
          Save list
        </Button>
      </div>
    </div>
  );
}

function ProviderCard({ info, onChange }: { info: ProviderInfo; onChange: () => void }) {
  const [key, setKey] = useState('');
  const [url, setUrl] = useState(info.baseUrl ?? '');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const hasKeyField = info.needsKey || info.keyOptional;
  const apply = async (p: ReturnType<typeof window.api.providers.setKey>) => {
    const r = await p;
    if (!r.ok) toast.error(r.error.message);
    onChange();
  };
  return (
    <section
      aria-label={info.label}
      data-provider={info.id}
      className="flex flex-col gap-2 rounded-lg border border-border p-3"
    >
      <div className="flex items-center gap-2">
        <StatusDot color={info.available ? 'var(--success)' : 'var(--muted)'} />
        <h4 className="text-[13px] font-semibold">{info.label}</h4>
        <span
          className="text-[12px] text-muted"
          data-provider-state={info.available ? 'detected' : 'not-detected'}
        >
          {info.available ? 'Detected' : 'Not detected'}
        </span>
        <span className="flex-1" />
        <Button
          disabled={testing || !info.available}
          onClick={async () => {
            setTesting(true);
            setResult(null);
            const r = await window.api.providers.test(info.id);
            setTesting(false);
            setResult(r.ok ? r.value : { ok: false, detail: r.error.message });
          }}
        >
          {testing ? 'Testing…' : 'Test connection'}
        </Button>
      </div>
      <p className="text-[12px] text-muted">{info.detail}</p>
      {result ? (
        <p
          role="status"
          className={`text-[12px] ${result.ok ? 'text-success' : 'text-danger'}`}
          data-test-result
        >
          {result.ok ? '✓ ' : '✗ '}
          {result.detail}
        </p>
      ) : null}
      {hasKeyField ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!key.trim()) return;
            void apply(window.api.providers.setKey({ id: info.id, key })).then(() => setKey(''));
          }}
        >
          <label htmlFor={`key-${info.id}`} className="w-40 text-[12px]">
            API key{' '}
            <span className="text-muted">
              {info.keySet ? `set (…${info.keySuffix})` : info.keyOptional ? 'optional' : 'not set'}
            </span>
          </label>
          <input
            id={`key-${info.id}`}
            type="password"
            autoComplete="off"
            className={`${input} min-w-0 flex-1`}
            value={key}
            placeholder={info.keySet ? 'replace key' : 'paste key'}
            onChange={(e) => setKey(e.target.value)}
          />
          <Button type="submit" disabled={!key.trim()}>
            Save
          </Button>
          {info.keySet ? (
            <Button
              onClick={() => void apply(window.api.providers.setKey({ id: info.id, key: null }))}
            >
              Remove
            </Button>
          ) : null}
        </form>
      ) : null}
      {info.kind !== 'cli' || info.id === 'gemini' ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void apply(window.api.providers.setBaseUrl({ id: info.id, url: url.trim() || null }));
          }}
        >
          <label htmlFor={`url-${info.id}`} className="w-40 text-[12px]">
            Base URL <span className="text-muted">optional</span>
          </label>
          <input
            id={`url-${info.id}`}
            className={`${input} min-w-0 flex-1`}
            value={url}
            placeholder={info.id === 'local' ? 'http://localhost:11434' : 'default'}
            onChange={(e) => setUrl(e.target.value)}
          />
          <Button type="submit">Save</Button>
        </form>
      ) : null}
      {info.id !== 'local' ? (
        <ModelListEditor provider={info.id} />
      ) : (
        <p className="text-[12px] text-muted">Models come from the local server.</p>
      )}
    </section>
  );
}

const LIMITS: { key: keyof OrchestratorConfig; label: string; hint: string; step?: string }[] = [
  { key: 'maxConcurrent', label: 'Runs at once', hint: 'across all agents' },
  { key: 'maxPerHour', label: 'Runs per hour', hint: 'rolling hour; reaching it pauses dispatch' },
  {
    key: 'dailySpendUsd',
    label: 'Daily spend ceiling (USD)',
    hint: 'estimate; 0 = no ceiling',
    step: '0.5',
  },
  {
    key: 'runTimeoutMin',
    label: 'Give up on a run after (minutes)',
    hint: 'it is retried once, then the task is blocked',
  },
];

/** Settings → Providers: detection, keys, base URLs, test connection, model lists and the orchestrator's limits (D27, D28). */
export function ProviderSettings({ open }: { open: boolean }) {
  const view = useOrch((s) => s.view);
  const [infos, setInfos] = useState<ProviderInfo[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const load = (refresh: boolean) =>
    window.api.providers.list(refresh).then((r) => {
      if (r.ok) setInfos(r.value);
    });
  useEffect(() => {
    if (open) void load(true);
  }, [open]);
  // Detection results arrive with each orchestrator status push: refresh the cards from them.
  useEffect(() => {
    if (open && view) void load(false);
  }, [open, view?.providers]); // eslint-disable-line react-hooks/exhaustive-deps

  const cfg = view?.config;
  const saveLimit = async (key: keyof OrchestratorConfig, raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return toast.error('Enter a number.');
    const r = await window.api.orchestrator.setConfig({ [key]: n });
    if (!r.ok) toast.error(r.error.message);
    setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== key)));
  };

  return (
    <section aria-label="Providers" className="flex flex-col gap-3">
      <h3 className="text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">
        Providers and orchestrator
      </h3>
      <p className="text-[12px] text-muted">
        Agents run on your computer with the permissions their provider already grants (Claude Code
        may edit files and run the project's npm scripts in the project folder). Command Center does
        not sandbox anything else an agent might do. Keys are stored encrypted on this computer and
        never shown again.
      </p>
      <OrchestratorControls />
      {cfg ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-2" data-orch-limits>
          {LIMITS.map((l) => (
            <label key={l.key} className="flex flex-col gap-0.5 text-[12px]">
              <span>{l.label}</span>
              <input
                type="number"
                min={0}
                step={l.step ?? '1'}
                aria-label={l.label}
                data-limit={l.key}
                className={`${input} w-28`}
                value={drafts[l.key] ?? String(cfg[l.key])}
                onChange={(e) => setDrafts((d) => ({ ...d, [l.key]: e.target.value }))}
                onBlur={(e) => drafts[l.key] !== undefined && void saveLimit(l.key, e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              />
              <span className="text-[11px] text-muted">{l.hint}</span>
            </label>
          ))}
          <label className="col-span-2 flex items-center gap-2 text-[12px]">
            <input
              type="checkbox"
              checked={cfg.autoReview}
              data-limit="autoReview"
              onChange={(e) =>
                void window.api.orchestrator.setConfig({ autoReview: e.target.checked })
              }
            />
            <span>
              After a task reaches Review, have a different agent review it (it never approves its
              own work; off by default, you review)
            </span>
          </label>
        </div>
      ) : null}
      {infos.map((info) => (
        <ProviderCard key={info.id} info={info} onChange={() => void load(false)} />
      ))}
    </section>
  );
}
