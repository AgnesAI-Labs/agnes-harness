# Sessions and recovery: continue your work

English | [简体中文](sessions.zh-CN.md)

<a id="会话与恢复让工作接续起来"></a>

[Documentation](../README.md) · [Security boundaries](security.md)

Work can continue across multiple terminal or browser visits. Use an explicit session ID to recover context, inspect execution records, and decide the next step.

A session contains task history, model selection, and execution state. A user request starts a run. CLI, Web, and SDK read the same backend facts, but a UI history projection is not a raw database backup.

<a id="找到并继续会话"></a>

## Find and resume a session

```sh
node packages/cli/dist/local/agnes.mjs sessions --json
node packages/cli/dist/local/agnes.mjs sessions show SESSION_ID
node packages/cli/dist/local/agnes.mjs resume SESSION_ID -p "Continue explaining the unfinished parts"
node packages/cli/dist/local/agnes.mjs -p --resume SESSION_ID "Continue our previous discussion"
node packages/cli/dist/local/agnes.mjs -p --continue "Continue"
```

`--continue` and `--resume` are mutually exclusive. Use an explicit ID when precision matters to avoid resuming an unintended recent session. Check working directory, model, and permissions separately for new and resumed sessions. Switching a Web workspace does not transfer existing sessions to a different daemon.

<a id="导出与导入"></a>

## Export and import

```sh
node packages/cli/dist/local/agnes.mjs export SESSION_ID --format agnes -o session.jsonl
node packages/cli/dist/local/agnes.mjs export SESSION_ID --format sharegpt -o training.json
node packages/cli/dist/local/agnes.mjs export SESSION_ID --html -o session.html
node packages/cli/dist/local/agnes.mjs import session.jsonl --from auto --key agnes:local:default:import:dm:docs-copy
```

The native import above uses a new session key. Choose a previously unused key for each trial. Omitting the key may point back to the original session; open or nonempty targets are rejected. Import is a one-shot path and does not support `--connect`. An imported session records its origin in its first event (`session/start` field `imported`: the source format, and for a native import the original session key); a Web diagnostics export of it carries an `imported` warning.

Exports may contain prompts, tool arguments, paths, and business data. Review them before sharing. `--raw` reduces privacy filtering and is not the default sharing method. Importing external formats such as Claude Code, Codex, or Pi converts data; it does not restore the original permissions or process, or guarantee lossless semantics. Preserve import errors and inspect the session list. Changing IDs and retrying is not a substitute for diagnosing a failure.

<a id="中断与重启"></a>

## Interruptions and restarts

A stop request, process exit, expired approval, and completed run are different events. Core recovers through persistent events and a state machine. Unknown side effects may require human confirmation. Recovery cannot guarantee exactly-once operations in external systems, and resending the same natural-language request is not a recovery protocol.

After a daemon failure, preserve the home and error, inspect `daemon status`, restart with the same profile, and check history before continuing. Do not delete SQLite, owner, or audit records to force a restart. Stop the relevant instance before backing up related data from its home. Copying a database file while it is being written is not a reliable backup.

TUI `/rewind SEQ` and Web forking create a new session from a historical point. They do not undo file writes, recall network requests, or invalidate completed tools. Recovery applies current permissions; past authorization is not revived automatically.

<a id="打开很大的旧会话"></a>

## Opening a very large session

A session with years of history or large attachments can take a while to open, because its whole history is checked before anything in it is trusted. While it opens:

- The daemon reports progress at least every 5 seconds. After 2 seconds the Web status line says how far it has got, for example "Still loading: checking history 40%".
- A client gives up only after 30 seconds with no word from the daemon (SDK `session.load` throws `LoadStalled`, code `LOAD_STALLED`), or after 10 minutes in all. A slow open that keeps reporting progress is left to finish. SDK callers can change both limits with `idleTimeoutMs` and `hardTimeoutMs`.
- After 10 seconds the Web shows the session's latest history read straight from storage, read-only, with a notice above it. It switches to the live session by itself when the open finishes. If the open fails, the stored history stays on screen with the reason.

The stored history is not verified: no integrity check ran on it, so treat it as a view for reading, not as proof of what the session contains. Large attachments appear in it as placeholders. Only a daemon that runs its sessions in workers reads it; an in-process daemon refuses the request (`stored-opening-unavailable`).

<a id="历史完整性校验"></a>

## History integrity

Every session's history is a hash chain, checked when the session opens. A session that was closed cleanly records how far its history was last checked, so reopening it shows the history before that part has been checked again and checks the full chain in the background. Until that check finishes, the session still accepts new messages and changes to queued input, but it starts no step: nothing is sent to the model and no tool runs, and its title is not generated. Forking the session, exporting it, and other writes such as stopping a turn or answering an approval wait for the check as well.

Some work does run before the check finishes, on the history as shown: the extension hooks that run when a session opens (`session_start`, `resources_discover`). A write that waits for the check holds the session's lock while it waits, so a new message sent behind it is accepted only once the check has finished.

If the check finds a changed record or a gap in the sequence, the session stops accepting anything, and every client attached to it is told that its history failed the check, whether the daemon runs sessions in workers or in its own process. The Web stops following the session, disables input, and shows the history read straight from storage, read-only and marked as not verified, with the reason; where storage cannot be read, the transcript already on screen stays with the same notice. The terminal UI says so in its status line and refuses further input. Requests about that session (opening, attaching, projecting, prompting, verifying, exporting, approving) are refused with `E_LEDGER_INTEGRITY`, and a client that reconnects gives that session up instead of retrying it.

The session is not reopened automatically. A failed check drops the record of how far the history was checked, so the next open, which someone has to ask for, checks the whole history from its first record: a history that was really changed is refused again. A record of the check that is itself wrong (it hashes correctly but names the wrong position or digest) makes an intact history fail once in the background; the next open checks everything from the first record and succeeds.

Known limits: the chain cannot show that records were removed from the end of a history; when a history ends before the position it was last checked to, the daemon writes a warning to its runtime log. `agh export` without `--raw` asks for the check once and then reads the history through the event stream; if the session's worker is put to sleep and woken between the two, the woken session shows its history before checking it again, so the export could read rows that check has not finished on. That needs something writing to `sessions.db` meanwhile. Do not edit `sessions.db` by hand; restore a backup taken while the instance was stopped instead.

Implementation: [session SDK](../../packages/sdk/src/session.ts), [Core](../../packages/core/src), [import](../../packages/cli/src/commands/import.ts), [export](../../packages/cli/src/commands/export.ts).
