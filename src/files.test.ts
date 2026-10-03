import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile, symlink, link, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import type { EikosClient, Risk } from "./client";
import { installFileReviewer } from "./files";
import { fileActions, inspectActions, inspectPath, protectedPath } from "./file-actions";
import type { Reporter, ReviewRecord } from "./report";
import { tracingReporter } from "./tracing";
import type { Tracer } from "@opentelemetry/api";
import { editPolicies } from "./policy";

const fixtures: string[] = [];
afterEach(async () => { for (const path of fixtures.splice(0)) await rm(path, { recursive: true }); });
async function fixture() {
  await mkdir("/tmp/opencode", { recursive: true });
  const path = await mkdtemp("/tmp/opencode/eikos-files-test-");
  fixtures.push(path);
  return path;
}
const patch = (...lines: string[]) => ({ patchText: ["*** Begin Patch", ...lines, "*** End Patch"].join("\n") });

async function harness(risk: Risk = "low", mode: "shadow" | "auto" = "shadow", reporter?: Reporter) {
  const directory = await fixture();
  const records: ReviewRecord[] = [];
  const states: any[] = [];
  const events: any[] = [];
  const messages = [{ type: "user", text: "Maintain the disposable fixture files in this project." }];
  let permission: (event: any) => Promise<void>;
  let executions = 0;
  let disposed = 0;
  let sequence = 0;
  const options = { effect: "allow", skip: false, source: true, agent: "build", resources: undefined as string[] | undefined, workspaceID: undefined as string | undefined, metadata: undefined as unknown };
  const client = { assess: async (state: unknown) => { states.push(state); return { risk }; } };
  const tools = Object.fromEntries(["patch", "edit", "write"].map((name) => [name, { execute: async (input: any, context: any) => {
    executions++;
    const files = await inspectActions(fileActions(name as any, input), directory);
    const event = {
      action: "edit", effect: options.effect, sessionID: context.sessionID, agent: options.agent,
      resources: options.resources ?? [...new Set(files.flatMap((f) => [f.path, ...(f.destination ? [f.destination] : [])]))],
      source: options.source ? { type: "tool", id: context.id, messageID: context.messageID } : undefined,
      metadata: options.metadata ?? { unrelated: "DO-NOT-SEND-METADATA", files: files.map((f) => ({
        file: f.destination ?? f.path, patch: "@@\n-old fixture\n+new fixture\n", status: f.operation === "delete" ? "deleted" : f.operation === "create" ? "added" : "modified",
      })) },
    };
    if (!options.skip) await permission(event);
    events.push(event);
    return { content: "DO-NOT-SEND-OUTPUT" };
  } }]));
  const ctx = {
    location: { directory },
    tool: { transform: async (fn: any) => { fn({ update: (name: string, update: any) => update(tools[name]) }); return { dispose: async () => { disposed++; } }; } },
    permission: { hook: async (_: string, fn: any) => { permission = fn; return { dispose: async () => { disposed++; } }; } },
    session: { get: async () => ({ location: { directory, workspaceID: options.workspaceID } }), context: async () => messages },
  };
  const cleanup = await installFileReviewer(ctx as unknown as Plugin.Context, client as unknown as EikosClient, reporter ?? ((r) => records.push(r)), mode);
  const run = (name: string, input: unknown, signal = new AbortController().signal) => tools[name].execute(input, { sessionID: "root", messageID: "message", id: String(++sequence), agent: "build", signal });
  return { directory, records, states, events, client, options, messages, run, cleanup, executions: () => executions, disposed: () => disposed, permission: () => permission };
}

