# CLI and TUI

English | [简体中文](cli.zh-CN.md)

<a id="cli-与-tui"></a>

[Documentation](../README.md) · [Full command reference](../reference/cli.md)

Use the CLI in terminals and scripts, and the TUI for ongoing conversations, context inspection, and approvals. Begin with a one-shot task, then use an interactive session when needed.

Examples assume the repository root as the working directory. From another directory, use an absolute path to the built entry point. Put a subcommand before the options that belong to it.

<a id="一次性输出"></a>

## One-shot output

```sh
node agnes.mjs -p "Explain this project"
printf '%s\n' 'Summarize this text' | node agnes.mjs -p
node agnes.mjs --mode json --chunks --meta "Explain this project"
```

`--mode json` automatically selects print mode. JSON output is suitable for programmatic consumption, but stderr may still contain runtime warnings. Check the exit code: partial text is not proof of success. `--park` lets a one-shot call wait for approval. A script without an available approval interaction cannot approve dangerous actions on its own.

By default, the CLI connects to or starts the shared local daemon. `--connect TARGET` selects an explicit target and does not fall back on failure. `--standalone` uses an embedded runtime; `--ephemeral` selects temporary execution. ACP is available through `acp` or `--mode acp`; do not assume it shares the ordinary daemon mode's lifecycle.

Ordinary automatic connections reuse a ready daemon after checking the canonical home/profile/data path, owner identity, private socket permissions, protocol and CLI version, and authenticated readiness. They do not prepare local plugin snapshots or verify installed packages again; the daemon still authorizes RPCs and verifies code before execution. Missing or unhealthy daemons use full startup preparation. A version mismatch requires stopping and restarting the daemon with the current CLI. Doctor, recovery, embedded execution and Web launchers retain their preparation paths.

<a id="交互式终端"></a>

## Interactive terminal

```sh
node agnes.mjs
```

The input box's top edge shows the model, the directory with its Git worktree and branch, and how full the context is; `┊` marks where automatic compaction starts.

Type `/` to see the current menu. Common actions:

| Action | Usage |
| --- | --- |
| New task / history | `/new [DIR]`, `/sessions`, `/resume [id\|all]` (`all` lists every workspace), `/search QUERY` (admin connection) |
| Session housekeeping | `/pin`, `/unpin`, `/rename TITLE`, `/archive` |
| Approval grants | `/grants` lists what lets tools run unasked in this session ("this session" and "always"); `/grants revoke N\|ID` withdraws one (admin connection) |
| Deliverables | `/deliverables` lists the files this session delivered; `/deliverables save N\|ID [PATH]` downloads one after checking size and sha256 |
| Subagents | `/agents` lists the subagents this session can control; `/agents stop N\|ID` interrupts one and `/agents resume N\|ID MESSAGE` sends it more work. The daemon decides what is allowed and its refusal is shown |
| Background jobs | `/jobs` lists this session's background jobs; `/jobs stop N\|ID` kills one (the daemon refuses jobs an agent owns) |
| Queued messages | `/queue` lists the messages typed during a turn with Enter that wait for it to end; `/queue edit N` moves one back into the editor, `/queue drop N` discards it. The queue is kept by the TUI and is lost on exit. Alt+Enter during a turn still hands the message to the daemon's follow-up queue, which `/queue` does not show |
| Model / preset | `/model`, `/model main ROUTE/MODEL`, `/preset NAME` |
| Context / usage | `/context`, `/usage`, `/cost` |
| Compaction | `/compact [instructions]`; inspect the receipt for execution, skip, or failure |
| Fork | `/rewind` opens a picker of completed turns; `/rewind SEQ` forks at a sequence number. Either creates a new session and does not roll back the filesystem |
| Plugins | `/packages`, `/install SOURCE`, `/package ...` |
| Resources | `/skills`, `/skill refresh ...`, `/mcp ...` |
| Display / exit | `/theme [light\|dark\|mono]`, `/help`, `/quit` |

