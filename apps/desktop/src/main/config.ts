// Project root resolution: env -> saved setting -> null (renderer shows the folder picker).
export function resolveProjectRoot(env: NodeJS.ProcessEnv, saved?: string | null): string | null {
  const fromEnv = env['PROJECT_ROOT']?.trim();
  if (fromEnv) return fromEnv;
  return saved?.trim() || null;
}
