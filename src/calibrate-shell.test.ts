import { expect, test } from "bun:test";
import { runShellCalibration, shellCases, summarizeShellCalibration } from "./calibrate-shell";
import type { Assessment } from "./client";

const low: Assessment = { risk: "low", confidence: 1, probabilities: { low: 1, medium: 0, high: 0, critical: 0 } };
test("exploratory suite contains exactly 100 uniquely named cases with fixed expectations", () => {
  expect(shellCases).toHaveLength(100);
  expect(new Set(shellCases.map((s) => s.name)).size).toBe(100);
  expect(shellCases.filter((s) => s.expected === "allow")).toHaveLength(30);
  expect(shellCases.filter((s) => s.expected === "ask")).toHaveLength(70);
});
test("shell calibration submits authored command evidence only and repeats cases", async () => {
  const states: any[] = [];
  const client = { assess: async (state: unknown) => { states.push(state); return low; } };
  const results = await runShellCalibration(client, shellCases.slice(0, 2), 2);
  expect(states).toHaveLength(4);
  expect(states[0].command).toBe(shellCases[0].command);
  expect(states[0].original_user_requests).toHaveLength(1);
  expect(states[0].cwd).toStartWith("/tmp/opencode/");
  expect(results.map((r) => r.iteration)).toEqual([1, 1, 2, 2]);
  expect(summarizeShellCalibration(results)).toEqual({ total: 4, unsafeAllows: 0, routineAsks: 0, errors: 0 });
});
test("unsafe allowances are failures, not hidden by expected approval cases", async () => {
  const results = await runShellCalibration({ assess: async () => low }, shellCases, 1);
  const summary = summarizeShellCalibration(results);
  expect(summary.unsafeAllows).toBe(shellCases.filter((s) => s.expected === "ask").length);
  expect(summary.unsafeAllows).toBeGreaterThan(0);
});
test("evaluator failures stay unrated, raw errors are not recorded", async () => {
  const results = await runShellCalibration({ assess: async () => { throw new Error("dummy-private-detail"); } }, shellCases.slice(0, 1), 1);
  expect(results[0].assessment).toBeUndefined();
  expect(results[0].actual).toBeUndefined();
  expect(summarizeShellCalibration(results).errors).toBe(1);
  expect(JSON.stringify(results)).not.toContain("dummy-private-detail");
});
test("repeat limits prevent accidental unbounded endpoint calls", async () => {
  for (const repeats of [0, 11, 1.5, NaN]) {
    await expect(runShellCalibration({ assess: async () => low }, [], repeats)).rejects.toThrow("Repeats");
  }
});
