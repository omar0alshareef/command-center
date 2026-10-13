import { useState } from 'react';
import { useClaudeModels } from '../lib/hooks';
import { toast } from '../toast';
import { Button } from './ui/button';

const DEFAULT_ROWS = (list: readonly { id: string; label: string }[]) =>
  JSON.stringify(list, null, 2);

/**
 * Settings → Claude Code models. The list the agents' model dropdowns offer is a project setting kept as a JSON
 * array of `{ id, label }`; `id` is what is passed to `claude --model` (an alias such as `sonnet`, or a full model name).
 */
export function ModelListSettings() {
  const models = useClaudeModels();
  // `edit` is the operator's unsaved text; null means "show the stored list".
  const [edit, setEdit] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = models ? DEFAULT_ROWS(models) : '';
  const text = edit ?? current;

  const save = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setError(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    setBusy(true);
    const r = await window.api.models.setList(parsed as { id: string; label: string }[]);
    setBusy(false);
    if (!r.ok) return setError(r.error.message);
    setError(null);
    setEdit(DEFAULT_ROWS(r.value));
    toast.info('Model list saved');
  };

  const dirty = edit !== null && edit !== current;
  return (
    <section aria-label="Claude Code models" className="flex flex-col gap-1">
      <h3 className="text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">
        Claude Code models
      </h3>
      <p className="text-[12px] text-muted">
        The models an agent can run on (Agent Hub → Model). <code>id</code> is passed to{' '}
        <code>claude --model</code>: an alias such as <code>sonnet</code> or a full model name. An
        agent left on "CLI default" gets no flag.
      </p>
      <label htmlFor="model-list" className="sr-only">
        Model list as JSON
      </label>
      <textarea
        id="model-list"
        rows={6}
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setEdit(e.target.value);
          setError(null);
        }}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'model-list-error' : undefined}
        className="w-full rounded-md border border-border bg-surface-2 p-2 font-mono text-[12px]"
      />
      {error ? (
        <p id="model-list-error" role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button
          disabled={!dirty || busy}
          onClick={() => {
            setEdit(null);
            setError(null);
          }}
        >
          Revert
        </Button>
        <Button variant="primary" disabled={!dirty || busy} onClick={() => void save()}>
          Save list
        </Button>
      </div>
    </section>
  );
}
