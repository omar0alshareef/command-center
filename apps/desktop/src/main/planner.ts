import { spawn } from 'node:child_process';
import {
  addPlanningQuestions,
  findClaude,
  getPlanningSession,
  getSessionDocuments,
  parseStageOutput,
  plannerPrompt,
  proposeTeam,
  savePlanningDocument,
  savePlanningProposal,
  setPlanningError,
  setPlanningStatus,
  type Db,
  type LlmStage,
  type PlannerContext,
  type PlannerStage,
  type Proposal,
} from '@command-center/core';
import type { PlannerEvent } from '../shared/ipc';
import { killTree } from './kill-tree';

// The planner runs as a child process (or an HTTPS call) from the main process, never inside a
// terminal PTY (D18). Its output streams to the Planning panel; nothing reaches the board (D15).

export interface RunResult {
  ok: boolean;
  output: string;
  truncated: boolean;
  error?: string;
}

export interface PlannerRunner {
  name: string;
  run(
    prompt: string,
    o: { signal: AbortSignal; onChunk: (text: string) => void },
  ): Promise<RunResult>;
}

/** Output beyond this many characters is dropped and the run is flagged truncated. */
export const OUTPUT_CAP = Number(process.env['COMMAND_CENTER_PLANNER_CAP']) || 200_000;
const TIMEOUT_MS = 10 * 60_000;

/** Claude Code in non-interactive mode: prompt on stdin, text on stdout, process tree killed on cancel. */
export function claudeCliRunner(bin: string, model: string | null): PlannerRunner {
  return {
    name: 'claude-code',
    run: (prompt, { signal, onChunk }) =>
      new Promise((resolve) => {
        const viaShell = bin.toLowerCase().endsWith('.cmd'); // npm's Windows wrapper needs cmd.exe
        const args = ['-p', '--output-format', 'text', '--no-session-persistence'];
        if (model) args.push('--model', model);
        const quote = (a: string) =>
          viaShell && /[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '')}"` : a;
        const child = spawn(quote(bin), args.map(quote), {
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: viaShell,
          windowsHide: true,
        });
        let out = '';
        let err = '';
        let truncated = false;
        let settled = false;
        const finish = (r: Omit<RunResult, 'truncated' | 'output'> & { output?: string }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          resolve({ output: out, truncated, ...r });
        };
        const stop = () => killTree(child.pid, () => child.kill());
        const onAbort = () => {
          stop();
          finish({ ok: false, error: 'Cancelled.' });
        };
        const timer = setTimeout(() => {
          stop();
          finish({ ok: false, error: `Timed out after ${TIMEOUT_MS / 60_000} minutes.` });
        }, TIMEOUT_MS);
        signal.addEventListener('abort', onAbort);
        child.stdout.on('data', (d: Buffer) => {
          const text = d.toString('utf8');
          const room = OUTPUT_CAP - out.length;
          if (room <= 0) {
            truncated = true;
            return;
          }
          const kept = text.length > room ? text.slice(0, room) : text;
          if (kept.length < text.length) truncated = true;
          out += kept;
          onChunk(kept);
        });
        child.stderr.on('data', (d: Buffer) => {
          if (err.length < 4000) err += d.toString('utf8');
        });
        child.on('error', (e) =>
          finish({ ok: false, error: `Could not run ${bin}: ${e.message}` }),
        );
        child.on('close', (code) =>
          finish(
            code === 0
              ? { ok: true }
              : {
                  ok: false,
                  error: `claude exited with code ${code}: ${err.trim().slice(0, 500)}`,
                },
          ),
        );
        child.stdin.on('error', () => undefined);
        child.stdin.end(prompt);
      }),
  };
}

