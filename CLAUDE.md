# Command Center

Electron desktop app + MCP server + operator CLI for steering a project worked on by AI agents. Single source of truth: SQLite (`command-center.db`).

## Read first (in this order)
1. `COMMAND_CENTER_BLUEPRINT.md` — architecture, schema, stack, APIs (wins on data/API conflicts)
2. `UI_UX_SPEC.md` — visuals and interaction (wins on UI conflicts)
3. `ROADMAP.md` — milestones M0–M15, decisions D1–D40 (apply these even where the blueprint differs). M0–M12 are done and approved; M13, M14 (Slice 1 first) and M15 remain.

## Working rules
- Build one milestone at a time, in order, starting at the first not-done milestone in `PROGRESS.md`.
- Operator authorization (2026-10-13): build M13.1, M13.2, M14 (Slice 1 first, then the rest of M14) and M15 in ROADMAP order, one after another, without waiting for "continue" between them. The Supervisor handoff still applies after each milestone. Stop after M15: `.supervisor/STOP_AFTER` contains `M15`. Do not start anything after M15.
- At milestone start: state the goal and files to create/change. At the end: run the exit criteria, show results, update `PROGRESS.md`, commit (`feat(Mx): ...`), then follow the Supervisor handoff below instead of stopping.
- Definition of Done: `tsc --noEmit` (strict) clean, lint clean, tests pass, `npm run dev` launches, exit criteria verified.
- Ambiguity: choose the simplest option, record it in `PROGRESS.md`, proceed.
- Target OS: Windows first (keep macOS/Linux working). Native modules (`node-pty`, `better-sqlite3`) need electron-rebuild; document Windows build-tool prerequisites.
- Security: contextIsolation on, nodeIntegration off, strict CSP, no raw SQL over IPC, render agent text as text only.

- `PROGRESS.md` is the project log. Record every change, decision, deviation and operator instruction there, dated, as it happens. The supervisor reads this file, and a new session relies on it to know where the project stands.

## Design work
- Visual decisions come from `UI_UX_SPEC.md` §4 (tokens) and §4.8 (Calm theme). Use tokens only: no hex values in components, no new colours without adding a token to the spec first.
- Before changing any view's look, read the matching section of `UI_UX_SPEC.md` §6 and §9 (acceptance checklist).
- Reference images from the operator are the source of truth for a new theme. Extract the exact hex values they give; mark any value you infer as inferred in the spec.
- Anti-slop check on every new view: no decorative gradients, no emoji as icons, no extra accent colours, no text under 4.5:1, no shadows on dense lists, one serif display font only (§4.8).
- Tokens and contrast: run the `test/a11y-tokens` test after any token change.
- Claude Code does not see Cowork skills. Do not rely on them; the spec above is the design brief.

## Layout
npm workspaces: `packages/core`, `packages/mcp-server`, `packages/cli`, `apps/desktop` (see ROADMAP §2).

## Supervisor handoff (replaces waiting for a typed "continue")
A reviewer (Claude in Cowork) checks each milestone. After finishing milestone Mx:
1. Write `.supervisor/Mx.handoff.md`: what you built, files changed, the exact commands you ran for the exit criteria (typecheck, lint, test, anything else) with their real output, deviations/ambiguities, and anything you could not verify (e.g. visual checks).
2. Commit, then run `node scripts/await-approval.mjs Mx`. It polls for up to ~9 minutes.
   - Output `STILL_WAITING` (exit code 2): run the same command again. Keep doing so; do not give up or start the next milestone.
   - `VERDICT: APPROVED`: start the next milestone in ROADMAP order.
   - `VERDICT: CHANGES_REQUESTED`: fix every listed item, rerun the checks, rewrite the handoff, delete nothing from `.supervisor/`, then call `await-approval` again. If a stale verdict file exists from the previous round, use `node scripts/await-approval.mjs Mx` only after the reviewer has replaced it (the reviewer removes/overwrites it when re-reviewing; if you see the same notes again immediately, wait 60s and retry).
3. Never write verdict files yourself. After M12 is approved, stop and report.

## Stop flag
If `.supervisor/STOP` exists, or the verdict notes say "STOP", finish the current milestone, write its handoff, wait for the verdict, then do NOT start the next milestone. Report to the user and end. The user removes `.supervisor/STOP` (or says "continue") to resume.
