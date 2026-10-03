# OpenLane

OpenCode V2 action-risk plugin; current backend is local Eikos typed decisions.

- Inspect code and preserve unrelated user changes. No commits/pushes unless requested.
- Never put credentials, authentication, sessions, diagnostic logs, dependencies
  or mutable agent state in source control. Never read real sensitive files.
- Preserve hard denies and role boundaries. Risk is not authority.
- Do not start/restart evaluator services. Readiness must fail before client startup.
- `bun test` for units; `bun run build` bundles (not typechecking).
- `bun run test:integration` uses owned loopback scratch servers, reviewed static
  work-profile config, authored dummy files, and a mock evaluator.
- `bun run test:calibration` classifies proposals only; never executes them.
- Source: `src/`; root `index.ts` is the configured local-plugin entrypoint.
- Portable path policy: `src/policy.ts`. Keep workstation providers/roles external.
- Launcher defaults: shell shadow, file auto. `--mode shadow` keeps both shadow.
- Keep security/coverage claims proportional to evidence. This is not a sandbox.
