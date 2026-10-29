# First run, home layout and diagnostics

English | [简体中文](getting-started.zh-CN.md)

[Documentation](../README.md) · [Build and install](install.md) · [Run your first task](quickstart.md)

Previous-version users: follow the [upgrade guide](upgrade-from-previous.md) to back up and clean up first. The fresh-environment steps below do not migrate old data.

## Start an isolated instance

Complete the source build first. From the repository root:

```sh
export AGH_HOME="$(mktemp -d /tmp/agh-home-XXXXXX)"
export AGNES_PROFILE=local-dev
node agnes.mjs serve
```

For an installed distribution use `agh serve`. Keep the complete distribution and matching native helpers. The terminal prints the loopback URL, selected home, profile and diagnostic summary. Open that URL. Use the same environment in other terminals; a second `mktemp` selects a different instance. Set `AGNES_LOCALE=zh-CN` for Chinese CLI messages. Web has its own language preference.

With no saved model accounts or previous sessions, Web offers three steps: connect a model, choose a work folder, and start a conversation. Enter your API key in the guide and choose **Verify & continue**, or choose the local Demo without a key. Choosing Demo selects it for your first conversation without another model-picking step. It runs locally without reasoning; connect a real model later in **Settings → Models**. Account setup reuses the Settings credential and OAuth flows; the default model is selected after verification. Advanced connection and model options are folded away. Tests contact the selected provider and may incur charges. The final step links to demos in **Agents**; opening the catalog grants no permissions. Defaults apply to new sessions. You can skip at any time and configure later in Settings. The skip preference is scoped to this home/profile in this browser.

At the folder step, **Choose folder** opens the system picker. While it is open, the guide explains that its window may be behind the browser; check the Dock/taskbar, use **Cancel**, enter a folder path manually, or skip. Opening or cancelling the picker does not select a folder or advance the step. Only a successfully admitted folder is kept; leaving the guide cancels its pending picker.

The composer lists models from enabled accounts and refreshes after account changes, including when you installed a plugin first. New conversations use the default account's model unless a saved user choice or an administrator's model default takes precedence. A remembered Demo choice yields to an available real account default for new conversations; existing sessions keep their model. The local Demo is a fresh-home fallback: saving an account replaces it with the configured models; deleting the last account leaves the picker empty until another account is enabled.

On a fresh local-dev home, the plain TUI also offers **Try local Demo / skip setup (no API key)**. Choose it to continue through the existing local teaching backend without creating a model account. Escape still cancels setup.

To add another account, open **Settings → Models → Add account**. Choose a provider, enter the key and choose **Verify & save**. The account name and endpoint are filled in for you; expand **Advanced options** to change them. A failed operation keeps the draft. Account row menus contain default selection, enablement and removal; removal requires a second confirmation.

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

SQLite has its own data-format gate, independent of the home marker. `E_DATA_DIR_STALE` requires stopping AGH, backing up and resetting only the named ledger files and `tables/`, preserving `profiles/`; `E_DATA_DIR_NEWER` requires upgrading AGH. Nothing is migrated. Follow [data-format recovery](install.md#data-format-and-upgrade) before deleting anything.

## Read diagnostics

```sh
agh doctor --json
agh doctor --probe --json
```

The default command checks Node, native helpers, layout, permissions, credential storage, sandbox boundary, daemon connection, disk space, model configuration, plugin integrity and local MCP isolation readiness. Every section reports `ok`, `warn` or `fail` plus a stable localized fix-hint key. Exit status is 1 when any check fails. It returns metadata, not credential values, provider endpoints or exception bodies.

Model services are never contacted by the default check. `--probe` explicitly tests enabled accounts, with a shared 45-second bound and cancellation; it may incur charges. The pre-existing `doctor provider --probe` minimal inference and named diagnostics remain available. `doctor platform` gives the detailed Linux bubblewrap/Landlock probe; binary presence alone does not establish isolation. MCP readiness does not certify a particular server's trust, profile or connectivity.

Web displays failed checks with the number of problems and offers **Settings → Advanced → Run diagnostics → Self-check**. Dismissing the notice hides it for seven days in this browser for the current home. **Check again** reads local state; **Test model accounts** explicitly contacts providers. Diagnostic failures do not prevent skipping setup. For socket, port, home or credential failures, follow [troubleshooting](troubleshooting.md).

Contract: [App Server](../reference/app-server.md); implementation: [home layout](../../packages/host-common/src/home-layout.ts), [doctor](../../packages/host-infrastructure/src/doctor.ts).
