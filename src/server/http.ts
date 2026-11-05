import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { ActiveSessionRegistry } from "../active-session-registry.js";
import {
  DEFAULT_TRANSCRIPT_PAGE_LIMIT,
  decodeTranscriptCursor,
  InvalidTranscriptCursorError,
  MAX_TRANSCRIPT_PAGE_LIMIT,
  type TranscriptPage,
} from "../transcript-pagination.js";
import { INITIAL_WEBSOCKET_SESSION_MESSAGE_LIMIT, previewInitialSessionState } from "../transcript-preview.js";
import { normalizeTuiEvent } from "../transcript-stream.js";
import type { AgentSettlement, DaemonConfig, DevicePushRoute, RemoteCloneResultEvent, RemoteCompactResultEvent, RemoteForkResultEvent, RemoteModelCatalogEvent, RemoteModelSelectResultEvent, RemoteModelSummary, RemoteSessionReplacedEvent, RemoteTreeNavigationResultEvent, RemoteTreeSnapshotEvent, RuntimeStatus } from "../types.js";

export type RemoteSessionSummary = {
  id: string;
  piSessionId: string;
  projectId: string;
  name: string | null;
  path: string;
  updatedAt: string;
  messageCount: number;
};

export type RemoteSessionState = {
  session: unknown;
  messages: unknown[];
  olderMessagesCursor: string | null;
  hasOlderMessages: boolean;
  tools: unknown[];
  isStreaming: boolean;
  pendingMessageCount: number;
  runtimeStatus?: unknown;
};

export type PromptSessionRequest = {
  text: string;
  streamingBehavior?: "steer" | "followUp" | null;
};

export type SessionService = {
  listProjectSessions?(projectId: string): Promise<RemoteSessionSummary[]>;
  createProjectSession?(projectId: string): Promise<RemoteSessionSummary>;
  getSessionState?(sessionId: string, options?: { messageLimit: number }): Promise<RemoteSessionState>;
  getSessionMessages?(sessionId: string, request: { before: string; limit: number }): Promise<TranscriptPage>;
  promptSession?(sessionId: string, request: PromptSessionRequest): Promise<void>;
  abortSession?(sessionId: string): Promise<void>;
  compactSession?(sessionId: string): Promise<void>;
  streamSession?(sessionId: string, send: (event: unknown) => void): Promise<void>;
};

export type DaemonServer = {
  address: string;
  close(): Promise<void>;
};

export type PairClaimRequest = {
  pairCode: string;
  deviceName: string;
};

export type PairClaimResponse = {
  deviceId: string;
  token: string;
  daemonName: string;
};

export type PairCodeResponse = {
  pairCode: string;
  expiresAt: string;
};

export type PairService = {
  createPairingCode?(): Promise<PairCodeResponse>;
  claimPairingCode(request: PairClaimRequest): Promise<PairClaimResponse>;
};

export type PushRouteService = {
  upsertPushRoute(route: DevicePushRoute): Promise<void>;
  removePushRoute(deviceId: string): Promise<boolean>;
};

export type StartServerOptions = {
  stateDir: string;
  config: DaemonConfig;
  piVersion?: string;
  daemonVersion?: string;
  authenticateToken?: (token: string) => boolean | Promise<boolean>;
  resolveDeviceId?: (token: string) => string | undefined | Promise<string | undefined>;
  pushRouteService?: PushRouteService;
  sessionService?: SessionService;
  activeSessions?: ActiveSessionRegistry;
  pairService?: PairService;
  notifyAgentSettlement?: (settlement: AgentSettlement) => Promise<void>;
  sessionSweepIntervalMs?: number;
};

const DEFAULT_SESSION_SWEEP_INTERVAL_MS = 1_000;

type StreamHub = Map<string, Set<WebSocket>>;

export function bindAddressesForConfig(bindAddress: string): string[] {
  const { host, port } = parseBindAddress(bindAddress);
  if (isLoopbackHost(host) || isWildcardHost(host)) return [bindAddress];
  return [bindAddress, `127.0.0.1:${port}`];
}

export async function startDaemonServer(options: StartServerOptions): Promise<DaemonServer> {
  const streamHub: StreamHub = new Map();
  const webSockets = new WebSocketServer({ noServer: true });
  const servers = bindAddressesForConfig(options.config.bindAddress).map(() => createHttpServer(options, streamHub, webSockets));
  const bindAddresses = bindAddressesForConfig(options.config.bindAddress);
  const sweepTimer = options.activeSessions
    ? setInterval(() => closeSessions(options.activeSessions!.pruneInactiveSessions(), streamHub), options.sessionSweepIntervalMs ?? DEFAULT_SESSION_SWEEP_INTERVAL_MS)
    : undefined;
  sweepTimer?.unref?.();

  for (let index = 0; index < servers.length; index += 1) {
    const { host, port } = parseBindAddress(bindAddresses[index] ?? options.config.bindAddress);
    await listen(servers[index]!, host, port);
  }

  const address = servers[0]!.address() as AddressInfo;
  return {
    address: `${address.address}:${address.port}`,
    close: async () => {
      if (sweepTimer) clearInterval(sweepTimer);
      webSockets.close();
      await Promise.all(servers.map((server) => closeServer(server)));
    },
  };
}

