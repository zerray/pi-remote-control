import { existsSync } from "node:fs";
import { activeBranchEntryIds, activeBranchEntryIdsFromSessionFile, readSessionTranscriptMessages, visibleConversationMessageCount } from "./session-transcript.js";
import { DEFAULT_TRANSCRIPT_PAGE_LIMIT, olderTranscriptPage, recentTranscriptWindow, type TranscriptPage } from "./transcript-pagination.js";
import type { AgentSettlement, ModelCatalogSnapshot, RuntimeStatus, ToolCallStatus, TreeSnapshot } from "./types.js";
import type { UiPrompt, UiPromptResponse } from "./ui-prompt.js";

export type ActiveProject = {
  id: string;
  name: string;
  path: string;
};

export type ActiveSessionRegistration = {
  id: string;
  piSessionId: string;
  project: ActiveProject;
  sessionFile: string;
  name?: string;
  pid: number;
  messageCount: number;
  isStreaming: boolean;
  updatedAt: string;
  runtimeStatus?: RuntimeStatus;
  modelCatalog?: ModelCatalogSnapshot;
  treeSnapshot?: TreeSnapshot;
  treeStateStale?: boolean;
  uiPrompts?: UiPrompt[];
  entries?: unknown[];
};

export type ActiveSessionSummary = {
  id: string;
  piSessionId: string;
  projectId: string;
  name: string | null;
  path: string;
  updatedAt: string;
  messageCount: number;
  isActive: boolean;
};

export type RemoteTuiCommand =
  | { type: "remote_prompt"; requestId: string; text: string; streamingBehavior?: "steer" | "followUp" | null }
  | { type: "remote_abort"; requestId: string }
  | { type: "remote_compact"; requestId: string }
  | { type: "remote_model_catalog_refresh"; requestId: string }
  | { type: "remote_model_select"; requestId: string; provider: string; modelId: string; baseCatalogVersion: string }
  | { type: "remote_tree_refresh"; requestId: string }
  | { type: "remote_tree_navigate"; requestId: string; targetEntryId: string; baseSnapshotVersion: string; baseBranchVersion: string; baseLeafId: string | null; summaryMode: "none" | "default" }
  | { type: "remote_fork"; requestId: string; targetEntryId: string; baseSnapshotVersion: string; baseBranchVersion: string; baseLeafId: string | null }
  | { type: "remote_clone"; requestId: string; baseSnapshotVersion: string; baseBranchVersion: string; baseLeafId: string | null }
  | { type: "remote_ui_prompt_response"; requestId: string; promptId: string; response: UiPromptResponse };

export type ActiveSessionState = TranscriptPage & {
  session: ActiveSessionSummary;
  tools: ToolCallStatus[];
  isStreaming: boolean;
  pendingMessageCount: number;
  runtimeStatus: RuntimeStatus | null;
  uiPrompts: UiPrompt[];
};

export type ActiveSessionTreeSnapshotResult =
  | { ok: true; snapshot: TreeSnapshot }
  | { ok: false; error: "session_not_active" | "tree_state_unavailable" };

export type ActiveSessionModelCatalogResult =
  | { ok: true; catalog: ModelCatalogSnapshot }
  | { ok: false; error: "session_not_active" | "model_catalog_unavailable" };

export type ActiveSessionTreeState = {
  leafId: string | null;
  branchVersion: string;
};

export type ActiveSessionNameGenerator = (request: {
  sessionId: string;
  project: ActiveProject;
  sessionFile: string;
  messages: ReturnType<typeof readSessionTranscriptMessages>;
  runtimeStatus?: RuntimeStatus;
}) => Promise<string | null | undefined>;

