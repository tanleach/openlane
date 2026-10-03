// Portable defaults, without workstation providers or agent configuration.
// OpenCode wildcard * spans slashes.
const roots = [
  "credentials*", "secrets", "secrets.*", "secrets/*",
  ".ssh", ".ssh/*", ".gnupg", ".gnupg/*", ".aws", ".aws/*",
  ".azure", ".azure/*", ".kube", ".kube/*", ".netrc", ".npmrc",
  ".git-credentials", ".docker/config.json", ".config/gh/hosts.yml",
  ".config/glab-cli/config.yml", "application_default_credentials.json",
  "auth.json", "mcp-auth.json", "token", "token.json", "tokens.json", ".token",
  ".local/share/opencode", ".local/share/opencode/*",
  ".local/state/opencode", ".local/state/opencode/*",
  ".codex/sessions", ".codex/sessions/*", ".codex/archived_sessions",
  ".codex/archived_sessions/*", ".codex/log", ".codex/log/*",
  ".codex/.codex-global-state.json", ".codex/history.jsonl",
  ".codex/session_index.jsonl", ".codex/*.sqlite*",
];
export const protectedPatterns = [
  ...roots.flatMap((path) => [path, `*/${path}`]),
  "*.env", "*.env.*", "*.token", "*.key", "*.pem", "*.p12", "*.pfx",
  "*/opencode/*.db*", "*/opencode/*.sqlite*", "/etc/shadow*", "/etc/gshadow*",
  "/proc/*/environ", "/proc/*/cmdline", "/proc/*/mem", "/proc/*/fd/*",
];
export const editPolicies = protectedPatterns.map((pattern) => ({ action: "permission", resource: `edit:${pattern}`, effect: "deny" }));
export const readPolicy = [
  ...protectedPatterns.map((pattern) => ({ pattern, effect: "deny" })),
  ...[".local/share/opencode/tool-output/*", ".local/share/opencode/shell-output/*",
    "*/.local/share/opencode/tool-output/*", "*/.local/share/opencode/shell-output/*"].map((pattern) => ({ pattern, effect: "allow" })),
];