/** Direct Anthropic API call (D19). The key is only ever placed in the request header. */
export function anthropicApiRunner(apiKey: string, model: string | null): PlannerRunner {
  return {
    name: 'anthropic-api',
    async run(prompt, { signal, onChunk }) {
      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          signal,
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: model || 'claude-sonnet-5-5',
            max_tokens: 16_000,
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        const body = (await res.json()) as {
          content?: { type: string; text?: string }[];
          error?: { message?: string };
        };
        if (!res.ok)
          return {
            ok: false,
            output: '',
            truncated: false,
            error: `API ${res.status}: ${body.error?.message ?? 'request failed'}`,
          };
        const text = (body.content ?? []).map((c) => c.text ?? '').join('');
        const truncated = text.length > OUTPUT_CAP;
        const output = truncated ? text.slice(0, OUTPUT_CAP) : text;
        onChunk(output);
        return { ok: true, output, truncated };
      } catch (e) {
        if (signal.aborted) return { ok: false, output: '', truncated: false, error: 'Cancelled.' };
        return {
          ok: false,
          output: '',
          truncated: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    },
  };
}

// ---------- settings (project `settings` table) ----------

export interface PlannerSettingsStore {
  runner: 'claude-code' | 'anthropic-api';
  model: string | null;
  apiKey: string | null;
}

export class Planner {
  private readonly running = new Map<string, { abort: AbortController; stage: PlannerStage }>();

  constructor(
    private readonly getDb: () => Db,
    private readonly settings: () => PlannerSettingsStore,
    private readonly emit: (e: PlannerEvent) => void,
  ) {}

  /** Sessions with a run in flight, and the stage each is on. */
  active(): { sessionId: string; stage: PlannerStage }[] {
    return [...this.running].map(([sessionId, r]) => ({ sessionId, stage: r.stage }));
  }

  cancel(sessionId: string): void {
    this.running.get(sessionId)?.abort.abort();
  }

  cancelAll(): void {
    for (const r of this.running.values()) r.abort.abort();
  }

  private runner(): PlannerRunner {
    const s = this.settings();
    if (s.runner === 'anthropic-api') {
      if (!s.apiKey) throw new Error('No API key is set. Add one in Settings → Planner.');
      return anthropicApiRunner(s.apiKey, s.model);
    }
    const bin = findClaude();
    if (!bin)
      throw new Error(
        'Claude Code (`claude`) was not found on PATH. Install it or switch the planner to an API key in Settings.',
      );
    return claudeCliRunner(bin, s.model);
  }

  /** Run one LLM stage: stream it, validate it, return the parsed output. Throws on any failure. */
  private async stage<S extends LlmStage>(
    sessionId: string,
    abort: AbortController,
    stage: S,
    ctx: PlannerContext,
  ) {
    const entry = this.running.get(sessionId);
    if (entry) entry.stage = stage;
    this.emit({ sessionId, type: 'stage', stage });
    const r = await this.runner().run(plannerPrompt(stage, ctx), {
      signal: abort.signal,
      onChunk: (text) => this.emit({ sessionId, type: 'chunk', stage, text }),
    });
    if (r.truncated)
      this.emit({
        sessionId,
        type: 'notice',
        stage,
        text: `Output passed ${OUTPUT_CAP.toLocaleString()} characters and was truncated.`,
      });
    if (!r.ok) throw new Error(r.error ?? 'The planner failed.');
    try {
      return parseStageOutput(stage, r.output);
    } catch (e) {
      if (r.truncated && e instanceof Error)
        e.message = `${e.message}\n(The output was truncated at ${OUTPUT_CAP.toLocaleString()} characters.)`;
      throw e;
    }
  }

  private context(sessionId: string): PlannerContext {
    const d = getPlanningSession(this.getDb(), sessionId);
    return {
      idea: d.session.idea,
      requirements: d.session.requirements,
      today: new Date().toISOString().slice(0, 10),
      manifesto: d.documents.find((x) => x.kind === 'manifesto')?.content,
      roadmap: d.documents.find((x) => x.kind === 'roadmap')?.content,
      milestones: d.proposal?.milestones,
    };
  }

  /** Run `fn` as this session's one active run; errors are recorded on the session, never thrown. */
  private async exclusive(
    sessionId: string,
    first: PlannerStage,
    fn: (a: AbortController) => Promise<void>,
  ) {
    if (this.running.has(sessionId))
      throw new Error('The planner is already running for this session.');
    getPlanningSession(this.getDb(), sessionId); // throws for an unknown id
    const abort = new AbortController();
    this.running.set(sessionId, { abort, stage: first });
    try {
      setPlanningError(this.getDb(), sessionId, null);
      await fn(abort);
      this.emit({ sessionId, type: 'done' });
    } catch (e) {
      const message = abort.signal.aborted
        ? 'Cancelled.'
        : e instanceof Error
          ? e.message
          : String(e);
      setPlanningError(this.getDb(), sessionId, message);
      this.emit({ sessionId, type: 'error', text: message });
    } finally {
      this.running.delete(sessionId);
    }
  }

  /** Ask the next round of questions; when the planner says it has enough, go straight to drafting. */
  interview(sessionId: string): Promise<void> {
    let ready = false;
    return this.exclusive(sessionId, 'interview', async (abort) => {
      const ctx = this.context(sessionId);
      const out = await this.stage(sessionId, abort, 'interview', ctx);
      const known = new Set(ctx.requirements.map((r) => r.question.trim().toLowerCase()));
      const fresh = out.questions.filter((q) => !known.has(q.trim().toLowerCase()));
      if (ctx.requirements.length === 0 && fresh.length < 3)
        throw new Error(
          `interview: the first round must ask at least 3 questions (got ${fresh.length}).`,
        );
      if (fresh.length > 0) addPlanningQuestions(this.getDb(), sessionId, fresh);
      ready = out.ready && fresh.length === 0;
    }).then(() => (ready ? this.draft(sessionId) : undefined));
  }

  /** Draft every document and table, stage by stage; each stage reads the previous stage's saved draft. */
  draft(sessionId: string): Promise<void> {
    return this.exclusive(sessionId, 'draft_manifesto', async (abort) => {
      const db = this.getDb();
      setPlanningStatus(db, sessionId, 'drafting');
      const assumptions: Proposal['assumptions'] = {};
      const save = (p: Partial<Proposal>) =>
        savePlanningProposal(db, sessionId, {
          ...(getPlanningSession(db, sessionId).proposal ?? {}),
          ...p,
          assumptions: {
            ...(getPlanningSession(db, sessionId).proposal?.assumptions ?? {}),
            ...assumptions,
          },
        });

      for (const kind of ['manifesto', 'roadmap'] as const) {
        const out = await this.stage(sessionId, abort, `draft_${kind}`, this.context(sessionId));
        savePlanningDocument(db, sessionId, kind, out.content, { newVersion: true });
        assumptions[kind] = out.assumptions;
        save({});
      }
      const caps = await this.stage(sessionId, abort, 'plan_stages', this.context(sessionId));
      assumptions['milestones'] = caps.assumptions;
      save({ milestones: caps.milestones });
      const planned = await this.stage(sessionId, abort, 'plan_tasks', this.context(sessionId));
      assumptions['tasks'] = planned.assumptions;

      const entry = this.running.get(sessionId);
      if (entry) entry.stage = 'propose_team';
      this.emit({ sessionId, type: 'stage', stage: 'propose_team' });
      const { team, tasks } = proposeTeam(caps.milestones, planned.tasks);
      save({ milestones: caps.milestones, tasks, team });
      if (getSessionDocuments(db, sessionId).length < 2)
        throw new Error('Drafting did not produce both documents.');
      setPlanningStatus(db, sessionId, 'review');
    });
  }
}
