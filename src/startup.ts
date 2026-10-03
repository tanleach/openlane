import { randomUUID } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { watch } from "node:fs";
import { dirname, resolve } from "node:path";

export function confirmedStartup(text: string, wrappers = true) {
  const instances = new Map<string, Set<string>>();
  for (const line of text.split("\n")) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry.instance !== "string") continue;
    const events = instances.get(entry.instance) ?? new Set<string>();
    instances.set(entry.instance, events);
    events.add(entry.event === "file_wrapper_registered" ? `file:${entry.tool}` : entry.event);
  }
  return [...instances.values()].some((events) => !events.has("plugin_failed") && !events.has("plugin_stopped") &&
    (wrappers ? ["plugin_ready", "shell_wrapper_registered", "file:patch", "file:edit", "file:write"] : ["plugin_ready"]).every((event) => events.has(event)));
}

export async function waitForStartup(log: string, signal: AbortSignal, wrappers = true) {
  await mkdir(dirname(log), { recursive: true, mode: 0o700 });
  return new Promise<void>((resolve, reject) => {
    let checking = false;
    let again = false;
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      watcher.close();
      signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    const check = async () => {
      if (settled) return;
      if (checking) { again = true; return; }
      checking = true;
      try {
        do {
          again = false;
          const text = await readFile(log, "utf8").catch(() => "");
          if (text.includes('"event":"plugin_failed"')) { finish(new Error("Eikos plugin setup failed")); return; }
          if (confirmedStartup(text, wrappers)) { finish(); return; }
        } while (again);
      } finally { checking = false; }
    };
    const watcher = watch(dirname(log), () => { void check(); });
    watcher.on("error", finish);
    const abort = () => finish(new Error("Eikos plugin startup deadline or cancellation"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort(); else void check();
  });
}

// Start a PRIVATE native server first. No client/task is submitted until both
// setup and all required wrappers are observed for the same plugin instance.
export async function gatedLaunch(args: string[], env: Record<string, string | undefined>, log: string, notice: (text: string) => void = console.error, startupMs = 45_000) {
  const forwarded = args.slice(1).filter((arg) => arg !== "--standalone");
  const directory = forwarded[0] === "run" ? process.cwd() : forwarded.find((arg) => !arg.startsWith("-")) ?? process.cwd();
  const childEnv = { ...env, OPENCODE_PASSWORD: randomUUID() };
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), startupMs);
  const server = (() => {
    try {
      return Bun.spawn([args[0], "serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"], {
        env: childEnv, cwd: resolve(directory), stdin: "pipe", stdout: "pipe", stderr: "ignore",
      });
    } catch (error) { clearTimeout(deadline); throw error; }
  })();
  let client: ReturnType<typeof Bun.spawn> | undefined;
  const stop = () => { controller.abort(); client?.kill("SIGTERM"); server.kill("SIGTERM"); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const serverExited = server.exited.then(() => { controller.abort(); client?.kill("SIGTERM"); });
  let consume: Promise<void> | undefined;
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const abort = () => reject(new Error("Private server failed to start"));
      controller.signal.addEventListener("abort", abort, { once: true });
      if (controller.signal.aborted) abort();
      consume = (async () => {
        let pending = "";
        const decoder = new TextDecoder();
        for await (const chunk of server.stdout) {
          pending += decoder.decode(chunk, { stream: true });
          if (pending.length > 65_536) { abort(); return; }
          let newline;
          while ((newline = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            try {
              const data = JSON.parse(line);
              const url = new URL(data.url);
              if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) continue;
              controller.signal.removeEventListener("abort", abort);
              resolve(url.href);
            } catch {}
          }
        }
      })().catch(abort);
    });
    const endpoint = new URL("/api/plugin", url);
    endpoint.searchParams.set("location[directory]", resolve(directory));
    const response = await fetch(endpoint, {
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${childEnv.OPENCODE_PASSWORD}`).toString("base64")}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("Unable to initialize private work location");
    await response.arrayBuffer();
    await waitForStartup(log, controller.signal, false);
    endpoint.pathname = "/api/rpc/openlane/status";
    const status = await fetch(endpoint, {
      method: "POST", body: JSON.stringify({ input: {} }),
      headers: { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`opencode:${childEnv.OPENCODE_PASSWORD}`).toString("base64")}` },
      signal: controller.signal,
    });
    if (!status.ok || (await status.json() as { output?: unknown }).output !== true) throw new Error("Required native tools are unavailable");
    await waitForStartup(log, controller.signal);
    if (controller.signal.aborted) throw new Error("Private server stopped during startup");
    clearTimeout(deadline);
    notice("OpenLane plugin and shell/patch/edit/write wrappers confirmed.");
    const clientArgs = forwarded[0] === "run" ? ["run", "--server", url, ...forwarded.slice(1)] : ["--server", url, ...forwarded];
    client = Bun.spawn([args[0], ...clientArgs], { env: childEnv, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return await client.exited;
  } finally {
    clearTimeout(deadline);
    server.kill("SIGTERM");
    const force = setTimeout(() => server.kill("SIGKILL"), 5000);
    await serverExited;
    clearTimeout(force);
    await consume;
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}
