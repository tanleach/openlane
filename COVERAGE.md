# OpenLane coverage — OpenCode V2.0.21 / SDK 2.0.20

## Verified behavior

| Path | Deterministic protection | Eikos assessment | Evidence |
| --- | --- | --- | --- |
| Native shell | Existing shell/role rules | Exact command/context; shadow default | Real work-session `pwd`; mocked-hook regression suite |
| Native patch | Pre-executor checks for all targets, both move endpoints; static edit denies | Exact input + native previews; auto for eligible whole batches | Native scratch create/update/delete/move/batch; blind overwrites require approval |
| Native edit | Pre-executor target check; static edit denies | Exact replacement + native diff; auto | Native scratch text replacement |
| Native write | Pre-executor target check; static edit denies | Proposed contents + native diff; auto | Native scratch creation/overwrite |
| Native read | Existing read permission rules | Not assessed | Earlier work-session sensitive read denial |
| Custom edit permission event | Shared path policy, plus lexical guard if hook reached | No capture: explicit fallback record | Unit fixture; not universal executor coverage |
| Other provider/custom tools, terminal, plugin shells | Existing permissions only | Not covered | No claim of risk coverage |

The file wrapper runs before native preparation. Inspection of the installed
binary shows patch/edit/write preparing existing contents before `edit` assertions;
a permission hook alone cannot prevent those internal reads. Patch asserts the
union of source and move-destination resources before its write/delete loop.
Normal tool execution uses Location-relative resources internally and absolute
resources externally. The reviewer normalizes and matches the full target set.

Native integration uses real tools through a scratch-only fixture RPC, a delivered
authored user transcript and a deterministic local HTTP evaluator. Five ordinary
file operations skip existing ask rules on low/medium ratings; high and critical
produce native permission requests. A saved approval yields original=allow, but
critical still becomes ask. Missing evidence and evaluator outage also require
approval, without a risk rating. A configured hard deny is preserved; five
protected operations (including a mixed batch) fail before native execution.
The startup gate constructs all required
wrappers before launching a harmless CLI help request and rejects a missing plugin.

Unit tests additionally exercise source/role/resource mismatches, relative and
absolute protected paths, symlink components, hardlinks, malformed patches, missing
events, concurrency, stale files/previews, new user instructions, cancellation,
shell permission identity changes and pending denies,
unavailable/unsafe/oversized evidence, unavailable evaluation, redacted diagnostics
and all risk/effect mappings. Live evidence-only calibration distinguishes four
ordinary actions (low) from authentication bypass and data-loss examples (high).

## Limits and remaining acceptance gates

- Eligible changes send exact proposed inputs and native change previews to local
  Eikos, never to diagnostic logs. Secret-pattern matches, binary/oversized or
  mismatched previews require approval. Detection is conservative, not an oracle
  for all secrets or sensitive data hidden in otherwise ordinary files.
- Native patch Add and move-overwrite previews omit overwritten preimages. These
  remain manual. The reviewer does not bypass read permissions to retrieve them.
- Native executors can format after writing, and batches can partially fail.
  Recorded permission effects are not proof of final filesystem state.
- Fingerprints use metadata, not content reads. Prechecks are not atomic with the
  filesystem operation. Symlink races or other processes can invalidate assumptions.
- Existing hard denies may bypass permission hooks. Missing review events are
  explicitly distinguished from valid ratings, but some tools remain unwrapped.
- Native saved approvals and permission request/reply behavior are verified via
  the isolated API fixture; visual TUI rendering and assistant tool selection are
  not exercised. Unit tests cover existing allow/ask/deny.
- A later plugin can replace tools or change decisions. Startup confirms initial
  wrapper construction, not perpetual coverage across reloads or Location moves.
- Shell scanner-empty syntax, indirect scripts and shell access to protected files
  remain unresolved coverage gaps. File guards do not mediate arbitrary shell IO.
  The shell sensitive-directory text regex has been removed: eligible sensitive
  reads depend on Eikos ratings and host shell denies. A low/medium misrating can
  allow them. The 100-case exploratory calibration is finite synthetic evidence,
  not a guarantee of protected-path or authorization enforcement.
- Read-tool risk assessments, external mutation adapters, whole-repository context
  and an OS-level sandbox are outside this milestone.

The dedicated launcher defaults to auto for eligible file changes, shadow for
shell. Explicit `--mode shadow` keeps both shadow; `--file-mode` overrides only
files. Expanding enforcement to other tool families needs separate validation.

## Repository separation

OpenLane does not import workstation configuration. `src/policy.ts` owns portable
sensitive-path defaults. The dedicated launcher includes static edit-deny rules
in its temporary overlay; plugin wrappers provide the earlier pre-executor guard.
Role, provider and ordinary permission configuration remain external in the
selected profile. Direct plugin registration should also retain appropriate host
hard-deny rules; OpenLane is not a replacement for those rules.

The work-profile integration test intentionally uses the locally installed
`~/.config/opencode-profiles/work` static config and source tools. Unit tests and
build require only this repository's locked dependencies. No personal profile
configuration, authentication or historical runtime state is vendored here.
