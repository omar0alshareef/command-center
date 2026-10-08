// Project root resolution. M0: env only. Saved setting and folder picker come later (M2).
export function resolveProjectRoot(env: NodeJS.ProcessEnv): string | null {
  const root = env['PROJECT_ROOT']?.trim();
  return root ? root : null;
}