function createHttpServer(options: StartServerOptions, streamHub: StreamHub, webSockets: WebSocketServer): Server {
  const server = createServer((request, response) => {
    void handleHttpRequest(request, response, options, streamHub).catch((error: unknown) => {
      handleHttpRequestFailure(error, response);
    });
  });
  server.on("upgrade", (request, socket, head) => {
    void handleUpgrade(request, socket, head, webSockets, options, streamHub).catch(() => {
      socket.destroy();
    });
  });
  return server;
}

// A long-running daemon must survive misbehaving clients: an aborted request or a
// malformed body rejects `handleHttpRequest`, and an unhandled rejection would
// terminate the whole process (Node's default for unhandled rejections).
function handleHttpRequestFailure(error: unknown, response: ServerResponse): void {
  if (response.headersSent || response.writableEnded || response.destroyed) return;
  if (error instanceof InvalidJsonBodyError) {
    writeJson(response, 400, { error: "invalid_json" });
    return;
  }
  if (isClientAbortError(error)) {
    response.destroy();
    return;
  }
  writeJson(response, 500, { error: "internal_error" });
}

function isClientAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message === "aborted"
    || (error as NodeJS.ErrnoException).code === "ECONNRESET"
    || (error as NodeJS.ErrnoException).code === "ERR_STREAM_PREMATURE_CLOSE";
}

