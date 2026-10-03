import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const events = ["plugin_starting", "plugin_ready", "plugin_failed", "plugin_stopped", "shell_wrapper_registered", "shell_started", "shell_finished", "shell_unreviewed", "file_wrapper_registered", "file_started", "file_finished", "file_unreviewed", "file_blocked", "review"] as const;
const reasons = ["no_permission_event", "hard_deny", "capture_unavailable", "role_mismatch", "scope_ineligible", "context_unavailable", "evidence_unavailable", "evaluator_unavailable", "stale_context", "protected_path", "unsafe_path", "unsupported_input"] as const;
const tools = ["shell", "patch", "edit", "write", "other"] as const;
const operations = ["create", "edit", "delete", "move", "overwrite", "batch", "read"] as const;
const outcomes = ["completed", "error", "blocked"] as const;
const effects = ["allow", "ask", "deny"] as const;
const risks = ["low", "medium", "high", "critical"] as const;

export type ReviewRecord = {
  event: typeof events[number];
  review?: number;
  risk?: typeof risks[number];
  recommendation?: typeof effects[number];
  original?: typeof effects[number];
  effect?: typeof effects[number];
  reason?: typeof reasons[number];
  tool?: typeof tools[number];
  operation?: typeof operations[number];
  outcome?: typeof outcomes[number];
  evidence?: "metadata_only" | "proposed_change";
  reviewMode?: "shadow" | "auto";
};
export type TraceDetail = {
  started: number;
  sessionID?: string;
  toolCallID?: string;
  command?: string;
  changes?: string;
  confidence?: number;
  evaluatorMs?: number;
};
export type Reporter = (record: ReviewRecord, detail?: TraceDetail) => void;

export function reviewLogPath(id: string, env = process.env) {
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("Invalid Eikos review log identity");
  }
  if (!env.XDG_STATE_HOME && !env.HOME) throw new Error("HOME or XDG_STATE_HOME is required");
  const state = env.XDG_STATE_HOME ?? join(env.HOME!, ".local", "state");
  if (!isAbsolute(state)) throw new Error("Eikos diagnostic state directory must be absolute");
  return join(state, "dev_environment", "eikos-risk", `${id}.jsonl`);
}

export function createReporter(mode: "shadow" | "auto", id: string = randomUUID(), env = process.env): Reporter {
  const path = reviewLogPath(id, env);
  const instance = randomUUID();
  let warned = false;
  return (record) => {
    let fd: number | undefined;
    try {
      // Explicitly allowlist fields AND values: never serialize caller objects,
      // session IDs, commands, prompts, paths, upstream errors or tool output.
      if (!events.includes(record.event)) throw new Error("Invalid diagnostic event");
      const effectiveMode = record.reviewMode === "shadow" || record.reviewMode === "auto" ? record.reviewMode : mode;
      const entry: Record<string, unknown> = { time: new Date().toISOString(), instance, mode: effectiveMode, event: record.event };
      if (Number.isSafeInteger(record.review) && record.review! > 0) entry.review = record.review;
      if (risks.includes(record.risk!)) entry.risk = record.risk;
      if (reasons.includes(record.reason!)) entry.reason = record.reason;
      if (tools.includes(record.tool!)) entry.tool = record.tool;
      if (operations.includes(record.operation!)) entry.operation = record.operation;
      if (outcomes.includes(record.outcome!)) entry.outcome = record.outcome;
      if (record.evidence === "metadata_only" || record.evidence === "proposed_change") entry.evidence = record.evidence;
      if (record.reviewMode === "shadow" || record.reviewMode === "auto") entry.reviewMode = record.reviewMode;
      for (const field of ["original", "recommendation", "effect"] as const) {
        if (effects.includes(record[field]!)) entry[field] = record[field];
      }
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
        throw new Error("Unsafe diagnostic file");
      }
      writeSync(fd, `${JSON.stringify(entry)}\n`);
    } catch {
      // Logging is diagnostic only: never change a permission or leak raw errors.
      if (!warned) console.error("OpenLane: redacted review log unavailable; ratings may not be observable.");
      warned = true;
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* No raw diagnostic errors. */ } }
    }
  };
}
