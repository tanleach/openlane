import type { Plugin } from "@opencode/plugin";
import { isAbsolute, relative, resolve } from "node:path";

import { EikosClient, riskEffect } from "./client";
import type { Reporter, ReviewRecord, TraceDetail } from "./report";
import { reviewContext, sensitive } from "./context";
import { readOnlyGit } from "./git-scope";
export { sensitive } from "./context";

type Invocation = {
  sessionID: string;
  messageID: string;
  id: string;
  agent: string;
  command: string;
  cwd: string;
  signal: AbortSignal;
  observed?: { command: string; cwd: string; shell: string; timeout: number };
  current?: () => Invocation["observed"];
  ambiguous?: boolean;
};
const key = (sessionID: string, messageID: string, id: string) => JSON.stringify([sessionID, messageID, id]);

function unchanged(invocation: Invocation) {
  try {
    return !!invocation.observed && !invocation.ambiguous && !invocation.signal.aborted &&
      JSON.stringify(invocation.current?.()) === JSON.stringify(invocation.observed);
  } catch {
    return false;
  }
}

// This detects common inline credentials, not arbitrary secrets. If detected,
// ask without sending either the command or user text to the reviewer.

export function localScope(command: string, cwd: string, directory: string, agent: string) {
  const path = relative(directory, cwd);
  if (path === ".." || path.startsWith("../") || isAbsolute(path)) return false;
  if (!new Set(["build", "engineer", "git", "scribe", "plan"]).has(agent)) return false;
  // Preserve role ownership; do not use a low score to hand Git/vault powers to another agent.
  if (/(?:^|[\s;&|/])git(?:\s|$)|\b(?:gh|glab|ghl)\b/.test(command) && agent !== "git") {
    if (!new Set(["build", "engineer"]).has(agent) || !readOnlyGit(command)) return false;
  }
  // Vault ownership is a role boundary, not a risk classification. Sensitive
  // directory mentions otherwise reach Eikos, including negative search globs.
  if (command.includes(".obsidian_vault") && agent !== "scribe") return false;
  // Plan is never granted new shell authority by the classifier. Its configured
  // rules/human approvals still apply, as do its existing read-only instructions.
  if (agent === "plan") return false;
  return true;
}