async function listen(server: Server, host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: StartServerOptions,
  streamHub: StreamHub,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (request.method === "GET" && pathname === "/v1/health") {
    writeJson(response, 200, {
      status: "ok",
      piVersion: options.piVersion ?? "unknown",
      daemonVersion: options.daemonVersion ?? "1.0.0",
    });
    return;
  }

  if (request.method === "POST" && pathname === "/v1/tui/sessions") {
    if (!(await isTuiAuthorized(request, options))) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    const rawBody = (await readJsonBody(request)) as Record<string, unknown>;
    const { modelCatalog: rawModelCatalog, ...registrationFields } = rawBody;
    const modelCatalog = rawModelCatalog === undefined
      ? undefined
      : reducedRemoteModelCatalogEvent({ type: "remote_model_catalog", catalog: rawModelCatalog })?.catalog;
    const body = {
      ...registrationFields,
      ...(modelCatalog ? { modelCatalog } : {}),
    } as Parameters<ActiveSessionRegistry["registerSession"]>[0];
    const session = options.activeSessions?.registerSession(body);
    writeJson(response, session ? 200 : 503, session ? { session } : { error: "active_sessions_unavailable" });
    return;
  }

  const tuiSessionMatch = pathname.match(/^\/v1\/tui\/sessions\/([^/]+)$/);
  if (request.method === "DELETE" && tuiSessionMatch) {
    if (!(await isTuiAuthorized(request, options))) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    const sessionId = decodeURIComponent(tuiSessionMatch[1] ?? "");
    const unregistered = options.activeSessions?.unregisterSession(sessionId) ?? false;
    if (unregistered) closeSessions([sessionId], streamHub);
    writeJson(response, 200, { unregistered });
    return;
  }

  const tuiCommandsMatch = pathname.match(/^\/v1\/tui\/sessions\/([^/]+)\/commands$/);
  if (request.method === "GET" && tuiCommandsMatch) {
    if (!(await isTuiAuthorized(request, options))) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    const sessionId = decodeURIComponent(tuiCommandsMatch[1] ?? "");
    if (options.activeSessions && !options.activeSessions.touchSession(sessionId)) {
      writeJson(response, 404, { error: "session_not_found" });
      return;
    }
    writeJson(response, 200, { commands: options.activeSessions?.takeCommands(sessionId) ?? [] });
    return;
  }

  const tuiEventMatch = pathname.match(/^\/v1\/tui\/sessions\/([^/]+)\/events$/);
  if (request.method === "POST" && tuiEventMatch) {
    if (!(await isTuiAuthorized(request, options))) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    const sessionId = decodeURIComponent(tuiEventMatch[1] ?? "");
    if (options.activeSessions && !options.activeSessions.touchSession(sessionId)) {
      writeJson(response, 404, { error: "session_not_found" });
      return;
    }
    const event = await readJsonBody(request);
    if ((event as { type?: unknown } | null)?.type === "agent_settled") {
      const settlementId = (event as { settlementId?: unknown }).settlementId;
      if (typeof settlementId !== "string" || !settlementId) {
        writeJson(response, 400, { error: "invalid_agent_settlement" });
        return;
      }
      const settlement = options.activeSessions?.acceptAgentSettlement(sessionId, settlementId);
      if (settlement && options.notifyAgentSettlement) {
        void options.notifyAgentSettlement(settlement).catch(() => undefined);
      }
      writeJson(response, 200, { accepted: true });
      return;
    }
    const modelCatalogEvent = reducedRemoteModelCatalogEvent(event);
    if (modelCatalogEvent) {
      options.activeSessions?.updateModelCatalog(sessionId, modelCatalogEvent.catalog);
      streamHub.get(sessionId)?.forEach((webSocket) => sendWebSocketJson(webSocket, modelCatalogEvent));
      writeJson(response, 200, { accepted: true });
      return;
    }
    const modelSelectResultEvent = reducedRemoteModelSelectResultEvent(event);
    if (modelSelectResultEvent) {
      streamHub.get(sessionId)?.forEach((webSocket) => sendWebSocketJson(webSocket, modelSelectResultEvent));
      writeJson(response, 200, { accepted: true });
      return;
    }
    if (isRuntimeStatusEvent(event)) {
      const changed = options.activeSessions?.updateRuntimeStatus(sessionId, event.status) ?? false;
      if (changed) streamHub.get(sessionId)?.forEach((webSocket) => sendWebSocketJson(webSocket, { type: "runtime_status", status: event.status }));
      writeJson(response, 200, { accepted: true });
      return;
    }
    if (isAgentLifecycleEvent(event)) {
      const changed = options.activeSessions?.updateSessionActivity(sessionId, { isStreaming: event.type === "agent_start" }) ?? false;
      if (changed) broadcastSessionState(sessionId, options, streamHub);
      writeJson(response, 200, { accepted: true });
      return;
    }
    if (isRemoteTreeSnapshotEvent(event)) {
      options.activeSessions?.updateTreeSnapshot(sessionId, event.snapshot);
      streamHub.get(sessionId)?.forEach((webSocket) => sendWebSocketJson(webSocket, event));
      writeJson(response, 200, { accepted: true });
      return;
    }
    if (isTreeStateEvent(event)) {
      const changed = options.activeSessions?.updateTreeState(sessionId, { leafId: event.leafId, branchVersion: event.branchVersion }) ?? false;
      if (changed) broadcastSessionState(sessionId, options, streamHub);
      writeJson(response, 200, { accepted: true });
      return;
    }
    if (isRemoteTreeNavigationResultEvent(event)) {
      if (event.ok) options.activeSessions?.updateTreeState(sessionId, { leafId: event.leafId, branchVersion: event.branchVersion });
      streamHub.get(sessionId)?.forEach((webSocket) => sendWebSocketJson(webSocket, event));
      if (event.ok) broadcastSessionState(sessionId, options, streamHub);
      writeJson(response, 200, { accepted: true });
      return;
    }
    if (isRemoteForkResultEvent(event)) {
      streamHub.get(sessionId)?.forEach((webSocket) => sendWebSocketJson(webSocket, event));
      writeJson(response, 200, { accepted: true });
      return;
    }
    if (isRemoteCloneResultEvent(event)) {
      streamHub.get(sessionId)?.forEach((webSocket) => sendWebSocketJson(webSocket, event));
      writeJson(response, 200, { accepted: true });
      return;
    }
    if (isRemoteSessionReplacedEvent(event)) {
      streamHub.get(sessionId)?.forEach((webSocket) => sendWebSocketJson(webSocket, event));
      options.activeSessions?.unregisterSession(sessionId);
      closeSessions([sessionId], streamHub);
      writeJson(response, 200, { accepted: true });
      return;
    }
    if (isRemoteCompactResultEvent(event)) {
      streamHub.get(sessionId)?.forEach((webSocket) => sendWebSocketJson(webSocket, event));
      writeJson(response, 200, { accepted: true });
      return;
    }
    if (isSessionNameEvent(event)) {
      options.activeSessions?.updateSessionName(sessionId, event.name);
      writeJson(response, 200, { accepted: true });
      return;
    }
    const normalizedEvents = normalizeTuiEvent(event);
    streamHub.get(sessionId)?.forEach((webSocket) => normalizedEvents.forEach((normalizedEvent) => sendWebSocketJson(webSocket, normalizedEvent)));
    writeJson(response, 200, { accepted: true });
    return;
  }

  if (request.method === "POST" && pathname === "/v1/pair/claim") {
    try {
      const body = (await readJsonBody(request)) as PairClaimRequest;
      const result = await options.pairService?.claimPairingCode(body);
      writeJson(response, 200, result ?? { error: "pairing_unavailable" });
    } catch (error) {
      if (error instanceof Error && error.message === "Invalid or expired pairing code") {
        writeJson(response, 400, { error: "invalid_pairing_code" });
      } else {
        writeJson(response, 500, { error: "internal_error" });
      }
    }
    return;
  }

  if ((request.method === "GET" && pathname === "/v1/push/config")
    || ((request.method === "PUT" || request.method === "DELETE") && pathname === "/v1/devices/self/push-route")) {
    const authorization = request.headers.authorization;
    const rawToken = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
    const deviceId = rawToken && options.resolveDeviceId ? await options.resolveDeviceId(rawToken) : undefined;
    if (!deviceId) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    if (request.method === "GET") {
      let gatewayUrl: URL | undefined;
      try {
        gatewayUrl = options.config.pushGatewayBaseUrl ? new URL(options.config.pushGatewayBaseUrl) : undefined;
      } catch {
        gatewayUrl = undefined;
      }
      if (!gatewayUrl || gatewayUrl.protocol !== "https:") {
        writeJson(response, 503, { error: "push_gateway_unconfigured" });
        return;
      }
      writeJson(response, 200, { gatewayBaseUrl: gatewayUrl.toString().replace(/\/$/u, "") });
      return;
    }
    if (!options.pushRouteService) {
      writeJson(response, 503, { error: "push_routes_unavailable" });
      return;
    }
    if (request.method === "DELETE") {
      const removed = await options.pushRouteService.removePushRoute(deviceId);
      writeJson(response, 200, { removed });
      return;
    }
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const routeId = typeof body.routeId === "string" ? body.routeId : "";
    const routeToken = typeof body.routeToken === "string" ? body.routeToken : "";
    if (!routeId || !routeToken || body.enabled !== true) {
      writeJson(response, 400, { error: "invalid_push_route" });
      return;
    }
    await options.pushRouteService.upsertPushRoute({
      deviceId,
      routeId,
      routeToken,
      enabled: true,
      updatedAt: new Date().toISOString(),
    });
    writeJson(response, 200, { registered: true, routeId });
    return;
  }

  if (request.method === "GET" && pathname === "/v1/projects") {
    if (!(await isAuthorized(request, options))) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }

    writeJson(response, 200, { projects: options.activeSessions?.listProjects() ?? [] });
    return;
  }

  const modelCatalogRefreshMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/models\/refresh$/);
  if (request.method === "POST" && modelCatalogRefreshMatch) {
    if (!(await isAuthorized(request, options))) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    const sessionId = decodeURIComponent(modelCatalogRefreshMatch[1] ?? "");
    const requestId = nextRequestId();
    if (!options.activeSessions?.enqueueCommand(sessionId, { type: "remote_model_catalog_refresh", requestId })) {
      writeJson(response, 409, { error: "session_not_active" });
      return;
    }
    writeJson(response, 200, { accepted: true, requestId });
    return;
  }

  const modelSelectionMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/model$/);
  if (request.method === "POST" && modelSelectionMatch) {
    if (!(await isAuthorized(request, options))) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    const sessionId = decodeURIComponent(modelSelectionMatch[1] ?? "");
    const state = options.activeSessions?.getSessionState(sessionId, { messageLimit: 1 });
    if (!state) {
      writeJson(response, 409, { error: "session_not_active" });
      return;
    }
    if (state.isStreaming) {
      writeJson(response, 409, { error: "session_busy" });
      return;
    }
    const catalogResult = options.activeSessions?.getModelCatalog(sessionId);
    if (!catalogResult?.ok) {
      writeJson(response, 409, { error: catalogResult?.error ?? "model_catalog_unavailable" });
      return;
    }
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const provider = typeof body.provider === "string" ? body.provider : "";
    const modelId = typeof body.modelId === "string" ? body.modelId : "";
    const baseCatalogVersion = typeof body.baseCatalogVersion === "string" ? body.baseCatalogVersion : "";
    if (catalogResult.catalog.catalogVersion !== baseCatalogVersion) {
      writeJson(response, 409, { error: "model_catalog_changed" });
      return;
    }
    if (!catalogResult.catalog.models.some((model) => model.provider === provider && model.modelId === modelId)) {
      writeJson(response, 409, { error: "model_not_found" });
      return;
    }
    const requestId = nextRequestId();
    if (!options.activeSessions?.enqueueCommand(sessionId, { type: "remote_model_select", requestId, provider, modelId, baseCatalogVersion })) {
      writeJson(response, 409, { error: "session_not_active" });
      return;
    }
    writeJson(response, 200, { accepted: true, requestId });
    return;
  }

  const modelCatalogMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/models$/);
  if (request.method === "GET" && modelCatalogMatch) {
    if (!(await isAuthorized(request, options))) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    const sessionId = decodeURIComponent(modelCatalogMatch[1] ?? "");
    const result = options.activeSessions?.getModelCatalog(sessionId) ?? { ok: false as const, error: "session_not_active" as const };
    if (!result.ok) {
      writeJson(response, 409, { error: result.error });
      return;
    }
    writeJson(response, 200, { catalog: result.catalog });
    return;
  }

  const abortMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/abort$/);
  if (request.method === "POST" && abortMatch) {
    if (!(await isAuthorized(request, options))) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }

    const sessionId = decodeURIComponent(abortMatch[1] ?? "");
    if (options.activeSessions) {
      if (!options.activeSessions.enqueueCommand(sessionId, { type: "remote_abort", requestId: nextRequestId() })) {
        writeJson(response, 409, { error: "session_not_active" });
        return;
      }
    } else {
      await options.sessionService?.abortSession?.(sessionId);
    }
    writeJson(response, 200, { aborted: true });
    return;
  }

  const compactMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/compact$/);
  if (request.method === "POST" && compactMatch) {
    if (!(await isAuthorized(request, options))) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }

    const sessionId = decodeURIComponent(compactMatch[1] ?? "");
    const requestId = nextRequestId();
    if (options.activeSessions) {
      if (!options.activeSessions.enqueueCommand(sessionId, { type: "remote_compact", requestId })) {
        writeJson(response, 409, { error: "session_not_active" });
        return;
      }
    } else {
      await options.sessionService?.compactSession?.(sessionId);
    }
    writeJson(response, 200, { accepted: true, requestId });
    return;
  }

  const promptMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/prompt$/);
  if (request.method === "POST" && promptMatch) {
    if (!(await isAuthorized(request, options))) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }

    const sessionId = decodeURIComponent(promptMatch[1] ?? "");
    const body = (await readJsonBody(request)) as PromptSessionRequest;
    if (options.activeSessions) {
      if (!options.activeSessions.enqueueCommand(sessionId, {
        type: "remote_prompt",
        requestId: nextRequestId(),
        text: body.text,
        streamingBehavior: body.streamingBehavior,
      })) {
        writeJson(response, 409, { error: "session_not_active" });
        return;
      }
    } else {
      await options.sessionService?.promptSession?.(sessionId, body);
    }
    writeJson(response, 200, { accepted: true });
    return;
  }

  const cloneMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/clone$/);
  if (request.method === "POST" && cloneMatch) {
    if (!(await isAuthorized(request, options))) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }

    const sessionId = decodeURIComponent(cloneMatch[1] ?? "");
    const requestId = nextRequestId();
    const bodyRecord = (await readJsonBody(request)) as Record<string, unknown>;
    const body = {
      baseSnapshotVersion: typeof bodyRecord.baseSnapshotVersion === "string" ? bodyRecord.baseSnapshotVersion : "",
      baseBranchVersion: typeof bodyRecord.baseBranchVersion === "string" ? bodyRecord.baseBranchVersion : "",
      baseLeafId: bodyRecord.baseLeafId === null || typeof bodyRecord.baseLeafId === "string" ? bodyRecord.baseLeafId : null,
    };
    if (options.activeSessions) {
      const state = options.activeSessions.getSessionState(sessionId, { messageLimit: 1 });
      if (!state) {
        writeJson(response, 409, { error: "session_not_active" });
        return;
      }
      if (state.isStreaming) {
        writeJson(response, 409, { error: "session_busy" });
        return;
      }
      const treeResult = options.activeSessions.getTreeSnapshot(sessionId);
      if (!treeResult.ok) {
        writeJson(response, 409, { error: treeResult.error });
        return;
      }
      if (treeResult.snapshot.stale === true
        || treeResult.snapshot.snapshotVersion !== body.baseSnapshotVersion
        || treeResult.snapshot.branchVersion !== body.baseBranchVersion
        || treeResult.snapshot.leafId !== body.baseLeafId) {
        writeJson(response, 409, { error: "tree_state_changed" });
        return;
      }
      if (!options.activeSessions.enqueueCommand(sessionId, { type: "remote_clone", requestId, ...body })) {
        writeJson(response, 409, { error: "session_not_active" });
        return;
      }
    }
    writeJson(response, 200, { accepted: true, requestId });
    return;
  }

  const forkMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/fork$/);
  if (request.method === "POST" && forkMatch) {
    if (!(await isAuthorized(request, options))) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }

    const sessionId = decodeURIComponent(forkMatch[1] ?? "");
    const requestId = nextRequestId();
    const bodyRecord = (await readJsonBody(request)) as Record<string, unknown>;
    const body = {
      targetEntryId: typeof bodyRecord.targetEntryId === "string" ? bodyRecord.targetEntryId : "",
      baseSnapshotVersion: typeof bodyRecord.baseSnapshotVersion === "string" ? bodyRecord.baseSnapshotVersion : "",
      baseBranchVersion: typeof bodyRecord.baseBranchVersion === "string" ? bodyRecord.baseBranchVersion : "",
      baseLeafId: bodyRecord.baseLeafId === null || typeof bodyRecord.baseLeafId === "string" ? bodyRecord.baseLeafId : null,
    };
    if (options.activeSessions) {
      const state = options.activeSessions.getSessionState(sessionId, { messageLimit: 1 });
      if (!state) {
        writeJson(response, 409, { error: "session_not_active" });
        return;
      }
      if (state.isStreaming) {
        writeJson(response, 409, { error: "session_busy" });
        return;
      }
      const treeResult = options.activeSessions.getTreeSnapshot(sessionId);
      if (!treeResult.ok) {
        writeJson(response, 409, { error: treeResult.error });
        return;
      }
      if (treeResult.snapshot.stale === true
        || treeResult.snapshot.snapshotVersion !== body.baseSnapshotVersion
        || treeResult.snapshot.branchVersion !== body.baseBranchVersion
        || treeResult.snapshot.leafId !== body.baseLeafId) {
        writeJson(response, 409, { error: "tree_state_changed" });
        return;
      }
      const target = treeResult.snapshot.entries.find((entry) => entry.id === body.targetEntryId);
      if (!target) {
        writeJson(response, 409, { error: "target_not_found" });
        return;
      }
      if (!target.isForkable) {
        writeJson(response, 409, { error: "target_not_forkable" });
        return;
      }
      if (!options.activeSessions.enqueueCommand(sessionId, { type: "remote_fork", requestId, ...body })) {
        writeJson(response, 409, { error: "session_not_active" });
        return;
      }
    }
    writeJson(response, 200, { accepted: true, requestId });
    return;
  }

  const treeNavigateMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/tree\/navigate$/);
  if (request.method === "POST" && treeNavigateMatch) {
    if (!(await isAuthorized(request, options))) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }

    const sessionId = decodeURIComponent(treeNavigateMatch[1] ?? "");
    const requestId = nextRequestId();
    const bodyRecord = (await readJsonBody(request)) as Record<string, unknown>;
    if (bodyRecord.customInstructions !== undefined || bodyRecord.replaceInstructions !== undefined) {
      writeJson(response, 400, { error: "custom_summary_instructions_unsupported" });
      return;
    }
    const body = {
      targetEntryId: typeof bodyRecord.targetEntryId === "string" ? bodyRecord.targetEntryId : "",
      baseSnapshotVersion: typeof bodyRecord.baseSnapshotVersion === "string" ? bodyRecord.baseSnapshotVersion : "",
      baseBranchVersion: typeof bodyRecord.baseBranchVersion === "string" ? bodyRecord.baseBranchVersion : "",
      baseLeafId: bodyRecord.baseLeafId === null || typeof bodyRecord.baseLeafId === "string" ? bodyRecord.baseLeafId : null,
      summaryMode: bodyRecord.summaryMode === "default" ? "default" as const : "none" as const,
    };
    if (options.activeSessions) {
      const state = options.activeSessions.getSessionState(sessionId, { messageLimit: 1 });
      if (!state) {
        writeJson(response, 409, { error: "session_not_active" });
        return;
      }
      if (state.isStreaming) {
        writeJson(response, 409, { error: "session_busy" });
        return;
      }
      const treeResult = options.activeSessions.getTreeSnapshot(sessionId);
      if (!treeResult.ok) {
        writeJson(response, 409, { error: treeResult.error });
        return;
      }
      if (treeResult.snapshot.stale === true
        || treeResult.snapshot.snapshotVersion !== body.baseSnapshotVersion
        || treeResult.snapshot.branchVersion !== body.baseBranchVersion
        || treeResult.snapshot.leafId !== body.baseLeafId) {
        writeJson(response, 409, { error: "tree_state_changed" });
        return;
      }
      if (!treeResult.snapshot.entries.some((entry) => entry.id === body.targetEntryId)) {
        writeJson(response, 409, { error: "target_not_found" });
        return;
      }
      if (!options.activeSessions.enqueueCommand(sessionId, { type: "remote_tree_navigate", requestId, ...body })) {
        writeJson(response, 409, { error: "session_not_active" });
        return;
      }
    }
    writeJson(response, 200, { accepted: true, requestId });
    return;
  }

  const treeRefreshMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/tree\/refresh$/);
  if (request.method === "POST" && treeRefreshMatch) {
    if (!(await isAuthorized(request, options))) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }

    const sessionId = decodeURIComponent(treeRefreshMatch[1] ?? "");
    const requestId = nextRequestId();
    if (options.activeSessions && !options.activeSessions.enqueueCommand(sessionId, { type: "remote_tree_refresh", requestId })) {
      writeJson(response, 409, { error: "session_not_active" });
      return;
    }
    writeJson(response, 200, { accepted: true, requestId });
    return;
  }

  const treeMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/tree$/);
  if (request.method === "GET" && treeMatch) {
    if (!(await isAuthorized(request, options))) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }

    const sessionId = decodeURIComponent(treeMatch[1] ?? "");
    const result = options.activeSessions?.getTreeSnapshot(sessionId) ?? { ok: false as const, error: "session_not_active" as const };
    if (!result.ok) {
      writeJson(response, 409, { error: result.error });
      return;
    }
    writeJson(response, 200, { snapshot: result.snapshot });
    return;
  }

  const sessionMessagesMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/messages$/);
  if (request.method === "GET" && sessionMessagesMatch) {
    if (!(await isAuthorized(request, options))) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }

    const limit = parsePositiveLimit(url.searchParams.get("limit"));
    if (!limit.valid) {
      writeJson(response, 400, { error: "invalid_limit" });
      return;
    }
    const before = url.searchParams.get("before");
    if (!before) {
      writeJson(response, 400, { error: "invalid_cursor" });
      return;
    }

    try {
      decodeTranscriptCursor(before);
      const sessionId = decodeURIComponent(sessionMessagesMatch[1] ?? "");
      const page = options.activeSessions?.getSessionMessages(sessionId, before, { limit: limit.value })
        ?? (await options.sessionService?.getSessionMessages?.(sessionId, { before, limit: limit.value }));
      if (!page) {
        writeJson(response, 404, { error: "session_not_found" });
        return;
      }
      writeJson(response, 200, page);
    } catch (error) {
      if (error instanceof InvalidTranscriptCursorError) writeJson(response, 400, { error: "invalid_cursor" });
      else writeJson(response, 500, { error: "internal_error" });
    }
    return;
  }

  const sessionMatch = pathname.match(/^\/v1\/sessions\/([^/]+)$/);
  if (request.method === "GET" && sessionMatch) {
    if (!(await isAuthorized(request, options))) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }

    const limit = parsePositiveLimit(url.searchParams.get("messageLimit"));
    if (!limit.valid) {
      writeJson(response, 400, { error: "invalid_limit" });
      return;
    }

    const sessionId = decodeURIComponent(sessionMatch[1] ?? "");
    const state = options.activeSessions?.getSessionState(sessionId, { messageLimit: limit.value })
      ?? (await options.sessionService?.getSessionState?.(sessionId, { messageLimit: limit.value }));
    if (!state) {
      writeJson(response, 404, { error: "session_not_found" });
      return;
    }
    writeJson(response, 200, state);
    return;
  }

  const projectSessionsMatch = pathname.match(/^\/v1\/projects\/([^/]+)\/sessions$/);
  if ((request.method === "GET" || request.method === "POST") && projectSessionsMatch) {
    if (!(await isAuthorized(request, options))) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }

    const projectId = decodeURIComponent(projectSessionsMatch[1] ?? "");
    if (request.method === "POST") {
      writeJson(response, 405, { error: "method_not_allowed" });
      return;
    }

    const sessions = options.activeSessions?.listProjectSessions(projectId) ?? (await options.sessionService?.listProjectSessions?.(projectId));
    writeJson(response, 200, { sessions: sessions ?? [] });
    return;
  }

  writeJson(response, 404, { error: "not_found" });
}

