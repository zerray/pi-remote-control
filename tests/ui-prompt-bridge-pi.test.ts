import { createExtensionRuntime, ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetUiPromptBridgeForTests, answerUiPrompt, installUiPromptBridge, openUiPrompts } from "../src/extension/ui-prompt-bridge.js";

// Guards the Pi behaviour the bridge relies on (ADR-0040): every extension in a session reads the
// same mutable `ctx.ui`, so wrapping it in this extension reaches dialogs opened by other extensions.

type Handler = (event: unknown, ctx: { ui: unknown }) => unknown;

function extension(path: string, handlers: Record<string, Handler>) {
  return {
    path,
    resolvedPath: path,
    handlers: new Map(Object.entries(handlers).map(([event, handler]) => [event, [handler]])),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
}

afterEach(() => {
  __resetUiPromptBridgeForTests();
});

describe("UI prompt bridge on the Pi extension runner", () => {
  it("answers another extension's select through the shared UI context", async () => {
    let localSignal: AbortSignal | undefined;
    const ui = {
      select: vi.fn((_title: string, _options: string[], options?: { signal?: AbortSignal }) => new Promise<string | undefined>((resolve) => {
        localSignal = options?.signal;
        options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
      })),
    };
    let gateAnswer: unknown;
    const remoteControl = extension("remote-control", { session_start: (_event, ctx) => installUiPromptBridge(ctx.ui, "sess_1") });
    const permissionGate = extension("permission-gate", {
      turn_start: async (_event, ctx) => {
        gateAnswer = await (ctx.ui as typeof ui).select("Allow rm -rf build?", ["Allow", "Block"]);
      },
    });
    const runner = new ExtensionRunner([remoteControl, permissionGate] as never, createExtensionRuntime(), "/tmp", {} as never, {} as never);
    runner.setUIContext(ui as never, "interactive" as never);

    await runner.emit({ type: "session_start", reason: "startup" } as never);
    const turn = runner.emit({ type: "turn_start", turnIndex: 0, timestamp: 0 } as never);
    await vi.waitFor(() => expect(openUiPrompts("sess_1")).toHaveLength(1));
    const [prompt] = openUiPrompts("sess_1");

    expect(answerUiPrompt("sess_1", prompt!.promptId, { type: "option", optionId: "opt_1" })).toEqual({ ok: true });
    await turn;
    expect(gateAnswer).toBe("Block");
    expect(localSignal?.aborted).toBe(true);
  });
});
