import { safeStorage } from 'electron';
import {
  abandonPlanningSession,
  answerPlanningQuestion,
  approvePlan,
  createPlanningSession,
  findClaude,
  getPlanningDocuments,
  getPlanningSession,
  listPlanningSessions,
  PLANNING_KINDS,
  savePlanningDocument,
  savePlanningProposal,
  validatePlan,
  type Db,
} from '@command-center/core';
import { z } from 'zod';
import type { PlannerEvent, PlannerSettings, Result } from '../shared/ipc';
import { Planner, type PlannerSettingsStore } from './planner';
import { run } from './task-api';

// Planning IPC. Drafts go to the planning tables only; `approve` is the one call that writes the board,
// and it exists only here (operator UI), never in the MCP server.

const KEY = { runner: 'planner.runner', model: 'planner.model', apiKey: 'planner.api_key' };
const Id = z.string().min(1).max(64);

function readSetting(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    { value: string } | undefined;
  return row?.value ?? null;
}
function writeSetting(db: Db, key: string, value: string | null): void {
  if (value === null) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

/** Keys are encrypted with the OS keychain when available (D25 applied early) and never leave main. */
function readKey(db: Db): string | null {
  const v = readSetting(db, KEY.apiKey);
  if (!v) return null;
  if (v.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
  return v.startsWith('raw:') ? v.slice(4) : v;
}

function storeSettings(db: Db): PlannerSettingsStore {
  return {
    runner: readSetting(db, KEY.runner) === 'anthropic-api' ? 'anthropic-api' : 'claude-code',
    model: readSetting(db, KEY.model),
    apiKey: readKey(db),
  };
}

const SettingsPatch = z
  .object({
    runner: z.enum(['claude-code', 'anthropic-api']),
    model: z.string().trim().max(80).nullable(),
    apiKey: z.string().trim().max(400).nullable(),
  })
  .partial()
  .strict();

export function planningApi(getDb: () => Db, emit: (e: PlannerEvent) => void) {
  const planner = new Planner(getDb, () => storeSettings(getDb()), emit);
  const start = (id: unknown, fn: (id: string) => Promise<void>): Result<null> =>
    run(() => {
      const sid = Id.parse(id);
      if (planner.active().some((a) => a.sessionId === sid))
        throw new Error('The planner is already running for this session.');
      void fn(sid);
      return null;
    });

  return {
    planner,
    list: () => run(() => listPlanningSessions(getDb())),
    get: (id: unknown) =>
      run(() => {
        const sid = Id.parse(id);
        return {
          ...getPlanningSession(getDb(), sid),
          running: planner.active().find((a) => a.sessionId === sid)?.stage ?? null,
        };
      }),
    create: (req: unknown) =>
      run(() => {
        const r = z.object({ idea: z.string(), title: z.string().optional() }).strict().parse(req);
        const s = createPlanningSession(getDb(), r.idea, r.title);
        void planner.interview(s.id);
        return s;
      }),
    answer: (req: unknown) =>
      run(() => {
        const r = z
          .object({ id: Id, index: z.number().int().min(0), answer: z.string() })
          .strict()
          .parse(req);
        return answerPlanningQuestion(getDb(), r.id, r.index, r.answer);
      }),
    saveDocument: (req: unknown) =>
      run(() => {
        const r = z
          .object({ id: Id, kind: z.enum(PLANNING_KINDS), content: z.string() })
          .strict()
          .parse(req);
        return savePlanningDocument(getDb(), r.id, r.kind, r.content);
      }),
    saveProposal: (req: unknown) =>
      run(() => {
        const r = z.object({ id: Id, proposal: z.unknown() }).strict().parse(req);
        return savePlanningProposal(getDb(), r.id, r.proposal);
      }),
    validate: (id: unknown) =>
      run(() => {
        const p = getPlanningSession(getDb(), Id.parse(id)).proposal;
        return p ? validatePlan(getDb(), p) : ['Nothing drafted yet.'];
      }),
    abandon: (id: unknown) =>
      run(() => {
        const sid = Id.parse(id);
        planner.cancel(sid);
        return abandonPlanningSession(getDb(), sid);
      }),
    approve: (id: unknown) =>
      run(() => {
        const sid = Id.parse(id);
        if (planner.active().some((a) => a.sessionId === sid))
          throw new Error('Wait for the planner to finish (or cancel it) before approving.');
        const r = approvePlan(getDb(), sid);
        return {
          milestones: r.milestones,
          tasks: r.tasks,
          withDeadlines: r.withDeadlines,
          dependencies: r.dependencies,
          agents: r.agents,
        };
      }),
    interview: (id: unknown) => start(id, (sid) => planner.interview(sid)),
    draft: (id: unknown) => start(id, (sid) => planner.draft(sid)),
    cancel: (id: unknown) =>
      run(() => {
        planner.cancel(Id.parse(id));
        return null;
      }),
    approvedDocuments: () => run(() => getPlanningDocuments(getDb())),
    settings: (): Result<PlannerSettings> =>
      run(() => {
        const s = storeSettings(getDb());
        return {
          runner: s.runner,
          model: s.model,
          keySet: Boolean(s.apiKey),
          keySuffix: s.apiKey ? s.apiKey.slice(-4) : null,
          claudeFound: findClaude() !== null,
          encrypted: safeStorage.isEncryptionAvailable(),
        };
      }),
    setSettings: (req: unknown): Result<null> =>
      run(() => {
        const p = SettingsPatch.parse(req);
        const db = getDb();
        if (p.runner) writeSetting(db, KEY.runner, p.runner);
        if (p.model !== undefined) writeSetting(db, KEY.model, p.model || null);
        if (p.apiKey !== undefined) {
          const k = p.apiKey || null;
          writeSetting(
            db,
            KEY.apiKey,
            k === null
              ? null
              : safeStorage.isEncryptionAvailable()
                ? `enc:${safeStorage.encryptString(k).toString('base64')}`
                : `raw:${k}`,
          );
        }
        return null;
      }),
  };
}
