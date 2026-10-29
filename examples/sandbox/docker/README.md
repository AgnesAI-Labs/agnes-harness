# Docker sandbox provider

Registers the `docker` sandbox provider. It runs a command in a container through the `docker` CLI and uses only the public `@agnes/extension-api` contract.

When `docker version` fails, the provider's capabilities stay `available: false` and `exec` refuses with `SANDBOX_UNAVAILABLE`. It does not run the command on the host.

Select it at startup with:

```yaml
providers:
  sandbox: { provider: docker }
```

Changing `providers.sandbox` requires a process restart. A plugin row injects `sandboxProviders` and calls `register` with `dockerSandboxProvider`, or applies `sandboxProvidersPlugin`.
