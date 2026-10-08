// Drives the BUILT app (apps/desktop/out) over CDP through the M9 exit criteria.
// usage: [MODE=empty] [DEV=1] [ONLY=L,A,C,S,W] node .supervisor/M9.verify.mjs <projectRoot> <screenshotPrefix>   (needs: npm run build -w apps/desktop -w packages/mcp-server; seed a fresh root with packages/core/src/seed.ts; MODE=empty wants an empty folder; DEV=1 uses the dev server)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const REPO = 'C:/Users/hasan/Desktop/Claude/command-center';
const require = createRequire(`${REPO}/package.json`);
const Database = require('better-sqlite3');
const [root, shot] = process.argv.slice(2);
const PORT = 9300 + Math.floor(Math.random() * 500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const env = { ...process.env, PROJECT_ROOT: root };
delete env.ELECTRON_RENDERER_URL;
const electronArgs = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${REPO}/apps/desktop/out/verify-profile-${PORT}`];
// DEV=1 launches the real dev server (what `npm run dev` runs): React's development build, with its warnings.
const app =
  process.env.DEV === '1'
    ? spawn(process.execPath, [`${REPO}/node_modules/electron-vite/bin/electron-vite.js`, 'dev', '--', ...electronArgs], {
        cwd: `${REPO}/apps/desktop`,
        env: { ...process.env, PROJECT_ROOT: root },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    : spawn(`${REPO}/node_modules/electron/dist/electron.exe`, ['.', ...electronArgs], {
        cwd: `${REPO}/apps/desktop`,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
let appLog = '';
app.stdout.on('data', (d) => (appLog += d));
app.stderr.on('data', (d) => (appLog += d));

// ---------- DB helpers (read-only, fresh connection per query) ----------
const q = (sql, ...p) => {
  const db = new Database(`${root}/command-center.db`, { readonly: true });
  try {
    return db.prepare(sql).all(...p);
  } finally {
    db.close();
  }
};
const task = (id) => q('SELECT * FROM subtasks WHERE id = ?', id)[0];
const until = async (fn, ms = 5000, what = 'condition') => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(40);
  }
  throw new Error('timeout: ' + what);
};

// ---------- CDP plumbing ----------
async function pageWsUrl() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const p = list.find((t) => t.type === 'page');
      if (p) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(150);
  }
  throw new Error('no page target\n' + appLog);
}
const ws = new WebSocket(await pageWsUrl());
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push((msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text).slice(0, 300));
  else if (msg.method === 'Log.entryAdded') {
    const e = msg.params.entry;
    if (['error', 'warning'].includes(e.level) && !/favicon/.test(e.url ?? '')) consoleErrors.push(`[log ${e.level}] ${e.text} ${e.url ?? ''}`.slice(0, 300));
  } else if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300));
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result.result.value;
};
const waitDom = (expr, ms = 6000) => until(async () => { try { return await ev(expr); } catch { return false; } }, ms, expr.slice(0, 90));
const screenshot = async (name) => {
  await sleep(700);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${shot}-${name}.png`, Buffer.from(r.result.data, 'base64'));
};

const rect = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
const mouse = (type, x, y, buttons = 0, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1, ...extra });
const key = async (k, code, vk, modifiers = 0, text) => {
  await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers, text });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
};
const SPACE = () => key(' ', 'Space', 32, 0, ' ');
const ENTER = () => key('Enter', 'Enter', 13, 0, '\r');
const TAB = () => key('Tab', 'Tab', 9);
const ESC = () => key('Escape', 'Escape', 27);
const ARROW = (dir) => key(`Arrow${dir}`, `Arrow${dir}`, dir === 'Right' ? 39 : 37);
const typeText = (text) => send('Input.insertText', { text });

