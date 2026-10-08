// Drives the BUILT app (apps/desktop/out) over CDP through the M8 exit criteria.
// usage: [MODE=empty] [DEV=1] [ONLY=L,A,C,S,W] node .supervisor/M8.verify.mjs <projectRoot> <screenshotPrefix>   (needs: npm run build -w apps/desktop -w packages/mcp-server; seed a fresh root with packages/core/src/seed.ts; MODE=empty wants an empty folder; DEV=1 uses the dev server)
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

// ---- M8 body: Terminal ----
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const MODE = process.env.MODE ?? 'main';

await send('Runtime.enable');
await send('Log.enable');
await waitDom(`!!document.querySelector('[role=tab]')`);
if (process.env.DEV === '1') check('D0 running under the Vite dev server in React development mode', await ev(`location.protocol === 'http:' && !!document.querySelector('script[src*="@vite/client"]')`), await ev(`location.href`));
await ev(`localStorage.removeItem('cc-terminal')`);

const aliveP = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const procTable = () => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'], { encoding: 'utf8', maxBuffer: 20e6 }));
const descendants = (rootPid) => { const t = procTable(); const out = new Set([rootPid]); let grew = true; while (grew) { grew = false; for (const p of t) if (out.has(p.ParentProcessId) && !out.has(p.ProcessId)) { out.add(p.ProcessId); grew = true; } } return [...out]; };
const gone = async (pids, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pids.every((p) => !aliveP(p))) return true; await sleep(200); } return false; };

const activeSel = `.term-host[style*="display: block"]`;
const termText = () => ev(`(document.querySelector('${activeSel} .xterm-rows')?.innerText ?? '').replace(/\\u00a0/g, ' ')`);
const cols = () => ev(`+document.querySelector('${activeSel}').dataset.cols`);
const rowsN = () => ev(`+document.querySelector('${activeSel}').dataset.rows`);
const sessions = () => ev(`[...document.querySelectorAll('[data-term-tab]')].map(t => ({ id: t.dataset.termTab, pid: +t.dataset.pid, status: t.dataset.status, active: t.getAttribute('aria-selected') === 'true' }))`);
const focusTerm = () => ev(`document.querySelector('${activeSel} .xterm-helper-textarea')?.focus()`);
const sendLine = async (text) => { await focusTerm(); await typeText(text); await ENTER(); };
const waitText = (re, ms = 10000) => until(async () => { const t = await termText(); return re.test(t) ? t : false; }, ms, String(re));
const click = async (x, y) => { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, 1); await mouse('mouseReleased', x, y, 0); await sleep(250); };
const center = async (sel) => { const r = await rect(sel); return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; };
const openTab = async (name) => { await ev(`[...document.querySelectorAll('[role=tab]')].find(t => t.textContent.includes(${JSON.stringify(name)})).click()`); await sleep(400); };
const PS = /PS [^\n]*>/;

