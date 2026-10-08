# First run, home layout and diagnostics

English | [简体中文](getting-started.zh-CN.md)

[Documentation](../README.md) · [Build and install](install.md) · [Run your first task](quickstart.md)

## Start an isolated instance

Complete the source build first. From the repository root:

```sh
export AGH_HOME="$(mktemp -d /tmp/agh-home-XXXXXX)"
export AGNES_PROFILE=local-dev
node agnes.mjs serve
```

For an installed distribution use `agh serve`. Keep the complete distribution and matching native helpers. The terminal prints the loopback URL, selected home, profile and diagnostic summary. Open that URL. Use the same environment in other terminals; a second `mktemp` selects a different instance. Set `AGNES_LOCALE=zh-CN` for Chinese CLI messages. Web has its own language preference.

With no saved model accounts or previous sessions, Web offers five steps: welcome, add and test an account, choose a default model, optionally browse official examples, and start a session. Account setup reuses Settings and saves credentials privately. Tests contact the selected provider and may incur charges. Examples retain capability review, trust and enablement; opening the catalog grants no permissions. Defaults apply to new sessions. You can skip every step, use the local demo, and configure later in Settings. The skip preference is scoped to this home/profile in this browser.

## One versioned home

`agh home info` is a read-only JSON report. It never creates directories or imports another product's home. `AGH_HOME` must be absolute; the default is `~/.agh`. The table defines the single supported layout and the paths for each role.

| Role | Path under AGH_HOME |
| --- | --- |
| Layout marker and instance identity | `home-layout.json`, version 1 |
| Profile/configuration | `profiles/PROFILE/` |
| Credentials / OAuth | `secrets/` / `auth/` |
| Ledger and session storage | `data/` |
| Installed packages | `data/profiles/PROFILE/packages/` |
| Runtime generations | `profiles/PROFILE/.runtime-generations/` |
| Logs and audit | `data/audit/` |
| Redacted error diagnostics | `diagnostics/errors.jsonl` |
| Cache | `cache/` |
| Temporary runtime files | `tmp/` |

The runtime creates missing housekeeping directories; PackageManager alone creates the live package store. Fresh startup creates missing directories with mode 0700 and a marker with mode 0600. Existing permissions are inspected, never silently repaired. Saved credential/configuration files require 0600. Package code has its own executable requirements; diagnostics do not recursively chmod plugins. Explicit profile data-directory overrides retain their existing meaning; `home info` lists the conventional layout, not those overrides.

A fresh home must be absent or empty. A non-empty directory without the version marker, or an unsupported marker version, is rejected with a localized message. Select a new empty private directory with AGH_HOME. Inspection and refusal leave existing files untouched.

## Read diagnostics

```sh
agh doctor --json
agh doctor --probe --json
```

The default command checks Node, native helpers, layout, permissions, credential storage, sandbox boundary, daemon connection, disk space, model configuration, plugin integrity and local MCP isolation readiness. Every section reports `ok`, `warn` or `fail` plus a stable localized fix-hint key. Exit status is 1 when any check fails. It returns metadata, not credential values, provider endpoints or exception bodies.

Model services are never contacted by the default check. `--probe` explicitly tests enabled accounts, with a shared 45-second bound and cancellation; it may incur charges. The pre-existing `doctor provider --probe` minimal inference and named diagnostics remain available. `doctor platform` gives the detailed Linux bubblewrap/Landlock probe; binary presence alone does not establish isolation. MCP readiness does not certify a particular server's trust, profile or connectivity.

Web displays failed checks as a dismissible notice and offers **Settings → Diagnostics → Self-check**. **Check again** reads local state; **Test model accounts** explicitly contacts providers. Diagnostic failures do not prevent skipping setup. For socket, port, home or credential failures, follow [troubleshooting](troubleshooting.md).

Contract: [App Server](../reference/app-server.md); implementation: [home layout](../../packages/host-common/src/home-layout.ts), [doctor](../../packages/host-infrastructure/src/doctor.ts).
