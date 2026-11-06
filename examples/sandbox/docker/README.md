# Docker sandbox provider

Registers the `docker` sandbox provider. It runs a command in a container through the `docker` CLI and uses only the public `@agnes/extension-api` contract.

This example runs Linux containers with `alpine:3.20` by default. An `options.image` override must also be a compatible Linux image. The probe reads the connected daemon's `OSType` using `docker info`; a reachable Windows container daemon is unsupported. A failed query or unrecognized OS leaves capabilities `available: false`, and `exec` refuses with `SANDBOX_UNAVAILABLE`. It does not run the command on the host.

This deployment requires the client and daemon to share the same local workspace filesystem at the same absolute paths; the workspace is mounted unchanged inside the Linux container. Windows drive and UNC paths require a mapping this example does not implement: those workspaces stay unavailable, and incompatible request paths are refused before execution. A Linux daemon alone does not prove a workspace can be mounted. A remote daemon cannot generally use files from the client machine. The container acceptance reads a unique client marker and writes it back through the bind, which the client verifies. Image pulls, permissions and bind failures remain execution errors.

Select it at startup with:

```yaml
providers:
  sandbox: { provider: docker }
```

Changing `providers.sandbox` requires a process restart. A plugin row injects `sandboxProviders` and calls `register` with `dockerSandboxProvider`, or applies `sandboxProvidersPlugin`.