async function handleUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  webSockets: WebSocketServer,
  options: StartServerOptions,
  streamHub: StreamHub,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const streamMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/stream$/);
  if (!streamMatch) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  if (!(await isAuthorized(request, options))) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const sessionId = decodeURIComponent(streamMatch[1] ?? "");
  webSockets.handleUpgrade(request, socket, head, (webSocket) => {
    webSockets.emit("connection", webSocket, request);
    const subscribers = streamHub.get(sessionId) ?? new Set<WebSocket>();
    subscribers.add(webSocket);
    streamHub.set(sessionId, subscribers);
    webSocket.once("close", () => subscribers.delete(webSocket));

    const activeState = options.activeSessions?.getSessionState(sessionId, { messageLimit: INITIAL_WEBSOCKET_SESSION_MESSAGE_LIMIT });
    if (activeState) sendWebSocketJson(webSocket, { type: "session_state", state: previewInitialSessionState(activeState) });

    const stream = options.sessionService?.streamSession?.(sessionId, (event) => {
      sendWebSocketJson(webSocket, event);
    });
    void stream?.catch(() => {
      if (webSocket.readyState !== WebSocket.CLOSED) webSocket.terminate();
    });
  });
}

async function isTuiAuthorized(request: IncomingMessage, options: StartServerOptions): Promise<boolean> {
  if (isLoopbackRemoteAddress(request.socket.remoteAddress)) return true;
  return isAuthorized(request, options);
}

