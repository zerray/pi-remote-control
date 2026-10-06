#!/usr/bin/env node
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createActiveSessionRegistry, type ActiveSessionNameGenerator } from "./active-session-registry.js";
import { defaultDaemonConfig, loadDaemonConfig, saveDaemonConfig } from "./config.js";
import { acquireDaemonLock, type DaemonLock } from "./lock.js";
import type { DaemonStore } from "./persistence/daemon-store.js";
import { ensureDaemonStateDir, getDaemonStateDir } from "./paths.js";
import { buildPairingLink } from "./pairing-link.js";
import { createPushSettlementNotifier } from "./push-gateway-client.js";
import { formatPairingDisplay } from "./qr.js";
import { startDaemonServer, type DaemonServer, type StartServerOptions } from "./server/http.js";
import { createLlmSessionNameGenerator } from "./session-name-generator.js";
import { resolvePiModule } from "./pi-module-resolution.js";
import type { DaemonConfig } from "./types.js";

export type CliDependencies = {
  getStateDir?: (options?: { env?: NodeJS.ProcessEnv }) => string;
  ensureStateDir?: (stateDir: string) => Promise<void>;
  loadConfig?: (stateDir: string) => Promise<DaemonConfig>;
  saveConfig?: (stateDir: string, config: DaemonConfig) => Promise<void>;
  startServer?: (options: StartServerOptions) => Promise<DaemonServer>;
  openStore?: (stateDir: string) => DaemonStore | Promise<DaemonStore>;
  acquireLock?: (stateDir: string) => Promise<DaemonLock | undefined>;
  waitForShutdown?: () => Promise<void>;
  readTextFile?: (path: string) => Promise<string>;
  removeFile?: (path: string) => Promise<void>;
  isProcessRunning?: (pid: number) => boolean;
  createSessionNameGenerator?: () => ActiveSessionNameGenerator;
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
  getPiVersion?: () => string | Promise<string>;
  writeLine?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
};

export async function main(argv = process.argv.slice(2), deps: CliDependencies = {}): Promise<number> {
  const command = argv[0];
  const env = deps.env ?? process.env;
  if (command === "status") return statusCommand(argv.slice(1), deps, env);
  if (command === "stop") return stopCommand(argv.slice(1), deps, env);
  if (command === "pair") return pairCommand(argv.slice(1), deps, env);
  if (command !== "start") {
    (deps.writeLine ?? console.log)("Usage: pi-remote-control start|stop|status|pair [options]");
    return command === "--help" || command === "-h" ? 0 : 1;
  }

  const parsed = parseStartArgs(argv.slice(1));
  const stateDir = parsed.stateDir ?? (deps.getStateDir ?? getDaemonStateDir)({ env });
  await (deps.ensureStateDir ?? ensureDaemonStateDir)(stateDir);

  const lock = await (deps.acquireLock ?? acquireDaemonLock)(stateDir);
  if (!lock) {
    (deps.writeLine ?? console.log)("pi-remote-control is already running");
    return 1;
  }

  const loadedConfig = await (deps.loadConfig ?? loadDaemonConfig)(stateDir).catch(async (error) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      const config = defaultDaemonConfig();
      await (deps.saveConfig ?? saveDaemonConfig)(stateDir, config);
      return config;
    }
    throw error;
  });
  await (deps.saveConfig ?? saveDaemonConfig)(stateDir, loadedConfig);
  const config = { ...loadedConfig, bindAddress: parsed.bindAddress ?? loadedConfig.bindAddress };
  const devToken = env.PI_REMOTE_CONTROL_DEV_TOKEN;
  const store = await (deps.openStore ?? openStore)(stateDir);
  const piVersion = await (deps.getPiVersion ?? readInstalledPiVersion)();
  const server = await (deps.startServer ?? startDaemonServer)({
    stateDir,
    config,
    piVersion,
    authenticateToken: devToken ? (token) => token === devToken || store.authenticateToken(token) : (token) => store.authenticateToken(token),
    resolveDeviceId: (token) => store.resolveDeviceId(token),
    pushRouteService: store,
    notifyAgentSettlement: createPushSettlementNotifier({
      gatewayBaseUrl: config.pushGatewayBaseUrl,
      listEnabledPushRoutes: () => store.listEnabledPushRoutes(),
    }),
    activeSessions: createActiveSessionRegistry({ isProcessRunning, nameGenerator: (deps.createSessionNameGenerator ?? createLlmSessionNameGenerator)() }),
    pairService: {
      createPairingCode: () => store.createPairingCode(new Date(), 5 * 60_000),
      claimPairingCode: async (request) => {
        const claimed = await store.claimPairingCode(request.pairCode, request.deviceName, new Date());
        if (!claimed) throw new Error("Invalid or expired pairing code");
        return claimed;
      },
    },
  });
  (deps.writeLine ?? console.log)(`pi-remote-control listening on http://${server.address}`);
  if (devToken) (deps.writeLine ?? console.log)("dev token authentication is enabled");

  await (deps.waitForShutdown ?? waitForInterrupt)();
  await server.close();
  store.close();
  await lock.release();
  return 0;
}

