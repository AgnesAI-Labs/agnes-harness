# Sandbox providers

English | [简体中文](sandbox-providers.zh-CN.md)

[Documentation](../README.md) · [Security](security.md) · [Configuration](../reference/configuration.md)

A sandbox provider runs a command and owns its processes. The host picks one provider when the process starts. The public contract is [`SandboxProvider`](../../packages/extension-api/src/sandbox-provider.ts).

## Startup selection

Put this in the profile:

```yaml
providers:
  sandbox: { provider: local }
```

`local` is the default and the current host sandbox: Seatbelt on macOS, bubblewrap on Linux, and the [Windows write restriction](#windows-write-restriction) on Windows. Omit the field to keep that default. `docker` is the example provider in `examples/sandbox/docker`. It is not loaded until a plugin registers it.

The choice is fixed for the life of the process. `catalog()` marks every entry `restartRequired: true`. Editing the profile does not move a command that is already running, and it does not retarget the running process. Start the process again to select a different id.

`providers.sandbox: { provider }` is the only way to choose a sandbox; the top-level `sandbox` block carries only the provider's `options`. `platform` cannot be selected: the platform backend belongs to the Host. It is listed in the provider catalog as `platform` with authority `host`, and no package can register or select it.

## Remote providers

A provider whose commands run on another machine exports a `sandboxProvider` from its package. Build it with `defineRemoteSandboxProvider({ id, version, openTransport })` from `@agnes/sandbox-remote`, then select it with `providers.sandbox: { provider: <id> }` and put the channel settings in that package's config (`rootTemplate`, `keepOnClose`, `providerTtlMs`, plus whatever `openTransport` reads). The Host opens the channel once at startup and runs its own exec gate, file policy and workspace fence over it, so the provider instance never carries a command itself. Only the selected remote provider's channel is opened. A remote workspace cannot select another provider.

## Capabilities

Each provider declares what it can really do:

| Field | Meaning |
| --- | --- |
| `network` | `true` only when a call can ask for network access and get it. `false` means the call must refuse, not open the network quietly |
| `fsWrite` | Absolute write roots the provider enforces. An empty static list makes no write-confinement claim; use the per-call enforcement result |
| `platform` | Operating systems this provider can run on |
| `available` | `false` when the provider cannot run commands. `exec` refuses with `SANDBOX_UNAVAILABLE` |

A missing tool is a missing capability. The Docker provider sets `available: false` when `docker version` fails, and it does not run the command on the host. The local provider accepts network requests only when the authorized per-call policy permits them. Its empty static `fsWrite` list is not an enforcement claim: the OS compiler and Host supply the probed posture for each call. Direct unbound calls are refused.

## What a provider implements

`exec` takes `argv`, `cwd`, optional `env`, `stdin`, time and output limits, and an `AbortSignal`. It also receives `policy` and returns the exit code, captured output and actual `enforcement`. `dispose` stops every process that instance started. Cancellation kills the process. It does not leave the command running and report success.

Register through a plugin that injects `sandboxProviders` and calls `register`. Duplicate ids are refused. `catalog()` lists id, version, source package, capabilities, and `restartRequired`.

The host OS confine still wraps `local` commands. A non-local provider id skips that confine so the same argv is not wrapped twice. `confine` then refuses instead of returning the raw argv. Tools that spawn a confined argv themselves need a provider that rewrites argv; this Docker provider runs `exec` inside a container and does not rewrite host argv.

## Per-call policy and workspace ownership

Every selected provider, including `local`, uses the same public `exec` entry. The Host passes the authorized workspace root and policy digest, allowed/denied read and write roots, network mode/hosts and minimum enforcement. Providers must refuse incompatible policies before spawning, and return actual enforcement; the Host never infers success from an id. Base first compiles local OS confinement into argv and the local public instance executes it.

Provider-specific options are a string mapping:

```yaml
providers:
  sandbox: { provider: docker }
sandbox:
  options:
    image: alpine:3.21
```

Instances are keyed by provider id, authorized workspace root and effective options. Equal keys share an instance; another workspace or options creates a separate instance. Each instance cancels and drains its own commands. The Host owns the underlying local spawner.

The Docker example reports partial process/network enforcement and refuses unsupported Host file denies or network allowlists. It does not satisfy the ordinary conditional L1 policy. Missing capability never falls back to local execution.

An explicit L0 override requests no command enforcement and reports `level: none, scope: []`. The file-tool fence still applies independently.

## Standard devices in local confinement

The macOS Seatbelt profile permits reads and writes to the exact `/dev/null` literal, and reads to the exact `/dev/zero`, `/dev/random` and `/dev/urandom` literals. This lets Git and other commands use the null sink under workspace-write, including when reads are restricted. It grants no writes to the other three devices, broad `/dev` subtree access, raw disk access, temporary-directory writes or additional ioctls. The existing controlling-TTY ioctl rule is unchanged. Explicit path denies override these device grants; protected paths and workspace write roots retain their restrictions.

Local stdio MCP isolation uses the same compiler, so its strict, workspace-write and network profiles have the same device exceptions. Its runtime read list already includes `/dev/null` and `/dev/urandom`; runtime reads alone do not authorize writes.

Linux bubblewrap already supplies an isolated minimal device tree through `--dev /dev`, rather than exposing host raw devices. Its device permissions are not identical to Seatbelt's literal rules. Landlock is currently a diagnostic ABI check, not an alternative command confinement backend. Windows has no implemented local L1 backend; the Windows compiler refuses confinement. Read-only and workspace-write commands use the [Windows write restriction](#windows-write-restriction) instead, and full access runs directly. Neither Linux nor Windows needs a device-policy change for this macOS defect.

## Windows write restriction

On Windows, `local` runs commands for `read-only` and `workspace-write` sessions under a Windows ACL write restriction: a restricted token, Low integrity, NTFS ACL grants and a Job Object that the Host owns. This is partial protection. It limits file writes only. It is not the full L1 isolation of macOS and Linux, and it is not a strict path sandbox. It needs an NTFS workspace and a working native module.

| Permission | Windows behavior |
| --- | --- |
| `read-only` | No write grant: commands get no write access to the workspace or a temporary directory. The tool policy still decides which commands run |
| `workspace-write` | Write grants cover only the workspace root and a private temporary directory that belongs to the session's lease. The side effects below list the exceptions |
| `full-access` | Runs directly with the current account, without isolation and without changing any ACL |

File reads and network access are not restricted. A command can read files outside the workspace and reach the network. Protected paths are still checked for file tools; an arbitrary script does not get the same protection.

`sandbox.windows_mode` selects the behavior and is either `write-restricted` or `require-full`. The official `read-only` and `workspace-write` permission overlays select `write-restricted`, and so does `standard-windows`, the Windows default recipe, which sets it itself and takes no overlay. With it, `required: true`, custom deny paths, network restrictions and other stronger requirements are refused; they are never downgraded to the write restriction. The default is `require-full`, which never uses the restriction. Windows has no full local backend, so `on_unavailable` decides as before: a custom recipe with `allow-if-unimplemented` runs its commands directly without isolation, `deny` refuses each command, and `required: true` refuses the workspace. The name of the operating system gives a custom recipe no other downgrade.

The start is refused, and the command never runs directly, when the restriction cannot be set up: a non-NTFS volume, a drive root, a UNC path, a junction root that is not verified, a missing native module, or a failed ACL change.

Side effects on the workspace:

- Grants stay on the workspace until explicitly removed. Ending a command or closing a session does not remove them.
- The grant adds a Low integrity label and an Everyone delete-child deny to the workspace directory. They are permanent until removed, and while they stay, other programs of the same Windows user that run at Low integrity can also write there.
- A hard-linked file inside the workspace, for example a pnpm store file, can be changed through the grant from its other names outside the workspace.
- Moving a directory on the same volume can carry its ACLs with the moved object. Moves are not tracked.
- Session extra directories and `extra_paths` get no write access. Commands that write there are denied.
- A workspace directory that was replaced by another one at the same path is not trusted. The session refuses its commands and does not open again, and its history is kept. The confirmation happens outside the session: check the new directory, run `agh doctor windows-acl --cwd <root> --repair`, then open the session again in place. A session whose saved workspace path or id no longer matches is not a replaced directory; no confirmation accepts it, its history is kept, and it needs a new session.

Limits inside a confined command:

- A Node program cannot start a child and capture its output or feed it input (`stdio: 'pipe'`, which is also the default of `execFileSync` and `execSync`): the start fails with `EPERM`. A child that inherits or ignores stdio starts, and PowerShell pipelines work.
- A read-only command has no writable temporary directory, so PowerShell starts in Constrained Language Mode: `Add-Type`, .NET method calls such as `[Console]::Out.Write`, COM and reflection fail, while cmdlets work. A workspace-write command is not affected.
- The restriction covers file writes only. Confined commands of one Windows user are not isolated from each other as processes: a read-only command can open the process of a workspace-write command that runs at the same time.

Each session has its own lease, with its own private temporary directory. A forked session opens its own lease and does not share its parent's; subagents that work inside a session's turn share that session's lease. A fork of a role session is refused under the write restriction, because the fork would not keep the role's captured limits.

Sessions created by an earlier version keep their history. A session that used an official permission overlay moves to the new rule when the session is opened; only the lease is taken, on the first command. A session with a stricter custom requirement is refused and its record is kept.

`agh doctor windows-acl --cwd <root>` shows the grant state for a workspace and lists sessions whose workspace directory was replaced. It is read-only by default. `--repair` removes AGH's own grant entries and confirms the replaced workspaces in place (this is the only way to confirm one); entries that someone else changed are kept and reported. A grant that a running session still uses is not removed. Run it in a normal terminal as the Windows user that runs AGH; it does not elevate. `--json` prints the report.

## Conditional local isolation

`l1Implementation` describes implementation support (`implemented`, `unimplemented`, or `unknown`), separately from command availability and the actual workspace probe. Missing support is unknown. Only the trusted builtin local backend can grant the unimplemented exception; a third-party declaration cannot authorize a fallback to local execution.

Ordinary presets use L1, `required: false`, `on_unavailable: allow-if-unimplemented`. On Windows, L1 is unimplemented. With the shipped presets and the official permission overlays, read-only and workspace-write sessions run under the [Windows write restriction](#windows-write-restriction) and are refused if it cannot be set up; they are never run directly. A custom recipe that leaves `windows_mode` at `require-full` keeps this unimplemented-platform policy, so `allow-if-unimplemented` runs its commands directly. Full access runs without OS isolation. macOS/Linux must still pass the real backend probe. A failed implemented backend refuses. `required: true` takes priority. The conditional value is invalid with L0. Explicit legacy `allow`/`deny` keep their semantics. Remote transports need their existing explicit policy; the new local conditional policy does not grant them an exception.

Named role children retain the parent's approved local fallback: a `partial / file` report does not itself require L1 when Host has already admitted that unimplemented-platform exception. Existing OS confinement, inherited mandatory isolation and a role's own stricter sandbox requirements remain enforced. A file-only parent that has not been granted the fallback is not an exception. A role child of a Windows session under the write restriction runs under that restriction too, even when its own recipe does not select it. A stricter requirement of the role, or a parent policy with a custom deny path, refuses it. File-tool boundaries, tool permissions and approval restrictions are unchanged; an unconfined shell still has no OS sandbox.

An L1 `loopback_serve` request may use `deny` or `allow-if-unimplemented`, with restricted access and an empty network allowlist. The actual listener still requires the local macOS L1 backend and a successful probe. On Windows a policy that selects the write restriction is refused, because that restriction leaves the command network open. Elsewhere, including a Windows recipe that keeps `require-full`, Host removes the unsupported listener request before applying the existing unimplemented-platform policy; this grants no controlled listener or OS network isolation there. The admin security status describes each policy with the same decision. An implemented backend's failure never permits fallback, and unconditional `allow` remains invalid with `loopback_serve`.

Before a session or child session executes, Host durably binds the actual workspace policy, provider/version, target, implementation and enforcement to that session. Restoration reprobes current conditions and requires a matching record. A historical session with no execution record can adopt the current decision only when its backend is L1, implementation is `implemented`, probe is `ready`, and enforcement is `full` with `file` scope. Pre-record sessions required OS isolation, so this adoption preserves that guarantee; Host durably publishes and rereads the record before continuing, and logs the adoption with a hashed session identifier. All other missing records, and every damaged, unreadable or incompatible record, refuse continuation with guidance to create a new session; history is preserved and can be viewed read-only when the conversation record remains readable. Intent hashes are not rewritten to pretend L0 was requested. This exception does not allow mixed-version continuation or bypass workspace and generation checks.