describe("deterministic file guard", () => {
  test("sensitive delete/create/update/move are blocked before executor or inference, including mixed batches", async () => {
    const h = await harness();
    const inputs = [
      ["patch", patch("*** Delete File: .env")],
      ["patch", patch("*** Add File: okay.txt", "+hello", "*** Delete File: nested/.env.local")],
      ["patch", patch("*** Update File: okay.txt", "*** Move to: .env", "@@", "-old", "+new")],
      ["patch", patch("*** Update File: .env", "*** Move to: okay.txt", "@@", "-old", "+new")],
      ["write", { path: ".env", content: "dummy" }],
      ["edit", { path: join(h.directory, "config/../.env"), oldString: "a", newString: "b" }],
    ] as const;
    h.client.assess = async () => { throw new Error("offline"); };
    for (const [tool, input] of inputs) await expect(h.run(tool, input)).rejects.toThrow("protected_path");
    expect(h.executions()).toBe(0);
    expect(h.records.filter((r) => r.event === "file_blocked")).toHaveLength(6);
    expect(JSON.stringify(h.records)).not.toContain(".env");
  });

  test("symlink leaf/ancestor and hardlinks are rejected without opening files", async () => {
    const path = await fixture();
    await writeFile(join(path, "dummy"), "fixture");
    await symlink("dummy", join(path, "alias"));
    await symlink(path, join(path, "directory-link"));
    await expect(inspectPath("alias", path)).rejects.toThrow("unsafe_path");
    await expect(inspectPath("directory-link/new.txt", path)).rejects.toThrow("unsafe_path");
    await link(join(path, "dummy"), join(path, "hardlink"));
    await expect(inspectPath("hardlink", path)).rejects.toThrow("unsafe_path");
  });

  test("static shared edit denies cover sensitive read-deny examples independently of plugin", () => {
    const paths = [".env", "sub/.env.local", "credentials.json", "sub/secrets/key", ".ssh/id_rsa", ".aws/config", ".docker/config.json", "auth.json", "key.pem", ".codex/sessions/x", ".local/share/opencode/state", "/proc/1/environ"];
    const matches = (pattern: string, value: string) => new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(value);
    for (const path of paths.flatMap((p) => [p, `/fixture/${p}`])) {
      if (path.includes("/fixture//proc")) continue;
      expect(protectedPath(path)).toBe(true);
      expect(editPolicies.some((r) => r.effect === "deny" && r.resource.startsWith("edit:") && matches(r.resource.slice(5), path))).toBe(true);
    }
    expect(protectedPath("src/index.ts")).toBe(false);
  });

  test("unsupported syntax and remote workspace cannot enter local native executor", async () => {
    const h = await harness();
    await expect(h.run("patch", { patchText: "unrecognized format" })).rejects.toThrow("unsupported_input");
    h.options.workspaceID = "remote";
    await expect(h.run("write", { path: "new.txt", content: "x" })).rejects.toThrow("unsafe_path");
    expect(h.executions()).toBe(0);
  });
});

