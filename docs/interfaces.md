# Interfaces

## iOS app ↔ daemon

Remote endpoints require `Authorization: Bearer <device-token>` unless explicitly noted. Request and response bodies are JSON. Session streaming uses WebSocket JSON messages.

### Pairing

Pair-code creation is not available through the remote iOS API. Codes are created only from the Pi TUI with `/remote-control-pair`.

`/remote-control-pair` displays a QR code that encodes a pairing link, prints a desktop pairing payload as a UTF-8 hex encoding of the same link, and prints the expiration time. The numeric pair code and raw pairing link are not printed as separate TUI text lines. Hex encoding is not a security mechanism; pairing security remains the short-lived pair code and expiration. `baseUrl` comes from daemon config `advertisedBaseUrl` and must be reachable from the client.

`POST /v1/pair/claim` is unauthenticated because the short-lived pair code is the bootstrap proof.

Request:

```json
{
  "pairCode": "123456",
  "deviceName": "Zerray iPhone"
}
```

Response:

```json
{
  "deviceId": "dev_...",
  "token": "...",
  "daemonName": "macbook-pro"
}
```

### Health

`GET /v1/health`

Response:

```json
{
  "status": "ok",
  "daemonVersion": "1.0.0"
}
```

### Push Route registration

`GET /v1/push/config` returns `{ "gatewayBaseUrl": "https://..." }` for the authenticated paired device when the daemon has a trusted HTTPS central gateway configured. It returns `503 push_gateway_unconfigured` otherwise. The app uses this discovery response only for direct route management with the gateway; route registration requests cannot override it.

`PUT /v1/devices/self/push-route` registers or replaces the central Push Gateway route for the paired device identified by the request bearer token. The daemon resolves device identity from authentication; callers do not supply a daemon device ID and cannot modify another paired device.

Request:

```json
{
  "routeId": "pushroute_...",
  "routeToken": "opaque-gateway-bearer-capability",
  "enabled": true
}
```

`routeToken` is a bearer secret and is stored only in owner-readable daemon state. The configured Push Gateway base URL is trusted daemon configuration and cannot be overridden by this request.

Response:

```json
{ "registered": true }
```

`DELETE /v1/devices/self/push-route` disables completion push for the authenticated paired device and removes the daemon's route capability. The iOS app separately revokes the route through its gateway management credential.

The independently deployed central Push Gateway exposes only these narrow routes:

- `POST /v1/routes`: iOS registers an APNs device token, APNs environment, and opaque daemon device ID; the response contains non-secret `routeId`, daemon-facing `routeToken`, and app-facing `managementToken`.
- `PUT /v1/routes/{routeId}/device`: iOS presents `managementToken` to rotate the APNs device token or environment.
- `DELETE /v1/routes/{routeId}`: iOS presents `managementToken` to revoke the route.
- `POST /v1/routes/{routeId}/agent-settled`: a daemon presents `routeToken` with an idempotent Agent Settlement containing only `settlementId`, `projectId`, and `sessionId`; caller-provided title, body, and APNs payload fields are ignored.

The gateway renders the fixed generic alert, owns APNs provider authentication and environment routing, revokes invalid APNs tokens, deduplicates by route and settlement ID, and rate-limits each route. The daemon never receives the APNs device token or provider credential.

### Projects

`GET /v1/projects`

Returns projects derived from active TUI sessions that enabled remote control.

Response:

```json
{
  "projects": [
    {
      "id": "proj_...",
      "name": "pi-ios",
      "path": "/Users/zerray/gitclone/pi-ios"
    }
  ]
}
```

### Sessions

`GET /v1/projects/{projectId}/sessions`

Returns only active remote-control TUI sessions for the project.

Response:

```json
{
  "sessions": [
    {
      "id": "sess_...",
      "piSessionId": "019e0a73-...",
      "projectId": "proj_...",
      "name": "Refactor auth module",
      "path": "/Users/zerray/.pi/agent/sessions/...jsonl",
      "updatedAt": "2026-05-09T09:47:00.000Z",
      "messageCount": 42,
      "isActive": true
    }
  ]
}
```

`name` is the effective display name. If the Pi TUI reports a nonblank session name, that TUI name is returned. If the TUI name is blank or absent, the daemon may return a short LLM-generated name stored only in active daemon process state. If no TUI or generated name is available, `name` is `null`. A later nonblank TUI name replaces any generated name.

`messageCount` is the daemon-computed count of top-level `user` and `assistant` transcript messages derived from the session file. Assistant messages whose `stopReason` is `"toolUse"` are included, because the app can show tool-call activity and details. Assistant thinking and tool-use blocks are content within an assistant message and do not increment the count separately. Top-level `toolResult`, `system`, internal tool execution, lifecycle, and other non-message records are excluded.

`POST /v1/projects/{projectId}/sessions` returns `405 method_not_allowed`. New sessions are created in the Pi TUI, then made visible by running `/remote-control`.

