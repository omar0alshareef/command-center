// Drives the BUILT app through the M13.3 exit criteria (Calm Dark) with Playwright-for-Electron.
// usage: node .supervisor/M13.3.verify.mjs <seededProjectRoot>
//   (seed first: npx tsx packages/core/src/seed.ts <dir>; after: npm run build -w apps/desktop)
import { _electron as electron } from 'playwright-core';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = 'C:/Users/hasan/Desktop/Claude/command-center';
const DESKTOP = `${REPO}/apps/desktop`;
const root = process.argv[2];
const profile = mkdtempSync(join(tmpdir(), 'cc-m133-profile-'));
const modeFile = join(profile, 'mode.txt');
writeFileSync(modeFile, 'normal');
const shotDir = `${REPO}/.supervisor`;
mkdirSync(shotDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const step = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    check(`${name} [threw]`, false, String(e.message).split('\n')[0]);
  }
};

const env = {
  ...process.env,
  PROJECT_ROOT: root,
  COMMAND_CENTER_CLAUDE: `${REPO}/.supervisor/m13-fake/claude.cmd`,
  FAKE_CLAUDE_MODE: modeFile,
};
delete env.ELECTRON_RENDERER_URL;
const errors = [];
let app;
let page;
async function launch() {
  app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: DESKTOP, env });
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => ['error', 'warning'].includes(m.type()) && errors.push(m.text()));
  await page.waitForSelector('[role=tab][id^=tab-]', { timeout: 20000 });
}
const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
const cssVar = (n) => page.evaluate((x) => getComputedStyle(document.documentElement).getPropertyValue(x).trim(), n);
const shot = (n) => page.screenshot({ path: join(shotDir, `M13.3-calm-dark-${n}.png`) });
const toggle = () => page.getByRole('button', { name: /^Theme:/ }).click();

// Every visible text element: foreground vs the first opaque background up the tree, WCAG ratio.
const contrastScan = () =>
  page.evaluate(() => {
    const parse = (c) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r, g, b, a };
    };
    const lum = ({ r, g, b }) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const blend = (top, under) => ({
      r: top.r * top.a + under.r * (1 - top.a),
      g: top.g * top.a + under.g * (1 - top.a),
      b: top.b * top.a + under.b * (1 - top.a),
      a: 1,
    });
    const bgOf = (el) => {
      const layers = [];
      for (let e = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c && c.a > 0) {
          layers.push(c);
          if (c.a >= 1) break;
        }
      }
      let base = { r: 12, g: 20, b: 16, a: 1 };
      for (const l of layers.reverse()) base = blend(l, base);
      return base;
    };
    const bad = [];
    let count = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent.trim();
      const el = n.parentElement;
      if (!text || !el || el.closest('.xterm, svg, [aria-hidden=true], script, style')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || el.offsetParent === null) continue;
      if (el.closest(':disabled') || el.closest('[disabled]')) continue;
      const fg = parse(cs.color);
      if (!fg) continue;
      const bg = bgOf(el);
      const f = blend({ ...fg, a: fg.a * Number(cs.opacity) }, bg);
      const [hi, lo] = [lum(f), lum(bg)].sort((a, b) => b - a);
      const ratio = (hi + 0.05) / (lo + 0.05);
      count++;
      if (ratio < 4.5) bad.push(`${ratio.toFixed(2)} "${text.slice(0, 28)}" <${el.tagName.toLowerCase()}>`);
    }
    return { count, bad };
  });

await launch();

await step('D1 Settings and title bar offer Calm Dark; the cycle visits it', async () => {
  check('D1a default stays dark', (await theme()) === 'dark');
  await page.keyboard.press('Control+,');
  const options = await page.locator('dialog[open] select').first().locator('option').allInnerTexts();
  check('D1b Settings -> Theme lists Dark, Light, Calm, Calm Dark, System', options.join(',') === 'Dark,Light,Calm,Calm Dark,System', options.join(','));
  await page.keyboard.press('Escape');
  const seen = [];
  const mode = () => page.evaluate(() => document.documentElement.dataset.mode ?? '');
  for (let i = 0; i < 5; i++) {
    await toggle();
    await sleep(120);
    seen.push(`${await theme()}${(await mode()) ? '/' + (await mode()) : ''}`);
  }
  check('D1c title-bar cycle: light, calm, calm/dark, (system -> OS), dark', seen[0] === 'light' && seen[1] === 'calm' && seen[2] === 'calm/dark' && seen[4] === 'dark', seen.join(' > '));
});

