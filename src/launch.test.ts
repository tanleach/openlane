import { describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { launch, launchOptions } from "./launch";

describe("opt-in startup gate", () => {
  test("preserves profile and run argument ordering, adds overlay without changing live config", () => {
    const env = { HOME: "/fixture", OPENCODE_EIKOS_API_KEY_ENV: "FIXTURE_KEY", FIXTURE_KEY: "fixture-secret" };
    const options = launchOptions(["--profile", "work", "--mode", "auto", "--", "run", "inspect"], env);
    expect(options.configDir).toBe("/fixture/.config/opencode-profiles/work");
    expect(options.args).toEqual(["run", "--standalone", "inspect"]);
    expect(options.overlay.plugins[0].options.mode).toBe("auto");
    expect(JSON.stringify(options.overlay)).not.toContain("fixture-secret");
    expect(launchOptions([], env).overlay.plugins[0].options.mode).toBe("shadow");
    expect(launchOptions([], env).overlay.plugins[0].options.fileMode).toBe("auto");
    expect(launchOptions(["--mode", "shadow"], env).overlay.plugins[0].options.fileMode).toBe("shadow");
    expect(launchOptions(["--mode", "shadow", "--file-mode", "auto"], env).overlay.plugins[0].options.fileMode).toBe("auto");
    expect(options.reviewLog).toStartWith("/fixture/.local/state/dev_environment/eikos-risk/");
    expect(options.overlay.plugins[0].package).toBe(fileURLToPath(new URL("../", import.meta.url)));
    expect(statSync(options.overlay.plugins[0].package).isDirectory()).toBe(true);
    for (const args of [["--", "--auto"], ["--", "--server=http://elsewhere"], ["--profile", "bad"], ["--mode", "bad"], ["--unknown"], ["--", "run", "--session", "existing"], ["--", "run", "-c"], ["--", "run", "--directory", "/different"]]) {
      expect(() => launchOptions(args, env)).toThrow();
    }
  });

  test("readiness failure prevents spawning; success uses isolated overlay and cleans it", async () => {
    await mkdir("/tmp/opencode", { recursive: true });
    const fixture = await mkdtemp("/tmp/opencode/eikos-launch-test-");
    const profile = join(fixture, "opencode-profiles", "personal");
    await mkdir(profile, { recursive: true });
    const files = [join(profile, "opencode.json"), join(profile, "opencode.jsonc")];
    for (const file of files) await writeFile(file, "{}");
    const old = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = fixture;
    let spawned = 0;
    let overlay = "";
    const notices: string[] = [];
    try {
      await expect(launch([], {
        ready: async () => { throw new Error("offline"); },
        spawn: async () => { spawned++; return 0; },
      })).rejects.toThrow("offline");
      expect(spawned).toBe(0);
      const code = await launch([], {
        ready: async () => {},
        notice: (message) => { notices.push(message); },
        spawn: async (args, env) => {
          spawned++;
          overlay = env.OPENCODE_CONFIG!;
          const config = JSON.parse(await readFile(overlay, "utf8"));
          expect(config.plugins[0].package).toBe(fileURLToPath(new URL("../", import.meta.url)));
          expect(config.plugins[0].options.mode).toBe("shadow");
          expect(config.plugins[0].options.reviewLogID).toBeString();
          expect(args).toEqual(["opencode", "--standalone"]);
          expect(env.OPENCODE_CONFIG_DIR).toBe(profile);
          return 7;
        },
      });
      expect(code).toBe(7);
      expect(spawned).toBe(1);
      expect(notices[0]).toContain("plugin loading not yet confirmed");
      expect(notices[0]).toContain("Redacted review log:");
      await expect(access(overlay)).rejects.toThrow();
      for (const file of files) expect(await readFile(file, "utf8")).toBe("{}");
    } finally {
      if (old === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = old;
      for (const file of files) await unlink(file);
      await rmdir(profile);
      await rmdir(join(fixture, "opencode-profiles"));
      await rmdir(fixture);
    }
  });
});
