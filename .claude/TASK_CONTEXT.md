# TASK-002: delete File

_WEEK 41, Phase: none, Progress: 50%, Schedule: on_track, Blocked: 0_

## Task description
delete File

**Goal**

TASK-002 says "delete File" and names no file, and it has no acceptance criteria. Research found no target. Deleting is irreversible, so first pin down the exact file with the operator. Delete only after they confirm the exact path.

**Steps, in order**

1. Run `get_task_context` and `get_task_history` for TASK-002. Check for a path, notes, or a rejection reason that names the file.
2. Run `start_task` for TASK-002.
3. If the task names an unambiguous path, go to step 6. Otherwise resolve the ambiguity:
   - "Desktop" could mean `C:\Users\hasan\Desktop`, the `C:\Users\hasan\Desktop\Claude` project folder, or Google Drive.
   - "Last file created" could mean newest by creation time or by modification time, and folders may or may not count.
4. List candidates, sorted by creation time, newest first. For a local path, run this in PowerShell: `Get-ChildItem -Force <dir> | Sort-Object CreationTime -Descending | Select-Object -First 10 Name,CreationTime,LastWriteTime,Length`. For Drive, use `search_files` with `createdTime`, and use `mcp__claude_ai_Google_Drive__get_file_metadata` for details. If read access is denied, say so and ask the operator for the listing or path.
5. Call `block_task` with the reason "needs the exact path confirmed by the operator". Present the top candidates with their creation and modification times, and ask which one to delete. Stop until the operator answers. Do not guess.
6. After the operator confirms, inspect the target (name, size, timestamps, whether it is a file or folder) and show it to them. Then delete only that path.
   - Run `unblock_task` first.
   - Local files: prefer the Recycle Bin over permanent removal. Use `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('<path>','OnlyErrorDialogs','SendToRecycleBin')`.
   - Drive files: use `trash_file`, which is recoverable.
7. Verify the file is gone with `Test-Path`, or by searching Drive. Run `log_action` with the path and the method used.
8. Run `complete_task` with a summary of the exact path, the confirmation received, how it was deleted, and the verification result.

**Files to touch**

Only the single confirmed target. Create or edit no other files.

**Constraints**

- Never delete without the operator's explicit confirmation of the exact path.
- Do not delete, write, or edit anything in `.supervisor/`. That includes `M12.verdict.json` and `STOP`, which belong to the reviewer.
- Do not delete `packages/core/test/delete-task.test.ts`. It is in-progress work alongside the modified `packages/core/src/tasks.ts` and the MCP task tools.
- Do not touch tracked repo files with uncommitted changes (`README.md`, `packages/core/src/tasks.ts`, `packages/mcp-server/**`).
- Do not use wildcards or recursive deletes. Delete one named file.
- Do not delete a folder unless the operator says folders count.
- You cannot approve your own work. After `complete_task`, the operator reviews it.

**Lessons from past rejections**

- None recorded. Do not assume the target. If a rejection later appears in the task history, treat its reason as a rule for this task.

## Acceptance criteria
_None._

## Context files
- command-center/
- .supervisor/
- packages/core/test/delete-task.test.ts

## Reference docs
_None._

## Constraints
_None._

## Relevant lessons
_None._