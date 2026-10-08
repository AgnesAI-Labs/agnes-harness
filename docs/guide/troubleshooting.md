# Troubleshooting: choose the next useful check

English | [简体中文](troubleshooting.zh-CN.md)

<a id="排错找到下一步可以检查的事"></a>

[Documentation](../README.md) · [Known limitations](../reference/limitations.md)

Identify whether the problem occurs during building, connection, model configuration, or plugin execution. The checks below aim to preserve evidence while locating the cause.

Record the current commit, Node version, command, error code, and home/profile. Do not dump the full environment or credentials. These commands continue to use your selected isolated AGH_HOME.

```sh
node packages/cli/dist/local/agnes.mjs --version
node packages/cli/dist/local/agnes.mjs daemon status
node packages/cli/dist/local/agnes.mjs doctor platform --json
node packages/cli/dist/local/agnes.mjs doctor storage --json
node packages/cli/dist/local/agnes.mjs doctor provider --json
```

`doctor storage` creates and cleans up a temporary probe database; it does not repair existing data. `doctor provider --probe` calls a model, so do not add it unintentionally.

| Symptom | Check and next action |
| --- | --- |
| Old Node / SQLite module error | Confirm Node >=24.10; your default shell and build may use different Node installations |
| Missing `dist/local/agnes.mjs` | Run the complete `build:local` from the repository root; stopping the daemon will not create a missing build |
| Missing or incompatible native helper | Keep the full distribution and rebuild for the current OS/architecture/Node; do not copy a single binary from another platform |
| `listen EPERM` | The execution environment prohibits sockets/loopback listeners; tests need the appropriate environment permissions without bypassing product security policy |
| Daemon exits immediately / `E_DAEMON_SOCKET_PATH` | Check helpers, versions, and home/profile. A short `/tmp/agh-*` trial home can isolate path issues. Long default paths have a short-directory fallback, but excessive explicit paths or invalid directory identity/permissions are refused |
| Port in use | Identify the owning trial Web listener, then stop your service or choose another port |
| Origin/Host mismatch | Match `AGNES_WEB_ORIGIN` exactly; do not mix localhost and 127.0.0.1. Explicitly stop an old instance with incompatible configuration |
| Page asks for a token / guide asks you to copy one | Check for mixed old builds or instructions; current local Web prints a normal URL |
| Missing provider / invalid route/model | Run config or Web settings, test and save, then choose from the current catalog; new defaults do not change existing sessions |
| `TOOL_ARGS_INVALID` | Read the parameter paths in the error and retry with complete arguments matching the tool schema. `write` requires both `path` and `content`; refused calls do not write files |
| Output ends with `max_tokens` / `OUTPUT_LIMIT` | The model response reached its output allowance; partial text is retained, unfinished tool calls are discarded, and the turn stops without automatic retries. Ask to continue with smaller calls, or configure the preset's `model.max_tokens` within the provider's supported range. This is separate from an input context overflow |
| `RATE_LIMIT` / HTTP 429 | The model service refused the request with a rate-limit error. Retry later; if persistent, check the account's service limits or contact the provider. This does not establish an input-context or output-token overflow |
| Generic backend failure after reading a file | Preserve the diagnostic ID and match it to the daemon audit record. The generic message alone does not establish a token overflow |
| `SANDBOX_UNAVAILABLE` | On Linux, check actual bwrap execution and user namespaces; on macOS, check system sandbox availability. Preserve refusal when unavailable |
| Plugin installed but no tools | Inspect trusted, desired, actual, row errors, dependencies, and manifest. A legacy `agnes.extensions` declaration alone is not a current ordinary backend entry |
| Frontend v2, old or unavailable backend | Check package anchor, web row, services ceiling/allow-list, current session, and runtime revision |
| Package/resource timeout | Query the returned operation ID; a timeout does not mean cancellation |
| Skill missing or shadowed | Inspect source roots, session workspace, revision, trust/desired/actual, winner/stale, then refresh the relevant root |
| Missing Skill deletion or priority action | Use Web management or the Node SDK; shell/TUI has no corresponding command. If Web also lacks the action, verify frontend and backend came from one complete build |
| Skill priority saved but unavailable | Check the winner's own trust/desired state. Priority grants no permission; refresh revision and expectedPriority after a conflict |
| Skill deletion failed / cannot re-enable | Inspect the operation and SKILL_REMOVAL_PENDING. Some files may already be deleted; resolve locks and explicitly retry. Restart/refresh is not undo |
| Empty MCP catalog or failed calls | Inspect definition revision, trust, desired state, connection, tool allow-list, and executable policy. The session path skips OAuth bindings; management tests do not prove session availability |
| Tool reports E_LEASE_EXPIRED | Check whether its row was unloaded, revoked, or replaced, and verify the build version. Older versions had a default 24-hour expiry; see [supported scope](../reference/limitations.md). Preserve the session and error, then reload according to actual state |
| Browser disconnected / task still running after stopping a client | Closing a client and canceling/stopping backend work are different actions; inspect backend history for the final state |
| Import failure | Preserve input and error and reproduce with a redacted minimal fixture; do not directly edit the database |

