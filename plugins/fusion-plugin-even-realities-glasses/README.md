# Even Realities Glasses Plugin (Fusion)

`@fusion-plugin-examples/even-realities-glasses` is a standalone Fusion plugin that provides a task-centric card workflow for Even Realities glasses.

## Scope (v1)

- Read board/task status through Fusion dashboard HTTP APIs (`/api/tasks*`)
- Quick capture text into new tasks
- Polling-based task transition notifications
- Agent actions: start work (`in-progress`) and request review (`in-review`)

Out of scope in v1: missions, roadmaps, search, multi-project routing, cloud/remote deployment orchestration.

## Install (workspace local)

From repo root:

```bash
pnpm install
pnpm --filter @fusion-plugin-examples/even-realities-glasses build
pnpm --filter @fusion-plugin-examples/even-realities-glasses test
```

## Required settings

- `fusionApiBaseUrl` (default `http://localhost:4040`)
- `fusionApiToken` (required Bearer token)
- `glassesDeviceId` (optional identifier)
- `pollingIntervalSeconds` (default 30, min 5)
- `notifyOnColumns` (default `["in-review"]`)
- `quickCaptureDefaultColumn` (default `triage`)
- `enableAgentActions` (default `true`)

## Quick capture

Use `POST /quick-capture` for one-gesture glasses capture (`POST /tasks` is still the general-purpose route).

Pipeline:
1. Strip leading wake phrase (`hey fusion`, `fusion`, `ok fusion`, `note`, `task`, `capture`)
2. Strip filler tokens (`um`, `uh`, `er`, `like`, `you know`) and transcript punctuation noise
3. Split first sentence into title + description (title capped at 80 chars; overflow moved into description)
4. Resolve column from request `column` or plugin setting `quickCaptureDefaultColumn` (fallback `triage`)

Example:

```bash
curl -X POST http://localhost:4040/api/plugins/fusion-plugin-even-realities-glasses/quick-capture \
  -H "Authorization: Bearer <apiKey>" \
  -H "Content-Type: application/json" \
  -d '{"text":"hey fusion, file a bug about the merge gate"}'
```

Response:

```json
{
  "task": {
    "id": "FN-1234",
    "description": "file a bug about the merge gate\nfile a bug about the merge gate",
    "column": "triage"
  },
  "card": {
    "id": "task-FN-1234",
    "kind": "task",
    "title": "FN-1234: file a bug about the merge gate",
    "bodyLines": [
      "file a bug about the merge gate\nfile a bug about the merge gate",
      "Column: triage"
    ],
    "accentColor": "yellow"
  }
}
```

## Notifications

Notifications are produced by polling `taskStore.listTasks({ includeArchived: false })` on `pollingIntervalSeconds` and diffing against persisted snapshot rows in `even_realities_seen_tasks`.

Diff reasons:
- `new-task` (task first seen in a watched column)
- `entered-column` (task moved into a watched column)
- `left-column` (task moved out of a watched column)
- `completed` (supported by diff engine; currently disabled in notifier v1)

Snapshot rows survive plugin restarts, so previously-seen tasks are not re-notified after reload.

### Notification endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/notifications` | Read pending events (`limit`, optional `drain=true`) with rendered cards |
| POST | `/notifications/ack` | Ack events by `taskIds` |
| POST | `/notifications/poll-now` | Force immediate poll and return emitted events |

Example:

```bash
curl -X GET "http://localhost:4040/api/plugins/fusion-plugin-even-realities-glasses/notifications?limit=25" \
  -H "Authorization: Bearer <apiKey>"
```

## Security notes

- Uses `Authorization: Bearer <token>` for all API requests.
- Prefer local/self-hosted Fusion instances and avoid exposing dashboard APIs to public networks.
- Treat `fusionApiToken` as secret material and rotate regularly.

## Transport extension point

The plugin intentionally uses `GlassesTransport` + `StubGlassesTransport` for now. The real Even Realities BLE/SDK transport should be wired behind this interface.

Dependency research task FN-3737 was not available in this task runtime, so no concrete protocol implementation is included yet. Integrate the real SDK by replacing the stub transport in `src/index.ts` while keeping route + notifier behavior unchanged.