`GET /v1/sessions/{sessionId}?messageLimit={limit}`

Returns the daemon's current state for an active remote-control TUI session with a bounded recent transcript window read from the session's Pi JSONL `sessionFile`. When the daemon has a valid TUI-reported `leafId`, the transcript window is filtered to the active branch path instead of raw JSONL file order. `session.messageCount` uses the transcript message count semantics described above. If `messageLimit` is absent, the daemon uses its default recent-message limit. The daemon enforces a maximum page size. Invalid non-positive limits return `400` with `invalid_limit`.

Response:

```json
{
  "session": {
    "id": "sess_...",
    "piSessionId": "019e0a73-...",
    "projectId": "proj_...",
    "name": "Refactor auth module",
    "path": "/Users/zerray/.pi/agent/sessions/...jsonl",
    "updatedAt": "2026-05-09T09:47:00.000Z",
    "messageCount": 4200,
    "isActive": true
  },
  "messages": [
    {
      "id": "msg_...",
      "role": "assistant",
      "content": [
        { "type": "thinking", "thinking": "Checking the project structure..." },
        { "type": "toolCall", "id": "call_...", "name": "bash", "arguments": { "command": "ls" } },
        { "type": "text", "text": "Recent answer text" }
      ],
      "text": "Recent answer text",
      "createdAt": "2026-05-09T09:47:00.000Z",
      "isStreaming": false
    }
  ],
  "olderMessagesCursor": "opaque-cursor-or-null",
  "hasOlderMessages": true,
  "tools": [],
  "isStreaming": false,
  "pendingMessageCount": 0,
  "runtimeStatus": {
    "model": {
      "provider": "anthropic",
      "id": "claude-sonnet-4-5",
      "name": "Claude Sonnet 4.5",
      "contextWindow": 200000,
      "maxTokens": 8192,
      "reasoning": true
    },
    "thinkingLevel": "medium",
    "usage": {
      "input": 12000,
      "output": 3000,
      "cacheRead": 50000,
      "cacheWrite": 10000,
      "cost": { "input": 0.036, "output": 0.045, "cacheRead": 0.015, "cacheWrite": 0.0375, "total": 0.1335 }
    },
    "context": { "tokens": 65000, "contextWindow": 200000, "percent": 32.5 },
    "updatedAt": "2026-05-09T09:47:00.000Z"
  }
}
```

`messages` are ordered oldest-to-newest within the returned window and represent transcript data persisted in the Pi session file at request time. Each item uses the same `TranscriptMessage` shape as live stream message events. `olderMessagesCursor` is `null` when there are no older messages. When present, the cursor is generated from the oldest returned message's `createdAt` timestamp. The cursor is encoded by the daemon and treated as opaque by clients.

`GET /v1/sessions/{sessionId}/messages?before={cursor}&limit={limit}`

Returns the next older transcript page from the session's Pi JSONL `sessionFile` before `cursor`. When the daemon has a valid TUI-reported `leafId`, the page is filtered to the active branch path instead of raw JSONL file order. The `before` value must be a cursor previously returned by the daemon. It represents an exclusive timestamp upper bound, so returned messages satisfy `createdAt < cursor.createdAt`. Invalid cursors return `400` with `invalid_cursor`. Invalid non-positive limits return `400` with `invalid_limit`.

Response:

```json
{
  "messages": [
    {
      "id": "msg_older",
      "role": "user",
      "content": [{ "type": "text", "text": "Older prompt text" }],
      "text": "Older prompt text",
      "createdAt": "2026-05-09T09:30:00.000Z",
      "isStreaming": false
    }
  ],
  "olderMessagesCursor": "next-older-cursor-or-null",
  "hasOlderMessages": true
}
```

`messages` are ordered oldest-to-newest within the returned page so the app can prepend the page while preserving transcript order. The daemon must not include duplicate message IDs within a single response. Pi Relay must still de-duplicate merged pages and live stream updates by message `id` because page requests and live events can overlap.

Public transcript messages use this shape:

```ts
type TranscriptMessage = {
  id: string;
  role: "user" | "assistant" | "toolResult" | "system";
  content: Array<
    | { type: "text"; text: string; truncated?: boolean; originalBytes?: number }
    | { type: "thinking"; thinking: string; truncated?: boolean; originalBytes?: number }
    | { type: "toolCall"; id: string; name: string; arguments: unknown; argumentsTruncated?: boolean; argumentsOriginalBytes?: number }
    | { type: "image"; data: string; mimeType: string; truncated?: boolean; originalBytes?: number }
  >;
  text: string;
  textTruncated?: boolean;
  textOriginalBytes?: number;
  createdAt: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  isStreaming: boolean;
};
```

`content` preserves Pi message blocks. `text` is a simple display summary. Tool-result messages include `toolCallId`, `toolName`, and `isError` when available. Truncation metadata is present only when the daemon intentionally sends a preview.

Tree snapshots use these public shapes:

