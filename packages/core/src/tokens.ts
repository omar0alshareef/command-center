// Rough token budget used for agent-facing text (ROADMAP risk register: char/4 estimator + a hard
// truncation guard; warn rather than fail).

export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface Capped {
  text: string;
  truncated: boolean;
  /** Estimated tokens of the original text. */
  originalTokens: number;
}

/**
 * Cap `text` at roughly `maxTokens`, cutting at a line boundary and appending a notice that says
 * how much was dropped and what to call for more. The result (notice included) stays within budget.
 */
export function capTokens(text: string, maxTokens: number, moreHint: string): Capped {
  const originalTokens = estimateTokens(text);
  if (originalTokens <= maxTokens) return { text, truncated: false, originalTokens };

  const notice = (dropped: number) =>
    `\n\n[truncated: ~${dropped} of ~${originalTokens} tokens omitted to fit a ${maxTokens}-token budget. ${moreHint}]`;
  const room = Math.max(0, maxTokens * CHARS_PER_TOKEN - notice(originalTokens).length);
  let cut = text.slice(0, room);
  const lastNewline = cut.lastIndexOf('\n');
  if (lastNewline > room * 0.5) cut = cut.slice(0, lastNewline);
  const dropped = originalTokens - estimateTokens(cut);
  return { text: cut + notice(dropped), truncated: true, originalTokens };
}
