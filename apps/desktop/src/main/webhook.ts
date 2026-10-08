import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  CoreError,
  getAgent,
  getTask,
  logAction,
  registerAgent,
  setMilestoneDates,
  transition,
  TASK_STATUSES,
  type Db,
  type Trigger,
} from '@command-center/core';
import { z, ZodError } from 'zod';
import type { WebhookStatus } from '../shared/ipc';

// Local webhook (ROADMAP D6): 127.0.0.1 only, bearer token from the settings table, zod-validated
// payloads, every write through core so the state machine and the activity log always apply.

export const WEBHOOK_PORT = 38120;
const TOKEN_KEY = 'webhook_token';
const MAX_BODY = 64 * 1024;
const ACTOR = 'webhook';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function getWebhookToken(db: Db): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(TOKEN_KEY) as
    { value: string } | undefined;
  return row?.value ?? regenerateWebhookToken(db);
}

export function regenerateWebhookToken(db: Db): string {
  const token = randomBytes(24).toString('hex');
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(TOKEN_KEY, token);
  return token;
}

export interface WebhookRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  remote: string | undefined;
  body: string;
}
export interface WebhookResponse {
  status: number;
  body: unknown;
}

const reply = (status: number, body: unknown): WebhookResponse => ({ status, body });
const fail = (status: number, code: string, message: string) =>
  reply(status, { ok: false, error: { code, message } });

const AgentId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,47}$/, 'lowercase letters, digits, . _ -');

const TaskUpdate = z.strictObject({
  task_id: z.string().min(1),
  status: z.enum(TASK_STATUSES),
  completed_by: AgentId.optional(),
  // Accepted for compatibility with the blueprint payload; core stamps the time itself.
  completed_at: z.string().optional(),
  reason: z.string().max(4000).optional(),
  summary: z.string().max(4000).optional(),
  force: z.boolean().optional(),
});
const MilestoneUpdate = z.strictObject({
  milestone_id: z.string().min(1),
  planned_start: z.string().nullable().optional(),
  planned_end: z.string().nullable().optional(),
  actual_start: z.string().nullable().optional(),
  actual_end: z.string().nullable().optional(),
});
const AgentAction = z.strictObject({
  agent_id: AgentId,
  action: z.string().trim().min(1).max(60),
  target_type: z.string().max(40).optional(),
  target_id: z.string().max(80).optional(),
  description: z.string().max(2000).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
});

/** An unknown agent id becomes an `external` agent on first use; a known one is left alone. */
function ensureAgent(db: Db, id: string): void {
  if (!getAgent(db, id)) registerAgent(db, { id, name: id, type: 'external' });
}

/** Map "set this task to status X" onto the one trigger core allows from the current status. */
function applyTaskUpdate(db: Db, input: z.infer<typeof TaskUpdate>) {
  const task = getTask(db, input.task_id);
  if (!task) return transition(db, input.task_id, 'reset'); // throws TaskNotFoundError
  if (task.status === input.status) return task;
  const actor = input.completed_by ?? ACTOR;
  ensureAgent(db, actor);
  const base = { actor, reason: input.reason, summary: input.summary, force: input.force };
  const run = (trigger: Trigger, extra: { skipSteps?: boolean } = {}) =>
    transition(db, task.id, trigger, { ...base, ...extra });

  switch (input.status) {
    case 'todo':
      return run('reset');
    case 'in_progress':
      if (task.status === 'blocked') return run('unblock');
      return run(task.status === 'review' ? 'reject' : 'start');
    case 'review':
      return run('complete', { skipSteps: task.status === 'todo' });
    case 'done':
      return run('approve', { skipSteps: task.status !== 'review' });
    case 'blocked':
      return run('block');
  }
}

/** Status mapping for core errors: missing thing 404, bad input 400, state conflict 409. */
function coreStatus(e: CoreError): number {
  if (e.code.endsWith('_NOT_FOUND')) return 404;
  if (e.code === 'INVALID_INPUT' || e.code === 'REASON_REQUIRED') return 400;
  return 409;
}

