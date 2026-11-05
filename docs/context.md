# Pi Remote Control Context

Glossary for the Pi Remote Control domain.

## Language

**Remote Tree Navigation**:
A native iOS session-tree navigation flow where the app chooses a target session entry and the owning Pi TUI extension performs the navigation in the live session.
_Avoid_: Remote `/tree`, slash-command passthrough

**UI Prompt**:
A blocking extension dialog (`select`, `confirm`, `input`, or `editor`) open in the owning TUI, published in reduced form so iOS can answer it with a validated remote response.
_Avoid_: Dialog passthrough, remote custom UI

**Tree Filter**:
A named view over a session tree that controls which kinds of entries are shown while preserving the same underlying tree and navigation targets.
_Avoid_: Tree mode, entry mode

**Tree Selection Semantics**:
The rules that map a selected tree entry to the actual live-session position and optional editor text. Remote Tree Navigation follows Pi `/tree`: user and custom-message entries branch from their parent with prompt text returned for editing, while other entries navigate directly.
_Avoid_: Selection shortcut, remote branch rule

**Branch Summary Choice**:
The user's decision about whether remote tree navigation should preserve context from an abandoned branch by creating a branch summary. For the MVP, iOS offers no summary or default summary only; custom focus instructions are deferred.
_Avoid_: Auto summarize, forced branch compaction, custom summary prompt

**Tree Snapshot**:
The latest TUI-reported view of a live session tree, including the current leaf and enough entry metadata for iOS to render a picker. Tree snapshots may be served from the daemon cache and refreshed asynchronously from the owning TUI extension.
_Avoid_: Daemon tree guess, blocking tree fetch

**Tree Entry**:
A reduced public representation of one session-tree node for iOS picker display and navigation targeting. It exposes stable metadata such as identity, parent, role/type, preview text, timestamp, labels, and current-leaf status without exposing raw Pi session entries.
_Avoid_: Raw session entry, transcript message

**Active Branch Transcript**:
The conversation transcript derived from the path between the session-tree root and the TUI-reported current leaf. It excludes messages that exist in the JSONL file but belong to abandoned branches.
_Avoid_: Linear transcript, file-order transcript

**Tree State Sync**:
The flow that keeps the daemon's cached current leaf and tree metadata aligned with the owning TUI session. It uses full Tree Snapshots at important boundaries and lightweight leaf or append updates as the active branch changes.
_Avoid_: One-time tree load, daemon-only tree state

**Navigation Result**:
The outcome reported to iOS after Remote Tree Navigation completes, including whether navigation succeeded or was cancelled, the new leaf, snapshot version, and any prompt text returned for editing. iOS uses returned prompt text only when its composer is empty or after user confirmation.
_Avoid_: Command ack, draft overwrite

**Navigation Busy Guard**:
The rule that Remote Tree Navigation is rejected while the owning TUI agent is streaming or otherwise not idle. The user must wait or abort before changing the active branch.
_Avoid_: Queued tree navigation, mid-stream branching

**Tree Refresh**:
An explicit request for the owning TUI extension to report a fresh Tree Snapshot. Opening a tree in iOS may use the daemon's cached snapshot immediately, while Tree Refresh updates that cache asynchronously.
_Avoid_: Side-effecting tree read, blocking tree open

**Tree Snapshot Version**:
A monotonically changing identifier for the full Tree Snapshot content that iOS based a tree action on. It changes when tree entries, labels, or display metadata change, but not for leaf-only active-branch movement after ordinary chat messages.
_Avoid_: Stale tree token, leaf version

**Branch Version**:
A monotonically changing identifier for the current active branch position. Remote tree navigation, fork, and clone use it with the Tree Snapshot Version so iOS cannot act on a branch position the user did not see.
_Avoid_: Snapshot version, leaf-only guard

**Remote Session Replacement**:
A remote-initiated action that replaces the owning live TUI session with a new session, such as fork or clone, while preserving remote-control continuity into the replacement session.
_Avoid_: Remote resume, automatic reactivation

**Remote Fork Draft**:
The selected user prompt text returned to iOS after a Remote Fork. It belongs to the iOS composer and is not prefilled into the replacement TUI editor.
_Avoid_: TUI fork prefill, auto-send fork prompt

**Forkable Entry**:
A user message Tree Entry that can be the target of Remote Fork. Non-user and custom-message entries are not forkable, even if Remote Tree Navigation can navigate to them.
_Avoid_: Any tree target, inferred fork target
