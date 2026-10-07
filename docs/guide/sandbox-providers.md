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
| `fsWrite` | Absolute write roots the provider enforces. An empty list means writes are not confined by this provider |
| `platform` | Operating systems this provider can run on |
| `available` | `false` when the provider cannot run commands. `exec` refuses with `SANDBOX_UNAVAILABLE` |

A missing tool is a missing capability. The Docker provider sets `available: false` when `docker version` fails, and it does not run the command on the host. The local provider reports `network: false` and an empty `fsWrite` because file and network confinement stay on the host sandbox seam. A direct call that asks the local provider for network or a write scope is refused.

## What a provider implements

`exec` takes `argv`, `cwd`, optional `env`, `stdin`, time and output limits, and an `AbortSignal`. It returns the exit code and captured output. `dispose` stops every process that instance started. Cancellation kills the process. It does not leave the command running and report success.

Register through a plugin that injects `sandboxProviders` and calls `register`. Duplicate ids are refused. `catalog()` lists id, version, source package, capabilities, and `restartRequired`.

The host OS confine still wraps `local` commands. A non-local provider id skips that confine so the same argv is not wrapped twice. `confine` then refuses instead of returning the raw argv. Tools that spawn a confined argv themselves need a provider that rewrites argv; this Docker provider runs `exec` inside a container and does not rewrite host argv.
