import { Plugin } from "@opencode/plugin";

import { EikosClient, settings } from "./client";
import { installReviewer } from "./runtime";
import { createReporter } from "./report";
import { installFileReviewer } from "./files";
import { traceSettings, tracingReporter } from "./tracing";

export default Plugin.define({
  id: "openlane",
  async setup(ctx) {
    const mode = ctx.options.mode ?? "shadow";
    if (mode !== "shadow" && mode !== "auto") throw new Error("Eikos mode must be shadow or auto");
    const fileMode = ctx.options.fileMode ?? mode;
    if (fileMode !== "shadow" && fileMode !== "auto") throw new Error("Eikos file mode must be shadow or auto");
    const client = new EikosClient(settings(ctx.options));
    const tracing = traceSettings(ctx.options);
    const report = tracingReporter(createReporter(mode, ctx.options.reviewLogID as string | undefined), tracing, mode);
    report({ event: "plugin_starting" });
    const cleanups: (() => Promise<void>)[] = [];
    try {
      // Install deterministic pre-execution guards before contacting Eikos.
      // The launch overlay also carries static edit denies if setup fails.
      cleanups.push(await installFileReviewer(ctx, client, report, fileMode));
      await client.ready();
      cleanups.push(await installReviewer(ctx, client, mode, report));
      const status = await ctx.rpc.register({
        id: "openlane", events: {},
        methods: { status: { input: { type: "object", additionalProperties: false }, output: { type: "boolean" } } },
      }, {
        // Tool transforms are lazy in V2. Listing forces construction without
        // executing a tool, submitting a task, or accessing any target file.
        status: async () => {
          const tools = await ctx.tool.list();
          return ["shell", "patch", "edit", "write"].every((id) => tools.some((tool) => tool.id === id));
        },
      });
      cleanups.push(() => status.dispose());
      report({ event: "plugin_ready" });
      return async () => {
        for (const cleanup of cleanups.reverse()) await cleanup();
        report({ event: "plugin_stopped" });
      };
    } catch (error) {
      for (const cleanup of cleanups.reverse()) await cleanup();
      report({ event: "plugin_failed" });
      throw error;
    }
  },
});