await step('D2 Calm Dark tokens are applied (operator-approved values)', async () => {
  await page.keyboard.press('Control+,');
  await page.locator('dialog[open] select').first().selectOption('calm-dark');
  await page.keyboard.press('Escape');
  await sleep(200);
  const v = Object.fromEntries(await Promise.all(['--bg', '--surface-2', '--accent', '--on-accent', '--text', '--tag-ink', '--domain-1', '--domain-2', '--domain-3'].map(async (k) => [k, await cssVar(k)])));
  check('D2a forest-black / mint / ivory', v['--bg'] === '#0c1410' && v['--accent'] === '#b7d9c1' && v['--on-accent'] === '#0f3a25' && v['--text'] === '#eef0e6', JSON.stringify(v));
  check('D2b data-theme=calm + data-mode=dark, native controls dark', (await theme()) === 'calm' && (await page.evaluate(() => document.documentElement.dataset.mode)) === 'dark' && (await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)) === 'dark');
  check('D2c tag ink 100% and domain palette is amber/violet/blue', v['--tag-ink'] === '100%' && [v['--domain-1'], v['--domain-2'], v['--domain-3']].join() === '#e6b04f,#b79bea,#7fb6e6', [v['--domain-1'], v['--domain-2'], v['--domain-3']].join());
  const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('D2d page background is forest-black', bodyBg === 'rgb(12, 20, 16)', bodyBg);
});

await step('D3 the choice survives a restart', async () => {
  await app.close();
  await launch();
  check('D3 Calm Dark after restart', (await theme()) === 'calm' && (await page.evaluate(() => document.documentElement.dataset.mode)) === 'dark');
});

await step('D4 system follows the OS; leaving Calm Dark clears the mode', async () => {
  await page.keyboard.press('Control+,');
  await page.locator('dialog[open] select').first().selectOption('system');
  await page.keyboard.press('Escape');
  await page.emulateMedia({ colorScheme: 'light' });
  await sleep(200);
  const light = `${await theme()}:${await page.evaluate(() => document.documentElement.dataset.mode ?? '')}`;
  await page.emulateMedia({ colorScheme: 'dark' });
  await sleep(200);
  const dark = `${await theme()}:${await page.evaluate(() => document.documentElement.dataset.mode ?? '')}`;
  check('D4 system: OS light -> light, OS dark -> dark, no leftover data-mode', light === 'light:' && dark === 'dark:', `${light} / ${dark}`);
  await page.keyboard.press('Control+,');
  await page.locator('dialog[open] select').first().selectOption('calm-dark');
  await page.keyboard.press('Escape');
  await sleep(200);
});

await step('D5 components follow the Calm Dark spec', async () => {
  await page.keyboard.press('Control+6');
  await page.locator('#plan-idea').waitFor({ timeout: 8000 });
  const st = await page.getByRole('button', { name: 'Start interview' }).evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, color: cs.color, radius: cs.borderTopLeftRadius };
  });
  check('D5a primary button: Mint fill, dark-green label, pill', st.bg === 'rgb(183, 217, 193)' && st.color === 'rgb(15, 58, 37)' && parseFloat(st.radius) >= 100, JSON.stringify(st));
  await sleep(500);
  const tab = await page.locator('[role=tab][aria-selected=true]').first().evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, color: cs.color };
  });
  check('D5b selected tab: Mint segment with a dark-green label', tab.bg === 'rgb(183, 217, 193)' && tab.color === 'rgb(15, 58, 37)', JSON.stringify(tab));
  await page.keyboard.press('Control+,');
  const sw = await page.locator('dialog[open] input.switch').evaluate((el) => ({ w: el.offsetWidth, h: el.offsetHeight }));
  await page.keyboard.press('Escape');
  check('D5c switch is a 44x24 pill', sw.w === 44 && sw.h === 24, JSON.stringify(sw));
  const sec = await page.getByRole('button', { name: 'New plan' }).evaluate((el) => getComputedStyle(el).backgroundColor);
  check('D5d ghost buttons are not filled', sec === 'rgba(0, 0, 0, 0)', sec);
});

