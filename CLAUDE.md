# Command Center

Electron desktop app + MCP server + operator CLI for steering a project worked on by AI agents. Single source of truth: SQLite (`command-center.db`).

## Read first (in this order)
1. `COMMAND_CENTER_BLUEPRINT.md` — architecture, schema, stack, APIs (wins on data/API conflicts)
2. `UI_UX_SPEC.md` — visuals and interaction (wins on UI conflicts)
3. `ROADMAP.md` — milestones M0–M12, decisions D1–D14 (apply these even where the blueprint differs)

## Working rules
- Build one milestone at a time, in order, starting at the first not-done milestone in `PROGRESS.md`.
- At milestone start: state the goal and files to create/change. At the end: run the exit criteria, show results, update `PROGRESS.md`, commit (`feat(Mx): ...`), then STOP and wait for "continue".
- Definition of Done: `tsc --noEmit` (strict) clean, lint clean, tests pass, `npm run dev` launches, exit criteria verified.
- Ambiguity: choose the simplest option, record it in `PROGRESS.md`, proceed.
- Target OS: Windows first (keep macOS/Linux working). Native modules (`node-pty`, `better-sqlite3`) need electron-rebuild; document Windows build-tool prerequisites.
- Security: contextIsolation on, nodeIntegration off, strict CSP, no raw SQL over IPC, render agent text as text only.

## Layout
npm workspaces: `packages/core`, `packages/mcp-server`, `packages/cli`, `apps/desktop` (see ROADMAP §2).