describe("file content review", () => {
  test("tracing sees validated proposed changes, not metadata/output or protected inputs", async () => {
    const spans: any[] = [];
    const reporter = tracingReporter(() => {}, { enabled: true, captureContent: true }, "shadow", () => ({
      startSpan: (_: string, options: any) => { spans.push(options); return { end() {} }; },
    }) as unknown as Tracer);
    const h = await harness("high", "shadow", reporter);
    await h.run("write", { path: "fixture.txt", content: "trace-file-fixture" });
    expect(spans[0].attributes).toMatchObject({ "openlane.risk": "high", "openlane.mode": "shadow", "openlane.effect": "allow", "session.id": "root" });
    expect(spans[0].attributes["openlane.changes"]).toContain("trace-file-fixture");
    expect(JSON.stringify(spans)).not.toContain("DO-NOT-SEND");
    spans.length = 0;
    await expect(h.run("write", { path: ".env", content: "password=dummy-fixture" })).rejects.toThrow("protected_path");
    expect(spans[0].attributes["openlane.reason"]).toBe("protected_path");
    expect(spans[0].attributes["openlane.changes"]).toBeUndefined();
    expect(JSON.stringify(spans)).not.toContain("dummy-fixture");
    await h.cleanup();
  });
  test("whole patches include exact proposed text and native diffs, but logs never contain them", async () => {
    const h = await harness("critical");
    await writeFile(join(h.directory, "old.txt"), "fixture");
    await h.run("patch", patch("*** Delete File: old.txt", "*** Update File: from.txt", "*** Move to: dest.txt", "@@", "-PRIVATE-OLD-CONTENT", "+PRIVATE-NEW-CONTENT", "*** Add File: new.txt", "+PRIVATE-ADDED-CONTENT"));
    expect(h.states).toHaveLength(1);
    expect(h.states[0].files.map((f: any) => f.operation)).toEqual(["delete", "move", "create"]);
    expect(h.states[0].files[1].destinationExisted).toBe(false);
    expect(JSON.stringify(h.states)).toContain("PRIVATE-ADDED-CONTENT");
    expect(JSON.stringify(h.states)).toContain("old fixture");
    expect(JSON.stringify(h.states)).not.toContain("DO-NOT-SEND");
    expect(h.events[0].effect).toBe("allow");
    expect(h.records.find((r) => r.event === "review")).toMatchObject({ risk: "critical", operation: "batch", recommendation: "ask", effect: "allow", evidence: "proposed_change", reviewMode: "shadow" });
    expect(JSON.stringify(h.records)).not.toContain(h.directory);
    expect(JSON.stringify(h.records)).not.toContain("PRIVATE");
  });

  test("create versus overwrite and all ratings preserve original allow/ask/deny", async () => {
    for (const risk of ["low", "medium", "high", "critical"] as const) {
      const h = await harness(risk);
      for (const effect of ["allow", "ask", "deny"]) {
        h.options.effect = effect;
        await h.run("write", { path: "new.txt", content: "hello" });
        expect(h.events.at(-1).effect).toBe(effect);
      }
      expect(h.states).toHaveLength(2);
      await writeFile(join(h.directory, "existing.txt"), "fixture");
      h.options.effect = "allow";
      await h.run("write", { path: "existing.txt", content: "hello" });
      expect(h.states.at(-1).files[0].operation).toBe("overwrite");
    }
  });

  test("stale files, user requests and cancellation invalidate ratings", async () => {
    for (const kind of ["file", "prompt", "cancel"]) {
      const h = await harness();
      const controller = new AbortController();
      h.client.assess = async () => {
        if (kind === "file") await writeFile(join(h.directory, "new.txt"), "changed");
        if (kind === "prompt") h.messages.push({ type: "user", text: "Stop now" });
        if (kind === "cancel") controller.abort();
        return { risk: "low" };
      };
      await h.run("write", { path: "new.txt", content: "hello" }, controller.signal);
      expect(h.records.find((r) => r.event === "review")).toMatchObject({ reason: "stale_context", effect: "allow" });
      expect(h.records.some((r) => r.risk)).toBe(false);
    }
  });

  test("source/resources/role mismatches, outage, and missing permission events are explicit", async () => {
    for (const kind of ["source", "resources", "role", "outage", "skip"]) {
      const h = await harness();
      if (kind === "source") h.options.source = false;
      if (kind === "resources") h.options.resources = ["different.txt"];
      if (kind === "role") h.options.agent = "plan";
      if (kind === "outage") h.client.assess = async () => { throw new Error("PRIVATE-UPSTREAM"); };
      if (kind === "skip") h.options.skip = true;
      await h.run("write", { path: "new.txt", content: "hello" });
      expect(h.records.some((r) => r.risk)).toBe(false);
      expect(h.records.some((r) => r.reason)).toBe(true);
      expect(JSON.stringify(h.records)).not.toContain("PRIVATE-UPSTREAM");
      expect(h.events[0].effect).toBe("allow");
      await h.cleanup();
      expect(h.disposed()).toBe(2);
    }
  });

  test("credential-like filenames and excessive target context are not sent upstream", async () => {
    const h = await harness();
    await h.run("write", { path: "token=PRIVATE_MARKER", content: "fixture" });
    expect(h.states).toHaveLength(0);
    expect(h.records.find((r) => r.event === "review")?.reason).toBe("evidence_unavailable");
    expect(JSON.stringify(h.records)).not.toContain("PRIVATE_MARKER");
  });

  test("concurrent calls and later permission events cannot reuse another file capture", async () => {
    const h = await harness();
    await Promise.all([h.run("write", { path: "one.txt", content: "one" }), h.run("edit", { path: "two.txt", oldString: "a", newString: "b" })]);
    expect(h.states).toHaveLength(2);
    expect(new Set(h.records.filter((r) => r.risk).map((r) => r.review)).size).toBe(2);
    await h.permission()(h.events[0]);
    expect(h.records.at(-1)?.reason).toBe("capture_unavailable");
    expect(h.states).toHaveLength(2);
  });

  test("auto removes asks for low/medium, escalates high/critical even from allows, preserves denies", async () => {
    for (const risk of ["low", "medium", "high", "critical"] as const) {
      const h = await harness(risk, "auto");
      for (const original of ["allow", "ask", "deny"]) {
        h.options.effect = original;
        await h.run("write", { path: "new.txt", content: "hello" });
        expect(h.events.at(-1).effect).toBe(original === "deny" ? "deny" : risk === "low" || risk === "medium" ? "allow" : "ask");
      }
      expect(h.states).toHaveLength(2);
    }
  });

  test("auto asks without rating for missing, unsafe, oversized or incomplete evidence", async () => {
    for (const kind of ["missing", "credential", "oversized", "binary", "destination", "patch-overwrite", "offline"]) {
      const h = await harness("low", "auto");
      if (kind === "missing") h.options.metadata = {};
      if (kind === "binary") h.options.metadata = { files: [{ file: "new.txt", status: "added", patch: "+\u0000binary" }] };
      if (kind === "offline") h.client.assess = async () => { throw new Error("offline"); };
      if (kind === "destination" || kind === "patch-overwrite") await writeFile(join(h.directory, "dest.txt"), "existing");
      const input = kind === "destination" ? patch("*** Update File: src.txt", "*** Move to: dest.txt", "@@", "-old", "+new") :
        kind === "patch-overwrite" ? patch("*** Add File: dest.txt", "+new") :
        { path: "new.txt", content: kind === "credential" ? "TOKEN=dummy-fixture-value" : kind === "oversized" ? "a".repeat(25_000) : "hello" };
      await h.run(kind === "destination" || kind === "patch-overwrite" ? "patch" : "write", input);
      expect(h.events[0].effect).toBe("ask");
      expect(h.records.some((r) => r.risk)).toBe(false);
      expect(h.states).toHaveLength(0);
    }
  });

  test("native diff changes during inference invalidate auto approval", async () => {
    const h = await harness("low", "auto");
    const metadata = { files: [{ file: "new.txt", status: "added", patch: "+hello" }] };
    h.options.metadata = metadata;
    h.client.assess = async () => { metadata.files[0].patch = "+different"; return { risk: "low" }; };
    await h.run("write", { path: "new.txt", content: "hello" });
    expect(h.events[0].effect).toBe("ask");
    expect(h.records.at(-2)?.reason).toBe("stale_context");
  });
});