const cardSel = (tid) => `[data-task-id="${tid}"]`;
const colSel = (s) => `[data-column="${s}"]`;
async function drag(tid, toStatus, { hold = false } = {}) {
  await ev(`document.querySelector('${cardSel(tid)}').scrollIntoView({ block: 'center' })`);
  let a = await rect(cardSel(tid));
  for (let i = 0; i < 40; i++) {
    await sleep(60);
    const n = await rect(cardSel(tid));
    const stable = Math.abs(n.x - a.x) < 0.5 && Math.abs(n.y - a.y) < 0.5;
    a = n;
    if (stable) break;
  }
  const b = await rect(colSel(toStatus));
  const sx = a.x + a.w / 2, sy = a.y + a.h / 2;
  const tx = b.x + b.w / 2, ty = Math.min(b.y + 90, b.y + b.h - 12);
  await mouse('mouseMoved', sx, sy);
  await mouse('mousePressed', sx, sy, 1);
  for (let i = 1; i <= 14; i++) {
    await mouse('mouseMoved', sx + ((tx - sx) * i) / 14, sy + ((ty - sy) * i) / 14, 1);
    await sleep(16);
  }
  if (!hold) {
    await mouse('mouseReleased', tx, ty, 0);
    // dnd-kit swallows clicks for ~50-100ms after a drop (by design); a person needs longer than that anyway.
    await sleep(400);
  }
  return { tx, ty };
}
const dialogText = () => ev(`document.querySelector('dialog[open]')?.innerText ?? null`);
const dialogButton = (label) =>
  ev(`(() => {
    const b = [...document.querySelectorAll('dialog[open] button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: b.disabled };
  })()`);
const clickInDialog = async (label) => {
  // Real mouse click, like a person: wait for the button to exist and be enabled first.
  for (let i = 0; i < 50; i++) {
    const btn = await dialogButton(label);
    if (btn && !btn.disabled) {
      await mouse('mouseMoved', btn.x, btn.y);
      await mouse('mousePressed', btn.x, btn.y, 1);
      await mouse('mouseReleased', btn.x, btn.y, 0);
      return 'ok';
    }
    if (i === 49) return btn ? 'disabled' : 'no button ' + label;
    await sleep(40);
  }
};
const noDialog = () => waitDom(`document.querySelectorAll('dialog[open]').length === 0`);
const toasts = () => ev(`[...document.querySelectorAll('[aria-live=polite] > div')].map(d => d.innerText.trim())`);
const colIds = (s) => ev(`[...document.querySelectorAll('${colSel(s)} [data-task-id]')].map(e => e.dataset.taskId)`);
const pickTask = (sql) => q(sql)[0]?.id;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 700) });
};
const ONLY = process.env.ONLY?.split(",");
const run = async (name, fn) => {
  if (ONLY && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (e) {
    let dump = ''; try { dump = JSON.stringify({ dialog: await dialogText(), toasts: await toasts(), errs: consoleErrors.slice(-2), ui: await ev("JSON.stringify({ ta: document.querySelector(\"dialog[open] textarea\")?.value, active: document.activeElement?.tagName + \":\" + document.activeElement?.textContent?.slice(0,20), btns: [...document.querySelectorAll(\"dialog[open] button\")].map(b => b.textContent.trim() + (b.disabled ? \"(disabled)\" : \"\")) })") }); } catch {} check(name + ' [threw]', false, e.message + ' :: ' + dump);
  }
};

// ---- M9 body: Operator CLI & pipeline ----
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = `${REPO}/packages/cli/dist/index.js`;
const cli = (args, extraEnv = {}, cwd = tmpdir()) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, PROJECT_ROOT: root, ...extraEnv } });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
};
const OKCHECK = 'node -e "process.exit(0)"';
const BADCHECK = 'node -e "process.exit(1)"';
const openTab = async (name) => { await ev(`[...document.querySelectorAll('[role=tab]')].find(t => t.textContent.includes(${JSON.stringify(name)})).click()`); await sleep(500); };
const click = async (x, y) => { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, 1); await mouse('mouseReleased', x, y, 0); await sleep(250); };
const center = async (sel) => { const r = await rect(sel); return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; };
const col = (id) => ev(`document.querySelector('[data-task-id="${id}"]')?.closest('[data-column]')?.dataset.column ?? null`);
const logRows = (id) => q(`SELECT agent_id, action, description FROM agent_log WHERE target_id = ? ORDER BY timestamp, rowid`, id);
const total = (sql, ...p) => q(sql, ...p)[0].c;

