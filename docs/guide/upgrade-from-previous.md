# Upgrade from the previous AGH

English | [简体中文](upgrade-from-previous.zh-CN.md)

[Documentation](../README.md) · [Installation](install.md) · [Quickstart](quickstart.md)

This page is for people who ran AGH from `main` before the plugin-kernel release. This release is a new product: capabilities are composed as plugins, agents have explicit launch declarations, applications select their presentation, and the Web workbench has changed. **There is no migration of the old environment.** Start with a clean home and configure the new product again.

Saved sessions, schedules, installed plugins and their trust, runtime generations, settings, model accounts and sign-ins do not carry over. Backups preserve old files for reference; copying them into the new home does not make them compatible. Plugin hot updates within the new architecture are a separate feature.

## What happens with an old environment

The new runtime refuses the retired `AGNES_HOME` variable, even if `AGH_HOME` is also set:

```text
E_HOME_INVALID
AGNES_HOME is no longer supported; unset it and set AGH_HOME to a new, empty private directory (clean home).
```

An occupied home without the supported layout marker produces this English message (the directory line contains your actual absolute path):

```text
E_HOME_VERSION: An old or unversioned AGH home was found. This version is a new product and cannot use this layout. Old data will not be migrated.
Old environment directory: <absolute home path>
Remove or move this directory before restarting, or set AGH_HOME to a different, new, empty private directory. Existing files were not changed.
Details: https://github.com/AgnesAI-Labs/agnes-harness/blob/main/README.md#new-product-clean-home
```

An invalid or unsupported marker also produces `E_HOME_VERSION`. Do not create or edit `home-layout.json` to bypass it.

A supported home has a separate SQLite data gate. The current `DATA_DIR_VERSION` is **2**. For example, a nonempty format-1 database produces `E_DATA_DIR_STALE` with the following message, substituting the actual paths:

```text
data directory <dataDir> was created by an older AGH (data format 1; this build supports 2). Stop AGH, back up <dataDir>, then delete <dataDir>/sessions.db, <dataDir>/sessions.db-wal, <dataDir>/sessions.db-shm and the directory <dataDir>/tables. Sessions, schedules, workspace bindings and plugin settings are lost; plugins you installed yourself must be reinstalled. Nothing was changed.
```

