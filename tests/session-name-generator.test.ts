import { describe, expect, it, vi } from "vitest";
import { buildSessionNamePrompt, createLlmSessionNameGenerator, sanitizeGeneratedSessionName } from "../src/session-name-generator.js";
import type { TranscriptMessage } from "../src/types.js";

function message(role: TranscriptMessage["role"], text: string, createdAt = "2026-05-09T00:00:00.000Z"): TranscriptMessage {
  return {
    id: `${role}_${createdAt}`,
    role,
    content: text ? [{ type: "text", text }] : [],
    text,
    createdAt,
    isStreaming: false,
  };
}

describe("session name generation", () => {
  it("calls an LLM to generate a session name from the transcript", async () => {
    const model = { provider: "anthropic", id: "claude-sonnet-4-5" };
    const modelRegistry = {
      find: vi.fn(() => model),
      getAvailable: vi.fn(() => [model]),
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: "test-key", headers: { "x-test": "1" } })),
    };
    const complete = vi.fn(async () => ({ content: [{ type: "text", text: "\"Debug login failure\"" }] }));
    const generator = createLlmSessionNameGenerator({ modelRegistry, complete });

    await expect(generator({
      sessionId: "sess_1",
      project: { id: "proj_1", name: "Example", path: "/repo/example" },
      sessionFile: "/tmp/session.jsonl",
      messages: [message("user", "The login button fails on iOS")],
      runtimeStatus: {
        model,
        thinkingLevel: "off",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        context: null,
        updatedAt: "2026-05-09T00:00:00.000Z",
      },
    })).resolves.toBe("Debug login failure");

    expect(modelRegistry.find).toHaveBeenCalledWith("anthropic", "claude-sonnet-4-5");
    expect(modelRegistry.getApiKeyAndHeaders).toHaveBeenCalledWith(model);
    expect(complete).toHaveBeenCalledWith(model, expect.objectContaining({
      messages: [expect.objectContaining({ role: "user", content: expect.stringContaining("The login button fails on iOS") })],
    }), expect.objectContaining({ apiKey: "test-key", headers: { "x-test": "1" }, maxTokens: 32 }));
    expect(complete.mock.calls[0]?.[2]).not.toHaveProperty("temperature");
  });

  it.each(["authentication", "completion"])("returns no name when %s fails", async (failure) => {
    const model = { provider: "test", id: "test-model" };
    const generator = createLlmSessionNameGenerator({
      modelRegistry: {
        find: () => model,
        getAvailable: () => [model],
        getApiKeyAndHeaders: async () => {
          if (failure === "authentication") throw new Error("auth unavailable");
          return { ok: true as const };
        },
      },
      complete: async () => { throw new Error("provider unavailable"); },
    });

    await expect(generator({
      sessionId: "sess_1",
      project: { id: "proj_1", name: "Example", path: "/repo/example" },
      sessionFile: "/tmp/session.jsonl",
      messages: [message("user", "Fix login")],
    })).resolves.toBeNull();
  });

  it("builds a bounded naming prompt from visible conversation text", () => {
    const prompt = buildSessionNamePrompt([
      message("system", "internal instructions"),
      message("user", "The iOS login button fails after pairing."),
      message("assistant", "I'll inspect the auth flow and pairing callback."),
      message("toolResult", "large logs should not be included"),
    ]);

    expect(prompt).toContain("Generate a short display name");
    expect(prompt).toContain("user: The iOS login button fails after pairing.");
    expect(prompt).toContain("assistant: I'll inspect the auth flow and pairing callback.");
    expect(prompt).not.toContain("internal instructions");
    expect(prompt).not.toContain("large logs should not be included");
  });

  it("does not build a naming prompt without user or assistant text", () => {
    expect(buildSessionNamePrompt([message("toolResult", "tool output")])).toBeNull();
    expect(buildSessionNamePrompt([message("user", "   ")])).toBeNull();
  });

  it("sanitizes LLM-generated names for API display", () => {
    expect(sanitizeGeneratedSessionName('  "Debug login failure"\n')).toBe("Debug login failure");
    expect(sanitizeGeneratedSessionName("A".repeat(120))).toBe(`${"A".repeat(77)}...`);
    expect(sanitizeGeneratedSessionName("   ")).toBeNull();
  });
});