Choose what a new session may do when you start it, for example `node agnes.mjs --permission read-only`; `--preset NAME` picks the recipe independently (see [permissions and presets](security.md#permissions-and-presets)). `/preset NAME` switches the open session's preset and keeps its permission; a different permission needs a new session.

TUI `/package` and shell `package` have different subcommand sets. Updates can be started from TUI/Web, but shell `package update` is not implemented. Follow the [lifecycle guide](packages.md).

Ctrl-O expands the latest tool card and reads the whole call and result from the daemon; while it loads, or if it cannot be read, the card keeps its preview and says why. Plan, subagent, job and workflow tool calls get cards of their own: a plan shows one row per step with its state, the others show their name, state, run time when the timeline has it, and a one-line summary.

When an approval card appears, inspect the tool, arguments, and scope, then choose an available allow/deny/abort option. `/yolo` enables full access for the current session: it skips tool approvals and allows file reads and writes inside and outside the workspace. Explicit policy denies, operating-system permissions, and configured command sandbox limits still apply. New sessions inherit the saved permission selection. `/yolo off` asks for routine approvals again.

`/plan`, `/plan on`, `/plan off`, and `/plan <instruction>` use the selected backend plan service in both TUI and Web. `/plan status` reports the mode; `/plan pending` shows the last submitted plan. If the backend is disabled or unavailable, the UI reports plan mode off. Existing `.agh/plan-mode.json` files are read without migration. Plan mode blocks write and execution tools even with full access; leaving through `exit_plan_mode` still requires human approval of the exact plan revision. An explicit human `/plan off` remains available.

## Schedules and triggers

`agh schedules` and `agh triggers` manage the same scheduled tasks and webhook rules as the Web automation page, and need an admin connection. A task that repeats every minute: `agh schedules add --prompt "Summarise new issues" --every 1m --cwd .`; `agh schedules run ID` runs it now, `pause` and `resume` stop and restart it, `archive` removes it, and `show ID` lists its recent runs. Webhook rules are written as JSON (`agh triggers add --file rule.json`); the JSON is checked against the protocol schema before anything is sent, and `agh triggers test RULE` runs a synthetic delivery. A refusal prints its code and exits 1; `--json` prints what the daemon returned.

## Plugin configuration, tree and applications

These commands mirror the Web admin pages and need an admin connection. `agh plugins config get ID` lists a plugin's configuration rows with their value, schema summary and whether the value is valid; fields the schema marks `x-secret`, `writeOnly` or `credential-reference`, and keys that look like credentials, are printed as `[redacted]` in text and `--json`. Values are written from a JSON file, never from the command line: `agh plugins config validate ID [ROW] --file value.json` only checks, `set` checks first and saves nothing (exit 1) when the value is invalid. `agh plugins tree` and `generations` show the plugin tree and runtime generations; `tree apply --file artifact.json` and `tree rollback` change the runtime and print what they would do unless `--yes` is given. `agh app show` and `preview PACKAGE#APP` read the application state and the consent preview; `app adopt` also needs `--yes`. `agh package source-policy` prints the allowed package sources. A refusal from the daemon is printed as is and exits 1.

## Settings and credentials

`agh settings` changes the same settings as the Web settings pages and needs an admin connection. Without a section it lists them: `model-slots`, `child-engines`, `auto-review`, `system-prompt`, `memory`, `observability`, `search` and `session-defaults`. `agh settings SECTION` (or `get`) prints one line per value, `--json` prints what the daemon returned. `agh settings SECTION set --file settings.json` saves JSON (`-` reads stdin) after checking it against the protocol schema; for most sections a `get --json` document, edited, is a valid input. `agh settings system-prompt set --text "..."` replaces the whole system prompt (it needs `--yes`; an empty text removes the replacement). `memory` works on the directory given by `--cwd`. `agh settings search test --text "query" [PROVIDER]` runs one search. This is separate from `agh config`, which signs in accounts and dumps the effective run configuration.

`agh credentials` lists the generic API-key credentials (id, name, creation time, what uses them), renames one (`rename ID NAME...`) and deletes one (`delete ID --yes`; without `--yes` it only shows what would be deleted, and a credential that is still in use also needs `--force`). A secret value is never shown. Adding or replacing a value is done with `agh config`, not on the command line.

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

Use `/attach <path>` in the TUI to upload an original in bounded chunks and submit its receipt as a prompt. Paths may contain spaces. Common image, document, archive and media extensions carry their own MIME type; any other extension uploads as `application/octet-stream`, and a daemon allow-list refusal is shown as returned. Errors preserve the backend attachment reason. The current session owns the receipt; switching sessions before the upload completes refuses submission.