async function isAuthorized(request: IncomingMessage, options: StartServerOptions): Promise<boolean> {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return false;
  const token = authorization.slice("Bearer ".length);
  return options.authenticateToken ? Boolean(await options.authenticateToken(token)) : false;
}

function isLoopbackRemoteAddress(address: string | undefined): boolean {
  return Boolean(address && (address === "::1" || address === "127.0.0.1" || address.startsWith("127.") || address.startsWith("::ffff:127.")));
}

function reducedRemoteModelCatalogEvent(event: unknown): RemoteModelCatalogEvent | undefined {
  if (!event || typeof event !== "object") return undefined;
  const record = event as Record<string, unknown>;
  const catalog = record.catalog && typeof record.catalog === "object" ? record.catalog as Record<string, unknown> : undefined;
  if (record.type !== "remote_model_catalog"
    || (record.requestId !== undefined && typeof record.requestId !== "string")
    || !catalog
    || !Array.isArray(catalog.models)
    || typeof catalog.catalogVersion !== "string"
    || typeof catalog.generatedAt !== "string") return undefined;
  const models = catalog.models.map(reducedRemoteModelSummary);
  if (models.some((model) => model === undefined)) return undefined;
  const currentModel = catalog.currentModel === null ? null : reducedRemoteModelSummary(catalog.currentModel);
  if (currentModel === undefined) return undefined;
  return {
    type: "remote_model_catalog",
    ...(typeof record.requestId === "string" ? { requestId: record.requestId } : {}),
    catalog: {
      currentModel,
      models: models as RemoteModelSummary[],
      catalogVersion: catalog.catalogVersion,
      generatedAt: catalog.generatedAt,
    },
  };
}

