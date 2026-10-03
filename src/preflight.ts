import { EikosClient, settings } from "./client";

// Run this before OpenCode, not from a model/tool. It starts no services and
// executes no shell command; the readiness command is only decision evidence.
try {
  await new EikosClient(settings({
    ...(process.env.OPENCODE_EIKOS_API_KEY_ENV ? { apiKeyEnv: process.env.OPENCODE_EIKOS_API_KEY_ENV } : {}),
  })).ready();
  console.log("Eikos ready: pinned checkpoint and typed-decision inference verified");
} catch {
  console.error("Eikos is unavailable or failed validation; OpenCode startup must stop.");
  process.exitCode = 1;
}
