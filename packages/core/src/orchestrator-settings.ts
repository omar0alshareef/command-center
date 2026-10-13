import { z } from 'zod';
import { write, type Db } from './db';
import { logAction } from './queries';

// Orchestrator controls and the D28 ceilings, kept in the `settings` table so the app, the CLI and the MCP server all
// see and change the same values.

export const ORCH_MODES = ['off', 'running', 'paused', 'draining'] as const;
/** off = never switched on; running = dispatching; paused = no new runs; draining = "stop after the current run". */
export type OrchMode = (typeof ORCH_MODES)[number];

const MODE_KEY = 'orchestrator.mode';
const CONFIG_KEYS = {
  maxConcurrent: 'orchestrator.max_concurrent',
  maxPerHour: 'orchestrator.max_per_hour',
  dailySpendUsd: 'orchestrator.daily_spend_usd',
  runTimeoutMin: 'orchestrator.run_timeout_min',
  autoReview: 'orchestrator.auto_review',
} as const;

export interface OrchestratorConfig {
  /** Runs at once, across all agents (default 2). */
  maxConcurrent: number;
  /** Runs started in any rolling hour (default 20). */
  maxPerHour: number;
  /** Estimated spend per local day, in USD; 0 = no ceiling (default 5). */
  dailySpendUsd: number;
  /** One run is given up after this many minutes (default 15). */
  runTimeoutMin: number;
  /** After a task reaches Review, dispatch a different agent to review it (D29). Off by default: the operator reviews. */
  autoReview: boolean;
}

export const ORCH_DEFAULTS: OrchestratorConfig = {
  maxConcurrent: 2,
  maxPerHour: 20,
  dailySpendUsd: 5,
  runTimeoutMin: 15,
  autoReview: false,
};

const ConfigPatchSchema = z
  .strictObject({
    maxConcurrent: z.number().int().min(1).max(16),
    maxPerHour: z.number().int().min(1).max(1000),
    dailySpendUsd: z.number().min(0).max(100_000),
    runTimeoutMin: z.number().int().min(1).max(240),
    autoReview: z.boolean(),
  })
  .partial();

function read(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    { value: string } | undefined;
  return row?.value ?? null;
}
const put = (db: Db, key: string, value: string) =>
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);

export function getOrchestratorConfig(db: Db): OrchestratorConfig {
  const n = (key: string, fallback: number) => {
    const v = Number(read(db, key));
    return read(db, key) !== null && Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  return {
    maxConcurrent: n(CONFIG_KEYS.maxConcurrent, ORCH_DEFAULTS.maxConcurrent) || 1,
    maxPerHour: n(CONFIG_KEYS.maxPerHour, ORCH_DEFAULTS.maxPerHour) || 1,
    dailySpendUsd: n(CONFIG_KEYS.dailySpendUsd, ORCH_DEFAULTS.dailySpendUsd),
    runTimeoutMin: n(CONFIG_KEYS.runTimeoutMin, ORCH_DEFAULTS.runTimeoutMin) || 1,
    autoReview: read(db, CONFIG_KEYS.autoReview) === '1',
  };
}

export function setOrchestratorConfig(
  db: Db,
  rawPatch: unknown,
  actor = 'operator',
): OrchestratorConfig {
  const patch = ConfigPatchSchema.parse(rawPatch);
  return write(db, () => {
    for (const [field, value] of Object.entries(patch))
      put(
        db,
        CONFIG_KEYS[field as keyof typeof CONFIG_KEYS],
        typeof value === 'boolean' ? (value ? '1' : '0') : String(value),
      );
    if (Object.keys(patch).length > 0)
      logAction(db, {
        agentId: actor,
        action: 'orchestrator_config_changed',
        description: `Orchestrator limits: ${Object.entries(patch)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ')}`,
        tags: ['orchestrator'],
      });
    return getOrchestratorConfig(db);
  });
}

export function getOrchestratorMode(db: Db): OrchMode {
  const m = read(db, MODE_KEY);
  return (ORCH_MODES as readonly string[]).includes(m ?? '') ? (m as OrchMode) : 'off';
}

export function setOrchestratorMode(db: Db, mode: OrchMode, actor = 'operator'): OrchMode {
  return write(db, () => {
    const before = getOrchestratorMode(db);
    if (before === mode) return mode;
    put(db, MODE_KEY, mode);
    logAction(db, {
      agentId: actor,
      action: 'orchestrator_mode_changed',
      description: `Orchestrator: ${before} -> ${mode}`,
      tags: ['orchestrator'],
    });
    return mode;
  });
}