```ts
type TreeSnapshot = {
  sessionId: string;
  leafId: string | null;
  snapshotVersion: string;
  branchVersion: string;
  entries: TreeEntry[];
  defaultFilter: "default";
  filters: Array<"default" | "no-tools" | "user-only" | "labeled-only" | "all">;
  generatedAt: string;
  stale?: boolean;
};

type TreeEntry = {
  id: string;
  parentId: string | null;
  type: "message" | "custom_message" | "branch_summary" | "compaction" | "model_change" | "thinking_level_change" | "label" | "session_info" | "custom" | "other";
  role?: "user" | "assistant" | "toolResult" | "system" | "custom";
  customType?: string;
  toolName?: string;
  title: string;
  preview: string;
  previewTruncated?: boolean;
  timestamp: string;
  label?: string;
  isCurrentLeaf: boolean;
  isOnActiveBranch: boolean;
  isForkable: boolean;
  navigationBehavior: "edit_prompt" | "navigate";
};
```

Runtime status snapshots use this shape and may be `null` when the TUI extension has not reported one yet:

```ts
type RuntimeStatus = {
  model: null | {
    provider: string;
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
  };
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | null;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  };
  context: null | {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
  updatedAt: string;
};
```

`POST /v1/sessions/{sessionId}/prompt`

Forwards a prompt to the TUI extension that owns the active session.

Request:

```json
{
  "text": "请解释这个项目结构",
  "streamingBehavior": null
}
```

`streamingBehavior` is `null`, `"steer"`, or `"followUp"`. `null` sends immediately when the TUI is idle; if the TUI is already busy, the extension delivers it as `"followUp"` so Pi does not reject the remote prompt for missing streaming delivery mode.

Response:

```json
{
  "accepted": true
}
```

If the session has no active TUI owner, the daemon returns `409`:

```json
{
  "error": "session_not_active"
}
```

`POST /v1/sessions/{sessionId}/abort`

Forwards abort to the TUI extension that owns the active session.

Response:

```json
{
  "aborted": true
}
```

`POST /v1/sessions/{sessionId}/compact`

Forwards a compact request to the TUI extension that owns the active session. This is the remote-control equivalent of running `/compact` in the Pi TUI. It is an explicit allowlisted action, not generic slash-command passthrough. The HTTP response only confirms that the daemon accepted the command for delivery; the asynchronous compaction outcome is reported later on the session WebSocket as `remote_compact_result`.

Response:

```json
{
  "accepted": true,
  "requestId": "req_..."
}
```

If the session has no active TUI owner, the daemon returns `409`:

```json
{
  "error": "session_not_active"
}
```

### Remote model selection

`GET /v1/sessions/{sessionId}/models` returns the latest Model Catalog Snapshot reported by the owning TUI extension:

```json
{
  "catalog": {
    "currentModel": {
      "provider": "anthropic",
      "modelId": "claude-sonnet-4-5",
      "name": "Claude Sonnet 4.5",
      "reasoning": true,
      "contextWindow": 200000,
      "maxTokens": 8192,
      "isScoped": true
    },
    "models": [],
    "catalogVersion": "modelsv_...",
    "generatedAt": "2026-05-09T09:47:00.000Z"
  }
}
```

The catalog contains only authenticated available models. Public entries omit API keys, provider headers, base URLs, provider environment, auth source, and cost-routing configuration. `isScoped` lets iOS initially mirror Pi's scoped model view; an empty Pi scope marks every available model as selectable from the all-model view.

`POST /v1/sessions/{sessionId}/models/refresh` queues a refresh in the owning TUI and returns:

```json
{ "accepted": true, "requestId": "req_..." }
```

The refreshed catalog arrives later as `remote_model_catalog` on the session WebSocket.

`POST /v1/sessions/{sessionId}/model` queues Remote Model Selection.

Request:

```json
{
  "provider": "anthropic",
  "modelId": "claude-sonnet-4-5",
  "baseCatalogVersion": "modelsv_..."
}
```

The daemon rejects selection with `409 session_busy` while the agent is active, `409 model_catalog_changed` when iOS used a stale catalog, and `409 model_not_found` when the cached catalog does not contain the exact provider/model identity. An accepted request returns a request ID; completion arrives asynchronously as `remote_model_select_result`. The TUI refreshes its live registry and can still report `model_unavailable` if authentication or availability changed after daemon validation.

Remote model selection never accepts free-form model patterns, CLI flags, thinking levels, or slash-command text. Pi performs its normal thinking-level clamping after `pi.setModel(...)`.

`GET /v1/sessions/{sessionId}/tree`

Returns the latest daemon-cached Tree Snapshot for an active remote-control session. This read has no side effects and does not ask the TUI extension to refresh. If the daemon has a cached snapshot that it no longer trusts, it still returns that snapshot with `stale: true` so iOS can display it while requesting refresh. If no snapshot is available yet, the daemon returns `409 tree_state_unavailable`; clients may request refresh with `POST /tree/refresh`.

