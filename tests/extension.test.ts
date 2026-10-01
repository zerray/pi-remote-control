import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import remoteControlExtension, { __resetRemoteControlExtensionStateForTests, collectRuntimeStatus, enrichTuiEventForDaemon, handleRemoteCommand } from "../src/extension/index.js";

type Registered = {
  name: string;
  description?: string;
  handler: (args: string, ctx: ExtensionTestContext) => Promise<void>;
};

type ExtensionTestContext = {
  cwd: string;
  sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
    getSessionName(): string | undefined;
    getEntries(): unknown[];
    getLeafId?(): string | null;
    getTree?(): unknown[];
  };
  model?: unknown;
  modelRegistry?: { refresh(): Promise<unknown>; getAvailable(): unknown[]; find?(provider: string, modelId: string): unknown };
  scopedModels?: Array<{ model: unknown }>;
  getContextUsage?(): unknown;
  isIdle(): boolean;
  ui: {
    theme: { fg(color: string, text: string): string };
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setStatus(key: string, text: string | undefined): void;
  };
};

type ExecCall = { command: string; args: string[] };

function createFakePi(execCalls: ExecCall[] = []) {
  const commands: Registered[] = [];
  const handlers = new Map<string, (event: unknown, ctx: ExtensionTestContext) => void | Promise<unknown>>();
  return {
    commands,
    handlers,
    pi: {
      registerCommand(name: string, options: Omit<Registered, "name">) {
        commands.push({ name, ...options });
      },
      on(name: string, handler: (event: unknown, ctx: ExtensionTestContext) => void | Promise<unknown>) {
        handlers.set(name, handler);
      },
      sendUserMessage: vi.fn(),
      exec: async (command: string, args: string[]) => {
        execCalls.push({ command, args });
        return { stdout: "pi-remote-control is running (pid 1234)\n", stderr: "", code: 0, killed: false };
      },
    },
  };
}

