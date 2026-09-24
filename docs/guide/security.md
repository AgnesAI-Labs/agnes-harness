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

`approvals.mode` accepts `manual`, `smart`, and `off`. TUI `/yolo` skips remaining approvals in the current session and cannot be undone in that session; it does not remove other permission or sandbox constraints. Do not make skipped approvals a beginner example or automation default.

A request to edit files is not permission for arbitrary plugin execution. Plugins should accurately declare read-only/destructive behavior, open-world access, replayability, and approval requirements. Metadata must match actual effects.

<a id="平台与进程"></a>

## Platforms and processes

Default command execution requires an available sandbox: bubblewrap on Linux and Seatbelt on macOS. If unavailable and policy requires refusal, execution returns `SANDBOX_UNAVAILABLE`. Successful Host startup does not prove every tool can execute. Some Windows security capabilities remain subject to implementation and external verification limits; see [limitations](../reference/limitations.md).

Local Web relies on loopback binding and exact Origin/Host checks, rather than internet user authentication. Do not expose it directly to the public internet. A manual `--connect` must identify the target explicitly. Windows named pipes also check process ownership against discovery records.

Computer Use is another privileged surface. Its local profile configuration still requires runtime components, a suitable model, and operating-system permissions. `computer-use permissions grant` starts an authorization flow; `install/restart` changes runtime components. Begin read-only diagnosis with `computer-use status` and `doctor computer-use`; do not automatically grant system permissions for documentation checks.

<a id="skill-管理的删除边界"></a>

## Skill deletion boundaries

Permanent deletion and priority changes require server-side admin authority and `resources.skills.write`, through the Web management BFF or Node SDK. Priority overrides do not grant trust or enablement and do not expand ordinary plugin API permissions.

Permanent disk Skill deletion covers every file in the selected directory. User sources may be shared by other applications. Package/runtime sources cannot be deleted through this interface. Deletion verifies the registered source, revision, and file identities before proceeding, and cannot be canceled after acceptance. Partial failure retains deletion markers, blocks re-enabling, and permits explicit constrained retries. Another same-name candidate may take over, subject to its own authorization. See [Skills](skills.md#permanently-delete-a-disk-skill) for the complete procedure and limits.

<a id="密钥和持久数据"></a>

## Secrets and persistent data

The configuration service stores provider keys in a credential backend. Public configuration retains only `secret://...` references. MCP CLI rejects plaintext options such as `--token` and `--env`, accepting constrained references instead. A reference does not grant arbitrary permission to read a secret.

`AGH_HOME` contains sessions, configuration, grants, audits, and caches. Reduced logging does not mean conversation text is free of sensitive information. Review user input, tool arguments, and paths before exporting, taking screenshots, or publishing errors. Do not commit `secrets/`, `auth/`, a complete home, real traces, or credential files. `publicConfig` reaches the browser and must never contain secrets or secret references.

File tools and sandbox policies protect workspace `.agh/secrets` and legacy `.agnes/secrets`. Do not point AGH's home at another product's data directory. Legacy `AGNES_HOME` is a compatibility option with no automatic migration.

Check the target system before retrying an operation with unknown side effects. Recovering a backend database cannot recall an email, undo a network write, or reverse a physical device action.

Implementation: [default profile](../../packages/host/templates/local-dev.yaml), [ordinary row API](../../packages/host/src/ext-host/row-extension-api.ts), [MCP argument policy](../../packages/resource-control-cli/src/resources.ts), [Web server](../../packages/web-server/src/server.ts).