Response:

```json
{
  "snapshot": {
    "sessionId": "sess_...",
    "leafId": "entry_leaf_or_null",
    "snapshotVersion": "treev_...",
    "branchVersion": "branchv_...",
    "entries": [
      {
        "id": "entry_...",
        "parentId": null,
        "type": "message",
        "role": "user",
        "title": "user",
        "preview": "Please inspect the auth flow",
        "timestamp": "2026-05-09T09:47:00.000Z",
        "label": "checkpoint",
        "isCurrentLeaf": false,
        "isOnActiveBranch": true,
        "isForkable": true,
        "navigationBehavior": "edit_prompt"
      }
    ],
    "defaultFilter": "default",
    "filters": ["default", "no-tools", "user-only", "labeled-only", "all"],
    "generatedAt": "2026-05-09T09:47:00.000Z"
  }
}
```

Tree snapshots contain the full reduced tree as a flat entry list. Assistant messages with no nonblank text content are omitted unless they are the current leaf or ended with an error/abort stop reason, matching Pi TUI `/tree` visibility. iOS applies the advertised filters and search locally to the remaining entries. `snapshotVersion` and `branchVersion` are opaque strings; clients compare them for equality and must not infer ordering. Entry previews are capped to about 500 characters and include `previewTruncated: true` when clipped. Labels are projected onto their target entries; label entries may also appear as entries when clients use the `all` filter. Snapshots marked `stale: true` are display-only; tree navigation, fork, and clone requests based on stale snapshots are rejected with `tree_state_changed` until a fresh snapshot is available.

`POST /v1/sessions/{sessionId}/tree/refresh`

Queues a request for the owning TUI extension to report a fresh Tree Snapshot. The HTTP response only confirms delivery was accepted; the fresh snapshot arrives later on the session WebSocket as `remote_tree_snapshot`.

Response:

```json
{ "accepted": true, "requestId": "req_..." }
```

`POST /v1/sessions/{sessionId}/tree/navigate`

Queues Remote Tree Navigation. The owning TUI extension applies Pi `/tree` selection semantics in the live session. User and custom-message targets branch from their parent and may return `editorText`; other targets navigate directly. Remote Tree Navigation is rejected while the session is busy and is guarded by both the Tree Snapshot Version and Branch Version that iOS based its selection on.

Request:

```json
{
  "targetEntryId": "entry_...",
  "baseSnapshotVersion": "treev_...",
  "baseBranchVersion": "branchv_...",
  "baseLeafId": "entry_leaf_or_null",
  "summaryMode": "none"
}
```

`summaryMode` is `"none"` or `"default"`; custom branch-summary focus instructions are not part of the MVP. The HTTP response only confirms that the daemon accepted the command. The final outcome arrives later as `remote_tree_navigation_result`.

Response:

```json
{ "accepted": true, "requestId": "req_..." }
```

Immediate errors include `409 session_not_active` and `409 session_busy` when the daemon already knows the owning session is unavailable or busy. Requests containing custom branch-summary focus fields such as `customInstructions` or `replaceInstructions` return `400 custom_summary_instructions_unsupported` in the MVP.

`POST /v1/sessions/{sessionId}/fork`

Queues Remote Fork. The target must be a user-message Tree Entry from the current Tree Snapshot. Remote Fork creates a replacement Pi session before the selected user prompt and returns that prompt text to iOS as `editorText`; it does not prefill the replacement TUI editor and does not auto-send the prompt. Remote Fork is rejected while the session is busy and is guarded by both the Tree Snapshot Version and Branch Version.

Request:

```json
{
  "targetEntryId": "entry_user_...",
  "baseSnapshotVersion": "treev_...",
  "baseBranchVersion": "branchv_...",
  "baseLeafId": "entry_leaf_or_null"
}
```

Response:

```json
{ "accepted": true, "requestId": "req_..." }
```

The final outcome arrives as `remote_fork_result`. On success, the old session stream also receives `remote_session_replaced` with the new active session summary.

`POST /v1/sessions/{sessionId}/clone`

Queues Remote Clone. Remote Clone duplicates the current active branch into a replacement Pi session and returns no draft text. It is rejected while the session is busy and is guarded by both the Tree Snapshot Version and Branch Version.

Request:

```json
{
  "baseSnapshotVersion": "treev_...",
  "baseBranchVersion": "branchv_...",
  "baseLeafId": "entry_leaf_or_null"
}
```

Response:

```json
{ "accepted": true, "requestId": "req_..." }
```

The final outcome arrives as `remote_clone_result`. On success, the old session stream also receives `remote_session_replaced` with the new active session summary.

### Session stream

`GET /v1/sessions/{sessionId}/stream` upgrades to WebSocket.