await send('Runtime.enable');
await send('Log.enable');
await waitDom(`!!document.querySelector('[role=tab]')`);
if (process.env.DEV === '1') check('D0 running under the Vite dev server in React development mode', await ev(`location.protocol === 'http:' && !!document.querySelector('script[src*="@vite/client"]')`), await ev(`location.href`));
await ev(`localStorage.removeItem('cc-terminal')`);

// A small project to explore, next to the board: files the explorer can find and a passing check script.
mkdirSync(join(root, 'src'), { recursive: true });
writeFileSync(join(root, 'src', 'workflow.ts'), 'export const workflow = "task workflow engine"; // moves a task between columns\n');
writeFileSync(join(root, 'src', 'board.ts'), 'export const board = "task board columns and cards";\n');
writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { typecheck: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' } }));
const todo = q(`SELECT id, label FROM subtasks WHERE status='todo' AND depends_on='[]' ORDER BY id LIMIT 6`);
const [T1, T2, T3, T4] = todo.map((t) => t.id);
q; // eslint-disable-line no-unused-expressions

// ===== A. simple commands =====
await run('A', async () => {
  const s = cli(['status']);
  const db = Object.fromEntries(q(`SELECT status, COUNT(*) c FROM subtasks GROUP BY status`).map((r) => [r.status, r.c]));
  check('A1 status prints the context line and per-status counts that match the DB', s.code === 0 && /WEEK \d+, Phase:/.test(s.out) && s.out.includes(`todo ${db.todo}`) && s.out.includes(`done ${db.done}`), s.out.split('\n').slice(0, 3).join(' | '));
  const sj = JSON.parse(cli(['status', '--json']).out);
  check('A2 status --json is valid JSON with the same totals', sj.total_tasks === total('SELECT COUNT(*) c FROM subtasks') && sj.tasks.todo === db.todo);
  const a = cli(['agents']);
  check('A3 agents lists the connected agents with nesting and state', a.code === 0 && /claude-code\s+orchestrator/.test(a.out) && /\n\s+research-explorer\s+sub-agent/.test(a.out) && /IDLE|ACTIVE/.test(a.out), a.out.split('\n').slice(0, 4).join(' | '));
  const l = cli(['log', '--task', T1, '--limit', '5']);
  const n = total(`SELECT COUNT(*) c FROM agent_log WHERE target_id = ?`, T1);
  check('A4 log --task prints that task\'s history (newest first)', l.code === 0 && l.out.trim().split('\n').length === Math.min(5, n), `${l.out.trim().split('\n').length} lines for ${n} rows`);
  const e1 = cli(['log', '--task', 'TASK-999']);
  check('A5 an unknown task is one clear error line and exit code 1, no stack trace', e1.code === 1 && /^error: No task TASK-999/m.test(e1.err) && !/\n\s+at /.test(e1.err), e1.err.trim());
  const e2 = cli(['status'], { PROJECT_ROOT: join(tmpdir(), 'no-such-folder-cc') });
  check('A6 a wrong project folder never creates a board and says so', e2.code === 1 && /No command-center\.db/.test(e2.err) && !existsSync(join(tmpdir(), 'no-such-folder-cc')), e2.err.trim().slice(0, 120));
  const cwdRun = spawnSync(process.execPath, [CLI, 'status'], { cwd: join(root, 'src'), encoding: 'utf8', env: { ...process.env, PROJECT_ROOT: '' } });
  check('A7 with no --root/PROJECT_ROOT it walks up from the current folder to the database', cwdRun.status === 0 && /WEEK \d+/.test(cwdRun.stdout), cwdRun.stderr.trim().slice(0, 100));
});

// ===== B. prepare =====
await run('B', async () => {
  await openTab('Agent Hub');
  await waitDom(`!!document.querySelector('[data-activity-feed]')`);
  const before = total('SELECT COUNT(*) c FROM agent_log');
  const t0 = performance.now();
  const r = cli(['prepare', '--id', T1, '--runner', 'local']);
  check('B1 prepare exits 0 and reports the file it wrote', r.code === 0 && /Wrote .*TASK_CONTEXT\.md/.test(r.out), r.out.trim().split('\n').at(-1));
  const file = join(root, '.claude', 'TASK_CONTEXT.md');
  const md = readFileSync(file, 'utf8');
  const sections = ['Task description', 'Acceptance criteria', 'Context files', 'Reference docs', 'Constraints', 'Relevant lessons'];
  check('B2 TASK_CONTEXT.md has all six blueprint sections, each exactly once', sections.every((s) => (md.match(new RegExp(`^## ${s}\\b`, 'gm')) ?? []).length === 1) && (md.match(/^## /gm) ?? []).length === 6, (md.match(/^## .*/gm) ?? []).join(' | '));
  check('B3 it starts with the task id and the live context line', md.startsWith(`# ${T1}:`) && /_WEEK \d+, Phase:/.test(md));
  check('B4 the research found the project files (workflow.ts / board.ts)', /src\/workflow\.ts|src\/board\.ts/.test(md), (md.match(/src\/[\w.]+/g) ?? []).slice(0, 4).join(','));
  const tokens = Math.ceil(md.length / 4);
  check('B5 the compressed research stays within the ~500-token budget (rough estimator)', (() => { const research = md.slice(md.indexOf('### Files'), md.indexOf('## Constraints')); return Math.ceil(research.length / 4) <= 575; })(), `whole file ~${tokens} tokens`);
  const rows = logRows(T1).filter((x) => x.timestamp === undefined || true).slice(-6);
  const stages = ['exploration_complete', 'compression_complete', 'prompt_optimized'];
  const byAgent = Object.fromEntries(q(`SELECT action, agent_id FROM agent_log WHERE target_id = ? AND action IN ('exploration_complete','compression_complete','prompt_optimized')`, T1).map((x) => [x.action, x.agent_id]));
  check('B6 each stage is logged under its own sub-agent', byAgent.exploration_complete === 'research-explorer' && byAgent.compression_complete === 'token-compressor' && byAgent.prompt_optimized === 'prompt-optimizer', JSON.stringify(byAgent));
  check('B7 the new agents were registered as sub-agents of operator-cli', q(`SELECT parent_id FROM agents WHERE id='token-compressor'`)[0]?.parent_id === 'operator-cli' && q(`SELECT type FROM agents WHERE id='operator-cli'`)[0]?.type === 'orchestrator');
  check('B8 the task itself is unchanged (still todo) but now carries the optimized prompt and context files', q(`SELECT status, prompt, context_files FROM subtasks WHERE id=?`, T1).every((r) => r.status === 'todo' && r.prompt.includes('Steps') && r.context_files.includes('src/')));
  // live in the Agent Hub
  await waitDom(`[...document.querySelectorAll('[data-feed-entry]')].some(e => e.dataset.agent === 'prompt-optimizer') && [...document.querySelectorAll('[data-feed-entry]')].some(e => e.dataset.agent === 'research-explorer' && e.innerText.includes('${T1}')) && [...document.querySelectorAll('[data-feed-entry]')].some(e => e.dataset.agent === 'token-compressor')`, 4000);
  check('B9 the stages show up live in the Agent Hub feed under the right agents', true, `${Math.round(performance.now() - t0)} ms after starting the CLI`);
  const feed = await ev(`[...document.querySelectorAll('[data-feed-entry]')].slice(0, 8).map(e => e.dataset.agent + ':' + e.innerText.split('\\n').slice(0, 2).join(' '))`);
  await waitDom(`!!document.querySelector('[data-agent-row="token-compressor"]') && !!document.querySelector('[data-agent-row="operator-cli"]')`, 4000);
  check('B10 and the agents appear in the Connected Agents tree', true);
  await screenshot('hub-after-prepare');
  void rows; void stages; void feed; void before;
});

// ===== C. task modal + in-app terminal =====
await run('C', async () => {
  await openTab('Task Board');
  await waitDom(`document.querySelectorAll('[data-column]').length === 5`);
  await sleep(500);
  await ev(`document.querySelector('[data-task-id="${T1}"]').scrollIntoView({ block: 'center' })`);
  const c = await center(`[data-task-id="${T1}"]`);
  await click(c.x, c.y);
  await waitDom(`!!document.querySelector('dialog[open]')`);
  await ev(`[...document.querySelectorAll('dialog[open] [role=tab]')].find(t => t.textContent.includes('Context')).click()`);
  await waitDom(`!!document.querySelector('dialog[open] [data-run-cli]')`);
  const btns = await ev(`[...document.querySelectorAll('dialog[open] [data-run-cli]')].map(b => b.dataset.runCli)`);
  const preview = await ev(`document.querySelector('dialog[open] pre').innerText`);
  check('C1 the Context tab previews the prepared context and offers Prepare / Start / Audit', btns.join() === 'prepare,start,audit' && /src\/(workflow|board)\.ts/.test(preview), btns.join());
  await screenshot('modal-context');
  await ev(`document.querySelector('dialog[open] [data-run-cli="prepare"]').click()`);
  await waitDom(`document.querySelector('[data-terminal]')?.offsetParent !== null && !document.querySelector('dialog[open]')`, 10000);
  await waitDom(`/PS [^\\n]*>\\s*command-center prepare --id ${T1}/.test(document.querySelector('.term-host[style*="display: block"] .xterm-rows')?.innerText.replace(/\\u00a0/g, ' ') ?? '')`, 12000);
  check('C2 the button opens the Terminal with the command typed (not run)', true);
  // press Enter: the real CLI runs inside the app's terminal through the launcher on PATH
  await ev(`document.querySelector('.term-host[style*="display: block"] .xterm-helper-textarea')?.focus()`);
  await typeText(' --runner local'); // the button types the command; the user can add flags before pressing Enter (the default would try the real claude, which is not logged in here)
  const NL = String.fromCharCode(10);
  await ENTER();
  const termNow = () => ev(`(document.querySelector('.term-host[style*="display: block"] .xterm-rows')?.innerText ?? '').split(String.fromCharCode(160)).join(' ')`);
  const wrote = await until(async () => { const t = (await termNow()).split(NL).join(''); return /Wrote .*TASK_CONTEXT\.md/.test(t) ? t : false; }, 40000, 'CLI output in the terminal').catch(() => null);
  if (!wrote) await screenshot('terminal-cli-failed');
  check('C3 pressing Enter runs the real CLI in the app terminal (the `command-center` launcher is on PATH)', !!wrote, wrote ? '' : (await termNow()).split(NL).filter((l) => l.trim()).slice(-6).join(' | '));
  await screenshot('terminal-cli');
  await ev(`document.querySelector('[data-quick-action="command-center status"]').click()`);
  await ENTER();
  await waitDom(`/Demo Project: WEEK/.test((document.querySelector('.term-host[style*="display: block"] .xterm-rows')?.innerText ?? '').replace(/\\u00a0/g, ' '))`, 30000);
  check('C4 the "command-center status" quick action works end to end', true);
});

// ===== D. audit =====
await run('D', async () => {
  await openTab('Task Board');
  await waitDom(`document.querySelectorAll('[data-column]').length === 5`);
  const rv = q(`SELECT id, acceptance_criteria FROM subtasks WHERE status='review' ORDER BY id`);
  const [R1, R2] = rv.map((r) => r.id);
  check('D0 the seed has two tasks in Review to audit', rv.length >= 2, rv.map((r) => r.id).join());
  await ev(`document.querySelector('[data-task-id="${R1}"]')?.scrollIntoView({ block: 'center' })`);
  const t0 = performance.now();
  const f = cli(['audit', '--id', R1, '--runner', 'local', '--check', OKCHECK]);
  check('D1 audit FAIL exits 1 and says the task went back to In Progress with a reason', f.code === 1 && /FAIL\. .* -> In Progress\. Reason recorded: Audit failed\./.test(f.out), f.out.trim().split('\n').at(-1).slice(0, 160));
  check('D2 the task is now In Progress in the DB', q(`SELECT status FROM subtasks WHERE id=?`, R1)[0].status === 'in_progress');
  const rej = q(`SELECT agent_id, description FROM agent_log WHERE target_id=? AND action='task_rejected' ORDER BY timestamp DESC LIMIT 1`, R1)[0];
  check('D3 the reason is recorded: a task_rejected log entry by final-validator, and a lessons_learned row', rej?.agent_id === 'final-validator' && /not met/.test(rej.description) && total(`SELECT COUNT(*) c FROM lessons_learned WHERE subtask_id=?`, R1) >= 1, rej?.description);
  await waitDom(`document.querySelector('[data-task-id="${R1}"]')?.closest('[data-column]')?.dataset.column === 'in_progress'`, 4000);
  check('D4 the card moves to In Progress on the board, live', true, `${Math.round(performance.now() - t0)} ms`);
  const acts = q(`SELECT agent_id, action FROM agent_log WHERE target_id=? AND action IN ('quality_check','security_scan','validation_failed')`, R1);
  check('D5 each audit stage is logged under its own agent', acts.some((a) => a.agent_id === 'code-quality') && acts.some((a) => a.agent_id === 'security-auditor') && acts.some((a) => a.agent_id === 'final-validator' && a.action === 'validation_failed'), JSON.stringify(acts));
  // PASS case
  const crit = JSON.parse(q(`SELECT acceptance_criteria FROM subtasks WHERE id=?`, R2)[0].acceptance_criteria).map((c) => ({ ...c, done: true }));
  const wdb = new Database(`${root}/command-center.db`);
  wdb.prepare(`UPDATE subtasks SET acceptance_criteria=? WHERE id=?`).run(JSON.stringify(crit), R2);
  wdb.close();
  const p = cli(['audit', '--id', R2, '--runner', 'local', '--check', OKCHECK]);
  check('D6 audit PASS exits 0 and leaves the task in Review for the human', p.code === 0 && /PASS\. .* waiting for your approval/.test(p.out) && q(`SELECT status FROM subtasks WHERE id=?`, R2)[0].status === 'review', p.out.trim().split('\n').at(-1));
  check('D7 validation_passed is logged by final-validator', q(`SELECT agent_id FROM agent_log WHERE target_id=? AND action='validation_passed'`, R2)[0]?.agent_id === 'final-validator');
  // a failing check
  const bad = cli(['audit', '--id', R2, '--runner', 'local', '--check', BADCHECK]);
  check('D8 a failing project check fails the audit and sends the task back', bad.code === 1 && q(`SELECT status FROM subtasks WHERE id=?`, R2)[0].status === 'in_progress' && /checks failed/.test(bad.out), bad.out.split('\n').find((l) => /Code Quality/.test(l) === false && /FAIL:/.test(l)));
  // secret in a touched file
  const SECRET = 'sk-' + 'Qq1Ww2Ee3Rr4Tt5Yy6Uu7Ii8Oo9';
  writeFileSync(join(root, 'src', 'leak.ts'), `export const key = "${SECRET}";\n`);
  const wdb2 = new Database(`${root}/command-center.db`);
  wdb2.prepare(`UPDATE subtasks SET status='review', context_files=? WHERE id=?`).run(JSON.stringify(['src/leak.ts']), R2);
  wdb2.close();
  const sec = cli(['audit', '--id', R2, '--runner', 'local', '--check', OKCHECK]);
  const leaked = q(`SELECT description FROM agent_log WHERE target_id=?`, R2).some((r) => (r.description ?? '').includes(SECRET)) || sec.out.includes(SECRET) || sec.err.includes(SECRET);
  check('D9 a hard-coded secret fails the security stage, and neither the output nor the log repeats it', sec.code === 1 && /possible secret/.test(sec.out) && !leaked, sec.out.split('\n').find((l) => /secret/.test(l))?.slice(0, 140));
  const a = cli(['audit', '--id', T2, '--runner', 'local']);
  check('D10 audit refuses a task that is still To Do', a.code === 1 && /Audit runs on tasks that are In Progress or in Review/.test(a.err), a.err.trim());
  await screenshot('board-after-audit');
});

// ===== S. start =====
await run('S', async () => {
  const s1 = cli(['start', '--id', T2, '--runner', 'local', '--check', OKCHECK]);
  check('S1 start with the local runner starts the task, prepares the context, and completes nothing', s1.code === 0 && q(`SELECT status FROM subtasks WHERE id=?`, T2)[0].status === 'in_progress' && /does not write code/.test(s1.out), s1.out.trim().split('\n').slice(-3).join(' | ').slice(0, 160));
  await openTab('Task Board');
  await waitDom(`document.querySelector('[data-task-id="${T2}"]')?.closest('[data-column]')?.dataset.column === 'in_progress'`, 4000);
  check('S2 the card is In Progress on the board', true);
  const s2 = cli(['start', '--id', T2, '--no-dispatch', '--runner', 'local', '--check', OKCHECK]);
  check('S3 --no-dispatch runs the checks and, when they pass, completes the task into Review', s2.code === 0 && q(`SELECT status FROM subtasks WHERE id=?`, T2)[0].status === 'review' && /-> Review/.test(s2.out), s2.out.trim().split('\n').at(-1));
  await waitDom(`document.querySelector('[data-task-id="${T2}"]')?.closest('[data-column]')?.dataset.column === 'review'`, 4000);
  check('S4 the card lands in Review (amber) live', true);
  const s3 = cli(['start', '--id', T3, '--no-dispatch', '--runner', 'local', '--check', BADCHECK]);
  check('S5 a failing check keeps the task In Progress, exits 1 and logs checks_failed', s3.code === 1 && q(`SELECT status FROM subtasks WHERE id=?`, T3)[0].status === 'in_progress' && logRows(T3).some((r) => r.action === 'checks_failed'), s3.out.trim().split('\n').at(-1));
  const s4 = cli(['start', '--id', T2]);
  check('S6 starting a task that is already in Review is refused', s4.code === 1 && /already review/.test(s4.err), s4.err.trim());
  const dep = q(`SELECT id, depends_on FROM subtasks WHERE status='todo' AND depends_on != '[]' LIMIT 1`)[0];
  if (dep) {
    const s5 = cli(['start', '--id', dep.id, '--runner', 'local']);
    check('S7 a task whose dependencies are unfinished is refused with an actionable message, unchanged', s5.code === 1 && q(`SELECT status FROM subtasks WHERE id=?`, dep.id)[0].status === 'todo', s5.err.trim().slice(0, 150));
  }
});

// ===== X. dry run, pluggable runner =====
await run('X', async () => {
  const logs = total('SELECT COUNT(*) c FROM agent_log');
  const stateSql = `SELECT GROUP_CONCAT(id || ':' || status) s FROM subtasks`;
  const before = q(stateSql)[0].s;
  const ctxBefore = existsSync(join(root, '.claude', 'TASK_CONTEXT.md')) ? readFileSync(join(root, '.claude', 'TASK_CONTEXT.md'), 'utf8') : null;
  const d1 = cli(['prepare', '--id', T4, '--dry-run']);
  const d2 = cli(['start', '--id', T4, '--dry-run']);
  const d3 = cli(['audit', '--id', 'TASK-036', '--dry-run']);
  check('X1 --dry-run prints every stage prompt for prepare, start and audit', /Research Explorer[\s\S]*Token Compressor[\s\S]*Prompt Optimizer/.test(d1.out) && /dispatch to the agent/.test(d2.out) && /Code Quality[\s\S]*Security[\s\S]*Final Validator/.test(d3.out) && [d1, d2, d3].every((d) => d.code === 0), [d1, d2, d3].map((d) => d.code).join());
  const ctxAfter = existsSync(join(root, '.claude', 'TASK_CONTEXT.md')) ? readFileSync(join(root, '.claude', 'TASK_CONTEXT.md'), 'utf8') : null;
  check('X2 --dry-run changes nothing: same log count, same task states, same context file', total('SELECT COUNT(*) c FROM agent_log') === logs && q(stateSql)[0].s === before && ctxAfter === ctxBefore);
  // pluggable runner: a stand-in `claude` executable that answers each stage
  const dir = mkdtempSync(join(tmpdir(), 'cc-fakeclaude-'));
  const script = join(dir, 'fake.mjs');
  writeFileSync(script, `import { readFileSync, appendFileSync } from 'node:fs';
const a = process.argv.slice(2); let s = '';
process.stdin.on('data', (d) => (s += d)).on('end', () => {
  const sys = readFileSync(a[a.indexOf('--append-system-prompt-file') + 1], 'utf8');
  appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, JSON.stringify({ tools: a.includes('--tools'), sys: sys.slice(0, 30), stdin: s.slice(0, 40) }) + '\\n');
  if (sys.startsWith('You are the Research Explorer')) console.log('## Files\\n- \`src/workflow.ts\` — the engine (from fake claude)\\n## Patterns\\n- plain functions\\n## Gaps\\n- none');
  else if (sys.startsWith('You are the Token Compressor')) console.log('## Files\\n- \`src/workflow.ts\` — engine\\n## Patterns\\n- plain\\n## Gaps\\n- none');
  else if (sys.startsWith('You are the Prompt Optimizer')) console.log('# Final prompt\\nBuild it from the fake claude optimizer.');
  else if (sys.startsWith('You are building')) console.log('edited\\nSUMMARY: fake agent built it');
  else console.log('looks fine\\nVERDICT: PASS');
});
`);
  const bin = join(dir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  writeFileSync(bin, process.platform === 'win32' ? `@echo off\r\nnode "${script}" %*\r\n` : `#!/bin/sh\nexec node "${script}" "$@"\n`, { mode: 0o755 });
  const r = cli(['start', '--id', T4, '--runner', 'claude', '--check', OKCHECK], { COMMAND_CENTER_CLAUDE: bin });
  check('X3 --runner claude pipes each stage through the Claude CLI interface (stand-in binary): prepare, dispatch, checks, complete', r.code === 0 && q(`SELECT status FROM subtasks WHERE id=?`, T4)[0].status === 'review', r.out.trim().split('\n').slice(-2).join(' | ').slice(0, 200));
  const calls = readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('X4 analysis stages get read-only tools, the builder gets edit tools, the prompt arrives on stdin', calls.length === 4 && calls.slice(0, 3).every((c) => c.tools) && !calls[3].tools && /TASK-0\d\d/.test(calls[3].stdin), calls.map((c) => `${c.sys.slice(8, 24)}:${c.tools ? 'ro' : 'rw'}`).join(' '));
  const md = readFileSync(join(root, '.claude', 'TASK_CONTEXT.md'), 'utf8');
  check('X5 the stand-in agent\'s output ended up in TASK_CONTEXT.md and the completion summary', /from fake claude|fake claude optimizer/.test(md) && q(`SELECT description FROM agent_log WHERE target_id=? AND action='task_completed'`, T4)[0]?.description.includes('fake agent built it'));
  const nr = cli(['prepare', '--id', T4, '--runner', 'claude'], { COMMAND_CENTER_CLAUDE: join(dir, 'does-not-exist.exe') });
  check('X6 an unusable agent CLI is a clean failure that leaves the task untouched', nr.code === 2 && /failed: Could not run/.test(nr.err), nr.err.trim().slice(0, 140));
});

check('Z0 no console errors/warnings during the whole run', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
// Quit gracefully so before-quit ends the terminal's shells.
void send('Browser.close');
await sleep(2500);
ws.close();
app.kill();
process.exit(results.every((r) => r.ok) ? 0 : 1);
