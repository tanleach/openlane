import { expect, test } from "bun:test";
import { confirmedStartup } from "./startup";

test("startup requires ready and all wrappers in one instance, and rejects failed/stopped instances", () => {
  const entries = ["plugin_ready", "shell_wrapper_registered", "patch", "edit", "write"].map((event) => ({
    instance: "one", event: ["patch", "edit", "write"].includes(event) ? "file_wrapper_registered" : event,
    tool: event,
  }));
  const text = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n");
  expect(confirmedStartup(text(entries))).toBe(true);
  expect(confirmedStartup(text(entries.slice(0, -1)))).toBe(false);
  expect(confirmedStartup(text(entries.map((entry, i) => ({ ...entry, instance: String(i) }))))).toBe(false);
  for (const event of ["plugin_failed", "plugin_stopped"]) expect(confirmedStartup(text([...entries, { instance: "one", event }]))).toBe(false);
  expect(confirmedStartup('{"event":"plugin_ready"')).toBe(false);
  expect(confirmedStartup("null\n[]\n5")).toBe(false);
});
