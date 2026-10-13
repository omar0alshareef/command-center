import type { ProviderId } from './types';

// Approximate list prices in USD per million tokens, matched by a substring of the model id. These are ESTIMATES for
// providers that report tokens but not cost; they are labelled "estimate" everywhere they appear (D26). claude-code
// reports its own cost, so it never uses this table. Edit when prices change.
const PRICES: { match: RegExp; input: number; output: number }[] = [
  { match: /haiku/i, input: 1, output: 5 },
  { match: /sonnet/i, input: 3, output: 15 },
  { match: /opus/i, input: 5, output: 25 },
  { match: /gpt.*(mini|nano)/i, input: 0.25, output: 2 },
  { match: /gpt|o[0-9]/i, input: 2.5, output: 10 },
  { match: /gemini.*flash/i, input: 0.3, output: 2.5 },
  { match: /gemini/i, input: 1.25, output: 10 },
];

/** Estimated cost in USD for one run, or null when the model is unknown or no tokens were reported. Local models are free. */
export function estimateCostUsd(
  provider: ProviderId,
  model: string | null,
  inputTokens: number | null,
  outputTokens: number | null,
): number | null {
  if (provider === 'local') return 0;
  if (inputTokens === null && outputTokens === null) return null;
  const price = PRICES.find((p) => (model ?? '').match(p.match));
  if (!price) return null;
  return ((inputTokens ?? 0) * price.input + (outputTokens ?? 0) * price.output) / 1_000_000;
}