export type ActiveSessionRegistry = {
  registerSession(session: ActiveSessionRegistration): ActiveSessionSummary;
  unregisterSession(sessionId: string): boolean;
  touchSession(sessionId: string): boolean;
  updateSessionName(sessionId: string, name: string | null | undefined): boolean;
  pruneInactiveSessions(): string[];
  listProjects(): ActiveProject[];
  listProjectSessions(projectId: string): ActiveSessionSummary[];
  getSessionState(sessionId: string, options?: { messageLimit?: number }): ActiveSessionState | undefined;
  getSessionMessages(sessionId: string, beforeCursor: string, options?: { limit?: number }): TranscriptPage | undefined;
  getModelCatalog(sessionId: string): ActiveSessionModelCatalogResult;
  updateModelCatalog(sessionId: string, catalog: ModelCatalogSnapshot): boolean;
  getTreeSnapshot(sessionId: string): ActiveSessionTreeSnapshotResult;
  updateTreeSnapshot(sessionId: string, snapshot: TreeSnapshot): boolean;
  updateTreeState(sessionId: string, state: ActiveSessionTreeState): boolean;
  updateRuntimeStatus(sessionId: string, status: RuntimeStatus): boolean;
  updateSessionActivity(sessionId: string, activity: { isStreaming: boolean; pendingMessageCount?: number }): boolean;
  openUiPrompt(sessionId: string, prompt: UiPrompt): boolean;
  closeUiPrompt(sessionId: string, promptId: string): boolean;
  getUiPrompt(sessionId: string, promptId: string): UiPrompt | undefined;
  acceptAgentSettlement(sessionId: string, settlementId: string): AgentSettlement | undefined;
  enqueueCommand(sessionId: string, command: RemoteTuiCommand): boolean;
  takeCommands(sessionId: string): RemoteTuiCommand[];
};

export type ActiveSessionRegistryOptions = {
  now?: () => number;
  staleSessionTimeoutMs?: number;
  isProcessRunning?: (pid: number) => boolean;
  nameGenerator?: ActiveSessionNameGenerator;
};

export const DEFAULT_ACTIVE_SESSION_STALE_TIMEOUT_MS = 5_000;

type StoredActiveSession = ActiveSessionRegistration & {
  summary: ActiveSessionSummary;
  tools: ToolCallStatus[];
  pendingMessageCount: number;
  commands: RemoteTuiCommand[];
  uiPrompts: UiPrompt[];
  treeState?: ActiveSessionTreeState;
  lastSettlementId?: string;
  lastSeenAtMs: number;
};

