// Explicit integration fixture only. Never registered by the production plugin.
import { Plugin } from "@opencode/plugin";
import { trace, type TracerProvider } from "@opentelemetry/api";

export default Plugin.define({
  id: "openlane.native-fixture",
  async setup(ctx) {
    if (!ctx.location.directory.startsWith("/tmp/opencode/eikos-native-")) throw new Error("Fixture requires isolated scratch location");
    // In-memory collector only; exercises the shared global API without sending
    // authored test content to a user's real Phoenix or installing another SDK.
    const spans: { attributes: Record<string, unknown>; ended: boolean }[] = [];
    if (!trace.setGlobalTracerProvider({ getTracer: () => ({ startSpan: (_name: string, options: any) => {
      const span = { attributes: options.attributes, ended: false };
      spans.push(span);
      return { end: () => { span.ended = true; } };
    } }) } as unknown as TracerProvider)) throw new Error("Scratch tracing provider unavailable");
    const registration = await ctx.rpc.register({
      id: "eikos-native-fixture", events: {},
      methods: {
        execute: { input: { type: "object" }, output: { type: "object" } },
        traces: { input: { type: "object" }, output: { type: "object" } },
      },
    }, {
      execute: async (request) => {
        const value = request as { tool: string; input: unknown; sessionID: string; messageID: string; id: string };
        if (!["patch", "edit", "write"].includes(value.tool)) throw new Error("Unsupported fixture tool");
        const tool = (await ctx.tool.list()).find((tool) => tool.id === value.tool)!;
        try {
          await tool.execute(value.input, {
            sessionID: value.sessionID as never, messageID: value.messageID as never, id: value.id as never,
            agent: "build" as never, signal: new AbortController().signal, progress: async () => {},
          });
          return { completed: true };
        } catch (error) {
          // This fixture uses only authored dummy text. Still return no contents.
          return { completed: false, guarded: String(error).includes("deterministic guard") };
        }
      },
      traces: async () => ({
        valid: spans.length > 0 && spans.every((s) => s.ended && s.attributes["session.id"] && s.attributes["openinference.span.kind"] === "CHAIN"),
        ratings: spans.filter((s) => s.attributes["openlane.risk"]).length,
        capturedContent: spans.some((s) => String(s.attributes["openlane.changes"] ?? "").includes("hello")),
        blocked: spans.some((s) => s.attributes["openlane.reason"] === "protected_path" && !s.attributes["openlane.changes"]),
      }),
    });
    return async () => { trace.disable(); await registration.dispose(); };
  },
});