function createContext() {
  const notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  return {
    statuses,
    notifications,
    ctx: {
      cwd: "/repo/example",
      sessionManager: {
        getSessionId: () => "pi_1",
        getSessionFile: () => "/tmp/session.jsonl",
        getSessionName: () => "Fix bug",
        getEntries: () => [{}, {}],
      },
      model: { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", contextWindow: 200000, maxTokens: 8192, reasoning: true },
      modelRegistry: {
        refresh: async () => ({ aborted: false, errors: new Map() }),
        getAvailable: () => [
          { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", contextWindow: 200000, maxTokens: 8192, reasoning: true },
          { provider: "openai", id: "gpt-5", name: "GPT-5", contextWindow: 400000, maxTokens: 128000, reasoning: true },
        ],
        find(provider: string, modelId: string) {
          return this.getAvailable().find((model) => model.provider === provider && model.id === modelId);
        },
      },
      scopedModels: [{ model: { provider: "anthropic", id: "claude-sonnet-4-5" } }],
      getContextUsage: () => ({ tokens: 65000, contextWindow: 200000, percent: 32.5 }),
      isIdle: () => true,
      ui: {
        theme: { fg: (color: string, text: string) => (color === "success" ? `\u001b[32m${text}\u001b[39m` : text) },
        notify(message: string, type?: "info" | "warning" | "error") {
          notifications.push({ message, type });
        },
        setStatus(key: string, text: string | undefined) {
          statuses.push({ key, text });
        },
      },
    },
  };
}

beforeEach(() => {
  vi.stubEnv("PI_REMOTE_CONTROL_LOCAL_URL", "http://127.0.0.1:17373");
  vi.stubEnv("PI_REMOTE_CONTROL_DEV_TOKEN", "test-token");
});

afterEach(() => {
  __resetRemoteControlExtensionStateForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("remote control extension", () => {
  it("collects runtime status from the live Pi context", () => {
    const ctx = {
      model: { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", contextWindow: 200000, maxTokens: 8192, reasoning: true },
      getContextUsage: () => ({ tokens: 65000, contextWindow: 200000, percent: 32.5 }),
      sessionManager: {
        entries: [
          { type: "message", message: { role: "user", content: "hello" } },
          { type: "message", message: { role: "assistant" }, usage: { input: 12, output: 3, cacheRead: 50, cacheWrite: 10, cost: { input: 0.036, output: 0.045, cacheRead: 0.015, cacheWrite: 0.0375, total: 0.1335 } } },
        ],
        getEntries() {
          return this.entries;
        },
      },
    };
    const pi = { getThinkingLevel: () => "medium" };

    expect(collectRuntimeStatus(pi, ctx, () => new Date("2026-05-09T09:47:00.000Z"))).toEqual({
      model: { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", contextWindow: 200000, maxTokens: 8192, reasoning: true },
      thinkingLevel: "medium",
      usage: { input: 12, output: 3, cacheRead: 50, cacheWrite: 10, cost: { input: 0.036, output: 0.045, cacheRead: 0.015, cacheWrite: 0.0375, total: 0.1335 } },
      context: { tokens: 65000, contextWindow: 200000, percent: 32.5 },
      updatedAt: "2026-05-09T09:47:00.000Z",
    });
  });

  it("registers remote-control commands", () => {
    const { pi, commands } = createFakePi();

    remoteControlExtension(pi as never);

    expect(commands.map((command) => command.name)).toEqual(["remote-control", "remote-control-pair"]);
  });

  it("starts daemon if needed and registers the current TUI session", async () => {
    const commands: Registered[] = [];
    const execCalls: ExecCall[] = [];
    const fetchCalls: unknown[] = [];
    const { ctx, notifications } = createContext();
    const pi = {
      registerCommand(name: string, options: Omit<Registered, "name">) {
        commands.push({ name, ...options });
      },
      on: vi.fn(),
      sendUserMessage: vi.fn(),
      exec: async (command: string, args: string[]) => {
        execCalls.push({ command, args });
        if (args.includes("status")) return { stdout: "pi-remote-control is stopped\n", stderr: "", code: 1, killed: false };
        return { stdout: "", stderr: "", code: 0, killed: false };
      },
    };
    const healthOutcomes = [new TypeError("fetch failed"), new Response(JSON.stringify({ status: "ok" }), { status: 200 })];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/health")) {
          fetchCalls.push({ url, init: undefined });
          const outcome = healthOutcomes.shift();
          if (outcome instanceof Error) throw outcome;
          return outcome!;
        }
        fetchCalls.push({ url, init: { method: init?.method, body: JSON.parse(String(init?.body)) } });
        return new Response(JSON.stringify({ session: { id: "sess_pi_1" } }), { status: 200 });
      }),
    );
    remoteControlExtension(pi as never);

    await commands.find((command) => command.name === "remote-control")!.handler("", ctx);

    expect(execCalls[0]).toEqual({ command: process.execPath, args: [expect.stringContaining("src/cli-runner.cjs"), "status"] });
    expect(execCalls[1]?.command).toBe("sh");
    expect(execCalls[1]?.args[1]).toContain("nohup");
    expect(fetchCalls).toEqual([
      { url: "http://127.0.0.1:17373/v1/health", init: undefined },
      { url: "http://127.0.0.1:17373/v1/health", init: undefined },
      {
        url: "http://127.0.0.1:17373/v1/tui/sessions",
        init: {
          method: "POST",
          body: expect.objectContaining({
            id: "sess_pi_1",
            piSessionId: "pi_1",
            sessionFile: "/tmp/session.jsonl",
            runtimeStatus: expect.objectContaining({ model: expect.objectContaining({ id: "claude-sonnet-4-5" }), context: expect.objectContaining({ percent: 32.5 }) }),
          }),
        },
      },
    ]);
    expect(notifications.at(-1)).toEqual({ message: "Remote control enabled for this session", type: "info" });
  });

  it("registers an initial reduced Model Catalog Snapshot", async () => {
    const { pi, commands } = createFakePi();
    const { ctx } = createContext();
    let registrationBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/tui/sessions")) registrationBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ session: { id: "sess_pi_1" } }), { status: 200 });
      }),
    );
    remoteControlExtension(pi as never);

    await commands.find((command) => command.name === "remote-control")!.handler("", ctx);

    expect(registrationBody?.modelCatalog).toEqual({
      currentModel: expect.objectContaining({ provider: "anthropic", modelId: "claude-sonnet-4-5", isScoped: true }),
      models: [
        expect.objectContaining({ provider: "anthropic", modelId: "claude-sonnet-4-5", isScoped: true }),
        expect.objectContaining({ provider: "openai", modelId: "gpt-5", isScoped: false }),
      ],
      catalogVersion: expect.stringMatching(/^modelsv_/),
      generatedAt: expect.any(String),
    });
    expect(JSON.stringify(registrationBody?.modelCatalog)).not.toContain("baseUrl");
  });

  it("registers an initial reduced Tree Snapshot when tree state is available", async () => {
    const { pi, commands } = createFakePi();
    const { ctx } = createContext();
    const longPreview = "x".repeat(501);
    ctx.sessionManager.getLeafId = () => "assistant_1";
    ctx.sessionManager.getTree = () => [
      {
        entry: { type: "message", id: "user_1", parentId: null, timestamp: "2026-05-09T00:00:00.000Z", message: { role: "user", content: "Inspect the auth flow" } },
        label: "checkpoint",
        children: [
          { entry: { type: "message", id: "assistant_1", parentId: "user_1", timestamp: "2026-05-09T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "I'll inspect it." }] } }, children: [] },
          { entry: { type: "custom_message", id: "custom_1", parentId: "user_1", timestamp: "2026-05-09T00:00:02.000Z", customType: "fixture", content: longPreview, display: true }, children: [] },
          { entry: { type: "compaction", id: "compact_1", parentId: "user_1", timestamp: "2026-05-09T00:00:03.000Z", summary: "Earlier auth investigation", tokensBefore: 12345 }, children: [] },
          { entry: { type: "branch_summary", id: "branch_1", parentId: "user_1", timestamp: "2026-05-09T00:00:04.000Z", summary: "Explored OAuth branch", fromId: "assistant_1" }, children: [] },
          { entry: { type: "label", id: "label_1", parentId: "user_1", timestamp: "2026-05-09T00:00:05.000Z", targetId: "user_1", label: "checkpoint" }, children: [] },
        ],
      },
    ];
    let registrationBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/tui/sessions")) registrationBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ session: { id: "sess_pi_1" } }), { status: 200 });
      }),
    );
    remoteControlExtension(pi as never);

    await commands.find((command) => command.name === "remote-control")!.handler("", ctx);

    const snapshot = registrationBody?.treeSnapshot as { entries: Array<Record<string, unknown>>; [key: string]: unknown };
    expect(snapshot).toMatchObject({
      sessionId: "sess_pi_1",
      leafId: "assistant_1",
      snapshotVersion: expect.stringMatching(/^treev_/),
      branchVersion: expect.stringMatching(/^branchv_/),
      defaultFilter: "default",
      filters: ["default", "no-tools", "user-only", "labeled-only", "all"],
    });
    expect(snapshot.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "user_1", type: "message", role: "user", title: "user", preview: "Inspect the auth flow", label: "checkpoint", isCurrentLeaf: false, isOnActiveBranch: true, isForkable: true, navigationBehavior: "edit_prompt" }),
      expect.objectContaining({ id: "assistant_1", type: "message", role: "assistant", title: "assistant", preview: "I'll inspect it.", isCurrentLeaf: true, isOnActiveBranch: true, isForkable: false, navigationBehavior: "navigate" }),
      expect.objectContaining({ id: "custom_1", type: "custom_message", role: "custom", customType: "fixture", preview: "x".repeat(500), previewTruncated: true, navigationBehavior: "edit_prompt" }),
      expect.objectContaining({ id: "compact_1", type: "compaction", title: "compaction", preview: "Earlier auth investigation" }),
      expect.objectContaining({ id: "branch_1", type: "branch_summary", title: "branch summary", preview: "Explored OAuth branch" }),
      expect.objectContaining({ id: "label_1", type: "label", title: "label", preview: "checkpoint" }),
    ]));
    expect(snapshot.entries.find((entry) => entry.id === "user_1")).not.toHaveProperty("message");
  });

  it("omits non-current assistant tree entries with no text content from reduced Tree Snapshots", async () => {
    const { pi, commands } = createFakePi();
    const { ctx } = createContext();
    ctx.sessionManager.getLeafId = () => "assistant_leaf_tool_only";
    ctx.sessionManager.getTree = () => [
      {
        entry: { type: "message", id: "user_1", parentId: null, timestamp: "2026-05-09T00:00:00.000Z", message: { role: "user", content: "run checks" } },
        children: [
          { entry: { type: "message", id: "assistant_text", parentId: "user_1", timestamp: "2026-05-09T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "Running checks." }] } }, children: [] },
          { entry: { type: "message", id: "assistant_tool_only", parentId: "user_1", timestamp: "2026-05-09T00:00:02.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "npm test" } }] }, stopReason: "toolUse" }, children: [] },
          { entry: { type: "message", id: "assistant_thinking_only", parentId: "user_1", timestamp: "2026-05-09T00:00:03.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "Checking" }] } }, children: [] },
          { entry: { type: "message", id: "assistant_error_tool_only", parentId: "user_1", timestamp: "2026-05-09T00:00:04.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call_2", name: "bash", arguments: { command: "bad" } }] }, stopReason: "error" }, children: [] },
          { entry: { type: "message", id: "assistant_leaf_tool_only", parentId: "user_1", timestamp: "2026-05-09T00:00:05.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call_3", name: "bash", arguments: { command: "still running" } }] }, stopReason: "toolUse" }, children: [] },
        ],
      },
    ];
    let registrationBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/tui/sessions")) registrationBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ session: { id: "sess_pi_1" } }), { status: 200 });
      }),
    );
    remoteControlExtension(pi as never);

    await commands.find((command) => command.name === "remote-control")!.handler("", ctx);

    const snapshot = registrationBody?.treeSnapshot as { entries: Array<Record<string, unknown>> };
    expect(snapshot.entries.map((entry) => entry.id)).toEqual([
      "user_1",
      "assistant_text",
      "assistant_error_tool_only",
      "assistant_leaf_tool_only",
    ]);
  });

  it("reports startup readiness failure without throwing", async () => {
    const commands: Registered[] = [];
    const { ctx, notifications } = createContext();
    const pi = {
      registerCommand(name: string, options: Omit<Registered, "name">) {
        commands.push({ name, ...options });
      },
      on: vi.fn(),
      sendUserMessage: vi.fn(),
      exec: async (command: string, args: string[]) => {
        if (args.includes("status")) return { stdout: "pi-remote-control is stopped\n", stderr: "", code: 1, killed: false };
        return { stdout: "", stderr: "", code: 0, killed: false };
      },
    };
    vi.stubEnv("PI_REMOTE_CONTROL_READY_ATTEMPTS", "1");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    remoteControlExtension(pi as never);

    await expect(commands.find((command) => command.name === "remote-control")!.handler("", ctx)).resolves.toBeUndefined();

    expect(notifications.at(-1)).toEqual({
      message: "pi-remote-control did not become ready; see /tmp/pi-remote-control.log",
      type: "error",
    });
  });

  it("reports registration network failures without throwing", async () => {
    const { pi, commands } = createFakePi();
    const { ctx, notifications } = createContext();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/v1/health")) return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      throw new TypeError("fetch failed");
    }));
    remoteControlExtension(pi as never);

    await expect(commands.find((command) => command.name === "remote-control")!.handler("", ctx)).resolves.toBeUndefined();

    expect(notifications.at(-1)).toEqual({ message: "Remote control enable failed: fetch failed", type: "error" });
  });

  it("uses localhost with the configured port for TUI control when no local override is set", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-remote-control-extension-"));
    try {
      await writeFile(join(root, "config.json"), JSON.stringify({ bindAddress: "100.86.12.34:17373" }));
      vi.unstubAllEnvs();
      vi.stubEnv("PI_REMOTE_CONTROL_DIR", root);
      vi.stubEnv("PI_REMOTE_CONTROL_URL", "https://macbook.tailnet.ts.net:17373");
      const { pi, commands } = createFakePi();
      const { ctx } = createContext();
      const urls: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify({ session: { id: "sess_pi_1" } }), { status: 200 });
      }));
      remoteControlExtension(pi as never);

      await commands.find((command) => command.name === "remote-control")!.handler("", ctx);

      expect(urls.at(-1)).toBe("http://127.0.0.1:17373/v1/tui/sessions");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("updates TUI status when toggling remote control", async () => {
    const { pi, commands } = createFakePi();
    const { ctx, statuses } = createContext();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    remoteControlExtension(pi as never);
    const command = commands.find((registered) => registered.name === "remote-control")!;

    await command.handler("", ctx);
    await command.handler("", ctx);

    expect(statuses).toEqual([
      { key: "remote-control", text: "\u001b[32mRemote Control Active\u001b[39m" },
      { key: "remote-control", text: undefined },
    ]);
  });

  it("re-registers a locally active TUI session when daemon heartbeat state is missing", async () => {
    vi.useFakeTimers();
    const { pi, commands } = createFakePi();
    const { ctx, statuses } = createContext();
    const fetchCalls: Array<{ url: string; method: string; body?: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.endsWith("/commands")) return new Response(JSON.stringify({ error: "session_not_found" }), { status: 404 });
        return new Response(JSON.stringify({ session: { id: "sess_pi_1" } }), { status: 200 });
      }),
    );
    remoteControlExtension(pi as never);

    await commands.find((command) => command.name === "remote-control")!.handler("", ctx);
    await vi.advanceTimersByTimeAsync(1000);

    expect(fetchCalls).toEqual([
      {
        url: "http://127.0.0.1:17373/v1/tui/sessions",
        method: "POST",
        body: expect.objectContaining({ id: "sess_pi_1", piSessionId: "pi_1", sessionFile: "/tmp/session.jsonl" }),
      },
      { url: "http://127.0.0.1:17373/v1/tui/sessions/sess_pi_1/commands", method: "GET", body: undefined },
      {
        url: "http://127.0.0.1:17373/v1/tui/sessions",
        method: "POST",
        body: expect.objectContaining({ id: "sess_pi_1", piSessionId: "pi_1", sessionFile: "/tmp/session.jsonl" }),
      },
    ]);
    expect(statuses).toEqual([{ key: "remote-control", text: "\u001b[32mRemote Control Active\u001b[39m" }]);
  });

  it("clears local active state when heartbeat re-registration fails", async () => {
    vi.useFakeTimers();
    const { pi, commands } = createFakePi();
    const { ctx, statuses, notifications } = createContext();
    const fetchCalls: Array<{ url: string; method: string }> = [];
    let registrationAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, method: init?.method ?? "GET" });
        if (url.endsWith("/commands")) return new Response(JSON.stringify({ error: "session_not_found" }), { status: 404 });
        registrationAttempts += 1;
        return new Response(JSON.stringify({ session: { id: "sess_pi_1" } }), { status: registrationAttempts === 1 ? 200 : 503 });
      }),
    );
    remoteControlExtension(pi as never);

    await commands.find((command) => command.name === "remote-control")!.handler("", ctx);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(statuses).toEqual([
      { key: "remote-control", text: "\u001b[32mRemote Control Active\u001b[39m" },
      { key: "remote-control", text: undefined },
    ]);
    expect(notifications.at(-1)).toEqual({ message: "Remote control disconnected; run /remote-control to re-enable", type: "warning" });
    expect(fetchCalls.filter((call) => call.url.endsWith("/commands"))).toHaveLength(1);
  });

  it("clears active status and unregisters on session shutdown", async () => {
    const { pi, commands, handlers } = createFakePi();
    const { ctx, statuses } = createContext();
    const fetchCalls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, init: { method: init?.method } });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    remoteControlExtension(pi as never);
    await commands.find((command) => command.name === "remote-control")!.handler("", ctx);

    await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);

    expect(fetchCalls.at(-1)).toEqual({
      url: "http://127.0.0.1:17373/v1/tui/sessions/sess_pi_1",
      init: { method: "DELETE" },
    });
    expect(statuses.at(-1)).toEqual({ key: "remote-control", text: undefined });
  });

  it("uses a bounded timeout when unregistering during shutdown", async () => {
    const { pi, commands, handlers } = createFakePi();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
    const deleteSignals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "DELETE" && init.signal instanceof AbortSignal) deleteSignals.push(init.signal);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    const { ctx } = createContext();
    remoteControlExtension(pi as never);
    await commands.find((command) => command.name === "remote-control")!.handler("", ctx);

    try {
      await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);

      expect(timeout).toHaveBeenCalledWith(5_000);
      expect(deleteSignals).toHaveLength(1);
    } finally {
      timeout.mockRestore();
    }
  });

  it("awaits proactive deactivation before session shutdown completes", async () => {
    const { pi, commands, handlers } = createFakePi();
    const { ctx } = createContext();
    let resolveDelete: (() => void) | undefined;
    const fetchCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        fetchCalls.push(`${init?.method ?? "GET"} ${url}`);
        if (init?.method === "DELETE") await new Promise<void>((resolve) => { resolveDelete = resolve; });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    remoteControlExtension(pi as never);
    await commands.find((command) => command.name === "remote-control")!.handler("", ctx);

    let completed = false;
    const shutdownPromise = Promise.resolve(handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx)).then(() => { completed = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fetchCalls.at(-1)).toBe("DELETE http://127.0.0.1:17373/v1/tui/sessions/sess_pi_1");
    expect(completed).toBe(false);
    resolveDelete?.();
    await shutdownPromise;
    expect(completed).toBe(true);
  });

  it("deactivates local remote-control state on session start", async () => {
    const { pi, commands, handlers } = createFakePi();
    const { ctx, statuses } = createContext();
    const fetchCalls: Array<{ url: string; init: { method?: string; body?: unknown } }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, init: { method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined } });
        return new Response(JSON.stringify({ session: { id: "sess_pi_1" } }), { status: 200 });
      }),
    );
    remoteControlExtension(pi as never);
    await commands.find((command) => command.name === "remote-control")!.handler("", ctx);

    handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, ctx);
    handlers.get("message_start")?.({ type: "message_start", message: { id: "msg_1", role: "user" } }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(statuses.at(-1)).toEqual({ key: "remote-control", text: undefined });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:17373/v1/tui/sessions");
  });

  it("notifies in the forked TUI session when remote control was disabled by a local fork", async () => {
    const { pi, commands, handlers } = createFakePi();
    const oldContext = createContext();
    const newContext = createContext();
    newContext.ctx.sessionManager.getSessionId = () => "pi_2";
    newContext.ctx.sessionManager.getSessionFile = () => "/tmp/fork.jsonl";
    const fetch = vi.fn(async () => new Response(JSON.stringify({ session: { id: "sess_pi_1" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    remoteControlExtension(pi as never);
    await commands.find((command) => command.name === "remote-control")!.handler("", oldContext.ctx);

    await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "fork", targetSessionFile: "/tmp/fork.jsonl" }, oldContext.ctx);
    handlers.get("session_start")?.({ type: "session_start", reason: "fork", previousSessionFile: "/tmp/session.jsonl" }, newContext.ctx);

    expect(newContext.notifications.at(-1)).toEqual({
      message: "Remote control was disabled for the previous session. Re-run /remote-control to control this fork from iOS.",
      type: "warning",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not automatically re-enable remote control on resumed sessions", async () => {
    const { pi, handlers } = createFakePi();
    const { ctx, statuses } = createContext();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ session: { id: "sess_pi_1" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    remoteControlExtension(pi as never);

    handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(statuses).toEqual([{ key: "remote-control", text: undefined }]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("toggles off an already registered TUI session", async () => {
    const { pi, commands } = createFakePi();
    const { ctx, notifications } = createContext();
    const fetchCalls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        fetchCalls.push({ url, init: { method: init.method } });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    remoteControlExtension(pi as never);
    const command = commands.find((registered) => registered.name === "remote-control")!;

    await command.handler("", ctx);
    await command.handler("", ctx);

    expect(fetchCalls.at(-1)).toEqual({ url: "http://127.0.0.1:17373/v1/tui/sessions/sess_pi_1", init: { method: "DELETE" } });
    expect(notifications.at(-1)).toEqual({ message: "Remote control disabled for this session", type: "info" });
  });

  it("enriches message events with stable session entry ids before daemon normalization", () => {
    const event = { type: "message_update", message: { role: "assistant", timestamp: 1778284801000, content: [{ type: "text", text: "hello" }] }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" } };
    const ctx = {
      sessionManager: {
        getEntries: () => [
          { type: "message", id: "msg_1", timestamp: "2026-05-09T00:00:01.000Z", message: { role: "assistant", timestamp: 1778284801000, content: [{ type: "text", text: "hello" }] } },
        ],
      },
    };

    expect(enrichTuiEventForDaemon(event, ctx as never)).toEqual({
      ...event,
      id: "msg_1",
      timestamp: "2026-05-09T00:00:01.000Z",
      message: { ...event.message, id: "msg_1" },
    });
  });

  it("forwards turn lifecycle events while remote control is active", async () => {
    const { pi, commands, handlers } = createFakePi();
    const { ctx } = createContext();
    const fetchCalls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        fetchCalls.push({ url, init: { method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined } });
        return new Response(JSON.stringify({ session: { id: "sess_pi_1" } }), { status: 200 });
      }),
    );
    remoteControlExtension(pi as never);
    await commands.find((command) => command.name === "remote-control")!.handler("", ctx);

    handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 0, timestamp: 1778284801000 }, ctx);
    handlers.get("turn_end")?.({ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [] }, toolResults: [] }, ctx);
    await vi.waitFor(() => expect(fetchCalls).toHaveLength(3));

    expect(fetchCalls.slice(1)).toEqual([
      {
        url: "http://127.0.0.1:17373/v1/tui/sessions/sess_pi_1/events",
        init: { method: "POST", body: { type: "turn_start", turnIndex: 0, timestamp: 1778284801000 } },
      },
      {
        url: "http://127.0.0.1:17373/v1/tui/sessions/sess_pi_1/events",
        init: { method: "POST", body: { type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [] }, toolResults: [] } },
      },
    ]);
  });

  it("forwards runtime status changes while remote control is active", async () => {
    const { pi, commands, handlers } = createFakePi();
    const entries = [{ type: "message", message: { role: "assistant" }, usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } }];
    const { ctx } = createContext();
    ctx.sessionManager.getEntries = () => entries;
    const fetchCalls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        fetchCalls.push({ url, init: { method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined } });
        return new Response(JSON.stringify({ session: { id: "sess_pi_1" } }), { status: 200 });
      }),
    );
    remoteControlExtension(pi as never);
    await commands.find((command) => command.name === "remote-control")!.handler("", ctx);

    entries.push({ type: "message", message: { role: "assistant" }, usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } } });
    handlers.get("message_end")?.({ type: "message_end", message: { id: "msg_1", role: "assistant" } }, ctx);
    await vi.waitFor(() => expect(fetchCalls).toContainEqual(expect.objectContaining({
      url: "http://127.0.0.1:17373/v1/tui/sessions/sess_pi_1/events",
      init: expect.objectContaining({ method: "POST", body: expect.objectContaining({ type: "runtime_status", status: expect.objectContaining({ usage: expect.objectContaining({ input: 3, output: 3 }) }) }) }),
    })));
  });

  it("reports package-internal tree_state after message appends while remote control is active", async () => {
    const { pi, commands, handlers } = createFakePi();
    const { ctx } = createContext();
    ctx.sessionManager.getLeafId = () => "entry_user_1";
    ctx.sessionManager.getEntries = () => [
      { type: "message", id: "entry_user_1", parentId: null, timestamp: "2026-05-09T00:00:00.000Z", message: { role: "user", timestamp: 1778284800000, content: "sent" } },
    ];
    const fetchCalls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        fetchCalls.push({ url, init: { method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined } });
        return new Response(JSON.stringify({ session: { id: "sess_pi_1" } }), { status: 200 });
      }),
    );
    remoteControlExtension(pi as never);
    await commands.find((command) => command.name === "remote-control")!.handler("", ctx);

    handlers.get("message_end")?.({ type: "message_end", message: { role: "user", timestamp: 1778284800000, content: "sent" } }, ctx);

    await vi.waitFor(() => expect(fetchCalls).toContainEqual({
      url: "http://127.0.0.1:17373/v1/tui/sessions/sess_pi_1/events",
      init: { method: "POST", body: { type: "tree_state", leafId: "entry_user_1", branchVersion: expect.stringMatching(/^branchv_/) } },
    }));
  });

  it("forwards TUI session-name changes while remote control is active", async () => {
    const { pi, commands, handlers } = createFakePi();
    const { ctx } = createContext();
    const fetchCalls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        fetchCalls.push({ url, init: { method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined } });
        return new Response(JSON.stringify({ session: { id: "sess_pi_1" } }), { status: 200 });
      }),
    );
    remoteControlExtension(pi as never);
    await commands.find((command) => command.name === "remote-control")!.handler("", ctx);

    handlers.get("session_info_changed")?.({ type: "session_info_changed", name: "Manual TUI Name" }, ctx);
    await vi.waitFor(() => expect(fetchCalls.at(-1)).toMatchObject({ url: "http://127.0.0.1:17373/v1/tui/sessions/sess_pi_1/events" }));

    expect(fetchCalls.at(-1)).toEqual({
      url: "http://127.0.0.1:17373/v1/tui/sessions/sess_pi_1/events",
      init: { method: "POST", body: { type: "session_name", name: "Manual TUI Name" } },
    });
  });

  it("retries pending transcript events and forwards the refreshed tree state once session entries appear", async () => {
    vi.useFakeTimers();
    const { pi, commands, handlers } = createFakePi();
    const { ctx } = createContext();
    const entries: unknown[] = [];
    ctx.sessionManager.getEntries = () => entries;
    ctx.sessionManager.getLeafId = () => "entry_user_1";
    const fetchCalls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        fetchCalls.push({ url, init: { method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined } });
        return new Response(JSON.stringify({ session: { id: "sess_pi_1" } }), { status: 200 });
      }),
    );
    remoteControlExtension(pi as never);
    await commands.find((command) => command.name === "remote-control")!.handler("", ctx);

    handlers.get("message_end")?.({ type: "message_end", message: { role: "user", timestamp: 1778284800000, content: "sent from iOS" } }, ctx);
    await vi.advanceTimersByTimeAsync(50);
    expect(fetchCalls).toHaveLength(1);

    entries.push({ type: "message", id: "entry_user_1", timestamp: "2026-05-09T00:00:00.000Z", message: { role: "user", timestamp: 1778284800000, content: "sent from iOS" } });
    await vi.advanceTimersByTimeAsync(100);

    await vi.waitFor(() => {
      const eventCalls = fetchCalls.filter((call) => typeof call === "object" && call !== null && String((call as { url?: unknown }).url).endsWith("/events"));
      expect(eventCalls).toHaveLength(2);
    });
    const eventCalls = fetchCalls.filter((call) => typeof call === "object" && call !== null && String((call as { url?: unknown }).url).endsWith("/events"));
    expect(eventCalls).toEqual([
      {
        url: "http://127.0.0.1:17373/v1/tui/sessions/sess_pi_1/events",
        init: { method: "POST", body: { type: "message_end", id: "entry_user_1", timestamp: "2026-05-09T00:00:00.000Z", message: { id: "entry_user_1", role: "user", timestamp: 1778284800000, content: "sent from iOS" } } },
      },
      {
        url: "http://127.0.0.1:17373/v1/tui/sessions/sess_pi_1/events",
        init: { method: "POST", body: { type: "tree_state", leafId: "entry_user_1", branchVersion: expect.stringMatching(/^branchv_/) } },
      },
    ]);
  });

  it("does not forward temporary transcript ids and flushes with canonical session entry ids", async () => {
    const { pi, commands, handlers } = createFakePi();
    const { ctx } = createContext();
    const entries: unknown[] = [];
    ctx.sessionManager.getEntries = () => entries;
    const fetchCalls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        fetchCalls.push({ url, init: { method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined } });
        return new Response(JSON.stringify({ session: { id: "sess_pi_1" } }), { status: 200 });
      }),
    );
    remoteControlExtension(pi as never);
    await commands.find((command) => command.name === "remote-control")!.handler("", ctx);

    handlers.get("message_start")?.({ type: "message_start", id: "tmp_1", timestamp: 1778284800000, message: { id: "tmp_1", role: "assistant", timestamp: 1778284800000, content: [{ type: "text", text: "hello" }] } }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchCalls).toHaveLength(1);

    entries.push({ type: "message", id: "entry_1", timestamp: "2026-05-09T00:00:00.000Z", message: { role: "assistant", timestamp: 1778284800000, content: [{ type: "text", text: "hello" }] } });
    handlers.get("message_end")?.({ type: "message_end", id: "tmp_1", timestamp: 1778284800000, message: { id: "tmp_1", role: "assistant", timestamp: 1778284800000, content: [{ type: "text", text: "hello" }] } }, ctx);
    await vi.waitFor(() => {
      const eventCalls = fetchCalls.filter((call) => typeof call === "object" && call !== null && String((call as { url?: unknown }).url).endsWith("/events"));
      expect(eventCalls).toEqual(expect.arrayContaining([
        {
          url: "http://127.0.0.1:17373/v1/tui/sessions/sess_pi_1/events",
          init: { method: "POST", body: { type: "message_start", id: "entry_1", timestamp: "2026-05-09T00:00:00.000Z", message: { id: "entry_1", role: "assistant", timestamp: 1778284800000, content: [{ type: "text", text: "hello" }] } } },
        },
        {
          url: "http://127.0.0.1:17373/v1/tui/sessions/sess_pi_1/events",
          init: { method: "POST", body: { type: "message_end", id: "entry_1", timestamp: "2026-05-09T00:00:00.000Z", message: { id: "entry_1", role: "assistant", timestamp: 1778284800000, content: [{ type: "text", text: "hello" }] } } },
        },
      ]));
    });
  });

  it("reports a fresh catalog after a local TUI model selection", async () => {
    const { pi, commands, handlers } = createFakePi();
    const { ctx } = createContext();
    const postedBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/events") && init?.body) postedBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ session: { id: "sess_pi_1" }, accepted: true }), { status: 200 });
      }),
    );
    remoteControlExtension(pi as never);
    await commands.find((command) => command.name === "remote-control")!.handler("", ctx);
    ctx.model = ctx.modelRegistry!.getAvailable()[1];

    await handlers.get("model_select")?.({ type: "model_select" }, ctx);

    await vi.waitFor(() => expect(postedBodies).toContainEqual(expect.objectContaining({
      type: "remote_model_catalog",
      catalog: expect.objectContaining({ currentModel: expect.objectContaining({ provider: "openai", modelId: "gpt-5" }) }),
    })));
  });

  it("reports Agent Settlement only for a non-aborted, non-error settled run", async () => {
    const { pi, commands, handlers } = createFakePi();
    const { ctx } = createContext();
    const postedBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/events") && init?.body) postedBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ session: { id: "sess_pi_1" }, accepted: true }), { status: 200 });
      }),
    );
    remoteControlExtension(pi as never);
    await commands.find((command) => command.name === "remote-control")!.handler("", ctx);

    await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
    await handlers.get("agent_end")?.({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
    await vi.waitFor(() => expect(postedBodies).toContainEqual({
      type: "agent_settled",
      settlementId: expect.stringMatching(/^settle_/),
    }));
    const completedSettlementCount = postedBodies.filter((body) => body.type === "agent_settled").length;

    await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
    await handlers.get("agent_end")?.({ type: "agent_end", messages: [{ role: "assistant", stopReason: "error" }] }, ctx);
    await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(postedBodies.filter((body) => body.type === "agent_settled")).toHaveLength(completedSettlementCount);

    await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
    await handlers.get("agent_end")?.({ type: "agent_end", messages: [] }, ctx);
    await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(postedBodies.filter((body) => body.type === "agent_settled")).toHaveLength(completedSettlementCount);
  });

  it("retries a pending Agent Settlement after the heartbeat reconnects", async () => {
    vi.useFakeTimers();
    const { pi, commands, handlers } = createFakePi();
    const { ctx } = createContext();
    let settlementAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
        if (body?.type === "agent_settled") {
          settlementAttempts += 1;
          if (settlementAttempts === 1) throw new TypeError("daemon restarting");
        }
        if (url.endsWith("/commands")) return new Response(JSON.stringify({ commands: [] }), { status: 200 });
        return new Response(JSON.stringify({ session: { id: "sess_pi_1" }, accepted: true }), { status: 200 });
      }),
    );
    remoteControlExtension(pi as never);
    await commands.find((command) => command.name === "remote-control")!.handler("", ctx);
    await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
    await handlers.get("agent_end")?.({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
    await vi.waitFor(() => expect(settlementAttempts).toBe(1));

    await vi.advanceTimersByTimeAsync(1_000);

    await vi.waitFor(() => expect(settlementAttempts).toBe(2));
  });

  it("forwards TUI events while remote control is active", async () => {
    const { pi, commands, handlers } = createFakePi();
    const { ctx } = createContext();
    const fetchCalls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        fetchCalls.push({ url, init: { method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined } });
        return new Response(JSON.stringify({ session: { id: "sess_pi_1" } }), { status: 200 });
      }),
    );
    ctx.sessionManager.getEntries = () => [
      { type: "message", id: "entry_1", timestamp: "2026-05-09T00:00:00.000Z", message: { role: "assistant", timestamp: 1778284800000, content: [{ type: "text", text: "hello" }] } },
    ];
    remoteControlExtension(pi as never);
    await commands.find((command) => command.name === "remote-control")!.handler("", ctx);

    handlers.get("message_start")?.({ type: "message_start", message: { role: "assistant", timestamp: 1778284800000, content: [{ type: "text", text: "hello" }] } }, ctx);
    await vi.waitFor(() => expect(fetchCalls.at(-1)).toMatchObject({ url: "http://127.0.0.1:17373/v1/tui/sessions/sess_pi_1/events" }));

    expect(fetchCalls.at(-1)).toEqual({
      url: "http://127.0.0.1:17373/v1/tui/sessions/sess_pi_1/events",
      init: { method: "POST", body: { type: "message_start", id: "entry_1", timestamp: "2026-05-09T00:00:00.000Z", message: { id: "entry_1", role: "assistant", timestamp: 1778284800000, content: [{ type: "text", text: "hello" }] } } },
    });
  });

  it("applies queued remote prompt and abort commands to the TUI runtime", () => {
    const sendUserMessage = vi.fn();
    const abort = vi.fn();
    const compact = vi.fn();
    handleRemoteCommand({ sendUserMessage } as never, { abort, compact, isIdle: () => true } as never, {
      type: "remote_prompt",
      requestId: "req_1",
      text: "hello",
      streamingBehavior: "followUp",
    });
    handleRemoteCommand({ sendUserMessage } as never, { abort, compact, isIdle: () => true } as never, { type: "remote_abort", requestId: "req_2" });

    expect(sendUserMessage).toHaveBeenCalledWith("hello", { deliverAs: "followUp" });
    expect(abort).toHaveBeenCalledOnce();
    expect(compact).not.toHaveBeenCalled();
  });

  it("defaults remote prompts without streamingBehavior to followUp while the TUI is busy", () => {
    const sendUserMessage = vi.fn();

    handleRemoteCommand({ sendUserMessage } as never, { abort: vi.fn(), compact: vi.fn(), isIdle: () => false } as never, {
      type: "remote_prompt",
      requestId: "req_1",
      text: "hello while busy",
      streamingBehavior: null,
    });

    expect(sendUserMessage).toHaveBeenCalledWith("hello while busy", { deliverAs: "followUp" });
  });

  it("refreshes the live model catalog and selects an exact authenticated model", async () => {
    const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} });
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    const { ctx } = createContext();
    const selectedModel = ctx.modelRegistry!.getAvailable()[1];
    const setModel = vi.fn(async (model: unknown) => {
      ctx.model = model;
      return true;
    });
    const pi = { sendUserMessage: vi.fn(), setModel, getThinkingLevel: () => "medium" };

    handleRemoteCommand(pi as never, ctx as never, { type: "remote_model_catalog_refresh", requestId: "req_refresh" }, "sess_pi_1");
    await vi.waitFor(() => expect(fetchCalls).toContainEqual(expect.objectContaining({
      body: expect.objectContaining({ type: "remote_model_catalog", requestId: "req_refresh" }),
    })));
    const refreshEvent = fetchCalls.find((call) => call.body.type === "remote_model_catalog")!.body;
    const catalogVersion = (refreshEvent.catalog as { catalogVersion: string }).catalogVersion;

    handleRemoteCommand(pi as never, ctx as never, {
      type: "remote_model_select",
      requestId: "req_select",
      provider: "openai",
      modelId: "gpt-5",
      baseCatalogVersion: catalogVersion,
    }, "sess_pi_1");

    await vi.waitFor(() => expect(fetchCalls.map((call) => call.body)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "remote_model_select_result",
        requestId: "req_select",
        ok: true,
        model: expect.objectContaining({ provider: "openai", modelId: "gpt-5" }),
        catalogVersion: expect.stringMatching(/^modelsv_/),
      }),
      expect.objectContaining({ type: "remote_model_catalog", catalog: expect.objectContaining({ currentModel: expect.objectContaining({ provider: "openai", modelId: "gpt-5" }) }) }),
      expect.objectContaining({ type: "runtime_status", status: expect.objectContaining({ model: expect.objectContaining({ provider: "openai", id: "gpt-5" }) }) }),
    ])));
    expect(setModel).toHaveBeenCalledWith(selectedModel);
  });

  it("clones the active branch into a replacement session without returning draft text", async () => {
    const fetchCalls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, init: { method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined } });
        return new Response(JSON.stringify({ accepted: true, session: { id: "sess_pi_clone" } }), { status: 200 });
      }),
    );
    const { ctx } = createContext();
    const replacementCtx = createContext().ctx;
    replacementCtx.sessionManager.getSessionId = () => "pi_clone";
    replacementCtx.sessionManager.getSessionFile = () => "/tmp/clone.jsonl";
    const fork = vi.fn(async (_entryId: string, options: { position?: "at"; withSession?: (ctx: typeof replacementCtx) => Promise<void> }) => {
      await options.withSession?.(replacementCtx);
      return { cancelled: false };
    });

    handleRemoteCommand({ sendUserMessage: vi.fn() } as never, { ...ctx, abort: vi.fn(), compact: vi.fn(), fork } as never, {
      type: "remote_clone",
      requestId: "req_clone_1",
      baseSnapshotVersion: "treev_1",
      baseBranchVersion: "branchv_1",
      baseLeafId: "entry_leaf",
    }, "sess_pi_1");

    await vi.waitFor(() => expect(fetchCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: "http://127.0.0.1:17373/v1/tui/sessions", init: expect.objectContaining({ method: "POST", body: expect.objectContaining({ id: "sess_pi_clone", sessionFile: "/tmp/clone.jsonl" }) }) }),
      { url: "http://127.0.0.1:17373/v1/tui/sessions/sess_pi_1/events", init: { method: "POST", body: { type: "remote_clone_result", requestId: "req_clone_1", ok: true, newSession: expect.objectContaining({ id: "sess_pi_clone", isActive: true }) } } },
      { url: "http://127.0.0.1:17373/v1/tui/sessions/sess_pi_1/events", init: { method: "POST", body: { type: "remote_session_replaced", requestId: "req_clone_1", oldSessionId: "sess_pi_1", newSession: expect.objectContaining({ id: "sess_pi_clone", isActive: true }) } } },
    ])));
    expect(fork).toHaveBeenCalledWith("entry_leaf", { position: "at", withSession: expect.any(Function) });
  });

  it("forks into a replacement session, preserves remote control, and returns draft text only to iOS", async () => {
    const fetchCalls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, init: { method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined } });
        return new Response(JSON.stringify({ accepted: true, session: { id: "sess_pi_fork" } }), { status: 200 });
      }),
    );
    const { ctx } = createContext();
    ctx.sessionManager.getEntry = (entryId: string) => entryId === "entry_user"
      ? { type: "message", id: "entry_user", parentId: "entry_parent", timestamp: "2026-05-09T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "selected " }, { type: "image", source: "ignored" }, { type: "text", text: "prompt" }] } }
      : undefined;
    const replacementCtx = createContext().ctx;
    replacementCtx.sessionManager.getSessionId = () => "pi_fork";
    replacementCtx.sessionManager.getSessionFile = () => "/tmp/fork.jsonl";
    const setEditorText = vi.fn();
    replacementCtx.ui.setEditorText = setEditorText as never;
    const fork = vi.fn(async (_entryId: string, options: { position?: "before"; withSession?: (ctx: typeof replacementCtx) => Promise<void> }) => {
      await options.withSession?.(replacementCtx);
      return { cancelled: false };
    });
    const sendUserMessage = vi.fn();

    handleRemoteCommand({ sendUserMessage } as never, { ...ctx, abort: vi.fn(), compact: vi.fn(), fork } as never, {
      type: "remote_fork",
      requestId: "req_fork_1",
      targetEntryId: "entry_user",
      baseSnapshotVersion: "treev_1",
      baseBranchVersion: "branchv_1",
      baseLeafId: "entry_leaf",
    }, "sess_pi_1");

    await vi.waitFor(() => expect(fetchCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: "http://127.0.0.1:17373/v1/tui/sessions", init: expect.objectContaining({ method: "POST", body: expect.objectContaining({ id: "sess_pi_fork", sessionFile: "/tmp/fork.jsonl" }) }) }),
      { url: "http://127.0.0.1:17373/v1/tui/sessions/sess_pi_1/events", init: { method: "POST", body: { type: "remote_fork_result", requestId: "req_fork_1", ok: true, newSession: expect.objectContaining({ id: "sess_pi_fork", isActive: true }), editorText: "selected prompt" } } },
      { url: "http://127.0.0.1:17373/v1/tui/sessions/sess_pi_1/events", init: { method: "POST", body: { type: "remote_session_replaced", requestId: "req_fork_1", oldSessionId: "sess_pi_1", newSession: expect.objectContaining({ id: "sess_pi_fork", isActive: true }) } } },
    ])));
    expect(fork).toHaveBeenCalledWith("entry_user", { position: "before", withSession: expect.any(Function) });
    expect(setEditorText).toHaveBeenCalledWith("");
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("notifies iOS as soon as the replacement session is registered during Remote Fork", async () => {
    const fetchCalls: Array<{ url: string; method: string; body?: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Response(JSON.stringify({ accepted: true, session: { id: "sess_pi_fork" } }), { status: 200 });
      }),
    );
    const { ctx } = createContext();
    ctx.sessionManager.getEntry = (entryId: string) => entryId === "entry_user"
      ? { type: "message", id: "entry_user", message: { role: "user", content: "selected prompt" } }
      : undefined;
    const replacementCtx = createContext().ctx;
    replacementCtx.sessionManager.getSessionId = () => "pi_fork";
    replacementCtx.sessionManager.getSessionFile = () => "/tmp/fork.jsonl";
    replacementCtx.ui.setEditorText = vi.fn() as never;
    let finishFork!: () => void;
    const forkFinished = new Promise<void>((resolve) => { finishFork = resolve; });
    const fork = vi.fn(async (_entryId: string, options: { position?: "before"; withSession?: (ctx: typeof replacementCtx) => Promise<void> }) => {
      await options.withSession?.(replacementCtx);
      await forkFinished;
      return { cancelled: false, selectedText: "late selected prompt" };
    });

    handleRemoteCommand({ sendUserMessage: vi.fn() } as never, { ...ctx, abort: vi.fn(), compact: vi.fn(), fork } as never, {
      type: "remote_fork",
      requestId: "req_fork_early",
      targetEntryId: "entry_user",
      baseSnapshotVersion: "treev_1",
      baseBranchVersion: "branchv_1",
      baseLeafId: "entry_leaf",
    }, "sess_pi_1");

    await vi.waitFor(() => expect(fetchCalls).toContainEqual(expect.objectContaining({
      url: "http://127.0.0.1:17373/v1/tui/sessions/sess_pi_1/events",
      body: expect.objectContaining({ type: "remote_fork_result", requestId: "req_fork_early", ok: true, editorText: "selected prompt" }),
    })));
    expect(fetchCalls).toContainEqual(expect.objectContaining({
      url: "http://127.0.0.1:17373/v1/tui/sessions/sess_pi_1/events",
      body: expect.objectContaining({ type: "remote_session_replaced", requestId: "req_fork_early" }),
    }));
    finishFork();
  });

  it("transfers local remote-control state to the replacement extension instance after Remote Fork", async () => {
    const oldExtension = createFakePi();
    const oldContext = createContext();
    oldContext.ctx.sessionManager.getEntry = (entryId: string) => entryId === "entry_user"
      ? { type: "message", id: "entry_user", parentId: "entry_parent", timestamp: "2026-05-09T00:00:00.000Z", message: { role: "user", content: "selected prompt" } }
      : undefined;
    const replacementExtension = createFakePi();
    const replacementContext = createContext();
    replacementContext.ctx.sessionManager.getSessionId = () => "pi_fork";
    replacementContext.ctx.sessionManager.getSessionFile = () => "/tmp/fork.jsonl";
    const setEditorText = vi.fn();
    replacementContext.ctx.ui.setEditorText = setEditorText as never;
    const fetchCalls: Array<{ url: string; method: string; body?: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Response(JSON.stringify({ accepted: true, session: { id: "sess_pi_fork" } }), { status: 200 });
      }),
    );
    remoteControlExtension(oldExtension.pi as never);
    await oldExtension.commands.find((command) => command.name === "remote-control")!.handler("", oldContext.ctx);

    const fork = vi.fn(async (_entryId: string, options: { position?: "before"; withSession?: (ctx: typeof replacementContext.ctx) => Promise<void> }) => {
      await oldExtension.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "fork", targetSessionFile: "/tmp/fork.jsonl" }, oldContext.ctx);
      remoteControlExtension(replacementExtension.pi as never);
      await options.withSession?.(replacementContext.ctx);
      return { cancelled: false, selectedText: "selected prompt" };
    });
    handleRemoteCommand({ sendUserMessage: vi.fn() } as never, { ...oldContext.ctx, abort: vi.fn(), compact: vi.fn(), fork } as never, {
      type: "remote_fork",
      requestId: "req_fork_1",
      targetEntryId: "entry_user",
      baseSnapshotVersion: "treev_1",
      baseBranchVersion: "branchv_1",
      baseLeafId: "entry_leaf",
    }, "sess_pi_1");

    await vi.waitFor(() => expect(replacementContext.statuses).toContainEqual({ key: "remote-control", text: "\u001b[32mRemote Control Active\u001b[39m" }));
    await vi.waitFor(() => expect(fetchCalls).toContainEqual(expect.objectContaining({
      url: "http://127.0.0.1:17373/v1/tui/sessions/sess_pi_1/events",
      body: expect.objectContaining({ type: "remote_session_replaced" }),
    })));
    const replacementEventIndex = fetchCalls.findIndex((call) => call.url === "http://127.0.0.1:17373/v1/tui/sessions/sess_pi_1/events" && (call.body as { type?: string } | undefined)?.type === "remote_session_replaced");
    const oldDeleteIndex = fetchCalls.findIndex((call) => call.url === "http://127.0.0.1:17373/v1/tui/sessions/sess_pi_1" && call.method === "DELETE");
    expect(oldDeleteIndex).toBeGreaterThan(replacementEventIndex);

    await vi.waitFor(() => expect(fetchCalls).toContainEqual({
      url: "http://127.0.0.1:17373/v1/tui/sessions/sess_pi_fork/commands",
      method: "GET",
      body: undefined,
    }));
    await replacementExtension.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, replacementContext.ctx);
  });

  it("uses Pi default branch summarization for default-summary Remote Tree Navigation", async () => {
    const fetchCalls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, init: { method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined } });
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    const { ctx } = createContext();
    const navigateTree = vi.fn(async () => ({ cancelled: false }));
    ctx.sessionManager.getLeafId = () => "entry_target";
    ctx.sessionManager.getTree = () => [
      { entry: { type: "message", id: "entry_target", parentId: null, timestamp: "2026-05-09T00:00:00.000Z", message: { role: "assistant", content: "target" } }, children: [] },
    ];

    handleRemoteCommand({ sendUserMessage: vi.fn() } as never, { ...ctx, abort: vi.fn(), compact: vi.fn(), navigateTree } as never, {
      type: "remote_tree_navigate",
      requestId: "req_nav_summary",
      targetEntryId: "entry_target",
      baseSnapshotVersion: "treev_1",
      baseBranchVersion: "branchv_1",
      baseLeafId: "entry_old",
      summaryMode: "default",
    }, "sess_pi_1");

    await vi.waitFor(() => expect(fetchCalls).toContainEqual(expect.objectContaining({
      url: "http://127.0.0.1:17373/v1/tui/sessions/sess_pi_1/events",
      init: expect.objectContaining({ body: expect.objectContaining({ type: "remote_tree_navigation_result", requestId: "req_nav_summary", ok: true }) }),
    })));
    expect(navigateTree).toHaveBeenCalledWith("entry_target", { summarize: true });
  });

  it("navigates the live TUI tree and posts a Remote Tree Navigation result", async () => {
    const fetchCalls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, init: { method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined } });
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    const { ctx } = createContext();
    const navigateTree = vi.fn(async () => ({ cancelled: false, editorText: "revise this prompt" }));
    ctx.sessionManager.getLeafId = () => "entry_parent";
    ctx.sessionManager.getTree = () => [
      { entry: { type: "message", id: "entry_parent", parentId: null, timestamp: "2026-05-09T00:00:00.000Z", message: { role: "assistant", content: "parent" } }, children: [] },
    ];

    handleRemoteCommand({ sendUserMessage: vi.fn() } as never, { ...ctx, abort: vi.fn(), compact: vi.fn(), navigateTree } as never, {
      type: "remote_tree_navigate",
      requestId: "req_nav_1",
      targetEntryId: "entry_user",
      baseSnapshotVersion: "treev_1",
      baseBranchVersion: "branchv_1",
      baseLeafId: "entry_parent",
      summaryMode: "none",
    }, "sess_pi_1");

    await vi.waitFor(() => expect(fetchCalls).toContainEqual({
      url: "http://127.0.0.1:17373/v1/tui/sessions/sess_pi_1/events",
      init: {
        method: "POST",
        body: expect.objectContaining({
          type: "remote_tree_navigation_result",
          requestId: "req_nav_1",
          ok: true,
          leafId: "entry_parent",
          editorText: "revise this prompt",
        }),
      },
    }));
    expect(navigateTree).toHaveBeenCalledWith("entry_user", { summarize: false });
  });

  it("posts stable Remote Tree Navigation error codes for cancelled, aborted, and failed summaries", async () => {
    const fetchCalls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, init: { method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined } });
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    const { ctx } = createContext();
    const navigateTree = vi.fn()
      .mockResolvedValueOnce({ cancelled: true })
      .mockResolvedValueOnce({ cancelled: true, aborted: true })
      .mockRejectedValueOnce(new Error("summary model failed"));

    for (const requestId of ["req_cancel", "req_abort", "req_fail"]) {
      handleRemoteCommand({ sendUserMessage: vi.fn() } as never, { ...ctx, abort: vi.fn(), compact: vi.fn(), navigateTree } as never, {
        type: "remote_tree_navigate",
        requestId,
        targetEntryId: "entry_target",
        baseSnapshotVersion: "treev_1",
        baseBranchVersion: "branchv_1",
        baseLeafId: "entry_old",
        summaryMode: "default",
      }, "sess_pi_1");
    }

    await vi.waitFor(() => {
      const bodies = fetchCalls.map((call) => (call as { init: { body: unknown } }).init.body);
      expect(bodies).toEqual(expect.arrayContaining([
        { type: "remote_tree_navigation_result", requestId: "req_cancel", ok: false, error: "cancelled" },
        { type: "remote_tree_navigation_result", requestId: "req_abort", ok: false, error: "aborted" },
        { type: "remote_tree_navigation_result", requestId: "req_fail", ok: false, error: "summarization_failed" },
      ]));
    });
  });

  it("posts a fresh Tree Snapshot when handling remote Tree Refresh", async () => {
    const fetchCalls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, init: { method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined } });
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    const { ctx } = createContext();
    ctx.sessionManager.getLeafId = () => "entry_1";
    ctx.sessionManager.getTree = () => [
      { entry: { type: "message", id: "entry_1", parentId: null, timestamp: "2026-05-09T00:00:00.000Z", message: { role: "user", content: "refresh me" } }, children: [] },
    ];

    handleRemoteCommand({ sendUserMessage: vi.fn() } as never, { ...ctx, abort: vi.fn(), compact: vi.fn() } as never, { type: "remote_tree_refresh", requestId: "req_tree_1" }, "sess_pi_1");

    await vi.waitFor(() => expect(fetchCalls).toContainEqual({
      url: "http://127.0.0.1:17373/v1/tui/sessions/sess_pi_1/events",
      init: {
        method: "POST",
        body: {
          type: "remote_tree_snapshot",
          requestId: "req_tree_1",
          snapshot: expect.objectContaining({
            sessionId: "sess_pi_1",
            leafId: "entry_1",
            entries: [expect.objectContaining({ id: "entry_1", preview: "refresh me", isCurrentLeaf: true })],
          }),
        },
      },
    }));
  });

  it("posts remote compact success and failure results from TUI callbacks", async () => {
    const fetchCalls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, init: { method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined } });
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    const compact = vi.fn();

    handleRemoteCommand({ sendUserMessage: vi.fn() } as never, { abort: vi.fn(), compact } as never, { type: "remote_compact", requestId: "req_3" }, "sess_pi_1");
    const options = compact.mock.calls[0]?.[0] as {
      onComplete(result: unknown): void;
      onError(error: Error): void;
    };
    options.onComplete({ summary: "Summary", firstKeptEntryId: "entry_1", tokensBefore: 12345 });
    options.onError(new Error("No compaction needed"));

    await vi.waitFor(() => expect(fetchCalls).toHaveLength(2));
    expect(fetchCalls).toEqual([
      {
        url: "http://127.0.0.1:17373/v1/tui/sessions/sess_pi_1/events",
        init: { method: "POST", body: { type: "remote_compact_result", requestId: "req_3", ok: true, summary: "Summary", firstKeptEntryId: "entry_1", tokensBefore: 12345 } },
      },
      {
        url: "http://127.0.0.1:17373/v1/tui/sessions/sess_pi_1/events",
        init: { method: "POST", body: { type: "remote_compact_result", requestId: "req_3", ok: false, message: "No compaction needed" } },
      },
    ]);
  });

  it("runs local pairing command from remote-control-pair", async () => {
    const execCalls: ExecCall[] = [];
    const { pi, commands } = createFakePi(execCalls);
    const { ctx, notifications } = createContext();
    pi.exec = async (command: string, args: string[]) => {
      execCalls.push({ command, args });
      if (args.includes("pair")) return { stdout: "Pairing link: pi-remote://pair?...\n", stderr: "", code: 0, killed: false };
      return { stdout: "pi-remote-control is running (pid 1234)\n", stderr: "", code: 0, killed: false };
    };
    remoteControlExtension(pi as never);

    await commands.find((command) => command.name === "remote-control-pair")!.handler("", ctx);

    expect(execCalls).toEqual([
      { command: process.execPath, args: [expect.stringContaining("src/cli-runner.cjs"), "status"] },
      { command: process.execPath, args: [expect.stringContaining("src/cli-runner.cjs"), "pair"] },
    ]);
    expect(notifications).toEqual([{ message: "Pairing link: pi-remote://pair?...", type: "info" }]);
  });
});