Server messages are daemon-normalized transcript stream events. The stream sends a bounded initial `session_state`, additional bounded `session_state` refreshes when session-level activity or active branch changes, turn lifecycle events, live `TranscriptMessage` lifecycle events, normalized tool execution events, `runtime_status`, Model Catalog Snapshots, model-selection results, tree snapshots, remote-action results, `remote_session_replaced`, `session_closed`, and errors. Live `TranscriptMessage.id` values use the same canonical Pi session-entry IDs as HTTP snapshots whenever the message has a persisted session entry. The stream must not send transcript message events with temporary TUI message IDs. It must not send raw Pi TUI extension events or full historical transcript payloads. Full or older persisted history is loaded only through the HTTP session snapshot and transcript-page endpoints. In-progress events that are not yet persisted may be delayed or omitted from the stream until they can be reconciled with the session entry; they are recovered by later snapshot/page reads.

Each WebSocket `session_state` contains a primary window of at most 20 recent messages regardless of the HTTP transcript default. If that primary window contains `toolResult` messages, older assistant messages that declare the matching `toolCall` IDs may be prepended as dependency context, so the final message array can exceed 20. Before the initial `session_state` is sent, oversized string payloads inside those messages are truncated to their first 10 KiB of UTF-8 data and marked with truncation metadata. This preview truncation applies to initial WebSocket state only; HTTP transcript endpoints keep their requested transcript windows, and live incremental events are not changed by this rule.

Initial state:

```json
{
  "type": "session_state",
  "state": {
    "session": { "id": "sess_...", "isActive": true },
    "messages": [
      {
        "id": "msg_...",
        "role": "toolResult",
        "content": [{ "type": "text", "text": "first 10 KiB preview...", "truncated": true, "originalBytes": 1048576 }],
        "text": "first 10 KiB preview...",
        "textTruncated": true,
        "textOriginalBytes": 1048576,
        "createdAt": "2026-05-09T09:47:00.000Z",
        "toolCallId": "call_...",
        "toolName": "bash",
        "isStreaming": false
      }
    ],
    "olderMessagesCursor": null,
    "hasOlderMessages": false,
    "tools": [],
    "isStreaming": false,
    "pendingMessageCount": 0,
    "runtimeStatus": null
  }
}
```

Turn lifecycle events:

```json
{ "type": "turn_start", "turnIndex": 0, "createdAt": "2026-05-09T09:47:00.000Z" }
{ "type": "turn_end", "turnIndex": 0 }
```

`turn_start` marks an active model/tool turn. `turn_end` marks that the turn is complete. Session-level working state is carried by `session_state.state.isStreaming`; the daemon refreshes `session_state` when TUI `agent_start` or `agent_end` changes that value. Transcript content is still delivered through message and tool events.

Message lifecycle events. `transcript_message_start` is emitted for assistant streaming messages; non-streaming user messages are emitted once as `transcript_message_end` to avoid duplicate client display.

```json
{ "type": "transcript_message_start", "message": { "id": "msg_...", "role": "assistant", "content": [], "text": "", "createdAt": "2026-05-09T09:47:00.000Z", "isStreaming": true } }
{ "type": "transcript_message_patch", "messageId": "msg_...", "contentIndex": 0, "patch": { "type": "thinking_delta", "delta": "Checking..." } }
{ "type": "transcript_message_patch", "messageId": "msg_...", "contentIndex": 1, "patch": { "type": "toolCall", "toolCall": { "type": "toolCall", "id": "call_...", "name": "bash", "arguments": { "command": "ls" } } } }
{ "type": "transcript_message_patch", "messageId": "msg_...", "contentIndex": 2, "patch": { "type": "text_delta", "delta": "Done." } }
{ "type": "transcript_message_end", "message": { "id": "msg_...", "role": "assistant", "content": [{ "type": "text", "text": "Done." }], "text": "Done.", "createdAt": "2026-05-09T09:47:02.000Z", "isStreaming": false } }
```

Tool execution events:

```json
{ "type": "tool_execution_start", "toolCallId": "call_...", "toolName": "bash", "args": { "command": "ls" } }
{ "type": "tool_execution_update", "toolCallId": "call_...", "toolName": "bash", "partialResult": { "content": [{ "type": "text", "text": "partial output" }] } }
{ "type": "tool_execution_end", "toolCallId": "call_...", "toolName": "bash", "result": { "content": [{ "type": "text", "text": "final output" }] }, "isError": false }
```

Runtime status events:

```json
{ "type": "runtime_status", "status": { "model": { "provider": "anthropic", "id": "claude-sonnet-4-5", "contextWindow": 200000 }, "thinkingLevel": "medium", "usage": { "input": 12000, "output": 3000, "cacheRead": 50000, "cacheWrite": 10000, "cost": { "input": 0.036, "output": 0.045, "cacheRead": 0.015, "cacheWrite": 0.0375, "total": 0.1335 } }, "context": { "tokens": 65000, "contextWindow": 200000, "percent": 32.5 }, "updatedAt": "2026-05-09T09:47:00.000Z" } }
```

The daemon sends `runtime_status` when the owning TUI extension reports a changed runtime-status snapshot. Clients should treat the event as replacing the previous runtime status for that session.