export function createActiveSessionRegistry(options: ActiveSessionRegistryOptions = {}): ActiveSessionRegistry {
  const sessions = new Map<string, StoredActiveSession>();
  const now = options.now ?? Date.now;
  const staleSessionTimeoutMs = options.staleSessionTimeoutMs ?? DEFAULT_ACTIVE_SESSION_STALE_TIMEOUT_MS;
  const isProcessRunning = options.isProcessRunning;
  const nameGenerator = options.nameGenerator;

  const pruneInactiveSessions = (): string[] => {
    const cutoff = now() - staleSessionTimeoutMs;
    const removed: string[] = [];
    for (const [sessionId, session] of sessions) {
      if (session.lastSeenAtMs <= cutoff || (isProcessRunning ? !isProcessRunning(session.pid) : false)) {
        sessions.delete(sessionId);
        removed.push(sessionId);
      }
    }
    return removed;
  };

  return {
    registerSession(session) {
      const summary = toSummary(session);
      sessions.set(session.id, {
        ...session,
        summary,
        tools: [],
        pendingMessageCount: 0,
        commands: [],
        uiPrompts: session.uiPrompts ?? [],
        lastSeenAtMs: now(),
      });
      if (!summary.name && nameGenerator) {
        const messages = readSessionTranscriptMessages(session.sessionFile);
        void nameGenerator({
          sessionId: session.id,
          project: session.project,
          sessionFile: session.sessionFile,
          messages,
          runtimeStatus: session.runtimeStatus,
        }).then((generatedName) => {
          const stored = sessions.get(session.id);
          const trimmed = typeof generatedName === "string" ? generatedName.trim() : "";
          if (stored && trimmed && !stored.summary.name) stored.summary.name = trimmed;
        }).catch(() => undefined);
      }
      return summary;
    },

    unregisterSession(sessionId) {
      return sessions.delete(sessionId);
    },

    touchSession(sessionId) {
      pruneInactiveSessions();
      const session = sessions.get(sessionId);
      if (!session) return false;
      session.lastSeenAtMs = now();
      return true;
    },

    updateSessionName(sessionId, name) {
      pruneInactiveSessions();
      const session = sessions.get(sessionId);
      if (!session) return false;
      const trimmed = typeof name === "string" ? name.trim() : "";
      if (trimmed) session.summary.name = trimmed;
      return true;
    },

    pruneInactiveSessions,

    listProjects() {
      pruneInactiveSessions();
      const projects = new Map<string, ActiveProject>();
      for (const session of sessions.values()) projects.set(session.project.id, session.project);
      return [...projects.values()].sort((left, right) => left.name.localeCompare(right.name));
    },

    listProjectSessions(projectId) {
      pruneInactiveSessions();
      return [...sessions.values()]
        .filter((session) => session.project.id === projectId)
        .map((session) => currentSummary(session))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },

    getSessionState(sessionId, options) {
      pruneInactiveSessions();
      const session = sessions.get(sessionId);
      if (!session) return undefined;
      const messages = readSessionMessages(session);
      return {
        session: {
          ...session.summary,
          messageCount: sessionFileExists(session) ? visibleConversationMessageCount(messages) : session.summary.messageCount,
          updatedAt: messages.at(-1)?.createdAt ?? session.summary.updatedAt,
        },
        ...recentTranscriptWindow(messages, options?.messageLimit ?? DEFAULT_TRANSCRIPT_PAGE_LIMIT),
        tools: session.tools,
        isStreaming: session.isStreaming,
        pendingMessageCount: session.pendingMessageCount,
        runtimeStatus: session.runtimeStatus ?? null,
        uiPrompts: session.uiPrompts,
      };
    },

    getSessionMessages(sessionId, beforeCursor, options) {
      pruneInactiveSessions();
      const session = sessions.get(sessionId);
      if (!session) return undefined;
      return olderTranscriptPage(readSessionMessages(session), beforeCursor, options?.limit ?? DEFAULT_TRANSCRIPT_PAGE_LIMIT);
    },

    getModelCatalog(sessionId) {
      pruneInactiveSessions();
      const session = sessions.get(sessionId);
      if (!session) return { ok: false, error: "session_not_active" };
      if (!session.modelCatalog) return { ok: false, error: "model_catalog_unavailable" };
      return { ok: true, catalog: session.modelCatalog };
    },

    updateModelCatalog(sessionId, catalog) {
      pruneInactiveSessions();
      const session = sessions.get(sessionId);
      if (!session) return false;
      if (JSON.stringify(session.modelCatalog ?? null) === JSON.stringify(catalog)) return false;
      session.modelCatalog = catalog;
      return true;
    },

    getTreeSnapshot(sessionId) {
      pruneInactiveSessions();
      const session = sessions.get(sessionId);
      if (!session) return { ok: false, error: "session_not_active" };
      if (!session.treeSnapshot) return { ok: false, error: "tree_state_unavailable" };
      return {
        ok: true,
        snapshot: session.treeStateStale ? { ...session.treeSnapshot, stale: true } : session.treeSnapshot,
      };
    },

    updateTreeSnapshot(sessionId, snapshot) {
      pruneInactiveSessions();
      const session = sessions.get(sessionId);
      if (!session) return false;
      session.treeSnapshot = snapshot;
      session.treeState = undefined;
      session.treeStateStale = false;
      return true;
    },

    updateTreeState(sessionId, state) {
      pruneInactiveSessions();
      const session = sessions.get(sessionId);
      if (!session) return false;
      session.treeState = state;
      session.treeStateStale = true;
      if (session.treeSnapshot) {
        session.treeSnapshot = { ...session.treeSnapshot, leafId: state.leafId, branchVersion: state.branchVersion };
      }
      return true;
    },

    updateRuntimeStatus(sessionId, status) {
      pruneInactiveSessions();
      const session = sessions.get(sessionId);
      if (!session) return false;
      if (JSON.stringify(session.runtimeStatus ?? null) === JSON.stringify(status)) return false;
      session.runtimeStatus = status;
      return true;
    },

    updateSessionActivity(sessionId, activity) {
      pruneInactiveSessions();
      const session = sessions.get(sessionId);
      if (!session) return false;
      const nextPendingMessageCount = activity.pendingMessageCount ?? session.pendingMessageCount;
      const changed = session.isStreaming !== activity.isStreaming || session.pendingMessageCount !== nextPendingMessageCount;
      session.isStreaming = activity.isStreaming;
      session.pendingMessageCount = nextPendingMessageCount;
      return changed;
    },

    openUiPrompt(sessionId, prompt) {
      pruneInactiveSessions();
      const session = sessions.get(sessionId);
      if (!session || session.uiPrompts.some((open) => open.promptId === prompt.promptId)) return false;
      session.uiPrompts = [...session.uiPrompts, prompt];
      return true;
    },

    closeUiPrompt(sessionId, promptId) {
      pruneInactiveSessions();
      const session = sessions.get(sessionId);
      if (!session || !session.uiPrompts.some((open) => open.promptId === promptId)) return false;
      session.uiPrompts = session.uiPrompts.filter((open) => open.promptId !== promptId);
      return true;
    },

    getUiPrompt(sessionId, promptId) {
      pruneInactiveSessions();
      return sessions.get(sessionId)?.uiPrompts.find((open) => open.promptId === promptId);
    },

    acceptAgentSettlement(sessionId, settlementId) {
      pruneInactiveSessions();
      const session = sessions.get(sessionId);
      if (!session || !settlementId || session.lastSettlementId === settlementId) return undefined;
      session.lastSettlementId = settlementId;
      return { settlementId, sessionId, projectId: session.project.id };
    },

    enqueueCommand(sessionId, command) {
      pruneInactiveSessions();
      const session = sessions.get(sessionId);
      if (!session) return false;
      session.commands.push(command);
      return true;
    },

    takeCommands(sessionId) {
      pruneInactiveSessions();
      const session = sessions.get(sessionId);
      if (!session) return [];
      const commands = session.commands;
      session.commands = [];
      return commands;
    },
  };
}

