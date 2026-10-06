# Resolve optional daemon Pi modules from the host

## Title

Resolve optional daemon Pi modules from the host

## Status

Accepted

## Context

Pi-managed package installations no longer automatically install host-provided peer dependencies. Extensions receive Pi module mappings inside the TUI, but the independent daemon does not inherit those mappings. Eager imports for optional session naming therefore prevented every daemon CLI command from loading.

## Decision

Keep Pi packages as peer dependencies rather than bundling another Pi runtime into the extension package. The TUI supplies its entry-point path to the daemon child through `PI_REMOTE_CONTROL_PI_ENTRY`. The daemon resolves its optional Pi modules relative to that entry point, follows executable symlinks, and honors ESM import exports. An explicit host takes precedence over locally installed peers; standalone invocations without a host entry point resolve local peers.

Load Pi APIs only when an unnamed session has usable transcript text. Dependency, initialization, authentication, and completion failures leave the generated name unset and do not prevent the relay from starting or operating. Version reporting uses the same resolution boundary without evaluating Pi modules.

## Consequences

Managed installations work without physical Pi peer dependencies in the extension directory. The daemon remains a separate process and does not acquire live session ownership.

Standalone installations without resolvable Pi dependencies retain remote-control functionality but report an unknown Pi version and cannot generate session names. They can supply the host entry point explicitly. No credentials or module instances are passed from the TUI to the daemon.
