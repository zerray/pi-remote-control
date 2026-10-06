import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repository = fileURLToPath(new URL("..", import.meta.url));
let root: string;
let packageRoot: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-remote-runtime-"));
  packageRoot = join(root, "remote-control");
  await cp(join(repository, "src"), join(packageRoot, "src"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ type: "module" }));
  await mkdir(join(packageRoot, "node_modules"));
  // Match Pi-managed installs: ordinary dependencies exist, host-provided peers do not.
  for (const dependency of ["jiti", "ws", "qrcode-terminal"]) {
    await symlink(join(repository, "node_modules", dependency), join(packageRoot, "node_modules", dependency), "dir");
  }
  env = { ...process.env, PI_OFFLINE: "1" };
  delete env.PI_REMOTE_CONTROL_PI_ENTRY;
  delete env.NODE_PATH;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function runNode(args: string[]) {
  return execFileAsync(process.execPath, args, { cwd: packageRoot, env, timeout: 15_000 });
}

function runScript(script: string) {
  return runNode(["-e", `
    const assert = require("node:assert/strict");
    const { createJiti } = require("jiti");
    const jiti = createJiti(${JSON.stringify(join(packageRoot, "src/cli-runner.cjs"))});
    (async () => { ${script} })().catch(error => { console.error(error); process.exitCode = 1; });
  `]);
}

async function installPiFixture(installation: string) {
  const entry = join(installation, "bin", "pi.js");
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, 'throw new Error("The Pi CLI must not be executed");');
  const packages = [
    {
      name: "@earendil-works/pi-coding-agent",
      exports: { ".": { import: "./index.js" } },
      source: `
        import { writeFileSync } from "node:fs";
        writeFileSync(${JSON.stringify(join(root, "pi-loaded"))}, "loaded");
        export class ModelRuntime { static async create() { return {}; } }
        export class ModelRegistry {
          getAvailable() { return [{ provider: "fixture", id: "fixture-model" }]; }
          async getApiKeyAndHeaders() { return { ok: true, apiKey: "synthetic-key" }; }
        }
      `,
    },
    {
      name: "@earendil-works/pi-ai",
      exports: { "./compat": { import: "./index.js" } },
      source: `
        export async function completeSimple(model, context, options) {
          if (model.id !== "fixture-model" || options.apiKey !== "synthetic-key") throw new Error("Invalid call");
          return { content: [{ type: "text", text: "Fix login flow" }] };
        }
      `,
    },
  ];
  for (const fixture of packages) {
    const directory = join(installation, "node_modules", fixture.name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({
      name: fixture.name, version: "9.8.7-fixture", type: "module", exports: fixture.exports,
    }));
    await writeFile(join(directory, "index.js"), fixture.source);
  }
  return entry;
}

const nameRequest = {
  sessionId: "session-test",
  project: { id: "project-test", name: "Example", path: "/example" },
  sessionFile: "/example/session.jsonl",
  messages: [{ id: "message-test", role: "user", text: "Fix login", content: [], createdAt: "2026-05-09T00:00:00Z", isStreaming: false }],
};

describe("daemon CLI without locally installed Pi peers", () => {
  it.each(["missing", "host", "invalid"])("runs the shipped CLI and serves HTTP with %s Pi dependencies", async (installation) => {
    if (installation === "host") env.PI_REMOTE_CONTROL_PI_ENTRY = await installPiFixture(join(root, "host"));
    if (installation === "invalid") env.PI_REMOTE_CONTROL_PI_ENTRY = join(root, "removed-pi.js");
    const { stdout } = await runNode(["src/cli-runner.cjs", "--help"]);
    expect(stdout).toContain("Usage: pi-remote-control start|stop|status|pair");

    const child = spawn(process.execPath, ["src/cli-runner.cjs", "start", "--state-dir", join(root, "state"), "--bind", "127.0.0.1:0"], {
      cwd: packageRoot, env, stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(child, "close");
    let output = "";
    let errors = "";
    let timer: NodeJS.Timeout | undefined;
    child.stderr.on("data", (chunk) => { errors += chunk; });
    try {
      const baseUrl = await Promise.race([
        new Promise<string>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`Daemon startup timed out: ${output}\n${errors}`)), 10_000);
          child.stdout.on("data", (chunk) => {
            output += chunk;
            const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
            if (match) resolve(match[1]);
          });
        }),
        exited.then(() => { throw new Error(`Daemon exited before listening: ${errors}`); }),
      ]);
      const response = await fetch(`${baseUrl}/v1/health`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ status: "ok", piVersion: installation === "host" ? "9.8.7-fixture" : "unknown" });
      const { stdout: status } = await runNode(["src/cli-runner.cjs", "status", "--state-dir", join(root, "state")]);
      expect(status).toContain(`is running (pid ${child.pid})`);
    } finally {
      clearTimeout(timer);
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      await exited;
      clearTimeout(killTimer);
    }
  });

  it.each(["direct", "symlink"])("loads import-only Pi modules from the %s host entry point", async (entryKind) => {
    const entry = await installPiFixture(join(root, "host Pi's installation"));
    await installPiFixture(packageRoot);
    for (const name of ["pi-ai", "pi-coding-agent"]) {
      await writeFile(join(packageRoot, "node_modules", "@earendil-works", name, "index.js"), 'throw new Error("Stale local Pi must not be loaded");');
    }
    env.PI_REMOTE_CONTROL_PI_ENTRY = entry;
    if (entryKind === "symlink") {
      const link = join(root, "pi");
      await symlink(entry, link);
      env.PI_REMOTE_CONTROL_PI_ENTRY = link;
    }
    const { stdout } = await runScript(`
      const { readInstalledPiVersion } = jiti("./cli.ts");
      const { createLlmSessionNameGenerator } = jiti("./session-name-generator.ts");
      assert.equal(await readInstalledPiVersion(), "9.8.7-fixture");
      const generate = createLlmSessionNameGenerator();
      assert.equal(await generate({ ...${JSON.stringify(nameRequest)}, messages: [] }), null);
      assert.equal(require("node:fs").existsSync(${JSON.stringify(join(root, "pi-loaded"))}), false);
      assert.equal(await generate(${JSON.stringify(nameRequest)}), "Fix login flow");
      console.log("host naming works");
    `);
    expect(stdout).toContain("host naming works");
  });

  it("uses local peers for standalone CLI installations without a host entry point", async () => {
    await installPiFixture(packageRoot);
    const { stdout } = await runScript(`
      const { readInstalledPiVersion } = jiti("./cli.ts");
      const { createLlmSessionNameGenerator } = jiti("./session-name-generator.ts");
      assert.equal(await readInstalledPiVersion(), "9.8.7-fixture");
      assert.equal(await createLlmSessionNameGenerator()(${JSON.stringify(nameRequest)}), "Fix login flow");
      console.log("standalone naming works");
    `);
    expect(stdout).toContain("standalone naming works");
  });

  it("returns no generated name when Pi dependencies are unavailable", async () => {
    const { stdout } = await runScript(`
      const { createLlmSessionNameGenerator } = jiti("./session-name-generator.ts");
      const generate = createLlmSessionNameGenerator();
      assert.equal(await generate(${JSON.stringify(nameRequest)}), null);
      console.log("naming unavailable, process healthy");
    `);
    expect(stdout).toContain("naming unavailable, process healthy");
  });
});
