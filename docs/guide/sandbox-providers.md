# Sandbox providers

English | [简体中文](sandbox-providers.zh-CN.md)

[Documentation](../README.md) · [Security](security.md) · [Configuration](../reference/configuration.md)

A sandbox provider runs a command and owns its processes. The host picks one provider when the process starts. The public contract is [`SandboxProvider`](../../packages/extension-api/src/sandbox-provider.ts).

## Startup selection

Put this in the profile:

```yaml
sandbox:
  provider: local
```

`local` is the default and the current host sandbox: Seatbelt on macOS, bubblewrap on Linux, and the current Windows posture. Omit the field to keep that default. `docker` is the example provider in `examples/sandbox/docker`. It is not loaded until a plugin registers it.

The choice is fixed for the life of the process. `catalog()` marks every entry `restartRequired: true`. Editing the profile does not move a command that is already running, and it does not retarget the running process. Start the process again to select a different id.

A remote workspace cannot select another provider. The remote runner stays in place.

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
sandbox:
  provider: docker
  options:
    image: alpine:3.21
```

Instances are keyed by provider id, authorized workspace root and effective options. Equal keys share an instance; another workspace or options creates a separate instance. Each instance cancels and drains its own commands. The Host owns the underlying local spawner.

The Docker example reports partial process/network enforcement and refuses unsupported Host file denies or network allowlists. It does not satisfy the default required L1 policy. Missing capability never falls back to local execution.

An explicit L0 override requests no command enforcement and reports `level: none, scope: []`. The file-tool fence still applies independently.
