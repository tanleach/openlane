import { expect, test } from "bun:test";
import { summarize } from "./summary";

test("summary separates shell/file counters, labels metadata-only ratings, and never renders arbitrary fields", () => {
  const rows = [
    { event: "plugin_ready" },
    { event: "review", instance: "a", review: 1, risk: "low", effect: "ask" },
    { event: "review", instance: "a", review: 1, tool: "patch", operation: "delete", risk: "high", effect: "allow", evidence: "metadata_only" },
    { event: "file_finished", instance: "a", review: 1, tool: "patch", outcome: "completed" },
    { event: "file_blocked", instance: "a", review: 2, tool: "patch", reason: "protected_path", effect: "deny", path: "PRIVATE", outcome: "PRIVATE", risk: "PRIVATE", operation: "PRIVATE" },
    null,
  ];
  const result = summarize(rows.map((row) => JSON.stringify(row)).join("\n") + '\n{"partial":');
  expect(result).toContain("shell | — | low | ask");
  expect(result).toContain("patch | delete | high (metadata only) | allow | completed");
  expect(result).toContain("not rated: protected_path | deny");
  expect(result).not.toContain("PRIVATE");
});