Unversioned databases, retired tables, or package tables without their ledger also cause `E_DATA_DIR_STALE`. `E_DATA_DIR_NEWER` means a newer build wrote the data: upgrade AGH, rather than downgrading its version stamp. The limited ledger reset for a **supported home** is in [data-format recovery](install.md#data-format-and-upgrade); it preserves profiles and is not a migration from the previous product.

## Locate everything before cleanup

Home resolution uses an explicit `AGH_HOME`, otherwise `HOME` plus `.agh`, otherwise the OS home plus `.agh`. The previous version also accepted `AGNES_HOME` after `AGH_HOME`; record that old value before unsetting it. On Windows, a custom `HOME` overrides the usual user-profile fallback. Paths below are defaults, not a reason to delete a similarly named directory belonging to another product.

| Platform | Default AGH home | Default data directory | Default profile directory |
| --- | --- | --- | --- |
| macOS | `$HOME/.agh` | `$HOME/.agh/data` | `$HOME/.agh/profiles/local-dev` |
| Linux | `$HOME/.agh` | `$HOME/.agh/data` | `$HOME/.agh/profiles/local-dev` |
| Windows | `%USERPROFILE%\.agh` | `%USERPROFILE%\.agh\data` | `%USERPROFILE%\.agh\profiles\local-dev` |

Use your actual OS home if it differs. `AGNES_PROFILE` or `--profile` selects another profile; back up **all** profiles. Let `H` be the actual home, `D` the configured data directory (normally `H/data`) and `P` a profile name:

| Location | What it holds / what to preserve before removal |
| --- | --- |
| `H/profiles/P/` | Profile YAML, `configuration.json`, package locks, configuration and trust metadata; `.runtime-generations/` retains composed code generations |
| `D/sessions.db`, `D/sessions.db-wal`, `D/sessions.db-shm`, `D/tables/` | Session ledger and package-owned state, including schedules and settings; back up the whole `D` after stopping |
| `D/profiles/P/packages/`, `D/profiles/P/.runtime-snapshots/` | Installed plugin bytes and retained package snapshots |
| `H/plugins/` | User plugin source discovered by the runtime; preserve your authored code separately and review it against the new API |
| `H/secrets/`, `H/auth/` | Credentials and authentication state; keep backups private, and configure accounts again |
| `D/audit/`, `H/diagnostics/` | Audit/runtime logs and diagnostics; shell redirections may also have written logs elsewhere |
| `H/daemon/`, `H/cache/`, `H/tmp/`, `H/terminal-sessions/`, `H/memory/` | Daemon identity/discovery, caches, temporary files, terminal session choices and learned memory |
| `H/sessions.db` and its sidecars, if present | A historical home-root ledger; included when backing up the whole home |
| `PROJECT/.agh/` | Workspace deployment/configuration, plugins, Skills and hook files; these are outside the home and can affect the new runtime |

A profile's `dataDir`, `cacheDir`, or `adapters.secrets.path` can point outside `H`. Inspect the old profile and startup options, including `--data-dir`, and back up those **exact** external locations separately. Moving `H` alone does not remove them. Do not remove shared directories or project source. No automatic fallback to `~/.agnes` is used; handle that folder only if you explicitly configured it as this AGH instance's home.

## Stop, back up and remove the old environment

1. Finish or cancel old tasks, and stop the old Web/`serve` terminal with Ctrl+C. Disable any startup wrapper you configured so it cannot restart the instance.
2. **Use the old distribution**, with its original home, profile and any data-directory override, to run `daemon status`, `daemon stop`, then `daemon status` again. From the old source checkout these are `node agnes.mjs daemon status` and `node agnes.mjs daemon stop`; an installed old CLI uses `agh daemon …`. You can address the exact instance with `--home /absolute/old-home --profile PROFILE` and, if used originally, `--data-dir /absolute/old-data`. Do not use a new runtime that rejects the old layout to stop the old instance. If identity verification refuses, keep the files and follow [troubleshooting](troubleshooting.md); do not delete a live daemon's lock.
3. After confirming it stopped, move the old home to a backup name. This removes it from the active path while preserving all files, including hidden ones. The examples deliberately require you to enter the path you just verified and refuse an existing backup name.

macOS / Linux (POSIX shell):

```sh
agh_old_home='/absolute/path/to/old-home'
agh_backup="${agh_old_home}.before-plugin-kernel"
test -d "$agh_old_home" && test ! -e "$agh_backup" && mv -- "$agh_old_home" "$agh_backup"
unset AGNES_HOME
unset AGH_HOME
unset AGNES_PROFILE
```

Windows (PowerShell):

```powershell
$aghOldHome = 'C:\absolute\path\to\old-home'
$aghBackup = "$aghOldHome.before-plugin-kernel"
if (!(Test-Path -LiteralPath $aghOldHome -PathType Container)) { throw 'Old home not found' }
if (Test-Path -LiteralPath $aghBackup) { throw 'Backup already exists' }
Move-Item -LiteralPath $aghOldHome -Destination $aghBackup -ErrorAction Stop
Remove-Item Env:AGNES_HOME, Env:AGH_HOME, Env:AGNES_PROFILE -ErrorAction SilentlyContinue
```

Keep the backup private: it includes credentials and conversation data. Check that the move succeeded before proceeding. Repeat the move with distinct backup names for dedicated external data/cache/secret directories. In each workspace that used the old product, back up and move **only its `.agh` folder** out of the active path (for example to `.agh.before-plugin-kernel`). Review any authored plugin/Skill before deliberately reintroducing it; do not copy old deployment, lock or trust files back. Leave the rest of the project intact. Shared Skill roots such as `.agents/skills` are not AGH environment data to delete.

Also remove retired `AGNES_HOME` and old path overrides from shell startup files, launch scripts or persistent Windows environment settings that you configured. Unsetting a variable above changes only the current shell. To retain the backup and use a custom location, set `AGH_HOME` to a **different, unused absolute path** instead of restoring the old value. Let AGH create it, especially on Windows where it establishes private ACLs.

Once the backup has been checked and you no longer need its contents, permanent deletion is optional. Delete only the verified backup: `rm -rf -- "$agh_backup"` on macOS/Linux, or `Remove-Item -LiteralPath $aghBackup -Recurse -Force` on Windows, in the same shell with that variable still set. Do not run either command against the new home or project root.

## Install and start again

Follow [Installation](install.md) to build the new revision with its pinned toolchain, then [Quickstart](quickstart.md) to run `node agnes.mjs serve` and open the printed URL. The source preview does not promise a published npm installer. Windows still has no completed end-to-end acceptance or verified L1 command sandbox; see [platform limitations](../reference/limitations.md).

Add model accounts and credentials again, select a default model, reinstall and review your plugins, and recreate needed settings, workspace registrations and automation tasks. Use the [local Demo](demo.md) to check the fresh environment without a paid model. Old sessions will not appear in the new history.

For help, open a [bug report](https://github.com/AgnesAI-Labs/agnes-harness/issues/new?template=bug_report.yml) with the old/new revisions, OS, Node version and exact error code. Share only a redacted excerpt, never a home backup or credentials. Security reports follow [SECURITY.md](../../SECURITY.md).

Implementation: [home resolution](../../packages/host-common/src/paths.ts), [home layout](../../packages/host-common/src/home-layout.ts), [refusal text](../../packages/host-common/src/home-message.ts), [profile resolution](../../packages/host-common/src/profile/resolve.ts), [daemon scope](../../packages/daemon/src/supervisor/scope.ts), [data gate](../../packages/host-infrastructure/src/adapters/storage-sqlite-data-dir.ts), [package snapshots](../../packages/package-manager/src/runtime-snapshots.ts), [local plugins](../../packages/package-manager/src/local-source.ts).