function authorized(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.match(/^Bearer (.+)$/)?.[1] ?? '');
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Pure request handler: no sockets, so it can be tested directly. */
export function handleWebhook(db: Db, req: WebhookRequest): WebhookResponse {
  if (!req.remote || !LOOPBACK.has(req.remote))
    return fail(403, 'FORBIDDEN', 'Webhook accepts local connections only.');
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  if (!HOSTS.has(host)) return fail(403, 'FORBIDDEN', 'Unexpected Host header.');
  if (!authorized(req.headers.authorization, getWebhookToken(db)))
    return fail(401, 'UNAUTHORIZED', 'Send "Authorization: Bearer <token>".');

  try {
    if (req.method === 'GET' && req.path === '/webhook/status')
      return reply(200, { ok: true, port: WEBHOOK_PORT, status: 'running' });
    if (req.method !== 'POST' || !req.path.startsWith('/webhook/'))
      return fail(404, 'NOT_FOUND', 'Unknown endpoint.');

    let json: unknown;
    try {
      json = JSON.parse(req.body);
    } catch {
      return fail(400, 'INVALID_JSON', 'Body must be JSON.');
    }

    switch (req.path) {
      case '/webhook/task-update':
        return reply(200, { ok: true, task: applyTaskUpdate(db, TaskUpdate.parse(json)) });
      case '/webhook/milestone-update': {
        const { milestone_id, ...dates } = MilestoneUpdate.parse(json);
        ensureAgent(db, ACTOR);
        return reply(200, {
          ok: true,
          milestone: setMilestoneDates(db, milestone_id, dates, ACTOR),
        });
      }
      case '/webhook/agent-action': {
        const a = AgentAction.parse(json);
        ensureAgent(db, a.agent_id);
        const id = logAction(db, {
          agentId: a.agent_id,
          action: a.action,
          targetType: a.target_type,
          targetId: a.target_id,
          description: a.description,
          tags: a.tags,
        });
        return reply(200, { ok: true, log_id: id });
      }
      default:
        return fail(404, 'NOT_FOUND', 'Unknown endpoint.');
    }
  } catch (e) {
    if (e instanceof ZodError)
      return fail(
        400,
        'INVALID_INPUT',
        e.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '),
      );
    if (e instanceof CoreError) return fail(coreStatus(e), e.code, e.message);
    return fail(500, 'ERROR', e instanceof Error ? e.message : String(e));
  }
}

/** The listening socket. Binds 127.0.0.1 only; the project DB is looked up per request. */
export class WebhookServer {
  private server: Server | null = null;
  private error: string | null = null;

  constructor(
    private readonly getDb: () => Db,
    private readonly port = WEBHOOK_PORT,
  ) {}

  start(): void {
    if (this.server) return;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size <= MAX_BODY) chunks.push(c);
      });
      req.on('end', () => {
        let out: WebhookResponse;
        if (size > MAX_BODY) out = fail(413, 'TOO_LARGE', 'Body over 64 KB.');
        else {
          try {
            out = handleWebhook(this.getDb(), {
              method: req.method ?? '',
              path: (req.url ?? '').split('?')[0] ?? '',
              headers: req.headers,
              remote: req.socket.remoteAddress,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          } catch (e) {
            out = fail(503, 'NO_PROJECT', e instanceof Error ? e.message : String(e));
          }
        }
        res.writeHead(out.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out.body));
      });
    });
    server.on('error', (e: NodeJS.ErrnoException) => {
      this.error = e.code === 'EADDRINUSE' ? `Port ${this.port} is already in use.` : e.message;
      this.server = null;
    });
    server.listen(this.port, '127.0.0.1', () => (this.error = null));
    this.server = server;
  }

  status(): WebhookStatus {
    const running = this.server?.listening ?? false;
    let token: string | null = null;
    try {
      token = getWebhookToken(this.getDb());
    } catch {
      // no project open yet
    }
    return { port: this.port, running, error: this.error, token };
  }

  regenerate(): WebhookStatus {
    regenerateWebhookToken(this.getDb());
    return this.status();
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }
}