function currentSummary(session: StoredActiveSession): ActiveSessionSummary {
  const messages = readSessionMessages(session);
  return {
    ...session.summary,
    messageCount: sessionFileExists(session) ? visibleConversationMessageCount(messages) : session.summary.messageCount,
    updatedAt: messages.at(-1)?.createdAt ?? session.summary.updatedAt,
  };
}

function readSessionMessages(session: Pick<StoredActiveSession, "sessionFile" | "treeSnapshot" | "treeStateStale" | "treeState">): ReturnType<typeof readSessionTranscriptMessages> {
  const leafId = session.treeState?.leafId ?? (session.treeStateStale ? null : session.treeSnapshot?.leafId) ?? null;
  if (!leafId) return readSessionTranscriptMessages(session.sessionFile);
  const entryIds = activeBranchEntryIdsFromSessionFile(session.sessionFile, leafId) ?? (!session.treeState && session.treeSnapshot ? activeBranchEntryIds(session.treeSnapshot) : undefined);
  if (!entryIds) {
    session.treeStateStale = true;
    return readSessionTranscriptMessages(session.sessionFile);
  }
  return readSessionTranscriptMessages(session.sessionFile, { entryIds });
}

function sessionFileExists(session: Pick<ActiveSessionRegistration, "sessionFile">): boolean {
  return session.sessionFile.length > 0 && existsSync(session.sessionFile);
}

function publicSessionName(name: string | undefined): string | null {
  const trimmed = name?.trim();
  return trimmed ? trimmed : null;
}

function toSummary(session: ActiveSessionRegistration): ActiveSessionSummary {
  return {
    id: session.id,
    piSessionId: session.piSessionId,
    projectId: session.project.id,
    name: publicSessionName(session.name),
    path: session.sessionFile,
    updatedAt: session.updatedAt,
    messageCount: session.messageCount,
    isActive: true,
  };
}