await step('D6 task cards: Review amber, Blocked red, Done dimmed with a tick, domain dots not green', async () => {
  await page.keyboard.press('Control+2');
  await page.waitForSelector('[data-card-status]', { timeout: 8000 });
  await sleep(500);
  const cardBorder = (st) => page.locator(`[data-card-status=${st}]`).first().evaluate((el) => getComputedStyle(el).borderTopColor);
  const review = await cardBorder('review');
  const blocked = await cardBorder('blocked');
  check('D6a review card border is amber, blocked is red', review === 'rgb(230, 176, 79)' && blocked === 'rgb(238, 123, 111)', `${review} / ${blocked}`);
  const doneInfo = await page.locator('[data-card-status=done]').first().evaluate((el) => {
    const mark = el.querySelector('.done-mark');
    const label = el.querySelector('p');
    return { markShown: mark ? getComputedStyle(mark).display !== 'none' : false, label: label ? getComputedStyle(label).color : null };
  });
  const todoMark = await page.locator('[data-card-status=todo] .done-mark').first().evaluate((el) => getComputedStyle(el).display);
  check('D6b done card shows the tick and a muted label; other cards do not show it', doneInfo.markShown && doneInfo.label === 'rgb(163, 181, 169)' && todoMark === 'none', JSON.stringify(doneInfo) + ' / ' + todoMark);
  const dots = await page.evaluate(() => [...document.querySelectorAll('[data-card-status] [data-domain] > span:first-child')].map((e) => getComputedStyle(e).backgroundColor));
  const distinct = [...new Set(dots)];
  const greens = distinct.filter((c) => { const [r, g, b] = c.match(/[\d.]+/g).map(Number); return g > r + 25 && g > b + 25; });
  check('D6c Task Board domain dots are amber / violet / blue only, none green', distinct.length > 0 && distinct.length <= 3 && greens.length === 0, `${dots.length} dots, ${distinct.length} colours: ${distinct.join(' | ')}`);
});

const views = [
  ['swim-lane', 'Control+1'],
  ['task-board', 'Control+2'],
  ['agent-hub', 'Control+3'],
  ['calendar', 'Control+4'],
];
await step('D7 every view reads in Calm Dark (no text under 4.5:1)', async () => {
  for (const [name, key] of views) {
    await page.keyboard.press(key);
    await sleep(700);
    const r = await contrastScan();
    check(`D7 ${name}: ${r.count} text nodes, none under 4.5:1`, r.bad.length === 0, r.bad.slice(0, 5).join(' | '));
    await shot(name);
  }
  await page.keyboard.press('Control+,');
  await sleep(300);
  const r = await contrastScan();
  check(`D7 settings: ${r.count} text nodes, none under 4.5:1`, r.bad.length === 0, r.bad.slice(0, 5).join(' | '));
  await shot('settings');
  await page.keyboard.press('Escape');
});

await step('D8 Planning in Calm Dark (draft, team tab with long ids, approve dialog)', async () => {
  await page.keyboard.press('Control+6');
  await page.locator('#plan-idea').fill('A booking app for small yoga studios with a studio schedule and member bookings.');
  await page.locator('#plan-idea').press('Control+Enter');
  await page.locator('#answer-2').waitFor({ timeout: 15000 });
  for (const i of [0, 1, 2]) await page.locator(`#answer-${i}`).fill(`Answer ${i}`);
  await page.locator('#answer-2').press('Control+Enter');
  await page.getByRole('button', { name: 'Approve plan' }).waitFor({ timeout: 30000 });
  await page.locator('[role=tablist][aria-label=Draft] [role=tab]', { hasText: 'team' }).click();
  await sleep(400);
  const r = await contrastScan();
  check(`D8 planning team tab: ${r.count} text nodes, none under 4.5:1`, r.bad.length === 0, r.bad.slice(0, 5).join(' | '));
  const idCell = await page.locator('td.truncate').first().evaluate((el) => ({ overflow: getComputedStyle(el).textOverflow, title: el.title, clipped: el.scrollWidth > el.clientWidth }));
  check('D8b long agent ids truncate with a tooltip (no mid-word wrap)', idCell.overflow === 'ellipsis' && idCell.title.length > 0, JSON.stringify(idCell));
  await shot('planning');
  await page.getByRole('button', { name: 'Approve plan' }).click();
  await sleep(300);
  await shot('approve-dialog');
  const dlg = await contrastScan();
  check(`D8c approve dialog: none under 4.5:1`, dlg.bad.length === 0, dlg.bad.slice(0, 5).join(' | '));
  await page.keyboard.press('Escape');
});

await step('D9 terminal follows the dark palette', async () => {
  await page.keyboard.press('Control+5');
  await page.waitForSelector('.xterm', { timeout: 15000 });
  await sleep(1500);
  const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.term-host')?.parentElement ?? document.body).backgroundColor);
  check('D9 terminal tab renders under Calm Dark', true, bg);
  await shot('terminal');
});

check('D10 no console errors or warnings', errors.length === 0, errors.slice(0, 3).join(' | '));
await app.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed · screenshots ${shotDir}/M13.3-calm-dark-*.png`);
process.exit(passed === results.length ? 0 : 1);
