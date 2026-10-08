# Security and trust: define execution boundaries

English | [简体中文](security.zh-CN.md)

<a id="安全与信任让执行有边界"></a>

[Documentation](../README.md) · [Recovery](sessions.md) · [Report a vulnerability](../../SECURITY.md)

**Built for trust** means making concrete choices: which code version to trust, which actions to allow, where execution may reach, and how to inspect results. This guide explains those choices and their limits for first-time users, plugin authors, and FDE integrators.

AGH can execute tools, write files, and connect to external systems. Model text, webpages, MCP results, Skills, and plugin configuration are not user authorization. Choose a working directory and acceptable capabilities before approving specific actions.

<a id="三类不同的信任"></a>

## Three kinds of trust

| Boundary | Meaning | What it does not establish |
| --- | --- | --- |
| Package trust | Accept code with a specific content hash and capability declaration | Authorization for all future versions |
| Tool approval | Allow an action once or within the scope of the selected option | Successful creation of an operating-system sandbox |
| Sandbox / execution constraints | Limit execution according to actual platform probes and policy | Isolation of malicious in-process plugins |

Ordinary third-party Cordis plugins are trusted in-process code. Trusting one may let it use Node capabilities available to the process. `ctx.extension()` constrains the extension API, not arbitrary Node code. Review both source and declared capabilities before installing a third-party package.

<a id="审批"></a>

## Approvals

The default interactive flow shows the tool and available decisions when needed. One-time approval, session approval, persistent grants, and denial have different scopes. The backend makes the final decision using current credentials and policy. On expiry, disconnection, or competing clients, the decision stored by the backend is authoritative.

The Web approval card shows locating fields such as the path or command first and states how many characters of a long value are shown. Session approval covers every later call of the same tool in that session, and the button names the tool. When the call cannot be shown in full, the card says so and does not offer session approval; only one-time approval or denial remains.

A call that is not approved says why, both in the session record and to the model: the user rejected it, no one answered in time, no client was connected to ask, the task was stopped while waiting, the command policy blocked it, or a delegated sub-agent asked for something outside its fixed scope. A call that nobody could be asked about is recorded as unavailable, not as rejected, and is not run.

`approvals.mode` accepts `manual`, `smart`, and `off`. Web **Full permissions** (`完全权限`) and TUI `/yolo` skip remaining approvals in the current session and allow file tools to read and write outside the selected workspace. The workspace remains the default directory for relative paths. The read-only preset continues to refuse changes. Explicit security denials, protected secret paths, operating-system permissions, and command sandbox constraints still apply. Do not make skipped approvals a beginner example or automation default.

Under Full permissions the Agnes home's own state — `secrets/`, `auth/` and `profiles/` — stays readable to the file tools but is not writable: `write`, `edit` and the other file-changing operations are refused with `denied by policy`, so a session cannot rewrite `profile.yaml` (for example to set `approvals.mode: off`) and carry that into later sessions. The same refusal applies when the selected workspace itself contains that state. Command access follows the selected preset independently: under `workspace-write`, shell writes remain inside the OS sandbox's allowed roots. Under the explicit `full-access` preset, shell has no OS confinement and can modify files accessible to the process, including the Agnes home.

Web **Workspace edits** (`工作区内修改`) limits file access to the selected workspace; command execution still follows the approval policy. A path outside that workspace is refused with guidance to switch to Full permissions or select its directory as the workspace, without opening an additional approval request.

The default verifier distinguishes repeated writes from read-only calls using the policy recorded for each call. Read-only polling does not trigger `repeated_write`; missing or unverifiable policy remains conservative, and the separate no-progress check still applies. MCP tools must advertise `readOnlyHint: true` to be classified as read-only. When an interactive verifier approval is allowed during the current run, AGH accepts the proposed completion and ends that turn. It does not ask the model to finish again or waive verification of future turns. Additional instructions queued while approval is pending are retained for a new turn, with their original author and trust.

A request to edit files is not permission for arbitrary plugin execution. Plugins should accurately declare read-only/destructive behavior, open-world access, replayability, and approval requirements. Metadata must match actual effects.

<a id="平台与进程"></a>

## Platforms and processes

The `standard` recipe and the default `workspace-write` preset require L1 OS confinement: bubblewrap on Linux or Seatbelt on macOS. The Host executes a confined child-process probe for each workspace policy before publishing its session runtime. A missing binary, disabled namespaces, or a rejected Seatbelt profile refuses session initialization with `E_SANDBOX_WORKSPACE` and a message identifying the required backend. Later execution refusal returns `SANDBOX_UNAVAILABLE`. Host startup without a session is not proof of sandbox availability. Windows has no proven L1 backend yet and also fails closed; see [limitations](../reference/limitations.md).

Choose a permission preset in the admin session-default selector, CLI `--preset <name>` when creating a session. Changing sandbox permissions in a live session requires a new session; `/preset` refuses that change. The profile's `presets.allowed` controls available choices. The local and enterprise templates select `workspace-write` by default; `standard` remains its compatible recipe name.

