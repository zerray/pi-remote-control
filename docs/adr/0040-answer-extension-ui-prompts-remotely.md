# Title

Answer extension UI prompts remotely

# Status

Accepted

# Context

Extensions block on `ctx.ui.select()`, `ctx.ui.confirm()`, `ctx.ui.input()`, and `ctx.ui.editor()`, often from a `tool_call` hook during an active run, such as a permission gate for destructive commands. From iOS such a session looked hung, with nothing to answer. A remote answer cannot be sent as a chat message: while the run is active, remote prompts are queued as follow-ups, and a follow-up waits for the run that is itself waiting for the dialog.

Pi `0.84.4` and newer emit `ui_prompt_start` and `ui_prompt_end`, but those events carry only the dialog kind and title. Pi has no API for listing a dialog's options or for answering a dialog that another extension opened. It does give every extension in a session the same mutable `ctx.ui` object, and the `select`, `confirm`, and `input` dialogs accept a `signal` that dismisses them.

# Decision

The owning TUI extension wraps the shared `ctx.ui` dialog methods for its session. Each `select`, `confirm`, `input`, or `editor` call is published as a reduced UI Prompt with an opaque prompt ID and, for `select`, opaque option IDs. The local dialog still opens with a merged `signal`. A local answer and a remote answer race; the first wins, and a winning remote answer dismisses the local dialog.

The daemon keeps open UI Prompts as active-session process state, includes them in `session_state`, and exposes one authenticated response endpoint. It validates the response type against the prompt kind and the option ID against the published options, rejects free text for fixed-choice prompts, and relays the response over the TUI command channel. The extension re-validates the response and resolves the waiting dialog call directly, so the answer never enters the message queue. Remote abort cancels open UI Prompts before aborting the run. When the session closes remotely (unregistered, heartbeat expired, or replaced), its open UI Prompts leave the daemon with it and iOS clears them on `session_closed`; the local dialogs are left to Pi, so disabling remote control never dismisses a dialog the terminal user is still answering.

Remote answering is on whenever remote control is active for the session; it needs no separate opt-in.

Issue #11 proposed `POST /v1/sessions/{id}/ui-prompt` with a `basePromptVersion` and a `ui_prompt_changed` rejection. This design drops the version. A dialog's title and options are fixed when the extension calls it, so a prompt never changes in place, and every call gets a new prompt ID that is never reused. The prompt ID already names one exact prompt: an answer to a prompt that has since closed is rejected as `ui_prompt_not_found` by the daemon or `ui_prompt_closed` by the TUI. Because several prompts can be open at once, the endpoint addresses the prompt in its path, `POST /v1/sessions/{id}/ui-prompts/{promptId}/response`, instead of targeting a single current prompt.

`ctx.ui.custom()` components are not published because they have no serializable shape. Extensions that want remote answers use the four supported dialogs. Pi's `editor` takes no dismissal signal, so after a remote answer the local editor stays open and its later local result is ignored. Editor prompts whose prefill exceeds the response limit are not published, because a remote answer could not preserve the full text.

Issue #11 also proposed that the daemon surface a "waiting on a terminal-only prompt" status for dialogs that cannot be published. This change does not build it. A session blocked on `ctx.ui.custom()` or on an unpublished editor prompt shows on iOS as a running session with no prompt card. Such a status would be an addition, not a replacement for remote answering: the bridge could wrap `custom()` to publish a non-answerable prompt marker.

# Consequences

A paired device can approve or reject actions that an extension's permission gate guards. Pairing and device-token authentication remain the trust boundary for that.

The bridge depends on Pi keeping `ctx.ui` shared and mutable. That is observed behavior, not a documented API. If Pi changes it, dialogs keep working locally and stop being remotely answerable, and `tests/ui-prompt-bridge-pi.test.ts` fails against the locked Pi version. An upstream Pi API for publishing and answering prompts would replace the wrapper.

Prompt display strings are extension-authored and may contain commands, paths, or model output. They are bounded, never stored durably, and never included in notifications.
