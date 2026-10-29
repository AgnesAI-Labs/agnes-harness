# Network deployment and proxies

English | [简体中文](deployment.zh-CN.md)

[Documentation](../README.md) · [Installation and Linux](install.md#linux-build) · [Security](security.md)

Run one App Server per canonical `AGH_HOME`; use the same home and profile for its clients. Local Web binds loopback and checks exact Origin/Host. The source quickstart is not a public reverse-proxy login deployment: adding a proxy does not create internet user authentication. Keep the local admin surface private. Remote SDK transports require their declared TLS/authentication setup and deployment acceptance.

## Outbound proxy configuration

Set proxies in the daemon's startup environment, then restart that daemon after existing tasks finish:

```sh
export HTTPS_PROXY=http://127.0.0.1:8080
export NO_PROXY=localhost,127.0.0.1
node agnes.mjs serve
```

This example assumes a proxy you already run. Never put proxy credentials in command arguments, screenshots or a shared environment dump. Official model HTTP adapters, MCP HTTP/SSE, URL/npm/git package downloads and OTLP HTTP export honor proxy settings. Lower-case names take precedence, including explicit empty values; HTTPS falls back to HTTP_PROXY when HTTPS_PROXY is absent. NO_PROXY bypasses matching hosts. Community adapters own their transport behavior, and workspace web_fetch retains its separate public-network policy.

## Timeouts and diagnosis

Use account **Base URL** for an endpoint override. Optional account/route network timeouts bound total requests, connection setup and idle streams; empty settings retain defaults. Changing them affects newly assembled sessions, not an admitted in-flight request. See [configuration](../reference/configuration.md#deployment-networking) for exact fields, ranges and precedence.

From the same source root/home run `node agnes.mjs doctor network --json` to read safe proxy host/port metadata. Do not infer that a model or MCP connection works from proxy configuration alone: explicitly test the account/server, then inspect a real session call. Default doctor performs local checks; `doctor --probe` contacts model services and may incur charges.

On Linux, install native prerequisites and verify actual bubblewrap namespaces using the [Linux installation guide](install.md#linux-build) and [diagnostics](troubleshooting.md#linux-diagnostics). A proxy does not relax sandbox network restrictions. Windows remains unverified end to end.

Source contracts: [network configuration](../../packages/protocol/schema/agnes-v1.json), [App Server](../reference/app-server.md), [diagnostics](observability.md).
