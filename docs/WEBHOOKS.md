# Webhooks

The app listens on `http://127.0.0.1:38120` while it is running. Local connections only; every request needs the token shown in **Agent Hub → Connect** (a copy-ready `curl` is there too). **Regenerate token** invalidates the old one at once.

| Endpoint | Body | Effect |
|---|---|---|
| `POST /webhook/task-update` | `{task_id, status, completed_by?, reason?, summary?, force?}` | Moves the task to `status` through the state machine (`blocked` and a review→`in_progress` reject need `reason`). Unknown `completed_by` ids become `external` agents. `completed_at` is accepted but ignored: core stamps the time. |
| `POST /webhook/milestone-update` | `{milestone_id, planned_start?, planned_end?, actual_start?, actual_end?}` (`YYYY-MM-DD` or `null`) | Sets milestone dates. |
| `POST /webhook/agent-action` | `{agent_id, action, target_type?, target_id?, description?, tags?}` | Appends to the activity log. |
| `GET /webhook/status` | — | `{port, status}` |

Errors: `401` bad/missing token, `403` non-local peer or foreign `Host`, `400` invalid body or status, `404` unknown task/milestone/endpoint, `409` illegal move or unmet dependencies, `413` body over 64 KB.

## curl

```bash
curl -X POST http://127.0.0.1:38120/webhook/task-update \
  -H "Authorization: Bearer $CC_TOKEN" -H "Content-Type: application/json" \
  -d '{"task_id":"TASK-001","status":"done"}'
```

## git post-commit hook (`.git/hooks/post-commit`)

```sh
#!/bin/sh
msg=$(git log -1 --pretty=%s | sed 's/"/\\"/g')
curl -s -X POST http://127.0.0.1:38120/webhook/agent-action \
  -H "Authorization: Bearer $CC_TOKEN" -H "Content-Type: application/json" \
  -d "{\"agent_id\":\"git-hook\",\"action\":\"commit\",\"description\":\"$msg\"}" >/dev/null || true
```

## n8n

HTTP Request node: method `POST`, URL `http://127.0.0.1:38120/webhook/task-update`, Header Auth `Authorization: Bearer <token>`, body type JSON, e.g. `{"task_id": "{{$json.task}}", "status": "done"}`. n8n must run on the same machine (no remote access by design).
