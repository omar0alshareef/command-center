# Supervisor Guide (for Claude in Cowork)

Read this first if you are a new Cowork session taking over supervision of the Command Center build.

## Role
Review each milestone Claude Code finishes. Write a verdict. Claude Code builds; the supervisor never edits product code.

## Read order
1. `PROGRESS.md` (what is done), then `git log --oneline | head`
2. `ROADMAP.md` (exit criteria per milestone, decisions D1-D14)
3. `UI_UX_SPEC.md` (visual/interaction rules; §9 QA checklist)
4. `.supervisor/` : `Mx.handoff.md`, `Mx.verdict.json`

## Loop
1. Look in `.supervisor/` for an `Mx.handoff.md` with no `Mx.verdict.json`.
2. Review it:
   - Handoff has REAL command output (typecheck, lint, test, build) and the ROADMAP exit criteria for Mx.
   - Read the key code. Check decisions D1-D14 are followed.
   - Security: contextIsolation on, nodeIntegration off, CSP, no raw SQL over IPC, agent text rendered as text only.
   - "Could not verify" items are listed honestly. Never approve unverified claims.
3. Write `.supervisor/Mx.verdict.json`:
   `{"verdict":"APPROVED"|"CHANGES_REQUESTED","notes":"..."}` (notes = concrete fixes or next-milestone cautions).
4. If CHANGES_REQUESTED, overwrite the same file when re-reviewing the new handoff.
5. Nothing pending: schedule the next check (send_later, about 6 min).
6. Stop after M12 is approved.

## Limits
- Supervisor runs in a Linux VM. It cannot run the Windows app or tests (native binaries). Review = read code + trust/verify reported output.
- Supervisor cannot type into the Claude Code chat or drive the Claude desktop app.
- Claude Code's permission classifier blocked `scripts/await-approval.mjs` once. The user may have to type "continue"/"APPROVED" in the Claude Code chat to relay a verdict.
- Visual checks (look, feel, animation) need the user's eyes. Flag them. Recommend the user open the app after M2, M3, M5.

## Status log (update as you go)
- M0 approved (done by user)
- M1 APPROVED (66 tests)
- M2 APPROVED (73 tests; live sync 109-610 ms)
- M3 Task Board: in progress

## Style
User likes short caveman-style replies (caveman:caveman skill). Code and files stay normal.
