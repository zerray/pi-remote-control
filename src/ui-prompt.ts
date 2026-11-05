import type { IsoTimestamp } from "./types.js";

export const UI_PROMPT_DISPLAY_TEXT_LIMIT = 4_000;
export const UI_PROMPT_OPTION_LIMIT = 200;
export const UI_PROMPT_TEXT_LIMIT = 65_536;

export type UiPromptKind = "select" | "confirm" | "input" | "editor";

export type UiPromptOption = { optionId: string; label: string };

export type UiPrompt = {
  promptId: string;
  kind: UiPromptKind;
  title: string;
  message?: string;
  placeholder?: string;
  prefill?: string;
  options?: UiPromptOption[];
  truncated?: true;
  createdAt: IsoTimestamp;
};

export type UiPromptResponse =
  | { type: "option"; optionId: string }
  | { type: "confirm"; confirmed: boolean }
  | { type: "text"; text: string }
  | { type: "cancel" };

// Every error a remote UI prompt response can report; the TUI adds `ui_prompt_closed` when the dialog is already gone.
export const UI_PROMPT_ANSWER_ERRORS = ["ui_prompt_closed", "invalid_ui_prompt_response", "option_not_found"] as const;
export type UiPromptAnswerError = (typeof UI_PROMPT_ANSWER_ERRORS)[number];
export type UiPromptResponseError = Exclude<UiPromptAnswerError, "ui_prompt_closed">;

export type UiPromptSpec =
  | { kind: "select"; title: unknown; options: unknown }
  | { kind: "confirm"; title: unknown; message: unknown }
  | { kind: "input"; title: unknown; placeholder: unknown }
  | { kind: "editor"; title: unknown; prefill: unknown };

/** Builds the public prompt for a live dialog call; undefined means the dialog cannot be answered remotely. */
export function buildUiPrompt(spec: UiPromptSpec, promptId: string, createdAt: IsoTimestamp): UiPrompt | undefined {
  const clip = createClipper();
  const prompt: UiPrompt = { promptId, kind: spec.kind, title: clip(stringOr(spec.title, "")), createdAt };
  if (spec.kind === "select") {
    if (!Array.isArray(spec.options)) return undefined;
    if (spec.options.length > UI_PROMPT_OPTION_LIMIT) clip.markTruncated();
    prompt.options = spec.options.slice(0, UI_PROMPT_OPTION_LIMIT).map((option, index) => ({ optionId: optionIdForIndex(index), label: clip(String(option)) }));
  }
  if (spec.kind === "confirm") prompt.message = clip(stringOr(spec.message, ""));
  if (spec.kind === "input" && typeof spec.placeholder === "string") prompt.placeholder = clip(spec.placeholder);
  if (spec.kind === "editor" && typeof spec.prefill === "string") {
    if (spec.prefill.length > UI_PROMPT_TEXT_LIMIT) return undefined;
    prompt.prefill = spec.prefill;
  }
  if (clip.truncated) prompt.truncated = true;
  return prompt;
}

/** Re-validates a prompt received over the package-internal control interface. */
export function reduceUiPrompt(value: unknown): UiPrompt | undefined {
  const record = asRecord(value);
  const kind = record.kind;
  if (typeof record.promptId !== "string" || !record.promptId || typeof record.createdAt !== "string") return undefined;
  if (kind !== "select" && kind !== "confirm" && kind !== "input" && kind !== "editor") return undefined;
  if (typeof record.title !== "string") return undefined;
  const clip = createClipper();
  if (record.truncated === true) clip.markTruncated();
  const prompt: UiPrompt = { promptId: record.promptId, kind, title: clip(record.title), createdAt: record.createdAt };
  if (kind === "select") {
    if (!Array.isArray(record.options)) return undefined;
    const options = record.options.map(asRecord);
    if (options.some((option) => typeof option.optionId !== "string" || typeof option.label !== "string")) return undefined;
    if (options.length > UI_PROMPT_OPTION_LIMIT) clip.markTruncated();
    prompt.options = options.slice(0, UI_PROMPT_OPTION_LIMIT).map((option) => ({ optionId: option.optionId as string, label: clip(option.label as string) }));
  }
  if (kind === "confirm") prompt.message = clip(stringOr(record.message, ""));
  if (kind === "input" && typeof record.placeholder === "string") prompt.placeholder = clip(record.placeholder);
  if (kind === "editor" && typeof record.prefill === "string") {
    if (record.prefill.length > UI_PROMPT_TEXT_LIMIT) return undefined;
    prompt.prefill = record.prefill;
  }
  if (clip.truncated) prompt.truncated = true;
  return prompt;
}

export function parseUiPromptResponse(value: unknown): UiPromptResponse | undefined {
  const record = asRecord(value);
  if (record.type === "option" && typeof record.optionId === "string") return { type: "option", optionId: record.optionId };
  if (record.type === "confirm" && typeof record.confirmed === "boolean") return { type: "confirm", confirmed: record.confirmed };
  if (record.type === "text" && typeof record.text === "string") return { type: "text", text: record.text };
  if (record.type === "cancel") return { type: "cancel" };
  return undefined;
}

export function validateUiPromptResponse(prompt: UiPrompt, response: UiPromptResponse): UiPromptResponseError | undefined {
  if (response.type === "cancel") return undefined;
  if (response.type === "option") {
    if (prompt.kind !== "select") return "invalid_ui_prompt_response";
    return prompt.options?.some((option) => option.optionId === response.optionId) ? undefined : "option_not_found";
  }
  if (response.type === "confirm") return prompt.kind === "confirm" ? undefined : "invalid_ui_prompt_response";
  if (prompt.kind !== "input" && prompt.kind !== "editor") return "invalid_ui_prompt_response";
  return response.text.length > UI_PROMPT_TEXT_LIMIT ? "invalid_ui_prompt_response" : undefined;
}

export function optionIndexForId(optionId: string): number | undefined {
  const match = /^opt_(\d+)$/u.exec(optionId);
  return match ? Number(match[1]) : undefined;
}

function optionIdForIndex(index: number): string {
  return `opt_${index}`;
}

function createClipper(): ((text: string) => string) & { truncated: boolean; markTruncated(): void } {
  const clip = Object.assign(
    (text: string) => {
      if (text.length <= UI_PROMPT_DISPLAY_TEXT_LIMIT) return text;
      clip.truncated = true;
      return `${text.slice(0, UI_PROMPT_DISPLAY_TEXT_LIMIT - 1)}…`;
    },
    {
      truncated: false,
      markTruncated() {
        clip.truncated = true;
      },
    },
  );
  return clip;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
