import { expect, test } from "bun:test";
import type { Tracer } from "@opentelemetry/api";
import { traceSettings, tracingReporter } from "./tracing";
import type { ReviewRecord } from "./report";

function harness(enabled = true, captureContent = true) {
  const local: ReviewRecord[] = [];
  const spans: any[] = [];
  const tracer = { startSpan: (name: string, options: unknown) => {
    const span = { name, options, ended: false };
    spans.push(span);
    return { end: () => { span.ended = true; } };
  } } as unknown as Tracer;
  const report = tracingReporter((r) => local.push(r), { enabled, captureContent }, "shadow", () => tracer);
  return { local, spans, report };
}

test("tracing defaults off and rejects invalid options", () => {
  expect(traceSettings({})).toEqual({ enabled: false, captureContent: false });
  expect(traceSettings({ tracing: true, traceContent: true })).toEqual({ enabled: true, captureContent: true });
  expect(() => traceSettings({ tracing: "true" })).toThrow();
  expect(() => traceSettings({ traceContent: 1 })).toThrow();
  const h = harness(false);
  h.report({ event: "review", risk: "low" });
  expect(h.local).toHaveLength(1);
  expect(h.spans).toHaveLength(0);
});

test("review spans preserve shadow recommendation versus actual effect, timing and session grouping", () => {
  const h = harness();
  const record: ReviewRecord = { event: "review", review: 1, risk: "high", original: "allow", effect: "allow", recommendation: "ask" };
  const started = Date.now() - 20;
  h.report(record, { started, sessionID: "dummy-session", toolCallID: "dummy-call", command: "printf fixture", confidence: 0.9, evaluatorMs: 12 });
  expect(h.spans).toHaveLength(1);
  expect(h.spans[0]).toMatchObject({ name: "openlane.review", ended: true });
  expect(h.spans[0].options.startTime.getTime()).toBe(started);
  expect(h.spans[0].options.attributes).toMatchObject({
    "openinference.span.kind": "CHAIN", "session.id": "dummy-session",
    "openlane.mode": "shadow", "openlane.tool": "shell", "openlane.tool_call_id": "dummy-call",
    "openlane.risk": "high", "openlane.recommendation": "ask", "openlane.effect": "allow",
    "openlane.command": "printf fixture", "openlane.confidence": 0.9, "openlane.evaluator_ms": 12,
  });
  expect(h.local).toEqual([record]);
  expect(JSON.stringify(h.local)).not.toContain("printf fixture");
});

test("file spans capture exact evidence only with opt-in, and do not invent ratings for fallbacks", () => {
  const changes = JSON.stringify({ proposed: { content: "dummy fixture" }, diffs: [{ diff: "+dummy fixture" }] });
  for (const capture of [false, true]) {
    const h = harness(true, capture);
    h.report({ event: "review", tool: "write", reviewMode: "auto", reason: "evaluator_unavailable", effect: "ask" }, { started: Date.now(), changes });
    const attrs = h.spans[0].options.attributes;
    expect(attrs["openlane.mode"]).toBe("auto");
    expect(attrs["openlane.reason"]).toBe("evaluator_unavailable");
    expect(attrs["openlane.risk"]).toBeUndefined();
    expect(attrs["openlane.changes"]).toBe(capture ? changes : undefined);
  }
});

test("detected credentials and oversized evidence are omitted; arbitrary detail fields never export", () => {
  const h = harness();
  for (const detail of [
    { command: "curl -H 'Authorization: Bearer dummy-credential'" },
    { command: "x".repeat(8_001) },
    { changes: JSON.stringify({ content: "password=dummy-credential" }) },
    { changes: "x".repeat(24_001) },
  ]) h.report({ event: "review" }, { started: Date.now(), ...detail, environment: "never-export", error: "never-export" } as any);
  for (const span of h.spans) {
    expect(span.options.attributes["openlane.command"]).toBeUndefined();
    expect(span.options.attributes["openlane.changes"]).toBeUndefined();
  }
  expect(JSON.stringify(h.spans)).not.toContain("never-export");
  expect(JSON.stringify(h.spans)).not.toContain("dummy-credential");
});

test("blocked and unreviewed actions emit metadata, lifecycle chatter does not", () => {
  const h = harness();
  h.report({ event: "plugin_ready" });
  h.report({ event: "shell_wrapper_registered" });
  h.report({ event: "file_blocked", tool: "patch", effect: "deny", reason: "protected_path" });
  h.report({ event: "shell_unreviewed", reason: "no_permission_event" });
  expect(h.spans).toHaveLength(2);
  expect(h.spans[0].options.attributes["openlane.effect"]).toBe("deny");
  expect(h.spans[1].options.attributes["openlane.risk"]).toBeUndefined();
});

test("tracing and local reporter failures are independent and contained", () => {
  const h = harness();
  expect(() => tracingReporter(() => { throw new Error("private error"); }, { enabled: true, captureContent: true }, "auto", () => {
    return { startSpan: () => { throw new Error("private error"); } } as unknown as Tracer;
  })({ event: "review", effect: "ask" })).not.toThrow();
  const report = tracingReporter(() => { throw new Error("private error"); }, { enabled: true, captureContent: false }, "shadow", () => ({
    startSpan: () => { h.spans.push("emitted"); return { end() {} }; },
  }) as unknown as Tracer);
  report({ event: "review" });
  expect(h.spans).toEqual(["emitted"]);
});