async function pairCommand(args: string[], deps: CliDependencies, env: NodeJS.ProcessEnv): Promise<number> {
  const writeLine = deps.writeLine ?? console.log;
  const stateDir = parseStateDirArg(args) ?? (deps.getStateDir ?? getDaemonStateDir)({ env });
  await (deps.ensureStateDir ?? ensureDaemonStateDir)(stateDir);
  const config = await (deps.loadConfig ?? loadDaemonConfig)(stateDir);
  const advertisedBaseUrl = parseAdvertisedBaseUrlArg(args) ?? env.PI_REMOTE_CONTROL_ADVERTISED_BASE_URL ?? config.advertisedBaseUrl ?? env.PI_REMOTE_CONTROL_URL;
  if (!advertisedBaseUrl) {
    writeLine("advertisedBaseUrl is required for QR pairing.");
    writeLine("Set ~/.pi/remote-control/config.json or PI_REMOTE_CONTROL_ADVERTISED_BASE_URL to an iOS-reachable URL.");
    writeLine("Example: https://macbook.tailnet.ts.net:17373");
    return 1;
  }

  const store = await (deps.openStore ?? openStore)(stateDir);
  try {
    const result = await store.createPairingCode(new Date(), 5 * 60_000);
    const pairingLink = buildPairingLink({
      advertisedBaseUrl,
      pairCode: result.pairCode,
      expiresAt: result.expiresAt,
    });
    for (const line of formatPairingDisplay({ expiresAt: result.expiresAt, pairingLink })) {
      writeLine(line);
    }
    return 0;
  } finally {
    store.close();
  }
}

async function stopCommand(args: string[], deps: CliDependencies, env: NodeJS.ProcessEnv): Promise<number> {
  const stateDir = parseStateDirArg(args) ?? (deps.getStateDir ?? getDaemonStateDir)({ env });
  const writeLine = deps.writeLine ?? console.log;
  const readTextFile = deps.readTextFile ?? ((path: string) => readFile(path, "utf8"));

  const lockFile = join(stateDir, "daemon.lock");
  try {
    const pid = Number.parseInt((await readTextFile(lockFile)).trim(), 10);
    try {
      (deps.sendSignal ?? process.kill)(pid, "SIGTERM");
      writeLine(`pi-remote-control stop requested (pid ${pid})`);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) throw error;
      writeLine(`pi-remote-control stale lock removed (pid ${pid})`);
    }
    await (deps.removeFile ?? ((path: string) => rm(path, { force: true })))(lockFile);
    return 0;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      writeLine("pi-remote-control is not running");
      return 1;
    }
    throw error;
  }
}

async function statusCommand(args: string[], deps: CliDependencies, env: NodeJS.ProcessEnv): Promise<number> {
  const stateDir = parseStateDirArg(args) ?? (deps.getStateDir ?? getDaemonStateDir)({ env });
  const writeLine = deps.writeLine ?? console.log;
  const readTextFile = deps.readTextFile ?? ((path: string) => readFile(path, "utf8"));

  const lockFile = join(stateDir, "daemon.lock");
  try {
    const pid = Number.parseInt((await readTextFile(lockFile)).trim(), 10);
    const running = (deps.isProcessRunning ?? isProcessRunning)(pid);
    if (running) {
      writeLine(`pi-remote-control is running (pid ${pid})`);
      return 0;
    }

    await (deps.removeFile ?? ((path: string) => rm(path, { force: true })))(lockFile);
    writeLine(`pi-remote-control is stopped (stale lock removed, pid ${pid})`);
    return 1;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      writeLine("pi-remote-control is stopped");
      return 1;
    }
    throw error;
  }
}

function parseAdvertisedBaseUrlArg(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--advertised-base-url") return args[index + 1];
  }
  return undefined;
}

async function openStore(stateDir: string): Promise<DaemonStore> {
  const { openDaemonStore } = await import("./persistence/daemon-store.js");
  return openDaemonStore(stateDir);
}

export async function readInstalledPiVersion(): Promise<string> {
  try {
    let directory = dirname(fileURLToPath(resolvePiModule("@earendil-works/pi-coding-agent")));
    while (true) {
      const packageJsonPath = join(directory, "package.json");
      try {
        const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { name?: unknown; version?: unknown };
        if (packageJson.name === "@earendil-works/pi-coding-agent" && typeof packageJson.version === "string") return packageJson.version;
      } catch (error) {
        if (!isNodeErrorCode(error, "ENOENT")) return "unknown";
      }
      const parent = dirname(directory);
      if (parent === directory) return "unknown";
      directory = parent;
    }
  } catch {
    return "unknown";
  }
}

function parseStateDirArg(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--state-dir") return args[index + 1];
  }
  return undefined;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function parseStartArgs(args: string[]): { stateDir?: string; bindAddress?: string } {
  const parsed: { stateDir?: string; bindAddress?: string } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--state-dir") parsed.stateDir = args[++index];
    else if (arg === "--bind") parsed.bindAddress = args[++index];
    else throw new Error(`Unknown start option: ${arg}`);
  }
  return parsed;
}

async function waitForInterrupt(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
