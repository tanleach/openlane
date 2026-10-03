import { constants } from "node:fs";
import { open } from "node:fs/promises";

export function summarize(text: string) {
  const calls = new Map<string, { tool: string; operation: string; rating: string; effect: string; outcome: string }>();
  let ready = false;
  for (const line of text.split("\n")) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== "object") continue;
    if (row.event === "plugin_ready") ready = true;
    if (!Number.isSafeInteger(row.review) || row.review < 1 || typeof row.instance !== "string") continue;
    const tool = ["patch", "edit", "write", "other"].includes(row.tool) ? row.tool : "shell";
    const key = JSON.stringify([row.instance, tool, row.review]);
    const call = calls.get(key) ?? { tool, operation: "—", rating: "not reviewed", effect: "—", outcome: "pending" };
    calls.set(key, call);
    if (["create", "edit", "delete", "move", "overwrite", "batch"].includes(row.operation)) call.operation = row.operation;
    if (["low", "medium", "high", "critical"].includes(row.risk)) call.rating = `${row.risk}${row.evidence === "metadata_only" ? " (metadata only)" : ""}${row.reviewMode === "auto" ? " [auto]" : ""}`;
    if (["allow", "ask", "deny"].includes(row.effect)) call.effect = row.effect;
    if (["protected_path", "unsafe_path", "unsupported_input", "hard_deny", "capture_unavailable", "role_mismatch", "scope_ineligible", "context_unavailable", "evidence_unavailable", "evaluator_unavailable", "stale_context", "no_permission_event"].includes(row.reason)) call.rating = `not rated: ${row.reason}`;
    if (row.event === "file_finished" && ["completed", "error", "blocked"].includes(row.outcome)) call.outcome = row.outcome;
    if (row.event === "shell_finished") call.outcome = "finished (exit unknown)";
  }
  return [
    ready ? "Plugin startup recorded; [auto] identifies enforced file ratings." : "Plugin startup not confirmed.",
    "Tool | Operation | Rating / reason | Permission hook effect | Tool outcome",
    ...[...calls.values()].slice(-20).map((call) => [call.tool, call.operation, call.rating, call.effect, call.outcome].join(" | ")),
    ...(calls.size ? [] : ["No wrapped calls recorded."]),
  ].join("\n");
}

if (import.meta.main) {
  try {
    if (Bun.argv.length !== 3) throw new Error("Expected one log path");
    const file = await open(Bun.argv[2], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 8 * 1024 * 1024 || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error("Unsafe or oversized diagnostic file");
      console.log(summarize(await file.readFile("utf8")));
    } finally { await file.close(); }
  } catch {
    console.error("Usage: bun summary.ts <private Eikos JSONL log> (regular file, maximum 8 MiB)");
    process.exitCode = 1;
  }
}
