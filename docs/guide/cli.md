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
node agnes.mjs --mode json "Explain this project"
node agnes.mjs --mode stream-json "Explain this project"
```

`--mode json` and `--mode stream-json` automatically select print mode. `--mode stream-json` writes one `{"schema":"agnes-cli-event/v1","event":{…}}` line per session event as it arrives (the event is the session event envelope), and the last line is always the same `agnes-cli-result/v1` result line that `--mode json` writes; exit codes and stderr do not change. Both formats are `v1`: fields may be added, but existing ones keep their meaning. JSON output is suitable for programmatic consumption, but stderr may still contain runtime warnings. Check the exit code: partial text is not proof of success. A one-shot call parks for approval only when the profile sets `limits."approval.park"`; a parked call prints `parked ticket=… session=…` and exits with code 3. The `--park` flag is refused. A script without an available approval interaction cannot approve dangerous actions on its own.

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
| Queued messages | While a turn runs, Enter queues the message in the daemon and it is sent automatically when the turn ends; Alt+Enter inserts it into the running turn instead (it is queued when the turn takes no guidance). Nothing is held by the TUI, so the queue survives exiting it and every client of the session sees it. `/queue` lists the queued messages and manages them by number: `/queue edit N` takes one back into the editor (its attachments are sent with the next message), `/queue drop N` discards it, `/queue now N` stops the running turn and sends it first, and `/queue steer N` turns it into guidance for the running turn. Alt+Up takes the newest queued message back into an empty editor. An action on a message that was already sent or removed says so |
| Model / preset | `/model`, `/model main ROUTE/MODEL`, `/preset NAME` |
| Context / usage | `/context`, `/usage`, `/cost` |
| Status | `/status` shows the session, preset, model, workspace, `AGH_HOME`, connection (local daemon or `--connect`), context use, cost, queued inputs and YOLO on one screen; a value that cannot be read shows `-` |
| Copy | `/copy` copies the last reply to the clipboard, `/copy N` the Nth from the end, `/copy code` the last code block of the last reply |
| Workspace changes | `/diff` lists the files this session changed (`+added -removed path`) and shows the diffs of the first three; `/diff turn` covers only the last turn and `/diff [turn] PATH` shows one file in full. A list that was cut off, a file with no diff (binary, too large) and a session record that does not cover every change are each stated |
| Compaction | `/compact [instructions]`; inspect the receipt for execution, skip, or failure |
| Fork | `/rewind` opens a picker of completed turns; `/rewind SEQ` forks at a sequence number. Either creates a new session and does not roll back the filesystem |
| Plugins | `/packages`, `/install SOURCE`, `/package ...` |
| Resources | `/skills`, `/skill refresh ...`, `/mcp ...` |
| Display / exit | `/theme [light\|dark\|mono]`, `/mouse`, `/thinking`, `/help`, `/quit`. `/thinking` switches, for this run only, between folding the model's thinking once its answer starts (the default: while it thinks, the last three rows show above the reply, then they become one line saying how much it thought) and keeping it open. `/mouse` turns mouse reporting off or on for this run: off, your terminal selects and copies text itself, but the wheel sends arrow keys that walk the prompt history. A copy reports Copied, Sent to clipboard (only the terminal was asked, as over SSH) or Copy failed |

Choose what a new session may do when you start it, for example `node agnes.mjs --permission read-only`; `--preset NAME` picks the recipe independently (see [permissions and presets](security.md#permissions-and-presets)). `/preset NAME` switches the open session's preset and keeps its permission; a different permission needs a new session.

Messages you send, slash commands included, are kept in `<AGH_HOME>/tui-history.jsonl` (readable only by you, the newest 500, immediate repeats skipped), so ↑ still finds them after a restart. Ctrl-R opens a reverse search: type to narrow, press Ctrl-R again for an older match, Enter puts the match in the input box without sending it, and Esc leaves the search and brings back the draft. If the file cannot be read or written, history lasts only for the current run.

Editing keys follow readline. Ctrl-A and Ctrl-E go to the start and end of the line, Ctrl-B and Ctrl-F move one character, and Alt-B, Alt-F or Ctrl-Left, Ctrl-Right move by word (Chinese text is cut into words). Ctrl-K cuts to the end of the line, Ctrl-U to its start, Ctrl-W or Alt-Backspace the word before the cursor and Alt-D the word after it; Ctrl-Y pastes the last cut back. There is one cut buffer inside the running TUI, each cut replaces it, and it never touches the system clipboard.

Ctrl-Z undoes the last edit in the input box and Ctrl-Shift-Z redoes it (redo needs a terminal that reports Shift, such as kitty). A run of typed characters is one step; each delete and each paste is a step of its own. The last 100 steps are kept, and sending the message or switching sessions clears them.

In a draft of several lines, ↑ and ↓ first move the cursor between the lines and keep its column; history is walked only when ↑ is pressed on the first line or ↓ on the last.

Ctrl-G edits the draft in your own editor: `$VISUAL`, else `$EDITOR` (the command may carry arguments, such as `code -w`; it is started directly, not through a shell). The draft goes to a file only you can read under `<AGH_HOME>/tmp/`, the TUI gives the terminal to the editor, and when the editor exits with status 0 the file replaces the draft. A non-zero status keeps the draft and shows a Cancelled notice. The file is deleted afterwards. With neither variable set, Ctrl-G says how to set one and does not guess an editor. This also works over `--connect`, since the editor runs on your machine and only your local draft changes.

The session, model and theme pickers filter as you type, ignoring case, over each row's title, id and time. The top line reads `Filter: xx (3/20)`: matches out of all rows. Backspace deletes a character, Esc clears the filter first and closes the picker only when it is already empty, and the number keys pick a row only while the filter is empty (otherwise a digit is part of the filter).

After you scroll up with PageUp or the wheel, a line above the function-key row reads `↓ New output below · End to jump back` once something new has arrived. End (or Ctrl-End) returns to the newest rows and follows new output again. While the input box holds a draft, End keeps moving the cursor to the end of its line, so only Ctrl-End jumps back and the line says so.

TUI `/package` and shell `package` have different subcommand sets. Updates can be started from TUI/Web, but shell `package update` is not implemented. Follow the [lifecycle guide](packages.md).

Leaving the TUI gives the terminal back exactly as it was before; the conversation is not printed again. If this run sent at least one message in the current session and the output is a terminal, one line is left behind, `agh --resume ID`, to return to that session.

Ctrl-O expands the latest tool card and reads the whole call and result from the daemon; while it loads, or if it cannot be read, the card keeps its preview and says why. Consecutive `read`, `grep`, `find` and `ls` calls collapse into one card such as `Read 4 files · Searched 2 times`; opening it lists each call's title row, and any other call ends the group. With mouse reporting on, clicking a card's title row opens or closes that card; Ctrl-O still toggles the latest. A collapsed card previews up to three screen rows of the result and `… N more lines`; `edit` and `write` show `+a -b` after their name instead, and open to a line diff of the change. Plan, subagent, job and workflow tool calls get cards of their own: a plan shows one row per step with its state, the others show their name, state, run time when the timeline has it, and a one-line summary.

Pasting works as in any terminal editor. The TUI asks the terminal for bracketed paste, so a pasted block arrives in one piece, line breaks included: `\r` and `\r\n` become newlines, tabs become two spaces and other control bytes are dropped. A paste of more than 10 lines or 1000 characters shows in the input box as one chip such as `[Pasted #1 · 42 lines]`; Backspace removes the whole chip and Enter sends the full original text. Chips exist only in the running TUI.

When an approval card appears, inspect the tool, arguments, and scope, then choose an available allow/deny/abort option. The dialog and the card show the same body: the tool, a risk label, and for `edit` and `write` a line diff of the change; the dialog keeps the raw input below it (PgUp/PgDn scroll). Option labels state their scope, for example "Always allow in this session"; Enter still starts on Reject. `/yolo` enables full access for the current session: it skips tool approvals and allows file reads and writes inside and outside the workspace. Explicit policy denies, operating-system permissions, and configured command sandbox limits still apply. New sessions inherit the saved permission selection. `/yolo off` asks for routine approvals again.

While the terminal reports focus, the TUI rings the bell once when a turn ends and once for each approval that starts waiting, but only when the window is in the background. The window title reads `agh · DIRECTORY`, with `… ` in front while a turn runs and `! ` while an approval waits, and the previous title comes back on exit. A terminal that does not report focus never gets the bell.

`/plan`, `/plan on`, `/plan off`, and `/plan <instruction>` use the selected backend plan service in both TUI and Web. `/plan status` reports the mode; `/plan pending` shows the last submitted plan. If the backend is disabled or unavailable, the UI reports plan mode off. Existing `.agh/plan-mode.json` files are read without migration. Plan mode blocks write and execution tools even with full access; leaving through `exit_plan_mode` still requires human approval of the exact plan revision. An explicit human `/plan off` remains available.

Esc during a turn interrupts it and keeps the message you were writing. With no turn running, Esc clears the draft, and pressing Esc twice within half a second on an empty editor opens the `/rewind` picker; while the `@` file menu is open it only closes that menu. Ctrl-C still interrupts a turn, and pressing it twice within a second quits. Both keys interrupt any turn the session is running, including one another client started: the daemon lets the session owner stop it and refuses anyone else.

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
