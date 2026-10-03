import { expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rmdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import plugin from "./index";
import { CHECKPOINT } from "./client";
import { reviewLogPath } from "./report";

test("actual plugin entrypoint rejects invalid options before making a request", async () => {
  expect(plugin.id).toBe("openlane");
  await expect(plugin.setup({ options: { mode: "invalid" } } as unknown as Plugin.Context)).rejects.toThrow("mode");
  await expect(plugin.setup({ options: { endpoint: "https://remote.example/v1" } } as unknown as Plugin.Context)).rejects.toThrow("loopback");
});

test("setup installs guards before readiness; failure and cleanup dispose registrations", async () => {
  await mkdir("/tmp/opencode", { recursive: true });
  const fixture = await mkdtemp("/tmp/opencode/eikos-plugin-log-test-");
  const oldState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = fixture;
  const reviewLogID = randomUUID();
  const log = reviewLogPath(reviewLogID);
  const model = `/cache/models--caiovicentino1--Eikos-27B-FP8/snapshots/${CHECKPOINT}`;
  const order: string[] = [];
  let disposed = 0;
  const registration = { dispose: async () => { disposed++; } };
  const ctx = {
    options: { reviewLogID }, location: { directory: "/project" },
    tool: { transform: async (callback: any) => {
      order.push("tool"); callback({ update: () => {} }); return registration;
    } },
    shell: { hook: async () => { order.push("shell"); return registration; } },
    permission: { hook: async () => { order.push("permission"); return registration; } },
    rpc: { register: async () => { order.push("rpc"); return registration; } },
  };
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async (url) => {
      if (String(url).endsWith("health")) { order.push("health"); return Response.json({ ok: true, model }); }
      order.push("inference");
      return Response.json({ model, answers: { risk: {
        type: "choice", choice: "low", probabilities: { low: 1, medium: 0, high: 0, critical: 0 }, confidence: 1,
      } } });
    }) as typeof fetch;
    const cleanup = await plugin.setup(ctx as unknown as Plugin.Context);
    expect(order).toEqual(["tool", "permission", "health", "inference", "tool", "shell", "permission", "rpc"]);
    if (cleanup) await cleanup();
    expect(disposed).toBe(6);
    order.length = 0;
    globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
    await expect(plugin.setup(ctx as unknown as Plugin.Context)).rejects.toThrow("offline");
    expect(order).toEqual(["tool", "permission"]);
    expect(disposed).toBe(8);
    const records = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(records.map((r) => r.event)).toEqual(["plugin_starting", "plugin_ready", "plugin_stopped", "plugin_starting", "plugin_failed"]);
    expect(await readFile(log, "utf8")).not.toContain("offline");
  } finally {
    globalThis.fetch = original;
    if (oldState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = oldState;
    await unlink(log).catch(() => {});
    await rmdir(dirname(log)).catch(() => {});
    await rmdir(dirname(dirname(log))).catch(() => {});
    await rmdir(fixture);
  }
});
