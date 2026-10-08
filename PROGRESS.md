# Progress

| Milestone | Status | Notes |
|---|---|---|
| M0 Foundation & tooling | done | Monorepo root + `apps/desktop` (electron-vite, React 19, Tailwind v4). Exit: `npm run dev` opens dark window; typecheck, lint, test pass. |
| M1 Core: schema, DB, state machine | not started | |
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
- Verified in M0: dev window launched (Electron process up), renderer mounted with `rgb(10,10,16)` background. Pixel-level check of the native window not done.
