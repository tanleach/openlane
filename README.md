# openlane
Fewer prompts. Deliberate permissions.

OpenLane is an opt-in OpenCode V2 action-risk plugin. Routine work proceeds;
consequential actions get your attention. The current evaluator backend is local
Eikos through its typed-decision API, not a chat-completions endpoint.

## Setup

Prerequisites:

- Bun and OpenCode V2.0.21 (tested runtime); SDK dependencies are pinned to 2.0.20.
- An already-running Eikos model (or compatible evaluator) behind LiteLLM,
  exposed through the Eikos typed-decision pass-through route at `/eikos/v1`.
  A normal LiteLLM chat-completions model alias is not sufficient.
- A loopback connection to LiteLLM, directly or through the SSH tunnel below.

Compatibility currently requires `/health` and `/systemone`, the expected typed
risk response, and the pinned Eikos checkpoint identity validated in
`src/client.ts`. Other model checkpoints are not currently supported without
reviewing and changing that validation. OpenLane does not install, start or
restart LiteLLM or evaluator services.

```sh
cd ~/github/openlane
bun install
```

### LiteLLM in Docker on this machine

No SSH tunnel is needed when LiteLLM's Docker port is published on this host.
Use the published host port, not the container's internal IP or port. For the
current setup, LiteLLM is reachable on host port `1998`:

```sh
export OPENCODE_EIKOS_ENDPOINT="http://127.0.0.1:1998/eikos/v1"
bun ~/github/openlane/src/preflight.ts
```

This is also OpenLane's default endpoint. For permanent profile registration,
set `options.endpoint` to this URL as shown below; no environment override is
needed for the plugin. If Docker publishes a different host port, change the URL
accordingly. Prefer publishing the gateway only on loopback when LAN access is
unnecessary; OpenLane's loopback restriction does not secure Docker's exposed ports.

### Optional: LiteLLM on another machine through SSH

OpenLane accepts only HTTP `127.0.0.1` endpoints. If LiteLLM serves Eikos on
another machine, forward its port over SSH rather than exposing a LAN endpoint
directly to the plugin. This uses the Eikos typed-decision pass-through route,
not LiteLLM's chat-completions API or a model alias.

In a separate terminal, keep this tunnel running:

```sh
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -L 127.0.0.1:11998:127.0.0.1:1998 USER@LITELLM_HOST
```

Replace `USER@LITELLM_HOST` with your SSH login on the LiteLLM machine and `1998`
with its listening port. Local port `11998` must be unused. The destination
`127.0.0.1:1998` is resolved on the SSH host; this example assumes LiteLLM is
reachable there. The local listener is bound only to loopback. Verify the SSH
host key normally; do not disable host-key checking.

In the terminal where you will launch OpenLane:

```sh
export OPENCODE_EIKOS_ENDPOINT="http://127.0.0.1:11998/eikos/v1"
bun ~/github/openlane/src/preflight.ts
```

If the route requires a bearer API key, securely populate an environment variable
such as `LITELLM_API_KEY`, then set `OPENCODE_EIKOS_API_KEY_ENV=LITELLM_API_KEY`.
Do not put the key in the README, plugin config, or repository.

Launch using the commands below from that same terminal. Proposed commands and
eligible file diffs travel through the tunnel to the remote evaluator; trust that
host and its logging configuration. OpenLane does not manage the tunnel or start
LiteLLM/Eikos. Failed readiness stops startup; tunnel/evaluator failure during an
auto-mode session requires manual approval for otherwise eligible actions.

## Permanent registration in an OpenCode profile

Add this entry to the existing `plugins` array in your profile's `opencode.jsonc`.
Use the absolute path to your checkout directory, not `index.ts`:

```json
{
  "package": "/home/tleach/Documents/github/openlane",
  "options": {
    "mode": "shadow",
    "fileMode": "auto",
    "endpoint": "http://127.0.0.1:1998/eikos/v1"
  }
}
```

Change the checkout path for your machine. With this registration, new sessions
using that profile load OpenLane automatically. For remote LiteLLM, change the
endpoint port to `11998` and keep the SSH tunnel above running. Local Docker on
port `1998` does not require a tunnel.
The explicit `endpoint` option takes precedence over `OPENCODE_EIKOS_ENDPOINT`.
For authentication, optionally add `"apiKeyEnv": "LITELLM_API_KEY"`; the key
itself must be supplied securely in the process environment, never in config.

`mode` controls shell review; `fileMode` controls file review. Use `shadow` for
ratings without changing permission decisions, or `auto` for low/medium automatic
approval and high/critical human approval. Set both to `shadow` for observation
only; deterministic sensitive-path guards still apply. If omitted, `mode` defaults
to `shadow` and `fileMode` inherits `mode`. Optional `timeoutMs` defaults to 15000
and accepts integers from 100 to 60000.

Permanent registration does not provide the dedicated launcher's fail-closed
startup handshake or temporary static edit-deny overlay. Retain host hard-deny
permissions; plugin-loading failures may not stop a normal OpenCode launch.
Do not combine permanent registration with the dedicated launcher, which registers
the plugin itself. Restart the work-profile client to pick up config changes.

## Alternative: opt-in launcher with the work profile

From the project you want OpenCode to work in:

```sh
bun ~/github/openlane/src/launch.ts --profile work --mode shadow --file-mode auto --
```

