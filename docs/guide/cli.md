# CLI and TUI

English | [简体中文](cli.zh-CN.md)

<a id="cli-与-tui"></a>

[Documentation](../README.md) · [Full command reference](../reference/cli.md)

Use the CLI in terminals and scripts, and the TUI for ongoing conversations, context inspection, and approvals. Begin with a one-shot task, then use an interactive session when needed.

Examples assume the repository root as the working directory. From another directory, use an absolute path to the built entry point. Put a subcommand before the options that belong to it.

<a id="一次性输出"></a>

## One-shot output

```sh
node packages/cli/dist/local/agnes.mjs -p "Explain this project"
printf '%s\n' 'Summarize this text' | node packages/cli/dist/local/agnes.mjs -p
node packages/cli/dist/local/agnes.mjs --mode json --chunks --meta "Explain this project"
```

`--mode json` automatically selects print mode. JSON output is suitable for programmatic consumption, but stderr may still contain runtime warnings. Check the exit code: partial text is not proof of success. `--park` lets a one-shot call wait for approval. A script without an available approval interaction cannot approve dangerous actions on its own.

By default, the CLI connects to or starts the shared local daemon. `--connect TARGET` selects an explicit target and does not fall back on failure. `--standalone` uses an embedded runtime; `--ephemeral` selects temporary execution. ACP is available through `acp` or `--mode acp`; do not assume it shares the ordinary daemon mode's lifecycle.

<a id="交互式终端"></a>

## Interactive terminal

```sh
node packages/cli/dist/local/agnes.mjs
```

Type `/` to see the current menu. Common actions:

| Action | Usage |
| --- | --- |
| New task / history | `/new`, `/sessions`, `/resume [id]` |
| Model / preset | `/model`, `/model main ROUTE/MODEL`, `/preset NAME` |
| Context / usage | `/context`, `/usage`, `/cost` |
| Compaction | `/compact [instructions]`; inspect the receipt for execution, skip, or failure |
| Fork | `/rewind SEQ` creates a new session; it does not roll back the filesystem |
| Plugins | `/packages`, `/install SOURCE`, `/package ...` |
| Resources | `/skills`, `/skill refresh ...`, `/mcp ...` |
| Display / exit | `/theme [light\|dark\|mono]`, `/help`, `/quit` |

TUI `/package` and shell `package` have different subcommand sets. Updates can be started from TUI/Web, but shell `package update` is not implemented. Follow the [lifecycle guide](packages.md).

When an approval card appears, inspect the tool, arguments, and scope, then choose an available allow/deny/abort option. `/yolo` skips approvals for the remainder of the current session and cannot be undone in that session. It is not a beginner default and does not remove sandbox or other permission constraints.

<a id="退出码"></a>

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Completed |
| 1 | Execution failure or unknown error |
| 2 | Argument or startup error |
| 3 | Parked and waiting |
| 4 | Budget limit / blocked |
| 5 | Maximum steps reached |
| 130 / 143 / 129 | SIGINT / SIGTERM / SIGHUP |

Implementation: [arguments and usage](../../packages/cli/src/args.ts), [exit codes](../../packages/cli/src/errors.ts), [TUI commands](../../packages/cli-tui/src/commands.ts).
