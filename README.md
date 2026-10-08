# Command Center

Desktop cockpit for steering a project worked on by AI agents. Single source of truth: SQLite (`command-center.db`) in the project root.

Read the docs in this order: `COMMAND_CENTER_BLUEPRINT.md` → `UI_UX_SPEC.md` → `ROADMAP.md`.

## Prerequisites (Windows)

- Node.js 22+
- Visual Studio Build Tools with the "Desktop development with C++" workload (needed by `node-pty` and `better-sqlite3` in M1/M8)
- Python 3 (node-gyp)

## Quick start

```bash
npm install
npm run dev
```

Optional: set `PROJECT_ROOT` to the project the app should watch (not used by the UI until M2).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Launch the Electron app with hot reload |
| `npm run typecheck` | `tsc --noEmit` (strict) in every workspace |
| `npm run lint` | ESLint over the repo |
| `npm test` | Vitest unit tests |
| `npm run format` | Prettier write |
