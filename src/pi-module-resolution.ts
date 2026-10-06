import { realpathSync } from "node:fs";
import { createJiti } from "jiti";

type PiModule = "@earendil-works/pi-coding-agent" | "@earendil-works/pi-ai/compat";

export function resolvePiModule(specifier: PiModule): string {
  const hostEntry = process.env.PI_REMOTE_CONTROL_PI_ENTRY;
  const base = hostEntry ? realpathSync(hostEntry) : import.meta.url;
  return createJiti(base).esmResolve(specifier);
}