| Preset | Command sandbox | Approval and file behavior |
| --- | --- | --- |
| `read-only` | Probed L1; no writable roots; command network denied | Read tools only; non-read effects are denied even under `/yolo` or `approvals.mode: off`; file writes are refused |
| `workspace-write` (default) | Probed L1; workspace and explicitly allowed write roots; command network denied | Workspace edits use the existing approval rules; shell and other risky calls still ask |
| `full-access` | Explicit L0; no OS command confinement | Ordinary tool approval policy allows calls; file tools can reach outside the workspace; principal denials and protected paths still apply |

Even under `full-access`, `edit` and overwriting an existing file with `write` require that the file was observed in the same session, through a read or a successful creation. `write` also refuses a stale read when another writer has changed the file; read it again before overwriting. Creating a new file does not require a prior read.

To run deliberately on a machine without L1, select `full-access` explicitly, for example `agh --preset full-access`. A profile can persist that choice:

```yaml
presets:
  default: full-access
  allowed: [standard, read-only, workspace-write, full-access]
```

A custom recipe can retain approvals while explicitly overriding `sandbox: { level: L0, required: false, on_unavailable: allow }`. This is unconfined command execution. Changing only `on_unavailable` does not override `required: true`. Web Full permissions and `/yolo` do not disable the selected preset's OS sandbox. L1 backends currently reject non-empty command-network host allowlists; `web_fetch` uses its separate public-network policy. A profile can select another sandbox provider at startup; see [Sandbox providers](sandbox-providers.md). The running process keeps that choice until it starts again.

Local Web relies on loopback binding and exact Origin/Host checks, rather than internet user authentication. Do not expose it directly to the public internet. A manual `--connect` must identify the target explicitly. Windows named pipes also check process ownership against discovery records.

Computer Use is another privileged surface. Its local profile configuration still requires runtime components, a suitable model, and operating-system permissions. `computer-use permissions grant` starts an authorization flow; `install/restart` changes runtime components. Begin read-only diagnosis with `computer-use status` and `doctor computer-use`; do not automatically grant system permissions for documentation checks.

<a id="skill-管理的删除边界"></a>

## Skill deletion boundaries

Permanent deletion and priority changes require server-side admin authority and `resources.skills.write`, through the Web management BFF or Node SDK. Priority overrides do not grant trust or enablement and do not expand ordinary plugin API permissions.

Permanent disk Skill deletion covers every file in the selected directory. User sources may be shared by other applications. Package/runtime sources cannot be deleted through this interface. Deletion verifies the registered source, revision, and file identities before proceeding, and cannot be canceled after acceptance. Partial failure retains deletion markers, blocks re-enabling, and permits explicit constrained retries. Another same-name candidate may take over, subject to its own authorization. See [Skills](skills.md#permanently-delete-a-disk-skill) for the complete procedure and limits.

<a id="密钥和持久数据"></a>

## Secrets and persistent data

Local model accounts use private files under `AGH_HOME/secrets` (also on macOS), shared with session model adapters. On a credential write, AGH narrows a home owned by the current user from owner-writable, non-group/world-writable permissions such as 0755 to 0700. It does not repair existing credential directories or files: directories must be 0700 and files 0600. Storage failures refuse the account operation and record the error class, reason, allowlisted OS code and affected path in `AGH_HOME/data/audit/configuration.jsonl`, without credential contents. Settings distinguishes permission failures, read-only filesystems and unsafe or invalid storage.

The configuration service stores provider keys in a credential backend. Public configuration retains only `secret://...` references. MCP CLI rejects plaintext options such as `--token` and `--env`, accepting constrained references instead. A reference does not grant arbitrary permission to read a secret.

`AGH_HOME` contains sessions, configuration, grants, audits, and caches. Reduced logging does not mean conversation text is free of sensitive information. Review user input, tool arguments, and paths before exporting, taking screenshots, or publishing errors. Do not commit `secrets/`, `auth/`, a complete home, real traces, or credential files. `publicConfig` reaches the browser and must never contain secrets or secret references.

File tools and sandbox policies protect workspace `.agh/secrets` and legacy `.agnes/secrets`. Do not point AGH's home at another product's data directory. Legacy `AGNES_HOME` is a compatibility option with no automatic migration.

Check the target system before retrying an operation with unknown side effects. Recovering a backend database cannot recall an email, undo a network write, or reverse a physical device action.

The persistence contract separates ledger, metadata/KV, durable child-control, reclaim and integrity. The full Host requires these five capabilities and accepts complete non-SQL providers, including the [JSONL example](../../examples/persistence/). Synchronous SQL is an optional `sqlite` port (`dialect: sqlite`); SQL-dependent third-party extensions must choose a provider supporting it. Default package domains and Host authorization/receipt stores consume owner-scoped metadata. Switching providers requires restart and never migrates files automatically; see [provider contracts and export/import migration](../extend/persistence.md).

Provider authors declare `capabilities: { ledger: true, ... }` and expose `metadata`, `childControl`, `reclaim` and `scanIntegrity` explicitly. SQLite ledger/child files remain compatible. Legacy grant and receipt schemas are validated before copying to metadata; revocations remain durable before observers are notified. Legacy SQL tables remain for rollback evidence, but metadata changes are not reflected back into them.

Implementation: [default profile](../../packages/host-common/templates/local-dev.yaml), [ordinary row API](../../packages/host-extensions/src/ext-host/row-extension-api.ts), [MCP argument policy](../../packages/resource-control-cli/src/resources.ts), [Web server](../../packages/web-server/src/server.ts).