function reducedRemoteModelSummary(value: unknown): RemoteModelSummary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const model = value as Record<string, unknown>;
  if (typeof model.provider !== "string" || typeof model.modelId !== "string" || typeof model.reasoning !== "boolean" || typeof model.isScoped !== "boolean") return undefined;
  return {
    provider: model.provider,
    modelId: model.modelId,
    ...(typeof model.name === "string" ? { name: model.name } : {}),
    reasoning: model.reasoning,
    ...(typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
    ...(typeof model.maxTokens === "number" && Number.isFinite(model.maxTokens) ? { maxTokens: model.maxTokens } : {}),
    isScoped: model.isScoped,
  };
}

function reducedRemoteModelSelectResultEvent(event: unknown): RemoteModelSelectResultEvent | undefined {
  if (!event || typeof event !== "object") return undefined;
  const record = event as Record<string, unknown>;
  if (record.type !== "remote_model_select_result" || typeof record.requestId !== "string") return undefined;
  if (record.ok === true) {
    const model = reducedRemoteModelSummary(record.model);
    if (!model || typeof record.catalogVersion !== "string") return undefined;
    return { type: "remote_model_select_result", requestId: record.requestId, ok: true, model, catalogVersion: record.catalogVersion };
  }
  const errors = new Set(["session_busy", "model_catalog_changed", "model_not_found", "model_unavailable", "selection_failed"]);
  if (record.ok !== false || typeof record.error !== "string" || !errors.has(record.error)) return undefined;
  return { type: "remote_model_select_result", requestId: record.requestId, ok: false, error: record.error as Extract<RemoteModelSelectResultEvent, { ok: false }>["error"] };
}