macOS daemon identity uses the kernel boot-session UUID, PID and the process's saved start timestamp; calendar-clock adjustments do not change it. Old owner/discovery records remain readable. An exact legacy identity match creates a private boot-bound migration witness without rewriting the old daemon's records. After that verification, status and stop remain valid across clock adjustments. If an old record has already drifted before verification, its boot cannot be established: status conservatively reports running and discovery/stop refuse unknown identity. No PID-only match, time tolerance or lock bypass is used.

The local launcher includes a child's startup refusal (such as `daemon or package mutation lock is held`) in the early-exit error when the child can publish its private startup diagnostic. The receipt is removed after startup succeeds or fails.

`E_SEAM_INIT` session initialization failures return `INTERNAL_ERROR` with a stable `data.code`: `E_SEAM_INIT`, or the specific `E_PROVIDER_*` cause when a provider fails to register or initialize. The daemon audit records that code without exception messages or request parameters. For a missing loop, check that its exact id/version is installed, enabled, and selected by the session bundle.

Unexpected daemon errors may include a `diagnosticId`. Match it against `audit/daemon.jsonl` under the selected dataDir. Failed audit writes may instead return `diagnosticUnavailable`; this does not prove there was no error. Records should contain safe method/code/time fields, but still review them for private context before sharing.

The supported home layout is described in [first run](getting-started.md). If AGH reports an unsupported layout, choose a new empty private directory with AGH_HOME; existing files remain untouched. `agh doctor --json` performs local checks; `agh doctor --probe` additionally contacts configured model services only when requested.

<a id="linux-diagnostics"></a>

## Linux diagnostics

`doctor` distinguishes bubblewrap installation from a verified L1 boundary, and reports the Landlock ABI (zero means unavailable/disabled, `unknown` means it could not be established). Landlock availability alone grants no isolation. Check the actual sandbox refusal rather than assuming that `bwrap --version` proves usability. In a restricted container, command refusal is expected unless the complete boundary works; explicit full-access remains unconfined.

Linux daemon identity binds `/proc/sys/kernel/random/boot_id`, PID and `/proc/<pid>/stat` start ticks. Clock adjustments cannot change that identity. PID reuse and reboot change it; unreadable or malformed records remain unknown. Zombies/dead tasks retain a PID but cannot run a daemon and are reported dead. Never repair an unknown identity by matching only PID or by deleting locks.

Missing native helpers require a rebuild with matching Node headers and a C toolchain. For a browser launch failure, provision Chromium with `playwright install --with-deps chromium` before the gate; do not download a browser during tests. Computer Use currently refuses Linux platform admission; installing a desktop alone does not establish driver evidence. Do not inject fake desktop capabilities.