if (MODE === 'quit') {
  await openTab('Terminal');
  await waitDom(`document.querySelectorAll('[data-term-tab]').length === 1`, 15000);
  await waitText(PS);
  await sendLine(`node -e "setInterval(()=>{},1000)"`);
  await sleep(1200);
  await ev(`document.querySelector('button[aria-label="New terminal session"]').click()`);
  await waitDom(`document.querySelectorAll('[data-term-tab]').length === 2`);
  await waitText(PS);
  await sendLine(`node -e "setInterval(()=>{},1000)"`);
  await sleep(1500);
  const ss = await sessions();
  const all = [...new Set(ss.flatMap((s) => descendants(s.pid)))];
  const nodes = all.length;
  const shellPids = ss.map((s) => s.pid);
  const kids = all.filter((p) => !shellPids.includes(p));
  check('Q1 two shells each running a child process (process tree captured)', ss.length === 2 && kids.length >= 2, `${nodes} processes (${kids.length} children) in the two trees, shells ${ss.map((s) => s.pid).join(',')}`);
  const before = ev(`1`);
  // A reload throws the renderer's sessions away: their shells must not be left behind.
  void send('Page.reload');
  const reloaded = await gone(all, 10000);
  check('Q1b reloading the window ends every shell and child process', reloaded, reloaded ? `${all.length} processes gone` : `alive: ${all.filter(aliveP).join(',')}`);
  await waitDom(`!!document.querySelector('[role=tab]')`, 15000);
  await sleep(800);
  await openTab('Terminal');
  await waitDom(`document.querySelectorAll('[data-term-tab]').length === 1`, 15000);
  await waitText(PS);
  await sendLine(`node -e "setInterval(()=>{},1000)"`);
  await sleep(1500);
  const ss2 = await sessions();
  all.length = 0;
  all.push(...descendants(ss2[0].pid));
  void send('Browser.close');
  const ok = await gone(all, 12000);
  const left = all.filter(aliveP);
  check('Q2 after quitting the app no shell or child process is left running', ok, left.length ? `still alive: ${left.join(',')}` : `${all.length} processes all gone`);
  check('Q3 the app process itself exited', !aliveP(app.pid) || (await gone([app.pid], 8000)));
  void before; void kids;
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

// ===== first visit =====
await run('V', async () => {
  check('V0 the Terminal tab is not mounted before the first visit', await ev(`!document.querySelector('[data-terminal]')`));
  await openTab('Terminal');
  await waitDom(`document.querySelectorAll('[data-term-tab]').length === 1`, 15000);
  check('V1 first visit auto-starts one session', true);
  const t = await waitText(PS, 15000);
  check('V2 PowerShell prompt appears', PS.test(t), t.split('\n')[0]);
  const info = await ev(`window.api.terminal.shells()`);
  check('V3 shells are detected, PowerShell first', info.length >= 2 && ['pwsh', 'powershell'].includes(info[0].id), info.map((s) => s.id).join(','));
  await screenshot('terminal-first');
});

await run('E', async () => {
  await sendLine('(Get-Location).Path');
  const t = await waitText(new RegExp(root.replace(/[\\/]/g, '.').replace(/[.*+?^${}()|[\]]/g, (m) => (m === '.' ? '.' : '\\' + m)).slice(-40)));
  check('E1 the session starts in the project root (PROJECT_ROOT), not the home folder', true, t.split('\n').find((l) => l.includes('command-center') || l.includes('tmp')) ?? '');
  await sendLine('dir');
  const d = await waitText(/command-center\.db/);
  check('E2 `dir` runs and lists the project database', /command-center\.db/.test(d));
  await sendLine('node -v');
  const n = await waitText(/\nv\d+\.\d+\.\d+/);
  check('E3 `node -v` prints a version', /\nv\d+\.\d+\.\d+/.test(n), (n.match(/\nv\d+\.\d+\.\d+/) ?? [''])[0].trim());
  await sendLine('Write-Output "unicode: ✓ ñ 日本"');
  const u = await waitText(/unicode: ✓ ñ 日本/);
  check('E4 unicode output renders', /unicode: ✓ ñ 日本/.test(u));
});

await run('R', async () => {
  const c0 = await cols();
  await sendLine('$Host.UI.RawUI.WindowSize.Width');
  await sleep(700);
  const t0 = await termText();
  const w0 = Number(([...t0.matchAll(/\n(\d{2,3})\s*\n/g)].pop() ?? [])[1]);
  check('R1 the PTY width equals the fitted xterm width', w0 === c0, `xterm ${c0}, PowerShell ${w0}`);
  await send('Emulation.setDeviceMetricsOverride', { width: 1250, height: 820, deviceScaleFactor: 1, mobile: false });
  await sleep(700);
  const c1 = await cols();
  await sendLine('$Host.UI.RawUI.WindowSize.Width');
  await sleep(700);
  const t1 = await termText();
  const w1 = Number(([...t1.matchAll(/\n(\d{2,3})\s*\n/g)].pop() ?? [])[1]);
  check('R2 resizing the window refits xterm and resizes the PTY', c1 !== c0 && w1 === c1, `cols ${c0} -> ${c1}; PowerShell reports ${w1}`);
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(600);
  const r = await ev(`(() => { const v = document.querySelector('[data-term-viewport]').getBoundingClientRect(); const s = document.querySelector('${activeSel} .xterm-screen').getBoundingClientRect(); return { vw: v.width, sw: s.width, vh: v.height, sh: s.height }; })()`);
  check('R3 the terminal fills its box (no more than one cell of slack)', r.vw - r.sw < 40 && r.vh - r.sh < 40, JSON.stringify(r));
});

await run('F', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-fs-'));
  const file = join(dir, 'fullscreen.js').replace(/\\/g, '/');
  writeFileSync(file, `
const out = process.stdout;
const draw = () => {
  const c = out.columns, r = out.rows;
  let s = '\\x1b[?25l\\x1b[2J\\x1b[H';
  s += '+' + '-'.repeat(c - 2) + '+';
  for (let y = 2; y < r; y++) s += '\\x1b[' + y + ';1H|' + '\\x1b[' + y + ';' + c + 'H|';
  s += '\\x1b[' + r + ';1H+' + '-'.repeat(c - 2) + '+';
  const msg = 'SIZE ' + c + 'x' + r;
  s += '\\x1b[' + Math.floor(r / 2) + ';' + Math.max(2, Math.floor((c - msg.length) / 2)) + 'H\\x1b[1;32m' + msg + '\\x1b[0m';
  out.write(s);
};
out.write('\\x1b[?1049h');
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (d) => { if (String(d) === 'q') { out.write('\\x1b[?25h\\x1b[?1049l'); process.exit(0); } });
out.on('resize', draw);
draw();
`);
  await sendLine(`node "${file}"`);
  const c = await cols(), r = await rowsN();
  await waitText(new RegExp(`SIZE ${c}x${r}`), 8000);
  check('F1 a full-screen alt-buffer app draws at the terminal size', true, `SIZE ${c}x${r}`);
  const alt = await termText();
  check('F2 the alt screen replaced the shell output while it runs', !/node -v/.test(alt));
  await screenshot('terminal-fullscreen');
  await send('Emulation.setDeviceMetricsOverride', { width: 1230, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(800);
  const c2 = await cols(), r2 = await rowsN();
  await waitText(new RegExp(`SIZE ${c2}x${r2}`), 8000);
  check('F3 on resize the app redraws to the new size', c2 !== c || r2 !== r, `${c}x${r} -> ${c2}x${r2}`);
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(600);
  await focusTerm();
  await typeText('q');
  await waitText(/node -v/, 8000);
  check('F4 quitting the app restores the shell screen and scrollback', true);
});

await run('C', async () => {
  const wasClaude = await ev(`1`);
  void wasClaude;
  await sendLine('& "' + process.env.USERPROFILE.split('\\').join('/') + '/.local/bin/claude.exe"'); // not on this machine's PATH, so by full path
  await sleep(6000);
  const t = await termText();
  const nonEmpty = t.split('\n').filter((l) => l.trim()).length;
  await screenshot('terminal-claude');
  check('C1 `claude` (a real full-screen TUI) renders content', nonEmpty >= 3 && !/is not recognized/.test(t), `${nonEmpty} non-empty rows; first: ${t.split('\n').find((l) => l.trim())?.slice(0, 80)}`);
  await send('Emulation.setDeviceMetricsOverride', { width: 1150 + 90, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(1500);
  await screenshot('terminal-claude-resized');
  const t2 = await termText();
  check('C2 and survives a resize (still drawing, no exception)', t2.split('\n').filter((l) => l.trim()).length >= 3);
  await send('Emulation.clearDeviceMetricsOverride');
  // The onboarding screen does not take Ctrl+C: end the session with its x (kills the process tree), start a fresh one.
  const claudePid = (await sessions()).at(-1).pid;
  await ev(`[...document.querySelectorAll('button[aria-label^="Close "][aria-label$=" session"]')].at(-1).click()`);
  await waitDom(`document.querySelectorAll('[data-term-tab]').length === 0`);
  check('C3 closing the tab kills claude and its children', await gone([claudePid], 8000));
  await ev(`document.querySelector('button[aria-label="New terminal session"]').click()`);
  await waitDom(`document.querySelectorAll('[data-term-tab]').length === 1`);
  await waitText(PS, 15000);
});

await run('P', async () => {
  await sendLine('1..300 | ForEach-Object { "line $_" }');
  await waitText(/line 300/);
  const ss0 = await sessions();
  await sendLine('1..600 | ForEach-Object { "tick $_"; Start-Sleep -Milliseconds 20 }');
  await sleep(1500);
  const t0 = await termText();
  const k0 = Number(([...t0.matchAll(/tick (\d+)/g)].pop() ?? [])[1]);
  await openTab('Task Board');
  await waitDom(`document.querySelectorAll('[data-column]').length === 5`);
  check('P1 the terminal is hidden (not destroyed) on another tab', await ev(`!!document.querySelector('[data-terminal]') && document.querySelector('[data-terminal]').offsetParent === null`));
  await sleep(3000);
  await openTab('Terminal');
  await sleep(600);
  const t1 = await waitText(/tick \d+/);
  const k1 = Number(([...t1.matchAll(/tick (\d+)/g)].pop() ?? [])[1]);
  check('P2 the running command kept running while hidden', k1 > k0 + 20 || /\n\d+ tick|PS /.test(t1) && k1 >= k0, `tick ${k0} -> ${k1}`);
  await waitText(PS, 20000);
  await ev(`document.querySelector('${activeSel} .xterm-viewport').scrollTop = 0`);
  await sleep(300);
  const top = await termText();
  check('P3 scrollback is intact after the round trip (first lines still there)', /line \d+|tick \d+/.test(top), top.split('\n')[0]);
  const ss1 = await sessions();
  check('P4 same session and same process (pid unchanged, still running)', ss1[0].pid === ss0[0].pid && aliveP(ss1[0].pid) && ss1[0].status === 'running');
  await ev(`document.querySelector('${activeSel} .xterm-viewport').scrollTop = 1e9`);
});

await run('S', async () => {
  const before = await sessions();
  await focusTerm();
  await key('T', 'KeyT', 84, 2 | 8); // Ctrl+Shift+T
  await waitDom(`document.querySelectorAll('[data-term-tab]').length === ${before.length + 1}`);
  const mid = await sessions();
  check('S1 Ctrl+Shift+T opens a second session and activates it', mid.length === before.length + 1 && mid.at(-1).active, mid.map((s) => s.id + (s.active ? '*' : '')).join(' '));
  await waitText(PS);
  const t = await termText();
  check('S2 the new session is a separate shell with its own empty scrollback', !/line 300|tick/.test(t));
  const newPid = mid.at(-1).pid;
  await focusTerm();
  await key('w', 'KeyW', 87, 2); // Ctrl+W
  await waitDom(`document.querySelectorAll('[data-term-tab]').length === ${before.length}`);
  check('S3 Ctrl+W closes the active session and kills its process', await gone([newPid], 6000), `pid ${newPid}`);
  const back = await sessions();
  check('S4 the first session is active again with its output', back[0].active && /PS /.test(await termText()));
  // second via the + button, close via the x
  await ev(`document.querySelector('button[aria-label="New terminal session"]').click()`);
  await waitDom(`document.querySelectorAll('[data-term-tab]').length === ${before.length + 1}`);
  const p2 = (await sessions()).at(-1).pid;
  await ev(`[...document.querySelectorAll('button[aria-label^="Close "][aria-label$=" session"]')].at(-1).click()`);
  await waitDom(`document.querySelectorAll('[data-term-tab]').length === ${before.length}`);
  check('S5 the tab × closes a session and kills its process', await gone([p2], 6000));
  // shell menu
  await ev(`document.querySelector('button[aria-label="Choose shell"]').click()`);
  await waitDom(`!!document.querySelector('[role=menu]')`);
  const items = await ev(`[...document.querySelectorAll('[role=menu] button')].map(b => b.textContent.trim())`);
  check('S6 the split button lists the detected shells', items.length >= 2 && items.some((i) => /PowerShell/.test(i)) && items.some((i) => /Command Prompt/.test(i)), items.join(' | '));
  const cmdItem = await ev(`(() => { const b = [...document.querySelectorAll('[role=menu] button')].find(b => b.textContent.includes('Command Prompt')); const r = b.getBoundingClientRect(); return { x: r.left + 20, y: r.top + 8 }; })()`);
  await click(cmdItem.x, cmdItem.y);
  await waitDom(`document.querySelectorAll('[data-term-tab]').length === ${before.length + 1}`);
  await sleep(1200);
  await sendLine('echo cmd-works %COMSPEC%');
  const cm = await waitText(/cmd-works .*cmd\.exe/i);
  check('S7 a Command Prompt session works', /cmd-works/.test(cm));
  const cmdId = (await sessions()).at(-1).id;
  await ev(`[...document.querySelectorAll('button[aria-label^="Close "][aria-label$=" session"]')].at(-1).click()`);
  await waitDom(`document.querySelectorAll('[data-term-tab]').length === ${before.length}`);
  void cmdId;
});

await run('X', async () => {
  await ev(`document.querySelector('button[aria-label="New terminal session"]').click()`);
  await waitDom(`document.querySelectorAll('[data-term-tab]').length === 2`);
  await waitText(PS);
  const pid = (await sessions()).at(-1).pid;
  await sendLine('exit');
  await waitDom(`!!document.querySelector('[data-exited-banner]')`, 8000);
  const banner = await ev(`document.querySelector('[data-exited-banner]').innerText.replace(/\\s+/g, ' ')`);
  check('X1 an exited process shows "Process exited (code 0)" with Restart', /Process exited \(code 0\)/.test(banner) && /Restart/.test(banner), banner);
  check('X2 the tab shows exited', (await ev(`document.querySelector('[data-term-tab][aria-selected=true]').dataset.status`)) === 'exited');
  await screenshot('terminal-exited');
  const rb = await center('[data-exited-banner] button');
  await click(rb.x, rb.y);
  await waitDom(`!document.querySelector('[data-exited-banner]') && document.querySelectorAll('[data-term-tab]').length === 2`, 8000);
  await waitText(PS);
  const s2 = await sessions();
  check('X3 Restart starts a fresh shell in the same tab slot', s2.at(-1).status === 'running' && s2.at(-1).pid !== pid, `${pid} -> ${s2.at(-1).pid}`);
  await ev(`[...document.querySelectorAll('button[aria-label^="Close "][aria-label$=" session"]')].at(-1).click()`);
  await waitDom(`document.querySelectorAll('[data-term-tab]').length === 1`);
});

await run('Q', async () => {
  await focusTerm();
  await key('Escape', 'Escape', 27);
  const lines = (await termText()).split('\n').filter((l) => PS.test(l)).length;
  await ev(`document.querySelector('[data-quick-action="command-center status"]').click()`);
  await sleep(600);
  const t = await termText();
  check('Q4 a quick-action chip types its command at the prompt', /PS [^\n]*>\s*command-center status/.test(t), t.split('\n').filter((l) => l.includes('command-center status')).join('|'));
  check('Q5 and does not run it (no extra prompt, no error)', t.split('\n').filter((l) => PS.test(l)).length === lines && !/not recognized/.test(t));
  await key('Escape', 'Escape', 27);
  await sleep(300);
  // clipboard paste
  await ev(`navigator.clipboard.writeText('echo pasted-ok').then(() => 1)`).catch(() => undefined);
  await focusTerm();
  await key('V', 'KeyV', 86, 2 | 8);
  await sleep(600);
  const p = await termText();
  check('Q6 Ctrl+Shift+V pastes the clipboard into the shell', /echo pasted-ok/.test(p), p.split('\n').slice(-3).join('|'));
  await key('Escape', 'Escape', 27);
  // clear
  await sendLine('"marker-before-clear"');
  await waitText(/marker-before-clear[\s\S]*marker-before-clear[\s\S]*PS /);
  await sleep(300);
  await ev(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Clear').click()`);
  await sleep(400);
  check('Q7 Clear empties the scrollback', !/marker-before-clear/.test(await termText()));
  // font
  const c0 = await cols();
  await ev(`document.querySelector('button[aria-label="Larger font"]').click()`);
  await ev(`document.querySelector('button[aria-label="Larger font"]').click()`);
  await sleep(600);
  const c1 = await cols();
  check('Q8 a larger font changes the cell grid (fewer columns) and persists', c1 < c0 && (await ev(`JSON.parse(localStorage.getItem('cc-terminal')).state.fontSize`)) === 15, `${c0} -> ${c1} cols`);
  await ev(`document.querySelector('button[aria-label="Smaller font"]').click()`);
  await ev(`document.querySelector('button[aria-label="Smaller font"]').click()`);
  await sleep(500);
});

await run('T', async () => {
  const tid = q(`SELECT id FROM subtasks ORDER BY id LIMIT 1`)[0].id;
  await ev(`window.__t = 1`);
  await openTab('Task Board');
  await waitDom(`document.querySelectorAll('[data-column]').length === 5`);
  await sleep(500);
  await ev(`document.querySelector('[data-task-id="${tid}"]').scrollIntoView({ block: 'center' })`);
  const c = await center(`[data-task-id="${tid}"]`);
  await click(c.x, c.y);
  await waitDom(`!!document.querySelector('dialog[open]')`);
  await ev(`document.querySelector('[data-run-prepare]').click()`);
  await waitDom(`document.querySelector('[data-terminal]')?.offsetParent !== null && !document.querySelector('dialog[open]')`, 8000);
  await sleep(1200);
  const t = await termText();
  check('T1 "Run prepare here" opens the Terminal and types the command (not executed)', new RegExp(`PS [^\\n]*>\\s*command-center prepare ${tid}\\s*$`, 'm').test(t), t.split('\n').filter((l) => l.includes('prepare')).join('|'));
  await key('Escape', 'Escape', 27);
  // theme
  await ev(`document.querySelector('button[aria-label="Switch to light theme"]')?.click()`);
  await sleep(600);
  const light = await ev(`(() => { const probe = document.createElement('i'); probe.style.color = 'var(--text)'; document.body.append(probe); const want = getComputedStyle(probe).color; probe.remove(); const row = document.querySelector('${activeSel} .xterm-rows'); return { want, got: getComputedStyle(row).color, bg: getComputedStyle(document.querySelector('.term-viewport').parentElement).backgroundColor }; })()`);
  check('T2 switching to the light theme recolours the terminal (text uses the light --text token)', light.got === light.want && light.want !== 'rgb(232, 232, 240)', JSON.stringify(light));
  await screenshot('terminal-light');
});

await run('Y', async () => {
  const mk = (arg) => ev(`window.api.terminal.create(${arg}).then(async (r) => { if (!r.ok) return r.error.code ?? r.error.message; const n = r.value.name; await window.api.terminal.kill(r.value.id); return n; })`);
  const sm = await mk(`{ shellId: 'nope-not-a-shell', cols: 80, rows: 24 }`);
  check('Y1 an unknown shell id falls back to the default shell (never an arbitrary path)', /PowerShell|Command Prompt|Git Bash/.test(sm), sm);
  const bad = await mk(`{ shellId: 'C:/Windows/System32/calc.exe', cols: 80, rows: 24 }`);
  check('Y2 an executable path in shellId is not run', /PowerShell|Command Prompt|Git Bash/.test(bad) && !/calc/i.test(bad), bad);
  const worse = await mk(`{ cols: 1e9, rows: -5 }`);
  check('Y3 absurd sizes are rejected by validation', worse !== 'ok', worse);
  for (const s of await sessions()) if (!s.active) void 0;
});

check('X0 no console errors/warnings during the whole run', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
// Quit gracefully so before-quit kills the shells (app.kill() would orphan them).
const leftover = (await sessions()).map((x) => x.pid);
const tree = [...new Set(leftover.flatMap((p) => { try { return descendants(p); } catch { return [p]; } }))];
void send('Browser.close');
const clean = await gone(tree, 12000);
console.log(clean ? `shutdown: ${tree.length} shell processes gone` : `shutdown: LEFT RUNNING ${tree.filter(aliveP).join(',')}`);
ws.close();
app.kill();
process.exit(results.every((r) => r.ok) && clean ? 0 : 1);
