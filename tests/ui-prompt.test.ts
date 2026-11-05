import { describe, expect, it } from "vitest";
import { buildUiPrompt, parseUiPromptResponse, reduceUiPrompt, validateUiPromptResponse, type UiPrompt } from "../src/ui-prompt.js";

const createdAt = "2026-05-09T09:47:00.000Z";

describe("UI prompts", () => {
  it("publishes kind-specific fields with opaque option ids", () => {
    expect(buildUiPrompt({ kind: "select", title: "Allow?", options: ["Allow", "Block"] }, "uip_1", createdAt)).toEqual({
      promptId: "uip_1",
      kind: "select",
      title: "Allow?",
      options: [{ optionId: "opt_0", label: "Allow" }, { optionId: "opt_1", label: "Block" }],
      createdAt,
    });
    expect(buildUiPrompt({ kind: "confirm", title: "Push?", message: "3 commits" }, "uip_2", createdAt)).toEqual({ promptId: "uip_2", kind: "confirm", title: "Push?", message: "3 commits", createdAt });
    expect(buildUiPrompt({ kind: "input", title: "Name", placeholder: undefined }, "uip_3", createdAt)).toEqual({ promptId: "uip_3", kind: "input", title: "Name", createdAt });
    expect(buildUiPrompt({ kind: "editor", title: "Plan", prefill: "draft" }, "uip_4", createdAt)).toEqual({ promptId: "uip_4", kind: "editor", title: "Plan", prefill: "draft", createdAt });
  });

  it("clips display text and option lists and marks the prompt truncated", () => {
    const prompt = buildUiPrompt({ kind: "select", title: "t".repeat(5_000), options: Array.from({ length: 250 }, (_, index) => `option ${index}`) }, "uip_1", createdAt)!;

    expect(prompt.title).toHaveLength(4_000);
    expect(prompt.title.endsWith("…")).toBe(true);
    expect(prompt.options).toHaveLength(200);
    expect(prompt.truncated).toBe(true);
  });

  it("does not publish editor prompts whose prefill cannot be answered losslessly", () => {
    expect(buildUiPrompt({ kind: "editor", title: "Plan", prefill: "x".repeat(65_537) }, "uip_1", createdAt)).toBeUndefined();
  });

  it("re-reduces control-interface prompts and drops unknown fields and kinds", () => {
    expect(reduceUiPrompt({ promptId: "uip_1", kind: "confirm", title: "Push?", message: "ok", extra: "secret", createdAt })).toEqual({ promptId: "uip_1", kind: "confirm", title: "Push?", message: "ok", createdAt });
    expect(reduceUiPrompt({ promptId: "uip_1", kind: "custom", title: "x", createdAt })).toBeUndefined();
    expect(reduceUiPrompt({ promptId: "uip_1", kind: "select", title: "x", options: [{ optionId: 1, label: "x" }], createdAt })).toBeUndefined();
  });

  it("accepts only responses that match the prompt kind and published options", () => {
    const select: UiPrompt = { promptId: "uip_1", kind: "select", title: "Allow?", options: [{ optionId: "opt_0", label: "Allow" }], createdAt };
    const confirm: UiPrompt = { promptId: "uip_2", kind: "confirm", title: "Push?", message: "", createdAt };
    const input: UiPrompt = { promptId: "uip_3", kind: "input", title: "Name", createdAt };

    expect(validateUiPromptResponse(select, { type: "option", optionId: "opt_0" })).toBeUndefined();
    expect(validateUiPromptResponse(select, { type: "option", optionId: "opt_1" })).toBe("option_not_found");
    expect(validateUiPromptResponse(select, { type: "text", text: "Allow" })).toBe("invalid_ui_prompt_response");
    expect(validateUiPromptResponse(confirm, { type: "confirm", confirmed: true })).toBeUndefined();
    expect(validateUiPromptResponse(confirm, { type: "text", text: "yes" })).toBe("invalid_ui_prompt_response");
    expect(validateUiPromptResponse(input, { type: "text", text: "main" })).toBeUndefined();
    expect(validateUiPromptResponse(input, { type: "text", text: "x".repeat(65_537) })).toBe("invalid_ui_prompt_response");
    expect(validateUiPromptResponse(input, { type: "cancel" })).toBeUndefined();
    expect(parseUiPromptResponse({ type: "confirm", confirmed: "yes" })).toBeUndefined();
  });
});