export async function installReviewer(ctx: Plugin.Context, client: EikosClient, mode: "shadow" | "auto", report: Reporter = () => {}) {
  const active = new Map<string, Invocation>();
  const calls = new Map<string, { review: number; permissions: number }>();
  let sequence = 0;
  const registrations: { dispose(): Promise<void> }[] = [];
  const emit: Reporter = (record, detail) => { try { report(record, detail); } catch { /* Diagnostics never affect execution. */ } };

  const contextFor = (sessionID: Parameters<typeof ctx.session.get>[0]["sessionID"]) => reviewContext(ctx, sessionID);

  try {
    // Wrap the actual executor, not execute.before: later input hooks have
    // already run. No new tool, shell process, or permission rules are added.
    registrations.push(await ctx.tool.transform((editor) => {
      editor.update("shell", (tool) => {
        const execute = tool.execute;
        emit({ event: "shell_wrapper_registered" });
        tool.execute = async (input, context) => {
          const id = key(context.sessionID, context.messageID, context.id);
          if (calls.has(id)) throw new Error("Duplicate shell review identity");
          const call = { review: ++sequence, permissions: 0 };
          const traceDetail: TraceDetail = { started: Date.now(), sessionID: context.sessionID, toolCallID: context.id };
          calls.set(id, call);
          emit({ event: "shell_started", review: call.review });
          try {
            const value = input as { command?: unknown; workdir?: unknown };
            if (typeof value?.command !== "string" || value.command.length > 8_000 || sensitive(value.command)) {
              // Missing capture causes manual approval in the permission hook.
              return await execute(input, context);
            }
            let session;
            try {
              session = await ctx.session.get({ sessionID: context.sessionID });
            } catch {
              return await execute(input, context);
            }
            const cwd = typeof value.workdir === "string" ? resolve(ctx.location.directory, value.workdir) : ctx.location.directory;
            const invocation: Invocation = { ...context, command: value.command, cwd };
            active.set(id, invocation);
            const cancel = () => active.delete(id);
            context.signal.addEventListener("abort", cancel, { once: true });
            if (session.location.workspaceID || context.signal.aborted) cancel();
            try {
              return await execute(input, context);
            } finally {
              active.delete(id);
              context.signal.removeEventListener("abort", cancel);
            }
          } finally {
            if (!call.permissions) emit({ event: "shell_unreviewed", review: call.review, reason: "no_permission_event" }, traceDetail);
            emit({ event: "shell_finished", review: call.review });
            calls.delete(id);
          }
        };
      });
    }));

    // V2's shell hook lacks session/tool IDs. Correlate only a unique exact
    // command + cwd. Rewrites or ambiguous concurrent calls must ask instead.
    registrations.push(await ctx.shell.hook("create.before", (event) => {
      const snapshot = () => ({
        command: event.command,
        cwd: resolve(ctx.location.directory, event.cwd),
        shell: event.shell,
        timeout: event.timeout,
      });
      const matches = [...active.values()].filter((i) => i.command === event.command && i.cwd === snapshot().cwd);
      if (matches.length !== 1 || matches[0].observed) {
        for (const i of matches) i.ambiguous = true;
        return;
      }
      matches[0].observed = snapshot();
      // In the inspected V2 runtime hooks share the mutable invocation object.
      // Retain only an accessor for non-secret fields to detect later rewrites.
      matches[0].current = snapshot;
    }));

    registrations.push(await ctx.permission.hook("evaluate", async (event) => {
      if (event.action !== "shell") return;
      const detail: TraceDetail = { started: Date.now(), sessionID: event.sessionID };
      const source = event.source;
      if (source?.type === "tool") detail.toolCallID = source.id;
      const id = source?.type === "tool" ? key(event.sessionID, source.messageID, source.id) : undefined;
      const call = id ? calls.get(id) : undefined;
      if (call) call.permissions++;
      if (event.effect === "deny") {
        emit({ event: "review", review: call?.review, original: "deny", effect: "deny", reason: "hard_deny" }, detail);
        return;
      }
      const invocation = id ? active.get(id) : undefined;
      const original = event.effect;
      const record: ReviewRecord = { event: "review", review: call?.review, original, reason: "capture_unavailable" };
      const fallback = () => {
        // Shadow never changes effects, including previously allowed commands.
        event.effect = mode === "shadow" ? original : "ask";
        event.message = "OpenLane: manual review required (context or evaluator unavailable)";
      };
      if (!invocation || !unchanged(invocation) || event.agent !== invocation.agent) {
        fallback();
        if (invocation && event.agent !== invocation.agent) record.reason = "role_mismatch";
        emit({ ...record, effect: event.effect }, detail);
        return;
      }
      // Establish the safe fallback before any await. Never serialize metadata,
      // environment values, raw errors, full transcripts, or command output.
      fallback();
      try {
        const permissionIdentity = JSON.stringify([event.action, event.resources, event.agent, event.source, event.sessionID]);
        record.reason = "context_unavailable";
        const context = await contextFor(event.sessionID);
        record.reason = "scope_ineligible";
        if (!localScope(invocation.command, invocation.cwd, context.directory, invocation.agent)) return;
        const state = {
          ...context, ...invocation.observed, agent: invocation.agent,
          session_id: event.sessionID, tool_call_id: source!.id,
          background: "Review effects regardless of foreground/background execution.",
        };
        record.reason = "evaluator_unavailable";
        detail.command = invocation.command;
        const evaluatorStart = performance.now();
        let assessment;
        try { assessment = await client.assess(state, invocation.signal); }
        finally { detail.evaluatorMs = performance.now() - evaluatorStart; }
        // A new user message or session move invalidates a pending assessment.
        record.reason = "stale_context";
        const current = await contextFor(event.sessionID);
        if (
          JSON.stringify(current) !== JSON.stringify(context) ||
          active.get(id!) !== invocation || !unchanged(invocation) ||
          JSON.stringify([event.action, event.resources, event.agent, event.source, event.sessionID]) !== permissionIdentity
        ) return;
        const effect = riskEffect(assessment.risk);
        // Never undo a deny introduced while inference was pending.
        if (event.effect !== "deny") event.effect = mode === "shadow" ? original : effect;
        event.message = `OpenLane${mode === "shadow" ? " shadow" : ""}: ${assessment.risk} risk → ${effect}`;
        record.risk = assessment.risk;
        detail.confidence = assessment.confidence;
        record.recommendation = effect;
        delete record.reason;
      } catch {
        // Existing fallback remains. Never include upstream errors with secrets.
      } finally {
        emit({ ...record, effect: event.effect }, detail);
      }
    }));
  } catch (error) {
    for (const registration of registrations.reverse()) await registration.dispose();
    throw error;
  }
  return async () => {
    active.clear();
    calls.clear();
    for (const registration of registrations.reverse()) await registration.dispose();
  };
}
