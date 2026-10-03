import { expect, test } from "bun:test";
import { launchOptions } from "./launch";
import { protectedPath } from "./file-actions";
import { editPolicies } from "./policy";

test("portable path protection and overlay do not rely on workstation config", () => {
  const options = launchOptions(["--profile", "work"], { HOME: "/fixture" });
  expect(options.overlay.experimental.policies).toEqual(editPolicies);
  for (const path of [".env", "nested/.env.local", "credentials.json", ".ssh/id_rsa", ".codex/sessions/one", "/proc/1/environ"]) {
    expect(protectedPath(path)).toBe(true);
  }
  expect(protectedPath("src/index.ts")).toBe(false);
  expect(protectedPath("/home/user/.local/share/opencode/tool-output/one")).toBe(false);
  expect(editPolicies.every((rule) => rule.effect === "deny" && rule.resource.startsWith("edit:"))).toBe(true);
});