Model events:

```json
{ "type": "remote_model_catalog", "requestId": "req_models_1", "catalog": { "currentModel": { "provider": "anthropic", "modelId": "claude-sonnet-4-5", "isScoped": true }, "models": [], "catalogVersion": "modelsv_2", "generatedAt": "2026-05-09T09:47:00.000Z" } }
{ "type": "remote_model_select_result", "requestId": "req_model_1", "ok": true, "model": { "provider": "anthropic", "modelId": "claude-sonnet-4-5", "isScoped": true }, "catalogVersion": "modelsv_2" }
{ "type": "remote_model_select_result", "requestId": "req_model_2", "ok": false, "error": "model_unavailable" }
```

Catalog events replace the cached picker state. Selection errors are `session_busy`, `model_catalog_changed`, `model_not_found`, `model_unavailable`, and `selection_failed`. A successful selection also causes a Runtime Status update; clients use Runtime Status as the authority for the active model.

Remote compact result events:

```json
{ "type": "remote_compact_result", "requestId": "req_...", "ok": true, "summary": "Conversation summary...", "firstKeptEntryId": "entry_...", "tokensBefore": 12345 }
{ "type": "remote_compact_result", "requestId": "req_...", "ok": false, "message": "Compaction failed: ..." }
```

The daemon sends `remote_compact_result` when the owning TUI extension reports completion or failure for a prior `remote_compact` command. Clients correlate the result with the `requestId` returned by `POST /v1/sessions/{sessionId}/compact`. Compact results are live stream events and are not included in HTTP session snapshots.

Tree and session replacement events:

```json
{ "type": "remote_tree_snapshot", "requestId": "req_...", "snapshot": { "sessionId": "sess_...", "leafId": "entry_...", "snapshotVersion": "treev_...", "branchVersion": "branchv_...", "entries": [], "defaultFilter": "default", "filters": ["default", "no-tools", "user-only", "labeled-only", "all"], "generatedAt": "2026-05-09T09:47:00.000Z" } }
{ "type": "remote_tree_navigation_result", "requestId": "req_...", "ok": true, "leafId": "entry_...", "snapshotVersion": "treev_...", "branchVersion": "branchv_...", "editorText": "Earlier prompt text" }
{ "type": "remote_tree_navigation_result", "requestId": "req_...", "ok": false, "error": "tree_state_changed" }
{ "type": "remote_fork_result", "requestId": "req_...", "ok": true, "newSession": { "id": "sess_new", "projectId": "proj_...", "isActive": true }, "editorText": "Selected prompt text" }
{ "type": "remote_clone_result", "requestId": "req_...", "ok": true, "newSession": { "id": "sess_new", "projectId": "proj_...", "isActive": true } }
{ "type": "remote_session_replaced", "requestId": "req_...", "oldSessionId": "sess_old", "newSession": { "id": "sess_new", "projectId": "proj_...", "isActive": true } }
```

Remote tree navigation error codes are `session_busy`, `tree_state_changed`, `target_not_found`, `summarization_failed`, `cancelled`, and `aborted`. Remote fork adds `target_not_forkable`. When `tree_state_changed` occurs, the TUI extension also reports a fresh `remote_tree_snapshot` so iOS can retry from current state. After successful tree navigation, the daemon broadcasts a fresh bounded `session_state`; clients should treat `session_state` as the canonical transcript refresh and the navigation result as the action outcome. After successful fork or clone, `remote_session_replaced` gives iOS the new session to subscribe to; the old session stream may then receive `session_closed`.

## Pi TUI extension ↔ daemon

The TUI control interface is package-internal and used by the Pi extension, not by iOS clients. Loopback TUI requests are accepted without a bearer token; non-loopback callers must provide a valid bearer token. The extension normally calls `127.0.0.1:<configured-port>` even when iOS uses `advertisedBaseUrl` over Tailscale.

### Daemon host module resolution

When starting the daemon, the extension sets `PI_REMOTE_CONTROL_PI_ENTRY` only for the child process to the absolute entry-point path of the launching Pi process. The daemon follows entry-point symlinks and resolves optional Pi dependencies relative to that host, not to any stale peers in the extension installation. The entry point is a resolution anchor and is never executed by the daemon.

Manual CLI invocations can supply the same variable. Without it, the daemon uses locally installed peers. Missing or invalid host dependencies yield `piVersion: "unknown"` when version resolution fails and leave generated names unset; they do not prevent daemon startup, status, stop, pairing, or session relay.

### Pair code creation

`/remote-control-pair` asks the daemon to create one short-lived pair code and displays it in the TUI as a QR code, a desktop pairing hex payload, and expiration time.

Response payload:

```json
{
  "pairCode": "123456",
  "expiresAt": "2026-05-09T09:52:00.000Z",
  "advertisedBaseUrl": "https://macbook.tailnet.ts.net:17373",
  "pairingLink": "pi-remote://pair?baseUrl=https%3A%2F%2Fmacbook.tailnet.ts.net%3A17373&code=123456&expiresAt=2026-05-09T09%3A52%3A00.000Z"
}
```

