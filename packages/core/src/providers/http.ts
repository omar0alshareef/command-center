import { ProviderError, redact, type ProviderEnv, type ProviderRunInput } from './types';

/** POST JSON and parse the reply. Maps timeouts, cancellation and HTTP errors to ProviderError; keys never appear in messages. */
export async function postJson(
  env: ProviderEnv,
  url: string,
  o: {
    headers: Record<string, string>;
    body: unknown;
    input: Pick<ProviderRunInput, 'signal' | 'timeoutMs'>;
    secrets?: (string | null)[];
  },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const secrets = o.secrets ?? [];
  const signal = AbortSignal.any([o.input.signal, AbortSignal.timeout(o.input.timeoutMs)]);
  let res: Response;
  try {
    res = await env.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...o.headers },
      body: JSON.stringify(o.body),
      signal,
    });
  } catch (e) {
    if (o.input.signal.aborted) throw new ProviderError('cancelled', 'Cancelled.');
    if (e instanceof Error && (e.name === 'TimeoutError' || signal.aborted))
      throw new ProviderError(
        'timeout',
        `Timed out after ${Math.round(o.input.timeoutMs / 1000)} s.`,
      );
    throw new ProviderError('failed', redact(e instanceof Error ? e.message : String(e), secrets));
  }
  const text = await res.text().catch(() => '');
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    if (res.ok)
      throw new ProviderError('bad_response', 'The provider did not reply with JSON.', res.status);
  }
  if (!res.ok) {
    const err = json['error'];
    const message =
      typeof err === 'string'
        ? err
        : typeof (err as { message?: unknown } | undefined)?.message === 'string'
          ? (err as { message: string }).message
          : text.slice(0, 300);
    throw new ProviderError(
      'failed',
      redact(`HTTP ${res.status}: ${message}`, secrets),
      res.status,
    );
  }
  return { status: res.status, json };
}

export const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