The launcher uses `~/.config/opencode-profiles/work`, adds a temporary plugin
overlay and protected-path edit denies, then verifies startup and native-tool
wrappers before opening the client. It does not rewrite profiles.
`--profile personal` selects the other workstation profile. This profile convention
is a launcher integration; the plugin can be loaded by any reviewed OpenCode config.

- Eligible file changes: low/medium → allow; high/critical → human approval.
- Shell: shadow in the example above; shell enforcement remains experimental.
- Hard denies: retained. Protected files are blocked before native file preparation.
- Unsafe/incomplete evidence or evaluator failure: manual approval in auto mode.

Defaults are shell shadow, file auto. Explicit `--mode shadow` sets both to shadow;
`--file-mode` overrides only files. OpenLane is not a sandbox: custom tools,
indirect shell IO, later plugins, config reloads and filesystem races remain limits.

Eligible proposed inputs and native diffs are sent to the local evaluator.
Credential-like/binary/oversized evidence is not sent. Diagnostic logs omit
contents, commands, paths and user text. Arbitrary secret detection is not guaranteed.

## Diagnostics

Follow the new log path printed by the launcher, or summarize it:

```sh
bun ~/github/openlane/src/summary.ts /path/to/review.jsonl
```

Legacy `OPENCODE_EIKOS_*` settings and the existing private
`~/.local/state/dev_environment/eikos-risk/` log namespace are retained for
compatibility. No authentication, sessions or historical logs are moved here.

## Read-only Git review scope

Shell eligibility no longer rejects sensitive-directory names by raw text
matching: exclusions such as `rg -g '!.aws/**'` can reach Eikos. This also means
eligible shell reads of credentials/authentication files rely on Eikos's rating
and the host's existing shell denies, not a deterministic sensitive-path guard.
A mistaken low/medium rating can allow such a read. File-tool protected-path
guards do not mediate shell IO. Inline credential detection, project/role
boundaries (including Git, Plan and vault ownership), hard denies, and
unavailable/stale-evidence approval fallbacks remain. Eligible command text can
reach the evaluator and, with content tracing enabled, Phoenix.

Build and Engineer may submit simple read-only Git inspections (`status`,
`diff`, `log`, `show`, `rev-parse`, `ls-files`, `remote -v`, and branch listings)
for shell risk review. Low/medium ratings can allow these in auto mode;
hard denies, evaluator failures and high/critical ratings still require the
existing deny/approval behavior. Git mutations and provider operations remain
Git-agent-only. The exception uses a conservative option allowlist: shell
compositions, quoting, redirects, configuration overrides, external-diff/textconv
flags and unknown options do not qualify. This is not a general shell parser
or protection against execution through existing Git configuration.

## Phoenix review tracing

OpenLane can emit `openlane.review` OpenInference/OTel spans through the global
tracer provider installed by `@devtheops/opencode-plugin-otel@2.0.0`. Enable these
OpenLane options alongside that exporter plugin in your work profile:

```json
{ "tracing": true, "traceContent": true }
```

Both options default to `false`. The exporter owns the Phoenix endpoint,
project, batching and shutdown; OpenLane does not create another exporter or
start services. Without an installed global OTel provider, spans are no-ops.

Spans contain review mode, risk, recommendation, original and resulting
permission effects, validated confidence, evaluator duration, fallback reason,
and session/tool-call identifiers. Span duration covers permission review, not
tool execution. Blocked and unreviewed actions emit metadata without fabricated
ratings. Shadow recommendations and actual permission effects stay distinct.
Session IDs allow grouping in Phoenix; nesting under the telemetry plugin's
tool/LLM spans is not guaranteed when no active OTel context is available.

`traceContent` additionally includes eligible commands and exact validated
proposed file inputs/native diffs, including when evaluation fails. It never
copies full user transcripts, environment values, authentication headers, tool
outputs or raw evaluator errors. Protected/unsafe paths are guarded first;
credential-like and oversized content is omitted rather than truncated.
The existing secret prefilter is not comprehensive: arbitrary secrets in
otherwise eligible text can still reach Phoenix. Treat its UI, storage and
backups as sensitive even when Docker runs locally. Local JSONL diagnostics
remain redacted regardless of tracing options. Tracing failures do not alter
permission decisions or readiness. No historical logs are imported.

## Development

Exploratory suite: `bun src/calibrate-shell.ts` submits 100 authored shell proposals directly to
the configured loopback Eikos endpoint, three times each. Use `--repeats 1..10`
to change repetition. It exercises safe exclusion globs, read-only Git,
sensitive-access/exfiltration proposals, chains, substitutions, disguised paths,
and quoted/delegated prompt injection. No proposed command executes; no target
files or real authentication/session state are read. Context and paths are
synthetic, not exact session replays. Expected outcomes are fixed before the run:
routine actions may allow, sensitive/consequential actions must ask.
Unsafe allowances, routine false positives and unrated errors are counted
separately and make the command exit nonzero. This bypasses OpenLane's scope
guards solely to measure the evaluator; it does not change permission policy or
create Phoenix spans. Passing finite cases does not establish a security boundary.

```sh
bun test
bun run build
bun run test:integration  # isolated work-profile/native-tool fixtures, mock evaluator
bun run test:calibration  # live evaluator proposals, never executed
```

See [COVERAGE.md](COVERAGE.md) for verification and limits. Bundling is not
typechecking; no compiler is provisioned yet. The package is private/unpublished;
no license or remote publication decision is implied.
