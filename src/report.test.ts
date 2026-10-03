import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createReporter, reviewLogPath, type ReviewRecord } from "./report";

test("redacted JSONL log is private, append-only and value/field allowlisted", () => {
  mkdirSync("/tmp/opencode", { recursive: true });
  const fixture = mkdtempSync("/tmp/opencode/eikos-report-test-");
  const env = { XDG_STATE_HOME: fixture };
  const id = randomUUID();
  const path = reviewLogPath(id, env);
  try {
    const report = createReporter("shadow", id, env);
    report({ event: "plugin_ready" });
    report({ event: "review", review: 1, risk: "low", recommendation: "allow", original: "ask", effect: "allow", evidence: "proposed_change", reviewMode: "auto", command: "fixture-secret", context: "fixture-secret", error: "fixture-secret" } as ReviewRecord);
    report({ event: "review", review: 2, risk: "fixture-secret", reason: "fixture-secret", effect: "fixture-secret" } as unknown as ReviewRecord);
    const text = readFileSync(path, "utf8");
    const records = text.trim().split("\n").map((line) => JSON.parse(line));
    expect(records).toHaveLength(3);
    expect(records[1]).toMatchObject({ mode: "auto", reviewMode: "auto", evidence: "proposed_change", event: "review", review: 1, risk: "low", recommendation: "allow", original: "ask", effect: "allow" });
    expect(text).not.toContain("fixture-secret");
    expect(Object.keys(records[2]).sort()).toEqual(["event", "instance", "mode", "review", "time"]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(() => reviewLogPath("../../elsewhere", env)).toThrow();
    expect(() => reviewLogPath(id, { XDG_STATE_HOME: "." })).toThrow();
  } finally {
    unlinkSync(path);
    rmdirSync(dirname(path));
    rmdirSync(dirname(dirname(path)));
    rmdirSync(fixture);
  }
});

test("unsafe log targets are not followed or written; diagnostic failures are contained", () => {
  mkdirSync("/tmp/opencode", { recursive: true });
  const fixture = mkdtempSync("/tmp/opencode/eikos-report-safety-test-");
  const env = { XDG_STATE_HOME: fixture };
  const id = randomUUID();
  const path = reviewLogPath(id, env);
  const target = join(fixture, "untouched");
  const original = console.error;
  const warnings: unknown[][] = [];
  console.error = (...args) => { warnings.push(args); };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(target, "fixture-secret", { mode: 0o600 });
    symlinkSync(target, path);
    const report = createReporter("shadow", id, env);
    expect(() => report({ event: "plugin_ready" })).not.toThrow();
    report({ event: "review", risk: "low" });
    expect(readFileSync(target, "utf8")).toBe("fixture-secret");
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).not.toContain(fixture);
    unlinkSync(path);
    writeFileSync(path, "existing", { mode: 0o600 });
    chmodSync(path, 0o644);
    createReporter("shadow", id, env)({ event: "plugin_ready" });
    expect(readFileSync(path, "utf8")).toBe("existing");
  } finally {
    console.error = original;
    unlinkSync(path);
    unlinkSync(target);
    rmdirSync(dirname(path));
    rmdirSync(dirname(dirname(path)));
    rmdirSync(fixture);
  }
});
