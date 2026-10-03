import { trace, type Tracer } from "@opentelemetry/api";
import { sensitive } from "./context";
import type { Reporter, ReviewRecord } from "./report";

export type TraceSettings = { enabled: boolean; captureContent: boolean };

export function traceSettings(options: Record<string, unknown>): TraceSettings {
  const enabled = options.tracing ?? false;
  const captureContent = options.traceContent ?? false;
  if (typeof enabled !== "boolean" || typeof captureContent !== "boolean") {
    throw new Error("OpenLane tracing and traceContent must be booleans");
  }
  return { enabled, captureContent };
}

// Use the process-wide OTel provider installed by the V2 telemetry plugin.
// Resolve it at emission time: OpenLane can load before that plugin. No exporter,
// network request, provider registration or service lifecycle is owned here.
export function tracingReporter(local: Reporter, settings: TraceSettings, mode: "shadow" | "auto", getTracer: () => Tracer = () => trace.getTracer("openlane", "0.1.0")): Reporter {
  return (record, detail) => {
    try { local(record); } catch { /* Independent diagnostic sinks. */ }
    if (!settings.enabled || !["review", "file_blocked", "shell_unreviewed", "file_unreviewed"].includes(record.event)) return;
    try {
      const attributes: Record<string, string | number> = {
        "openinference.span.kind": "CHAIN",
        "openlane.mode": record.reviewMode ?? mode,
        "openlane.tool": record.tool ?? "shell",
      };
      // Same fixed fields as local diagnostics; never copy arbitrary metadata,
      // evaluator bodies, environments, prompts, tool outputs or raw errors.
      for (const field of ["event", "review", "risk", "recommendation", "original", "effect", "reason", "tool", "operation", "outcome", "evidence"] as const) {
        const value = record[field];
        if (value !== undefined) attributes[`openlane.${field}`] = value;
      }
      if (detail?.sessionID) attributes["session.id"] = detail.sessionID;
      if (detail?.toolCallID) attributes["openlane.tool_call_id"] = detail.toolCallID;
      if (detail?.confidence !== undefined) attributes["openlane.confidence"] = detail.confidence;
      if (detail?.evaluatorMs !== undefined) attributes["openlane.evaluator_ms"] = detail.evaluatorMs;
      if (settings.captureContent) {
        for (const field of ["command", "changes"] as const) {
          const value = detail?.[field];
          // Reject rather than truncate: bounded, already-reviewed evidence only.
          if (value && value.length <= (field === "command" ? 8_000 : 24_000) && !sensitive(value)) {
            attributes[`openlane.${field}`] = value;
          }
        }
      }
      const span = getTracer().startSpan("openlane.review", {
        startTime: new Date(detail?.started ?? Date.now()), attributes,
      });
      span.end();
    } catch { /* Tracing must never change permissions or readiness. */ }
  };
}
