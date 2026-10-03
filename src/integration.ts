// Explicit installed-runtime check: bun run test:integration
// Only authored fixtures and reviewed work configuration enter scratch state.
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile, stat, access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { launchOptions } from "./launch";
import { waitForStartup, gatedLaunch } from "./startup";
import { CHECKPOINT } from "./client";

const root = await mkdtemp("/tmp/opencode/eikos-native-");
const project = join(root, "project");
const profile = join(root, "config/opencode-profiles/work");
await Promise.all([project, profile, join(root, "home"), join(root, "tmp")].map((p) => mkdir(p, { recursive: true, mode: 0o700 })));
const installed = join(process.env.HOME!, ".config/opencode-profiles/work");
for (const name of ["opencode.json", "opencode.jsonc"]) {
  const text = await readFile(join(installed, name), "utf8");
  if (/"apiKey"\s*:\s*"(?!\{env:)/.test(text)) throw new Error("Inline authentication refused");
  // Permanent work registration must not duplicate the launcher overlay or
  // contact the real evaluator/Phoenix from this owned scratch test.
  const config = JSON.parse(text);
  config.plugins = (config.plugins ?? []).filter((entry: string | { package: string }) => {
    const target = typeof entry === "string" ? entry : entry.package;
    return target !== fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "") &&
      !target.startsWith("@devtheops/opencode-plugin-otel");
  });
  await writeFile(join(profile, name), JSON.stringify(config), { mode: 0o600 });
}
await symlink(await realpath(join(installed, "tools")), join(profile, "tools"));
const model = `/cache/models--caiovicentino1--Eikos-27B-FP8/snapshots/${CHECKPOINT}`;
const assessments: unknown[] = [];
let offline = false;
let risk: "low" | "medium" | "high" | "critical" = "low";
// Deterministic model fixture: exercises the actual HTTP protocol without a GPU
// dependency. Native tools and native permissions are NOT mocked.
const evaluator = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (offline) return new Response("fixture offline", { status: 503 });
  if (new URL(request.url).pathname.endsWith("health")) return Response.json({ ok: true, model });
  const body = await request.json() as { state: string };
  assessments.push(JSON.parse(body.state));
  return Response.json({ model, answers: { risk: { type: "choice", choice: risk, probabilities: { low: Number(risk === "low"), medium: Number(risk === "medium"), high: Number(risk === "high"), critical: Number(risk === "critical") }, confidence: 1 } } });
} });
const env = {
  PATH: process.env.PATH!, HOME: join(root, "home"), TMPDIR: join(root, "tmp"),
  XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"),
  XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"),
  OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
  OPENCODE_EIKOS_ENDPOINT: `http://127.0.0.1:${evaluator.port}/v1`, OPENCODE_PASSWORD: randomUUID(),
};
const options = launchOptions(["--profile", "work"], env);
const overlay = join(root, "overlay.json");
await writeFile(overlay, JSON.stringify({ ...options.overlay, plugins: [
  ...options.overlay.plugins.map((entry) => ({ ...entry, options: { ...entry.options, tracing: true, traceContent: true } })),
  fileURLToPath(new URL("./fixtures/native/", import.meta.url)),
] }), { mode: 0o600 });
const server = Bun.spawn(["opencode", "serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"], {
  cwd: project, env: { ...env, OPENCODE_CONFIG: overlay, OPENCODE_CONFIG_DIR: profile }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
});
const errors = new Response(server.stderr).text();
const signal = AbortSignal.timeout(45_000);
const headers = { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`opencode:${env.OPENCODE_PASSWORD}`).toString("base64")}` };
let consume: Promise<void> | undefined;
try {
  const url = await new Promise<string>((resolve, reject) => {
    const abort = () => reject(new Error("Fixture server startup deadline"));
    signal.addEventListener("abort", abort, { once: true });
    consume = (async () => {
      let output = "";
      for await (const chunk of server.stdout) {
        output += new TextDecoder().decode(chunk);
        for (const line of output.split("\n")) {
          try { const data = JSON.parse(line); if (data.url) { signal.removeEventListener("abort", abort); resolve(data.url); } } catch {}
        }
      }
    })();
  });
  async function api(path: string, body?: unknown) {
    const target = new URL(path, url);
    target.searchParams.set("location[directory]", project);
    const response = await fetch(target, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
    if (!response.ok) throw new Error(`Fixture API ${path}: ${response.status}`);
    return response.status === 204 ? undefined : response.json() as Promise<any>;
  }
  await api("/api/plugin");
  await waitForStartup(options.reviewLog, signal, false);
  const status = await api("/api/rpc/openlane/status", { input: {} });
  if (status.output !== true) throw new Error("Native tools missing");
  await waitForStartup(options.reviewLog, signal);
  const cli = Bun.spawn(["opencode", "api", "--server", url, "GET", "/api/config"], {
    cwd: project, env, stdin: "ignore", stdout: "ignore", stderr: "pipe",
  });
  const cliError = new Response(cli.stderr).text();
  if (await cli.exited !== 0) throw new Error("Native CLI could not authenticate to private server");
  await cliError;
  const seed = await api("/api/session", { location: { directory: project }, agent: "build", permissions: [
    { action: "edit", resource: "*", effect: "ask" },
    { action: "edit", resource: "denied.txt", effect: "deny" },
  ] });
  const messageID = `msg_${randomUUID()}`;
  // Import ONLY an authored fixture transcript. A resume:false prompt remains
  // queued, so it cannot stand in for delivered original-user context.
  const session = await api("/api/experimental/session/import", {
    info: { ...seed.data, id: `ses_${randomUUID()}` }, location: { directory: project },
    messages: [{ id: messageID, type: "user", time: { created: Date.now() }, text: "Create, edit, move and delete only these disposable fixture files for the integration test.", files: [], agents: [], skills: [] }],
  });
  let n = 0;
  async function run(tool: string, input: unknown, expected: boolean) {
    const result = await api("/api/rpc/eikos-native-fixture/execute", { input: {
      tool, input, sessionID: session.data.id, messageID, id: `fixture${++n}`,
    } });
    if (result.output.completed !== expected) throw new Error(`Native ${tool} fixture ${n} unexpected outcome`);
  }
  async function manual(tool: string, input: unknown, decision: "once" | "always" | "reject", expected: boolean) {
    let settled = false;
    const pending = run(tool, input, expected);
    pending.then(() => { settled = true; }, () => { settled = true; });
    let permission;
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await api(`/api/session/${session.data.id}/permission`);
      permission = result.data[0];
      if (permission) break;
      if (settled) throw new Error("Action completed without required approval");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!permission) throw new Error("Expected native approval prompt");
    await api(`/api/session/${session.data.id}/permission/${permission.id}/reply`, { decision });
    await pending;
  }
  await run("write", { path: "demo.txt", content: "hello\n" }, true);
  risk = "medium";
  await run("edit", { path: "demo.txt", oldString: "hello", newString: "updated" }, true);
  risk = "low";
  await run("write", { path: "demo.txt", content: "updated\n" }, true);
  await run("patch", { patchText: "*** Begin Patch\n*** Update File: demo.txt\n*** Move to: dest.txt\n@@\n-updated\n+moved\n*** End Patch" }, true);
  if ((await readFile(join(project, "dest.txt"), "utf8")) !== "moved\n") throw new Error("Move/overwrite failed");
  await run("patch", { patchText: "*** Begin Patch\n*** Delete File: dest.txt\n*** Add File: created.txt\n+new\n*** End Patch" }, true);
  await run("write", { path: "denied.txt", content: "must not be written" }, false);
  if (await access(join(project, "denied.txt")).then(() => true, () => false)) throw new Error("Hard deny was bypassed");
  await writeFile(join(project, ".env"), "DUMMY_FIXTURE=not-a-secret\n", { mode: 0o600 });
  const before = await stat(join(project, ".env"));
  offline = true;
  await manual("write", { path: "outage.txt", content: "must require approval" }, "reject", false);
  await run("patch", { patchText: "*** Begin Patch\n*** Delete File: .env\n*** End Patch" }, false);
  await run("write", { path: ".env", content: "dummy replacement" }, false);
  await run("edit", { path: ".env", oldString: "DUMMY", newString: "OTHER" }, false);
  await run("patch", { patchText: "*** Begin Patch\n*** Update File: created.txt\n*** Move to: .env\n@@\n-new\n+changed\n*** End Patch" }, false);
  await run("patch", { patchText: "*** Begin Patch\n*** Add File: must-not-exist.txt\n+dummy\n*** Delete File: .env\n*** End Patch" }, false);
  if (await access(join(project, "must-not-exist.txt")).then(() => true, () => false)) throw new Error("Protected batch partially executed");
  offline = false;
  risk = "high";
  await manual("write", { path: "manual.txt", content: "harmless fixture for approval test" }, "always", true);
  if (!(await api("/api/permission/saved")).data.length) throw new Error("Fixture approval was not saved");
  risk = "critical";
  await manual("write", { path: "critical.txt", content: "harmless fixture rated critical by mock" }, "reject", false);
  risk = "low";
  // Saved approval must not bypass missing evidence or grant low-risk approval
  // to a blind patch overwrite whose native preview omits the old contents.
  await manual("patch", { patchText: "*** Begin Patch\n*** Add File: created.txt\n+replacement\n*** End Patch" }, "reject", false);
  if ((await stat(join(project, ".env"))).mtimeMs !== before.mtimeMs) throw new Error("Guarded fixture changed");
  await access(join(project, "created.txt"));
  const log = await readFile(options.reviewLog, "utf8");
  const records = log.trim().split("\n").map((line) => JSON.parse(line));
  const ratings = records.filter((r) => r.event === "review" && r.tool && r.risk);
  if (ratings.length !== 7) throw new Error(`Expected seven native ratings, got ${ratings.length}; reasons: ${records.filter((r) => r.reason).map((r) => r.reason).join(",")}`);
  if (!ratings.some((r) => r.original === "ask" && r.effect === "allow" && r.risk === "low") || !ratings.some((r) => r.risk === "medium" && r.effect === "allow")) throw new Error("Low/medium did not skip approvals");
  if (!ratings.some((r) => r.risk === "critical" && r.original === "allow" && r.effect === "ask")) throw new Error("Critical bypassed saved approval");
  if (records.filter((r) => r.event === "file_blocked").length !== 5) throw new Error("Missing guard outcomes");
  if (!records.some((r) => r.reason === "evaluator_unavailable" && r.effect === "ask")) throw new Error("Outage fallback not recorded");
  if (JSON.stringify(assessments).includes("DUMMY_FIXTURE") || log.includes(project) || log.includes("hello")) throw new Error("Fixture content leaked to evidence/log");
  const tracing = await api("/api/rpc/eikos-native-fixture/traces", { input: {} });
  if (!tracing.output.valid || tracing.output.ratings !== 7 || !tracing.output.capturedContent || !tracing.output.blocked) throw new Error("Native review tracing mismatch");
  const gated = launchOptions(["--profile", "work"], env);
  const gatedOverlay = join(root, "gated-overlay.json");
  await writeFile(gatedOverlay, JSON.stringify(gated.overlay), { mode: 0o600 });
  const cwd = process.cwd();
  const notices: string[] = [];
  try {
    process.chdir(project);
    const code = await gatedLaunch(["opencode", "run", "--standalone", "--help"], {
      ...env, XDG_DATA_HOME: join(root, "gated-data"), XDG_STATE_HOME: env.XDG_STATE_HOME,
      OPENCODE_CONFIG: gatedOverlay, OPENCODE_CONFIG_DIR: profile,
    }, gated.reviewLog, (text) => notices.push(text));
    if (code !== 0 || !notices.some((text) => text.includes("wrappers confirmed"))) throw new Error("Gated CLI launch failed");
    const missing = launchOptions(["--profile", "work"], env);
    const missingOverlay = join(root, "missing-overlay.json");
    await writeFile(missingOverlay, "{}", { mode: 0o600 });
    let rejected = false;
    try {
      await gatedLaunch(["opencode", "run", "--standalone", "--help"], {
        ...env, XDG_DATA_HOME: join(root, "missing-data"), OPENCODE_CONFIG: missingOverlay, OPENCODE_CONFIG_DIR: profile,
      }, missing.reviewLog, () => { throw new Error("Missing reviewer reached client launch"); }, 1500);
    } catch { rejected = true; }
    if (!rejected) throw new Error("Missing reviewer did not stop startup");
  } finally { process.chdir(cwd); }
  console.log(`PASS: native work-profile auto low/medium approvals, high/critical prompts, saved approvals, missing-evidence/outage fallback, hard deny, five guards, shared-provider review tracing and gated startup.\nFixture: ${root}`);
} finally {
  server.kill("SIGTERM");
  const force = setTimeout(() => server.kill("SIGKILL"), 5000);
  await server.exited;
  clearTimeout(force);
  await consume;
  await writeFile(join(root, "server.log"), await errors, { mode: 0o600 });
  evaluator.stop(true);
}
