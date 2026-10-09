# Sessions and recovery: continue your work

English | [简体中文](sessions.zh-CN.md)

<a id="会话与恢复让工作接续起来"></a>

[Documentation](../README.md) · [Security boundaries](security.md)

Work can continue across multiple terminal or browser visits. Use an explicit session ID to recover context, inspect execution records, and decide the next step.

A session contains task history, model selection, and execution state. A user request starts a run. CLI, Web, and SDK read the same backend facts, but a UI history projection is not a raw database backup.

<a id="找到并继续会话"></a>

## A damaged log tail

Opening a SQLite ledger with a torn JSON/checksum tail preserves its verified prefix, durably quarantines the damaged raw rows and registers in a private `sessions.db.tail-<diagnosticId>.json` sidecar, and records a recovery diagnostic. The JSONL example similarly preserves exact damaged bytes in `store.jsonl.tail-<diagnosticId>.bin`. Web shows a localized notice with the diagnostic ID. Keep the sidecar when investigating a storage failure; it is not ordinary model context.

Outstanding effects are closed as unknown instead of being replayed, including normally replay-safe tools. Check the external result before requesting another operation. A valid event/transaction after damage, a missing chain link, or a damaged prefix referenced by a fork refuses automatic truncation. Unknown future format versions are refused explicitly; this recovery does not upgrade or migrate formats.

## Find and resume a session

```sh
node agnes.mjs sessions --json
node agnes.mjs sessions show SESSION_ID
node agnes.mjs resume SESSION_ID -p "Continue explaining the unfinished parts"
node agnes.mjs -p --resume SESSION_ID "Continue our previous discussion"
node agnes.mjs -p --continue "Continue"
```

`--continue` and `--resume` are mutually exclusive. Use an explicit ID when precision matters to avoid resuming an unintended recent session. Check working directory, model, and permissions separately for new and resumed sessions. Switching a Web workspace does not transfer existing sessions to a different daemon.

<a id="搜索历史"></a>

## Search history

Settings → History searches session titles and message text, filters by an exact workspace path, and pages the results. The index is a separate SQLite file rebuilt from the ledger. It does not modify the ledger. The read-only tools `session_search`, `session_event_search`, `session_trace`, `session_event_trace`, and `session_event_read` stay inside the caller's workspace and recorded owner.

<a id="导出与导入"></a>

## Export and import

```sh
node agnes.mjs export SESSION_ID --format agnes -o session.jsonl
node agnes.mjs export SESSION_ID --format sharegpt -o training.json
node agnes.mjs export SESSION_ID --html -o session.html
node agnes.mjs import session.jsonl --from auto --key agnes:local:default:import:dm:docs-copy
```

The native import above uses a new session key. Choose a previously unused key for each trial. Omitting the key may point back to the original session; open or nonempty targets are rejected. Import is a one-shot path and does not support `--connect`. An imported session records its origin in its first event (`session/start` field `imported`: the source format, and for a native import the original session key); a Web diagnostics export of it carries an `imported` warning.

Exports may contain prompts, tool arguments, paths, and business data. Review them before sharing. `--raw` reduces privacy filtering and is not the default sharing method. Importing external formats such as Claude Code, Codex, or Pi converts data; it does not restore the original permissions or process, or guarantee lossless semantics. Preserve import errors and inspect the session list. Changing IDs and retrying is not a substitute for diagnosing a failure.

<a id="中断与重启"></a>

## Interruptions and restarts

A stop request, process exit, expired approval, and completed run are different events. Core recovers through persistent events and a state machine. Unknown side effects may require human confirmation. Recovery cannot guarantee exactly-once operations in external systems, and resending the same natural-language request is not a recovery protocol.

After a daemon failure, preserve the home and error, inspect `daemon status`, restart with the same profile, and check history before continuing. Do not delete SQLite, owner, or audit records to force a restart. Stop the relevant instance before backing up related data from its home. Copying a database file while it is being written is not a reliable backup.

TUI `/rewind SEQ` and Web forking create a new session from a historical point. They do not undo file writes, recall network requests, or invalidate completed tools. Recovery applies current permissions; past authorization is not revived automatically.

Implementation: [session SDK](../../packages/sdk/src/session.ts), [Core](../../packages/core/src), [import](../../packages/cli/src/commands/import.ts), [export](../../packages/cli/src/commands/export.ts).

<a id="persistent-goals"></a>

## Persistent goals

The official default goal plugin keeps a session objective on the ledger. In Web, open the goal bar above the conversation to create/edit it, set automatic-round and optional credit limits, pause/resume, complete, or clear it. The CLI uses the same session input:

```text
/goal create --max-rounds 10 --budget 20 Deliver a tested patch
/goal edit --max-rounds 5 Deliver a smaller patch
/goal edit --budget none Remove the goal credit cap
/goal pause
/goal resume
/goal complete
/goal clear
```

/goal followed by an objective also creates a goal; /goal in the CLI displays its status. Options precede the objective. The default allowance is ten automatic rounds without an additional credit limit. Resume grants a fresh round allowance while keeping spend. Editing preserves phase and spend. The model can report completion or a blocker with evidence through goal_update, and cannot raise limits or resume itself.

Automatic rounds enter the next-turn inbox. Human controls take priority; stale rounds stop before model work. Completion, blockers, cancellation, errors and exhausted limits stop continuation. Credit checks occur between steps/turns; an in-flight response can exceed the goal limit, while normal model budget admission still applies. Unknown credit usage with a goal budget blocks continuation. Restored and forked active goals pause until explicit resume.

## Control running work

Sending while the agent is working queues a steer for the next step boundary, after the active model call or tool batch. Edit or withdraw it above the composer before delivery. **Interrupt now** on a queued message cooperatively stops the active step and runs that message next; committed effects remain committed and unknown outcomes remain unknown.

**Pause** waits for the next boundary; **Resume** continues the same turn. Reloading the browser or cold restarting the daemon keeps the pause. **Cancel** ends the turn and returns queued steers to the composer. The trace's **Human control facts** shows the actor, time, request and outcome. Controls use the session's pinned Loop generation, including during an upgrade. Unsupported controls are disabled with the pinned Loop's refusal reason.

SDK: `session.controls()` reads capabilities and state; `steer(content)`, `editQueued(itemId, content)`, `removeQueued(itemId)`, `interrupt(itemId)`, `pause()`, `resume()` and `cancel()` use durable commands. A Loop opts in through `LoopFactory.controls`; omission refuses steer, interrupt and pause.

The composer’s child tree lists owned workflow and sub-agent sessions with duration and token usage (unknown values stay explicit). **Stop child** cooperatively ends the child’s turn while keeping the workflow waiting; a continue message runs in the same child with its original constraints. SDK callers use `stopChild(childId)` and `continueChild(childId, text)`. Child and parent control facts retain the human actor. External child providers expose their own interrupt/continue capabilities; unsupported actions remain disabled. `controls({ afterSeq })` pages the complete control history using `factsThrough` and `factsMore`.
