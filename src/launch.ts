import { access, mkdir, mkdtemp, unlink, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { EikosClient, settings } from "./client";
import { reviewLogPath } from "./report";
import { gatedLaunch } from "./startup";
import { editPolicies } from "./policy";

export function launchOptions(argv: string[], env = process.env) {
  let profile = "personal";
  let mode = "shadow";
  let fileMode: string | undefined;
  let explicitMode = false;
  let args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") { args = argv.slice(i + 1); break; }
    if (arg === "--profile" && argv[i + 1]) { profile = argv[++i]; continue; }
    if (arg === "--mode" && argv[i + 1]) { mode = argv[++i]; explicitMode = true; continue; }
    if (arg === "--file-mode" && argv[i + 1]) { fileMode = argv[++i]; continue; }
    throw new Error("Use --profile personal|work --mode shadow|auto --file-mode shadow|auto -- [OpenCode arguments]");
  }
  if (profile !== "personal" && profile !== "work") throw new Error("Unknown OpenCode profile");
  if (mode !== "shadow" && mode !== "auto") throw new Error("Unknown Eikos mode");
  fileMode ??= explicitMode ? mode : "auto";
  if (fileMode !== "shadow" && fileMode !== "auto") throw new Error("Unknown Eikos file mode");
  // A connected server would not load this overlay. Native --auto can also
  // bypass human review, so don't combine it with the risk-review policy.
  if (args.some((arg) => /^--(?:server|standalone|auto)(?:=|$)/.test(arg))) {
    throw new Error("Eikos launcher does not accept --server, --standalone, or --auto");
  }
  // Keep startup confirmation bound to the directory the client will use.
  if (args.some((arg) => /^--(?:dir|directory|cwd|workspace)(?:=|$)/.test(arg) || arg === "-C")) throw new Error("Change directory before launching Eikos");
  if (args.some((arg) => /^--(?:continue|session|fork)(?:=|$)/.test(arg) || arg === "-c" || /^-s/.test(arg))) throw new Error("Resume sessions from the gated interactive client");
  if (args[0] !== "run" && args.length > 1) throw new Error("Use a single project directory, or run -- [prompt arguments]");
  if (args[0] !== "run" && args[0]?.startsWith("-")) throw new Error("Interactive Eikos accepts only a project directory");
  if (!env.HOME && !env.XDG_CONFIG_HOME) throw new Error("HOME or XDG_CONFIG_HOME is required");
  const configDir = join(env.XDG_CONFIG_HOME ?? join(env.HOME!, ".config"), "opencode-profiles", profile);
  const apiKeyEnv = env.OPENCODE_EIKOS_API_KEY_ENV;
  const options = {
    mode, fileMode, endpoint: env.OPENCODE_EIKOS_ENDPOINT ?? "http://127.0.0.1:1998/eikos/v1",
    reviewLogID: randomUUID(),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
  };
  // Validate before any side effects. The overlay contains no resolved key.
  const config = settings(options, env);
  return {
    configDir, config, reviewLog: reviewLogPath(options.reviewLogID, env),
    // Installed V2.0.21 accepts configured LOCAL PLUGIN DIRECTORIES, not .ts
    // files. Passing index.ts is skipped before setup (and before logging).
    overlay: {
      experimental: { policies: editPolicies },
      plugins: [{ package: fileURLToPath(new URL("../", import.meta.url)), options }],
    },
    args: args[0] === "run" ? ["run", "--standalone", ...args.slice(1)] : ["--standalone", ...args],
  };
}

type LaunchDependencies = {
  ready: (client: EikosClient) => Promise<void>;
  spawn?: (args: string[], env: Record<string, string | undefined>) => Promise<number>;
  notice?: (message: string) => void;
};

export async function launch(argv: string[], dependencies: LaunchDependencies = {
  ready: (client: EikosClient) => client.ready(),
  notice: (message: string) => console.error(message),
}) {
  const options = launchOptions(argv);
  await access(join(options.configDir, "opencode.json"));
  await access(join(options.configDir, "opencode.jsonc"));
  // Fail before launching OpenCode, even if its plugin loader isolates errors.
  await dependencies.ready(new EikosClient(options.config));
  await mkdir("/tmp/opencode", { recursive: true, mode: 0o700 });
  const directory = await mkdtemp("/tmp/opencode/eikos-launch-");
  const overlay = join(directory, "opencode.json");
  try {
    await writeFile(overlay, JSON.stringify(options.overlay), { mode: 0o600 });
    dependencies.notice?.(`OpenLane shell=${options.overlay.plugins[0].options.mode}, files=${options.overlay.plugins[0].options.fileMode}: preflight passed (plugin loading not yet confirmed).\nEligible file changes send proposed content/diffs to local Eikos; diagnostic logs omit contents.\nRedacted review log: ${options.reviewLog}\nLook for plugin_ready, then review entries; ordinary shell output does not contain ratings.`);
    const env = {
      ...process.env, OPENCODE_CONFIG: overlay, OPENCODE_CONFIG_DIR: options.configDir,
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    };
    return dependencies.spawn ? await dependencies.spawn(["opencode", ...options.args], env) :
      await gatedLaunch(["opencode", ...options.args], env, options.reviewLog, dependencies.notice);
  } finally {
    // Remove only the exact file/directory created here; never broad recursive cleanup.
    await unlink(overlay).catch(() => {});
    await rmdir(directory).catch(() => {});
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await launch(Bun.argv.slice(2));
  } catch {
    console.error("OpenLane startup failed: check profile installation, local endpoint, checkpoint and readiness. No unreviewed fallback was launched.");
    process.exitCode = 1;
  }
}