function isRuntimeStatusEvent(event: unknown): event is { type: "runtime_status"; status: RuntimeStatus } {
  return Boolean(event && typeof event === "object" && (event as { type?: unknown }).type === "runtime_status" && (event as { status?: unknown }).status && typeof (event as { status?: unknown }).status === "object");
}

function isSessionNameEvent(event: unknown): event is { type: "session_name"; name: string } {
  return Boolean(event && typeof event === "object" && (event as { type?: unknown }).type === "session_name" && typeof (event as { name?: unknown }).name === "string");
}

function isAgentLifecycleEvent(event: unknown): event is { type: "agent_start" | "agent_end" } {
  return Boolean(event && typeof event === "object" && ((event as { type?: unknown }).type === "agent_start" || (event as { type?: unknown }).type === "agent_end"));
}

function isTreeStateEvent(event: unknown): event is { type: "tree_state"; leafId: string | null; branchVersion: string } {
  if (!event || typeof event !== "object") return false;
  const record = event as Record<string, unknown>;
  return record.type === "tree_state"
    && (record.leafId === null || typeof record.leafId === "string")
    && typeof record.branchVersion === "string";
}

function isRemoteTreeSnapshotEvent(event: unknown): event is RemoteTreeSnapshotEvent {
  if (!event || typeof event !== "object") return false;
  const record = event as Record<string, unknown>;
  const snapshot = record.snapshot as Record<string, unknown> | undefined;
  return record.type === "remote_tree_snapshot"
    && (record.requestId === undefined || typeof record.requestId === "string")
    && Boolean(snapshot)
    && typeof snapshot === "object"
    && typeof snapshot.sessionId === "string"
    && (snapshot.leafId === null || typeof snapshot.leafId === "string")
    && typeof snapshot.snapshotVersion === "string"
    && typeof snapshot.branchVersion === "string"
    && Array.isArray(snapshot.entries);
}