### Session registration

When `/remote-control` enables a session, the extension registers the current TUI session. The registration `name` is the current Pi TUI session name, if one has been explicitly set. A blank or absent `name` lets the daemon generate an ephemeral API display name. The registration `messageCount` is an initial hint from the TUI; public HTTP responses use daemon-computed transcript message counts from `sessionFile` when available. Registration includes the initial tree snapshot when available so branch-aware reads can begin immediately:

```json
{
  "type": "register_session",
  "session": {
    "id": "sess_...",
    "piSessionId": "019e0a73-...",
    "sessionFile": "/Users/zerray/.pi/agent/sessions/...jsonl",
    "name": "Refactor auth module",
    "project": {
      "id": "proj_...",
      "name": "pi-ios",
      "path": "/Users/zerray/gitclone/pi-ios"
    },
    "pid": 12345,
    "messageCount": 42,
    "isStreaming": false,
    "runtimeStatus": {
      "model": { "provider": "anthropic", "id": "claude-sonnet-4-5", "contextWindow": 200000 },
      "thinkingLevel": "medium",
      "usage": { "input": 12000, "output": 3000, "cacheRead": 50000, "cacheWrite": 10000, "cost": { "input": 0.036, "output": 0.045, "cacheRead": 0.015, "cacheWrite": 0.0375, "total": 0.1335 } },
      "context": { "tokens": 65000, "contextWindow": 200000, "percent": 32.5 },
      "updatedAt": "2026-05-09T09:47:00.000Z"
    },
    "modelCatalog": {
      "currentModel": { "provider": "anthropic", "modelId": "claude-sonnet-4-5", "reasoning": true, "contextWindow": 200000, "maxTokens": 8192, "isScoped": true },
      "models": [],
      "catalogVersion": "modelsv_1",
      "generatedAt": "2026-05-09T09:47:00.000Z"
    },
    "treeSnapshot": {
      "sessionId": "sess_...",
      "leafId": "entry_leaf_or_null",
      "snapshotVersion": "treev_...",
      "branchVersion": "branchv_...",
      "entries": [],
      "defaultFilter": "default",
      "filters": ["default", "no-tools", "user-only", "labeled-only", "all"],
      "generatedAt": "2026-05-09T09:47:00.000Z"
    }
  }
}
```

`GET /v1/tui/sessions/{sessionId}/commands` also acts as the TUI heartbeat while remote control is active. The daemon removes active-session registrations when the owning TUI PID exits or when heartbeats stop, then broadcasts `session_closed` to iOS subscribers. If this heartbeat returns `404 { "error": "session_not_found" }` while the TUI extension still has local remote-control state active, the extension re-registers the current session by posting the same registration payload to `/v1/tui/sessions`. If re-registration fails, the extension clears local active state and notifies the user. Entering or resuming a TUI session does not automatically enable remote control; the user must run `/remote-control` each time.

### TUI-to-daemon events

While active, the extension forwards Pi extension events and runtime-status snapshots to the daemon over the package-internal control interface. Raw Pi event payloads are internal inputs only. Before posting message lifecycle events, the extension canonicalizes `message_start`, `message_update`, and `message_end` IDs to the Pi session JSONL message entry ID. If a lifecycle event cannot yet be matched to a unique session entry, the extension buffers it briefly instead of posting a temporary TUI ID. Buffered events are correlated by a TUI temporary message ID when present, otherwise by exact `message.role + message.timestamp`; content hashing and fuzzy text matching are not part of the contract. The daemon normalizes accepted internal events before sending any WebSocket messages to iOS.

Accepted internal event kinds include turn lifecycle, message lifecycle, assistant message updates, tool execution lifecycle, agent lifecycle, Agent Settlement, queue, status, Model Catalog Snapshot, model-selection result, tree, and session lifecycle events emitted or computed by the Pi extension. Runtime-status snapshots are posted as `{ "type": "runtime_status", "status": RuntimeStatus }`; the daemon stores the snapshot and broadcasts the public `runtime_status` WebSocket event when it changes. TUI session-name updates are posted as `{ "type": "session_name", "name": "Refactor auth module" }`; a nonblank name replaces any daemon-generated active-session name.

Tree snapshots are posted as `{ "type": "tree_snapshot", "requestId": "req_...", "snapshot": TreeSnapshot }`. Lightweight branch-state updates may be posted as `{ "type": "tree_state", "leafId": "entry_...", "branchVersion": "branchv_..." }` when the active branch grows and a full snapshot is not needed. `tree_state` is package-internal and is not forwarded to iOS as a public WebSocket event. The daemon stores the latest tree and branch state in active-session process memory. If cached tree state becomes invalid against the session file, transcript reads fall back to linear JSONL order and the daemon marks tree state stale until the TUI reports a fresh snapshot.

