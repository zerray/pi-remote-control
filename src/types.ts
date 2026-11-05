import type { UiPrompt } from "./ui-prompt.js";

export type IsoTimestamp = string;

export type DaemonConfig = {
  bindAddress: string;
  advertisedBaseUrl?: string;
  pushGatewayBaseUrl?: string;
};

export type DaemonState = {
  pid: number;
  startedAt: IsoTimestamp;
  version: string;
  piVersion: string;
  bindAddress: string;
  stateDir: string;
};

export type PairedDevice = {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: IsoTimestamp;
  lastSeenAt?: IsoTimestamp;
  revokedAt?: IsoTimestamp;
};

export type DevicePushRoute = {
  deviceId: string;
  routeId: string;
  routeToken: string;
  enabled: boolean;
  updatedAt: IsoTimestamp;
};

export type PairingCode = {
  id: string;
  codeHash: string;
  createdAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
  consumedAt?: IsoTimestamp;
};

export type TranscriptContentBlock =
  | { type: "text"; text: string; truncated?: boolean; originalBytes?: number }
  | { type: "thinking"; thinking: string; truncated?: boolean; originalBytes?: number }
  | { type: "toolCall"; id: string; name: string; arguments: unknown; argumentsTruncated?: boolean; argumentsOriginalBytes?: number }
  | { type: "image"; data: string; mimeType: string; truncated?: boolean; originalBytes?: number };

export type TranscriptMessage = {
  id: string;
  role: "user" | "assistant" | "toolResult" | "system";
  content: TranscriptContentBlock[];
  text: string;
  textTruncated?: boolean;
  textOriginalBytes?: number;
  createdAt: IsoTimestamp;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  isStreaming: boolean;
};

export type TranscriptMessagePatch =
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "toolCall"; toolCall: Extract<TranscriptContentBlock, { type: "toolCall" }> }
  | { type: "replace"; message: TranscriptMessage };

export type TreeFilter = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

export type TreeSnapshot = {
  sessionId: string;
  leafId: string | null;
  snapshotVersion: string;
  branchVersion: string;
  entries: TreeEntry[];
  defaultFilter: "default";
  filters: TreeFilter[];
  generatedAt: IsoTimestamp;
  stale?: boolean;
};

export type TreeEntry = {
  id: string;
  parentId: string | null;
  type: "message" | "custom_message" | "branch_summary" | "compaction" | "model_change" | "thinking_level_change" | "label" | "session_info" | "custom" | "other";
  role?: "user" | "assistant" | "toolResult" | "system" | "custom";
  customType?: string;
  toolName?: string;
  title: string;
  preview: string;
  previewTruncated?: boolean;
  timestamp: IsoTimestamp;
  label?: string;
  isCurrentLeaf: boolean;
  isOnActiveBranch: boolean;
  isForkable: boolean;
  navigationBehavior: "edit_prompt" | "navigate";
};

export type RuntimeStatus = {
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
  updatedAt: IsoTimestamp;
};

export type AgentSettlement = {
  settlementId: string;
  sessionId: string;
  projectId: string;
};

export type RemoteModelSummary = {
  provider: string;
  modelId: string;
  name?: string;
  reasoning: boolean;
  contextWindow?: number;
  maxTokens?: number;
  isScoped: boolean;
};

export type ModelCatalogSnapshot = {
  currentModel: RemoteModelSummary | null;
  models: RemoteModelSummary[];
  catalogVersion: string;
  generatedAt: IsoTimestamp;
};

export type RemoteModelCatalogEvent = { type: "remote_model_catalog"; requestId?: string; catalog: ModelCatalogSnapshot };

export type RemoteModelSelectResultEvent =
  | { type: "remote_model_select_result"; requestId: string; ok: true; model: RemoteModelSummary; catalogVersion: string }
  | { type: "remote_model_select_result"; requestId: string; ok: false; error: "session_busy" | "model_catalog_changed" | "model_not_found" | "model_unavailable" | "selection_failed" };

export type RemoteTreeSnapshotEvent = { type: "remote_tree_snapshot"; requestId?: string; snapshot: TreeSnapshot };

export type RemoteTreeNavigationResultEvent =
  | { type: "remote_tree_navigation_result"; requestId: string; ok: true; leafId: string | null; snapshotVersion: string; branchVersion: string; editorText?: string }
  | { type: "remote_tree_navigation_result"; requestId: string; ok: false; error: "session_busy" | "tree_state_changed" | "target_not_found" | "summarization_failed" | "cancelled" | "aborted" };

export type RemoteForkResultEvent =
  | { type: "remote_fork_result"; requestId: string; ok: true; newSession: unknown; editorText: string }
  | { type: "remote_fork_result"; requestId: string; ok: false; error: "session_busy" | "tree_state_changed" | "target_not_found" | "target_not_forkable" | "cancelled" | "aborted" };

export type RemoteCloneResultEvent =
  | { type: "remote_clone_result"; requestId: string; ok: true; newSession: unknown }
  | { type: "remote_clone_result"; requestId: string; ok: false; error: "session_busy" | "tree_state_changed" | "cancelled" | "aborted" };

export type RemoteSessionReplacedEvent = { type: "remote_session_replaced"; requestId: string; oldSessionId: string; newSession: unknown };

export type RemoteCompactResultEvent =
  | { type: "remote_compact_result"; requestId: string; ok: true; summary: string; firstKeptEntryId: string; tokensBefore: number }
  | { type: "remote_compact_result"; requestId: string; ok: false; message: string };

export type RemoteUiPromptResultEvent =
  | { type: "remote_ui_prompt_result"; requestId: string; promptId: string; ok: true }
  | { type: "remote_ui_prompt_result"; requestId: string; promptId: string; ok: false; error: "ui_prompt_closed" | "invalid_ui_prompt_response" | "option_not_found" };

export type TranscriptStreamEvent =
  | { type: "session_state"; state: unknown }
  | { type: "runtime_status"; status: RuntimeStatus }
  | RemoteModelCatalogEvent
  | RemoteModelSelectResultEvent
  | RemoteTreeSnapshotEvent
  | RemoteTreeNavigationResultEvent
  | RemoteForkResultEvent
  | RemoteCloneResultEvent
  | RemoteSessionReplacedEvent
  | RemoteCompactResultEvent
  | RemoteUiPromptResultEvent
  | { type: "ui_prompt_opened"; prompt: UiPrompt }
  | { type: "ui_prompt_closed"; promptId: string }
  | { type: "turn_start"; turnIndex: number; createdAt?: IsoTimestamp }
  | { type: "turn_end"; turnIndex: number }
  | { type: "transcript_message_start"; message: TranscriptMessage }
  | { type: "transcript_message_patch"; messageId: string; contentIndex?: number; patch: TranscriptMessagePatch }
  | { type: "transcript_message_end"; message: TranscriptMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result?: unknown; isError: boolean }
  | { type: "session_closed" }
  | { type: "error"; error: string };

export type ToolCallStatus = {
  id: string;
  name: string;
  status: "pending" | "running" | "succeeded" | "failed" | "aborted";
  summary?: string;
  updatedAt: IsoTimestamp;
};