function isRemoteTreeNavigationResultEvent(event: unknown): event is RemoteTreeNavigationResultEvent {
  if (!event || typeof event !== "object") return false;
  const record = event as Record<string, unknown>;
  if (record.type !== "remote_tree_navigation_result" || typeof record.requestId !== "string") return false;
  if (record.ok === true) {
    return (record.leafId === null || typeof record.leafId === "string")
      && typeof record.snapshotVersion === "string"
      && typeof record.branchVersion === "string"
      && (record.editorText === undefined || typeof record.editorText === "string");
  }
  return record.ok === false && typeof record.error === "string";
}

function isRemoteForkResultEvent(event: unknown): event is RemoteForkResultEvent {
  if (!event || typeof event !== "object") return false;
  const record = event as Record<string, unknown>;
  if (record.type !== "remote_fork_result" || typeof record.requestId !== "string") return false;
  if (record.ok === true) return Boolean(record.newSession) && typeof record.editorText === "string";
  return record.ok === false && typeof record.error === "string";
}

function isRemoteCloneResultEvent(event: unknown): event is RemoteCloneResultEvent {
  if (!event || typeof event !== "object") return false;
  const record = event as Record<string, unknown>;
  if (record.type !== "remote_clone_result" || typeof record.requestId !== "string") return false;
  if (record.ok === true) return Boolean(record.newSession) && record.editorText === undefined;
  return record.ok === false && typeof record.error === "string";
}

function isRemoteSessionReplacedEvent(event: unknown): event is RemoteSessionReplacedEvent {
  if (!event || typeof event !== "object") return false;
  const record = event as Record<string, unknown>;
  return record.type === "remote_session_replaced"
    && typeof record.requestId === "string"
    && typeof record.oldSessionId === "string"
    && Boolean(record.newSession);
}

function isRemoteCompactResultEvent(event: unknown): event is RemoteCompactResultEvent {
  if (!event || typeof event !== "object") return false;
  const record = event as Record<string, unknown>;
  if (record.type !== "remote_compact_result" || typeof record.requestId !== "string") return false;
  if (record.ok === true) {
    return typeof record.summary === "string" && typeof record.firstKeptEntryId === "string" && typeof record.tokensBefore === "number";
  }
  return record.ok === false && typeof record.message === "string";
}

function nextRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function parsePositiveLimit(rawLimit: string | null): { valid: true; value: number } | { valid: false } {
  if (rawLimit === null) return { valid: true, value: DEFAULT_TRANSCRIPT_PAGE_LIMIT };
  const parsed = Number(rawLimit);
  if (!Number.isInteger(parsed) || parsed <= 0) return { valid: false };
  return { valid: true, value: Math.min(parsed, MAX_TRANSCRIPT_PAGE_LIMIT) };
}

function parseBindAddress(bindAddress: string): { host: string; port: number } {
  const index = bindAddress.lastIndexOf(":");
  if (index === -1) throw new Error(`Invalid bind address: ${bindAddress}`);
  return {
    host: bindAddress.slice(0, index),
    port: Number.parseInt(bindAddress.slice(index + 1), 10),
  };
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || host === "[::1]" || host === "127.0.0.1" || host.startsWith("127.");
}

function isWildcardHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]" || host === "";
}

class InvalidJsonBodyError extends Error {
  constructor() {
    super("invalid_json_body");
    this.name = "InvalidJsonBodyError";
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new InvalidJsonBodyError();
  }
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function broadcastSessionState(sessionId: string, options: StartServerOptions, streamHub: StreamHub): void {
  const activeState = options.activeSessions?.getSessionState(sessionId, { messageLimit: INITIAL_WEBSOCKET_SESSION_MESSAGE_LIMIT });
  if (!activeState) return;
  streamHub.get(sessionId)?.forEach((webSocket) => sendWebSocketJson(webSocket, { type: "session_state", state: previewInitialSessionState(activeState) }));
}

function closeSessions(sessionIds: string[], streamHub: StreamHub): void {
  for (const sessionId of sessionIds) {
    streamHub.get(sessionId)?.forEach((webSocket) => sendWebSocketJson(webSocket, { type: "session_closed" }));
    streamHub.delete(sessionId);
  }
}

function sendWebSocketJson(webSocket: WebSocket, event: unknown): void {
  if (webSocket.readyState === WebSocket.OPEN) webSocket.send(JSON.stringify(event));
}