Model catalogs are posted as `{ "type": "remote_model_catalog", "requestId": "req_...", "catalog": ModelCatalogSnapshot }`; the daemon replaces its active-session cache and broadcasts the public event. Model-selection outcomes are posted as `{ "type": "remote_model_select_result", "requestId": "req_...", "ok": true, "model": RemoteModelSummary, "catalogVersion": "modelsv_..." }` or a failure with a stable `error`.

Agent Settlement is posted as `{ "type": "agent_settled", "settlementId": "settle_..." }`. The ID is stable for duplicate delivery of the same settled run. The extension emits it only after at least one agent run and does not treat a terminal aborted or error outcome as completed work. The daemon uses it for push idempotency and does not expose it as transcript content.

Remote compact results are posted as `{ "type": "remote_compact_result", "requestId": "req_...", "ok": true, "summary": "...", "firstKeptEntryId": "entry_...", "tokensBefore": 12345 }` or `{ "type": "remote_compact_result", "requestId": "req_...", "ok": false, "message": "..." }`; the daemon broadcasts the public `remote_compact_result` WebSocket event without storing it durably. Tree navigation, fork, clone, and session-replacement results are posted with the public result shapes described in the session stream section.

### Daemon-to-TUI commands

The daemon forwards iOS requests to the owning TUI extension:

```json
{ "type": "remote_prompt", "requestId": "req_...", "text": "...", "streamingBehavior": null }
{ "type": "remote_abort", "requestId": "req_..." }
{ "type": "remote_compact", "requestId": "req_..." }
{ "type": "remote_model_catalog_refresh", "requestId": "req_..." }
{ "type": "remote_model_select", "requestId": "req_...", "provider": "anthropic", "modelId": "claude-sonnet-4-5", "baseCatalogVersion": "modelsv_..." }
{ "type": "remote_tree_refresh", "requestId": "req_..." }
{ "type": "remote_tree_navigate", "requestId": "req_...", "targetEntryId": "entry_...", "baseSnapshotVersion": "treev_...", "baseBranchVersion": "branchv_...", "baseLeafId": "entry_current_or_null", "summaryMode": "default" }
{ "type": "remote_fork", "requestId": "req_...", "targetEntryId": "entry_...", "baseSnapshotVersion": "treev_...", "baseBranchVersion": "branchv_...", "baseLeafId": "entry_current_or_null" }
{ "type": "remote_clone", "requestId": "req_...", "baseSnapshotVersion": "treev_...", "baseBranchVersion": "branchv_...", "baseLeafId": "entry_current_or_null" }
```

Prompt and abort command acknowledgements are not part of the current MVP protocol. Compact, model refresh, model selection, tree navigation, fork, and clone completion are reported asynchronously through their corresponding WebSocket result events. Tree refresh completion is reported through `remote_tree_snapshot`.

## Pi integration boundary

The daemon keeps Pi-specific transport details inside the package. Pi SDK/RPC is not used by the daemon to operate sessions in the MVP; those calls are made by the live TUI process through the extension API.

| Action | Owner |
| --- | --- |
| Create pair code | TUI command `/remote-control-pair` asks daemon locally. |
| Enable remote visibility | TUI command `/remote-control`. |
| List remote sessions | Daemon active TUI session registry. |
| Prompt | iOS → daemon → owning TUI extension → Pi extension API. |
| Abort | iOS → daemon → owning TUI extension → Pi extension API. |
| Compact | iOS → daemon → owning TUI extension → Pi extension API `ctx.compact()` → TUI-reported `remote_compact_result` → iOS WebSocket. |
| Model catalog | Owning TUI model registry → reduced Model Catalog Snapshot → daemon process cache → iOS HTTP/WebSocket. |
| Select model | iOS → daemon stale/busy guard → owning TUI extension → Pi extension API `pi.setModel(...)` → selection result and Runtime Status → iOS WebSocket. |
| Completion push | Pi `agent_settled` → owning TUI extension Agent Settlement → daemon Push Route → central Push Gateway → APNs. |
| Tree refresh | iOS → daemon → owning TUI extension → TUI-reported `TreeSnapshot` → daemon cache → iOS WebSocket. |
| Tree navigation | iOS → daemon → owning TUI extension → Pi extension API `ctx.navigateTree()` → TUI-reported navigation result and tree snapshot → daemon branch-aware state/session refresh → iOS WebSocket. |
| Fork | iOS → daemon → owning TUI extension → Pi extension API `ctx.fork()` → replacement session registration → replacement/result events → iOS WebSocket. |
| Clone | iOS → daemon → owning TUI extension → Pi extension API `ctx.fork(currentLeaf, { position: "at" })` or equivalent clone flow → replacement session registration → replacement/result events → iOS WebSocket. |
| Stream events | Raw Pi event/status/tree snapshot or remote-action result → TUI extension → daemon normalization/storage/forwarding → iOS WebSocket normalized transcript, status, tree, or result event. |
