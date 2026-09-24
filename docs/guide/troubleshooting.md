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

Unexpected daemon errors may include a `diagnosticId`. Match it against `audit/daemon.jsonl` under the selected dataDir. Failed audit writes may instead return `diagnosticUnavailable`; this does not prove there was no error. Records should contain safe method/code/time fields, but still review them for private context before sharing.

There is no command that automatically repairs every home migration. Do not delete owner records, locks, SQLite databases, or rollback snapshots to hide errors. Before switching versions, finish tasks, stop the relevant daemon, back up your data, and start a complete new distribution using the [installation guide](install.md).
