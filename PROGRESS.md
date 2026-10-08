# Progress

| Milestone | Status | Notes |
|---|---|---|
| M0 Foundation & tooling | done | Monorepo root + `apps/desktop` (electron-vite, React 19, Tailwind v4). Exit: `npm run dev` opens dark window; typecheck, lint, test pass. |
| M1 Core: schema, DB, state machine | done | `packages/core`: migrations 001/002, zod row schemas, queries, `transition()`, lessons (FTS5), context builders, seed. 66 tests incl. a 3-process concurrent-writer test. |
| M2 Shell, IPC, store, live sync | not started | |
| M3 Task Board | not started | |
| M4 MCP server (core loop) | not started | |
| M5 Swim Lane | not started | |
| M6 Agent Hub | not started | |
| M7 Calendar | not started | |
| M8 Terminal | not started | |
| M9 Operator CLI & pipeline | not started | |
| M10 Self-improving memory | not started | |
| M11 Webhooks | not started | |
| M12 Polish, settings, packaging | not started | |

## Decisions / ambiguities
- M0 versions (D12, latest stable, exact pins): electron 44.7.0, electron-vite 5.0.0, react/react-dom 19.3.0, tailwindcss + @tailwindcss/vite 4.3.3, vitest 5.0.3, eslint 10.12.0, typescript 5.9.3, prettier 3.9.9.
- Vite 7.3.7 pinned with `@vitejs/plugin-react` 5.2.0: electron-vite 5 supports Vite 5–7; plugin-react 6 requires Vite 8 (peer conflict). Revisit when electron-vite supports Vite 8.
- TypeScript kept on 5.x (blueprint `^5.7`); TypeScript 7 not used.
- shadcn/ui init deferred to M2 (no components yet). Simplest choice: tokens + Tailwind `@theme` in `styles.css` only.
- Fonts bundled via `@fontsource/inter` and `@fontsource/jetbrains-mono` (npm, offline).
- CSP `connect-src` allows `localhost` ws/http for Vite HMR in dev; tighten for packaging in M12.
- Electron's postinstall did not fetch the binary under this npm setup; ran `node node_modules/electron/install.js` manually. Recheck on a clean clone.
- Git repo initialised in `command-center/` (was not a repo before M0).
- Window frame: frameless only on macOS; not visually verified on macOS.
- M1 versions: better-sqlite3 13.0.3 (prebuilt, loaded on Node 24 with no build tools), zod 4.6.5, tsx 4.23.15. FTS5 available (SQLite 3.53.4).
- M1 `schema_version` is created by the migration runner, not migration 002 (it must exist before any migration runs). Migrations are TS string modules, not `.sql` files, so they bundle without file-copy steps.
- M1 migration 002 also inserts built-in agents `operator` (human) and `system` (external) so `agent_log` FKs always resolve. `transition()` defaults `actor` to `operator`; other actors must be registered first (M4 auto-registers).
- M1 `transition()` triggers: start, complete, approve, reject, block, unblock, reset. Skip-step moves (todo→done, todo→review) from UI/UX §6.2 are not allowed by the core yet; add a confirmed `skip` path in M3 when the board needs it.
- M1 `start` throws `DependenciesIncompleteError` for unfinished `depends_on` unless `force: true` (board's "start anyway?").
- M1 `acceptance_criteria` is `{text, done}[]` and milestone `notes` is `{text, author, at}[]` (blueprint only says "JSON array").
- M1 `lessons_learned.fix_applied` is '' on reject; M10 fills it (and writes LESSONS_LEARNED.md).
- M1 write transactions use `BEGIN IMMEDIATE` (`write()` helper): deferred read→write upgrades fail with SQLITE_BUSY_SNAPSHOT, which busy_timeout does not retry.
- M1 activity feed pages by `(timestamp, id)` cursor, not offset, so live inserts don't shift pages.
- **M2 risk:** `better-sqlite3` built for Node (tests, seed, CLI, MCP) and for Electron (electron-rebuild) are different binaries in one `node_modules`. Plan a separate Electron-ABI copy or run the app's DB access through a build that doesn't clobber the Node one.
- M1 exit check: `tsx packages/core/src/seed.ts <dir>` made a DB (8 milestones, 60 tasks, 6 agents, 200 log rows) that a second process opened read-only. No `sqlite3` CLI on this machine, so not opened in a SQLite GUI.
- ESLint now applies Node globals to `*.js/*.mjs` (was TS only).
- Observed mid-M1, not made by me: `CLAUDE.md` gained a "Supervisor handoff" section (replaces "STOP and wait for continue" with writing `.supervisor/Mx.handoff.md` and polling `scripts/await-approval.mjs`), and `scripts/await-approval.mjs` + empty `.supervisor/` appeared. Not acted on or committed; waiting on the user to confirm they want this workflow.
- Verified in M0: dev window launched (Electron process up), renderer mounted with `rgb(10,10,16)` background. Pixel-level check of the native window not done.
