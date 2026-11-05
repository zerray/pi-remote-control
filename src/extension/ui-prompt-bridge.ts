import { randomUUID } from "node:crypto";
import { buildUiPrompt, optionIndexForId, validateUiPromptResponse, type UiPrompt, type UiPromptKind, type UiPromptResponse, type UiPromptAnswerError, type UiPromptSpec } from "../ui-prompt.js";

// Pi gives every extension the same mutable `ctx.ui` object and has no API for answering another
// extension's dialog. The bridge wraps that shared object's dialog methods so the owning TUI can
// publish open prompts and race a remote answer against the local dialog (ADR-0040).

export type UiPromptBridgeListener = {
  opened(sessionId: string, prompt: UiPrompt): void;
  closed(sessionId: string, promptId: string): void;
};

export type UiPromptAnswerResult = { ok: true } | { ok: false; error: UiPromptAnswerError };

type DialogMethod = (...args: unknown[]) => unknown;

type PendingUiPrompt = {
  sessionId: string;
  prompt: UiPrompt;
  answer(response: UiPromptResponse): void;
};

const DIALOG_KINDS: UiPromptKind[] = ["select", "confirm", "input", "editor"];
const sessionIdsByUi = new WeakMap<object, string>();
const pendingPrompts = new Map<string, PendingUiPrompt>();
let listener: UiPromptBridgeListener | undefined;

export function setUiPromptBridgeListener(next: UiPromptBridgeListener): void {
  listener = next;
}

/** Wraps the session's shared UI object once and (re)binds it to the session that currently owns it. */
export function installUiPromptBridge(ui: unknown, sessionId: string): void {
  if (!ui || typeof ui !== "object") return;
  const target = ui as Record<string, unknown>;
  const alreadyInstalled = sessionIdsByUi.has(target);
  sessionIdsByUi.set(target, sessionId);
  if (alreadyInstalled) return;
  for (const kind of DIALOG_KINDS) {
    const original = target[kind];
    if (typeof original !== "function") continue;
    try {
      target[kind] = wrapDialog(target, kind, original as DialogMethod);
    } catch {
      // A frozen or accessor-only UI context keeps working locally; it is just not remotely answerable.
    }
  }
}

export function openUiPrompts(sessionId: string): UiPrompt[] {
  return [...pendingPrompts.values()].filter((pending) => pending.sessionId === sessionId).map((pending) => pending.prompt);
}

export function answerUiPrompt(sessionId: string, promptId: string, response: UiPromptResponse): UiPromptAnswerResult {
  const pending = pendingPrompts.get(promptId);
  if (!pending || pending.sessionId !== sessionId) return { ok: false, error: "ui_prompt_closed" };
  const error = validateUiPromptResponse(pending.prompt, response);
  if (error) return { ok: false, error };
  pending.answer(response);
  return { ok: true };
}

export function cancelUiPrompts(sessionId: string): void {
  for (const pending of [...pendingPrompts.values()]) {
    if (pending.sessionId === sessionId) pending.answer({ type: "cancel" });
  }
}

export function __resetUiPromptBridgeForTests(): void {
  pendingPrompts.clear();
  listener = undefined;
}

function wrapDialog(ui: object, kind: UiPromptKind, original: DialogMethod): DialogMethod {
  return (...args: unknown[]) => {
    const sessionId = sessionIdsByUi.get(ui);
    const prompt = sessionId ? buildUiPrompt(specFor(kind, args), `uip_${randomUUID()}`, new Date().toISOString()) : undefined;
    if (!sessionId || !prompt) return original.apply(ui, args);
    return raceDialog(ui, kind, original, args, sessionId, prompt);
  };
}

async function raceDialog(ui: object, kind: UiPromptKind, original: DialogMethod, args: unknown[], sessionId: string, prompt: UiPrompt): Promise<unknown> {
  // `editor` takes no dialog options, so Pi offers no way to dismiss it after a remote answer.
  const dismiss = kind === "editor" ? undefined : new AbortController();
  const localArgs = dismiss ? withDismissSignal(args, dismiss) : args;
  let answerRemotely!: (response: UiPromptResponse) => void;
  const remote = new Promise<UiPromptResponse>((resolve) => {
    answerRemotely = resolve;
  });
  const optionValues = kind === "select" && Array.isArray(args[1]) ? args[1] : [];
  pendingPrompts.set(prompt.promptId, { sessionId, prompt, answer: answerRemotely });
  try {
    const local = Promise.resolve(original.apply(ui, localArgs));
    notify(() => listener?.opened(sessionId, prompt));
    const outcome = await Promise.race([
      local.then((value) => ({ remote: false as const, value })),
      remote.then((response) => ({ remote: true as const, response })),
    ]);
    if (!outcome.remote) return outcome.value;
    dismiss?.abort();
    return valueForResponse(kind, outcome.response, optionValues);
  } finally {
    pendingPrompts.delete(prompt.promptId);
    notify(() => listener?.closed(sessionId, prompt.promptId));
  }
}

function specFor(kind: UiPromptKind, args: unknown[]): UiPromptSpec {
  if (kind === "select") return { kind, title: args[0], options: args[1] };
  if (kind === "confirm") return { kind, title: args[0], message: args[1] };
  if (kind === "input") return { kind, title: args[0], placeholder: args[1] };
  return { kind, title: args[0], prefill: args[1] };
}

function withDismissSignal(args: unknown[], dismiss: AbortController): unknown[] {
  const options = args[2] && typeof args[2] === "object" ? (args[2] as { signal?: AbortSignal }) : {};
  const callerSignal = options.signal;
  if (callerSignal?.aborted) dismiss.abort();
  else callerSignal?.addEventListener("abort", () => dismiss.abort(), { once: true });
  return [args[0], args[1], { ...options, signal: dismiss.signal }];
}

function valueForResponse(kind: UiPromptKind, response: UiPromptResponse, optionValues: unknown[]): unknown {
  if (response.type === "cancel") return kind === "confirm" ? false : undefined;
  if (response.type === "confirm") return response.confirmed;
  if (response.type === "text") return response.text;
  const index = optionIndexForId(response.optionId);
  return index === undefined ? undefined : optionValues[index];
}

function notify(callback: () => void): void {
  try {
    callback();
  } catch {
    // Remote publication must never break the local dialog.
  }
}
