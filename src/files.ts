import type { Plugin } from "@opencode/plugin";
import type { EikosClient } from "./client";
import { riskEffect } from "./client";
import { reviewContext, sensitive } from "./context";
import { FileGuardError, fileActions, inProject, inspectActions, protectedPath, type FileTool } from "./file-actions";
import type { Reporter, ReviewRecord, TraceDetail } from "./report";
import { changeEvidence, EvidenceUnavailable } from "./evidence";

const identity = (session: string, message: string, call: string) => JSON.stringify([session, message, call]);
const tools = ["patch", "edit", "write"] as const;

export async function installFileReviewer(ctx: Plugin.Context, client: EikosClient, report: Reporter = () => {}, mode: "shadow" | "auto" = "shadow") {
  type Capture = {
    review: number; tool: FileTool; agent: string; input: unknown; directory: string; signal: AbortSignal;
    files: Awaited<ReturnType<typeof inspectActions>>; permissions: number;
  };
  const active = new Map<string, Capture>();
  let sequence = 0;
  const registrations: { dispose(): Promise<void> }[] = [];
  const emit: Reporter = (record, detail) => { try { report({ ...record, reviewMode: mode }, detail); } catch {} };
  try {
    registrations.push(await ctx.tool.transform((editor) => {
      for (const name of tools) editor.update(name, (tool) => {
        const execute = tool.execute;
        emit({ event: "file_wrapper_registered", tool: name });
        tool.execute = async (input, context) => {
          const id = identity(context.sessionID, context.messageID, context.id);
          const review = ++sequence;
          const traceDetail: TraceDetail = { started: Date.now(), sessionID: context.sessionID, toolCallID: context.id };
          let capture: Capture | undefined;
          let blocked = false;
          let completed = false;
          const record: ReviewRecord = { event: "file_started", tool: name, review };
          emit(record);
          try {
            if (active.has(id)) throw new FileGuardError("unsupported_input");
            // Detach from mutable tool inputs. Native schemas for these three tools
            // contain only scalar fields. Never retain or serialize output/diffs.
            const copy = Object.freeze(structuredClone(input));
            const actions = fileActions(name, copy);
            const session = await ctx.session.get({ sessionID: context.sessionID });
            if (session.location.workspaceID || session.location.directory !== ctx.location.directory || context.signal.aborted) throw new FileGuardError("unsafe_path");
            const files = await inspectActions(actions, ctx.location.directory);
            record.operation = files.length === 1 ? files[0].operation : "batch";
            capture = { review, tool: name, agent: context.agent, input: copy, directory: ctx.location.directory, signal: context.signal, files, permissions: 0 };
            active.set(id, capture);
            // Guard precedes native preparation, which may read contents before
            // asserting edit permission. Guard errors never disclose raw paths.
            if (context.signal.aborted) throw new FileGuardError("unsafe_path");
            const result = await execute(copy, context);
            completed = true;
            return result;
          } catch (error) {
            if (error instanceof FileGuardError) {
              blocked = true;
              emit({ ...record, event: "file_blocked", reason: error.reason, effect: "deny" }, traceDetail);
              throw new Error(`File action blocked by OpenLane deterministic guard (${error.reason}).`);
            }
            throw error;
          } finally {
            if (capture && !capture.permissions && !blocked) emit({ ...record, event: "file_unreviewed", reason: "no_permission_event" }, traceDetail);
            emit({ ...record, event: "file_finished", outcome: blocked ? "blocked" : completed ? "completed" : "error" });
            if (capture && active.get(id) === capture) active.delete(id);
          }
        };
      });
    }));
    registrations.push(await ctx.permission.hook("evaluate", async (event) => {
      if (event.action !== "edit") return;
      const detail: TraceDetail = { started: Date.now(), sessionID: event.sessionID };
      const source = event.source;
      if (source?.type === "tool") detail.toolCallID = source.id;
      const id = source?.type === "tool" ? identity(event.sessionID, source.messageID, source.id) : undefined;
      const capture = id ? active.get(id) : undefined;
      const original = event.effect;
      const record: ReviewRecord = {
        event: "review", tool: capture?.tool ?? "other", review: capture?.review,
        operation: capture ? capture.files.length === 1 ? capture.files[0].operation : "batch" : undefined,
        original, effect: original, reason: "capture_unavailable", reviewMode: mode,
      };
      if (capture) capture.permissions++;
      // Deterministic path protection, even for a custom tool that asserts edit.
      // Custom tools that never assert permission remain outside this boundary.
      if (event.resources.some((p) => protectedPath(p))) {
        event.effect = "deny";
        emit({ ...record, effect: "deny", reason: "protected_path" }, detail);
        return;
      }
      if (original === "deny") { emit({ ...record, reason: "hard_deny" }, detail); return; }
      // Establish manual fallback BEFORE awaiting context/evidence/evaluation.
      if (mode === "auto") event.effect = "ask";
      record.effect = event.effect;
      event.message = `OpenLane file${mode === "shadow" ? " shadow" : ""}: assessment unavailable; ${mode === "shadow" ? "permissions unchanged" : "manual approval required"}`;
      if (!capture) { emit(record, detail); return; }
      try {
        record.reason = "role_mismatch";
        if (event.agent !== capture.agent) return;
        record.reason = "scope_ineligible";
        if (!["build", "engineer"].includes(capture.agent)) return;
        if (capture.files.some((f) => [f.path, f.destination].some((p) => p && (!inProject(p, capture.directory) || /(?:^|\/)\.(?:git|obsidian_vault)(?:\/|$)/.test(p))))) return;
        record.reason = "capture_unavailable";
        const targets = new Set(capture.files.flatMap((f) => [f.path, ...(f.destination ? [f.destination] : [])]));
        const inspectedResources = await inspectActions(event.resources.map((path) => ({ path, operation: "edit", added: 0, removed: 0 })), capture.directory);
        if (inspectedResources.length !== targets.size || inspectedResources.some((f) => !targets.has(f.path))) return;
        record.reason = "context_unavailable";
        const context = await reviewContext(ctx, event.sessionID);
        if (context.directory !== capture.directory) return;
        const snapshot = () => inspectActions(fileActions(capture.tool, capture.input), capture.directory);
        record.reason = "stale_context";
        if (capture.signal.aborted || JSON.stringify(await snapshot()) !== JSON.stringify(capture.files)) return;
        record.reason = "evidence_unavailable";
        const evidence = changeEvidence(capture.tool, capture.input, capture.files, event.metadata, capture.directory);
        const permissionIdentity = JSON.stringify([event.resources, event.agent, event.source, event.sessionID]);
        const state = {
          ...context, agent: capture.agent, action: "file_change", tool: capture.tool,
          evidence: "proposed_change", changes: evidence,
          files: capture.files.map(({ fingerprint, destinationFingerprint, ...file }) => file),
        };
        record.reason = "context_unavailable";
        if (JSON.stringify(state).length > 36_000 || sensitive(JSON.stringify(state))) return;
        record.reason = "evaluator_unavailable";
        detail.changes = JSON.stringify(evidence);
        const evaluatorStart = performance.now();
        let assessment;
        try { assessment = await client.assess(state, capture.signal); }
        finally { detail.evaluatorMs = performance.now() - evaluatorStart; }
        record.reason = "stale_context";
        if (capture.signal.aborted || active.get(id!) !== capture || JSON.stringify(await snapshot()) !== JSON.stringify(capture.files) || JSON.stringify(await reviewContext(ctx, event.sessionID)) !== JSON.stringify(context) ||
          JSON.stringify(changeEvidence(capture.tool, capture.input, capture.files, event.metadata, capture.directory)) !== JSON.stringify(evidence) ||
          JSON.stringify([event.resources, event.agent, event.source, event.sessionID]) !== permissionIdentity) return;
        record.risk = assessment.risk;
        detail.confidence = assessment.confidence;
        record.recommendation = riskEffect(assessment.risk);
        record.evidence = "proposed_change";
        delete record.reason;
        // Never undo a deny introduced while inference was pending.
        if (event.effect !== "deny") event.effect = mode === "shadow" ? original : record.recommendation;
        event.message = `OpenLane file${mode === "shadow" ? " shadow" : ""}: ${assessment.risk} risk → ${record.recommendation}`;
      } catch (error) {
        if (error instanceof EvidenceUnavailable) record.reason = "evidence_unavailable";
        if (error instanceof FileGuardError) {
          // A target becoming sensitive/unsafe during preparation cannot proceed.
          event.effect = "deny";
          record.effect = "deny";
          record.reason = error.reason;
        }
      } finally { emit({ ...record, effect: event.effect }, detail); }
    }));
  } catch (error) {
    for (const registration of registrations.reverse()) await registration.dispose();
    throw error;
  }
  return async () => {
    active.clear();
    for (const registration of registrations.reverse()) await registration.dispose();
  };
}
