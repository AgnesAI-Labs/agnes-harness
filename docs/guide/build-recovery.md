# Recovering from an interrupted runtime build

English | [简体中文](build-recovery.zh-CN.md)

<a id="运行时构建目录中断后的检查"></a>

[Documentation](../README.md) · [Installation](install.md)

This guide covers CLI `build:local` and CLI/Daemon `build:runtime` output on Windows, macOS, and Linux. It does not cover live application upgrades or session-data migration.

The default `build:local` output is `packages/cli/dist/local`, with `local.build-lock`, `local.tmp-*`, and `previous` inside the lock. The examples below use `build:runtime` directory names; both builders use the same transaction mechanism.

A normal completed build leaves only `dist/agnes-runtime`. During a build, the sibling `agnes-runtime.build-lock` prevents another build, randomized `agnes-runtime.tmp-*` directories hold the uncommitted package, and `previous` inside the lock temporarily holds the old package.

On a lock error, do not delete the directory based on its name or age. First confirm the build process for that output has exited. Preserve output, lock, and staging directories to avoid concurrent modification.

- **Output exists and is complete:** Check file hashes in the aggregate manifest and the matching Node version, then determine whether preparation was interrupted or post-commit cleanup failed. In the latter case, `previous` may be incomplete and must not overwrite the current new package.
- **Output missing, `previous` exists:** The build may have stopped after moving the old package, or rollback may have failed. Verify the backup before restoring it to the original output path on the same filesystem. Preserve evidence on permission or file-lock errors; do not delete the backup first.
- **Output and backup both missing:** Cleaning the lock cannot restore the old package. Confirm the build process has exited, retain logs, fix permissions or disk problems, and rebuild from trusted source.

`build:local` has no aggregate manifest, so the `build:runtime` manifest check does not apply. Verify CLI, daemon, worker, Web, and platform-native files, and check startup using the matching Node version. If backup completeness is uncertain, preserve it and build trusted source into a new absolute directory using `build:local --output-dir <NEW_DIRECTORY>`. Do not combine old and new directories.

Only handle leftover locks and staging directories after confirming that output has been recovered and no build process is using it. Move evidence to a separate preservation directory on the same filesystem before retrying. On macOS/Linux, PID or directory age alone is also insufficient reason to delete a lock. The tools do not automatically take over locks or recover after forced termination, and do not guarantee atomic commits across filesystems or power-loss recovery.
