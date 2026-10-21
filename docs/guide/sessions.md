# Sessions and recovery: continue your work

English | [简体中文](sessions.zh-CN.md)

In Web, recorded content becomes readable before execution admission finishes. You can edit a local text draft while “Preparing session…” is shown; sending, file references, attachments and approval actions wait for admission. Drafts belong to the current profile and session. Switching sessions cancels the old opening wait, preserves its text draft and leaves running agents alone. A failed admission keeps the record readable and offers a new-session recovery path; preparation never sends your draft automatically.

<a id="会话与恢复让工作接续起来"></a>

[Documentation](../README.md) · [Security boundaries](security.md)

Work can continue across multiple terminal or browser visits. Use an explicit session ID to recover context, inspect execution records, and decide the next step.

A session contains task history, model selection, and execution state. A user request starts a run. CLI, Web, and SDK read the same backend facts, but a UI history projection is not a raw database backup.

<a id="找到并继续会话"></a>

## A damaged log tail

SQLite histories are verified completely before session hooks, recovery, titles, tools or models can execute. An atomic append watermark also detects a removed tail. A corrupt row, a missing chain link or a mismatched head found by foreground verification refuses the open without truncating stored evidence. Preserve the database for investigation; use the read-only history view when execution is unavailable. Homes from the old, pre-plugin product remain unsupported. Earlier builds of this plugin architecture may lack append watermarks: their complete hash chain is still verified, and the next append atomically enables watermark protection without rewriting historical events. A tail removed before any watermark existed cannot be detected by that later protection.

Cold opens and reopening a live session use the same verified-head checkpoint. The foreground checks the tail after that checkpoint; cold opens also read and fold its prefix. A cold open then rehashes the complete prefix in the background. Only queued user input may be appended while that check runs: steps, forks and other writes wait. A changed stored byte found by a check seals the session and removes the checkpoint. Reopening a session that is still live in the same process does not rehash a prefix that process already hashed: only the tail after the checkpoint is checked, so a row changed before the checkpoint is found by the next cold open, not on reopen. Cancelling an opening wait does not release this execution gate. A fork still being created is refused if its parent closes, seals or changes verification cycle before the child is published. Already published children do not inherit later parent recheck gates.

A successful `session/load` or `_agnes/v1/session.open` response means the foreground check and session opening have finished; it does not promise that the checkpointed prefix has finished background verification. ACP load also replays recorded content, which may still be unverified. A prompt submitted at this point may queue, but its execution waits for the full check. If that check finds corruption, the existing ledger seal immediately refuses further input, model/tool execution, forks and checkpoint reuse, and deletes the verified-head checkpoint. A prompt already waiting for verification fails with `TURN_ERROR` carrying `E_LEDGER_INTEGRITY`; a later prompt is refused with `E_LEDGER_INTEGRITY`. A subsequent load/open reports `E_SESSION_CORRUPT` with the existing new-session recovery action. These RPC errors report the failure when an operation is requested; opening successfully is not a background-verification completion notification. Stored evidence is retained, and cancelling or disconnecting a client cannot authorize execution past the check.

Web can display an **unverified, read-only preview** while verification runs. Large stored payloads and inline media may appear as placeholders. The preview grants no execution authority; the live session replaces it only after verification succeeds. Recent-window and scan-budget markers identify omitted history. SDK `session.load(id, { onProgress })` reports verification and replay progress; `timeouts.loadIdle` (30 seconds) and `timeouts.loadHard` (10 minutes) independently bound a load. A timeout or disconnect cancels that connection's pending load. A live session's background integrity check continues independently.

While opening, the preview uses a neutral status line and stays readable at normal contrast. It remains visible after admission until the first formal projection replaces it; pending previews cannot overwrite that projection or change the admitted generation's readiness. The composer permits local text drafts while the session is being prepared; execution actions still wait for the formal opening and controls to be ready. A read-only warning with recovery actions appears only when opening is refused; it is not the ordinary loading state.

The JSONL persistence example has its own diagnostic sidecars; it does not define SQLite recovery policy.

Tool argument failures are corrected automatically. By default, two consecutive invalid calls to the same tool disable that tool for the rest of the turn; other tools remain available and a new turn starts fresh. Web groups the attempts in one collapsed technical record and uses text when a view cannot be generated. Content failures from the completion verifier receive at most one automatic correction, then stop with the existing text and a collapsed explanation preserved. The completion policy may also explicitly finish with the nonpassing verdict recorded. If the verifier or repair service is unavailable, the turn ends with an honest “could not complete verification” note. Human acceptance of unverified completion has been removed, and historical verifier questions are withdrawn automatically. Business approvals, unknown-effect reconciliation and budget approvals remain available. A failed operation is not recorded as successful.

## Find and resume a session

```sh
node agnes.mjs sessions --json
node agnes.mjs sessions show SESSION_ID
node agnes.mjs resume SESSION_ID -p "Continue explaining the unfinished parts"
node agnes.mjs -p --resume SESSION_ID "Continue our previous discussion"
node agnes.mjs -p --continue "Continue"
```

`--continue` and `--resume` are mutually exclusive. Use an explicit ID when precision matters to avoid resuming an unintended recent session. Check working directory, model, and permissions separately for new and resumed sessions. Switching a Web workspace does not transfer existing sessions to a different daemon.

A model-account change does not replace a saved session’s plugin code or permission policy. If its recorded model is no longer available, reopen the session and explicitly select an available model before continuing.

<a id="搜索历史"></a>

## Search history

Settings → History matches literal substrings in session titles (including Chinese) and phrases in message text, filters by an exact workspace path, and pages the results. The index is a separate SQLite file rebuilt from the ledger. It does not modify the ledger. The read-only tools `session_search`, `session_event_search`, `session_trace`, `session_event_trace`, and `session_event_read` stay inside the caller's workspace and recorded owner.

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

If a submitted steer, follow-up or queue control has no confirmed result, the SDK retains its
original command ID. Reconnect retries a pending command once. An uncertain acknowledgement,
`UNCERTAIN` error or another failed replay moves it to `needs-confirmation`, stops automatic
retries and allows the remaining commands and session subscriptions to recover. Definitive
refusals clear the command. `session.pendingCommands()` includes both pending and
needs-confirmation entries; `session.checkCommand(commandId)` explicitly checks using the
original payload and identity. Numeric success results are unchanged; submission errors carry
`submission: { sessionId, commandId, state }` while the SDK owns the command.

Web shows **Result unconfirmed. Please check before sending again.** (「结果未确认，请核对」)
and offers **Check result**. It does not restore the SDK-owned message as a fresh draft, and
blocks another send until the result is known. With browser storage available, the journal
survives reload in that tab. Selecting another session does not transfer its unresolved commands.
Queue promotion changes the existing item into guidance atomically, preserving attachments;
it never removes the item and compensates with another message.

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

For an exact raw export containing artifact references, use `node agnes.mjs export SESSION_ID --raw -o session.agnes`. Keep `session.agnes` together with `session.agnes.artifacts/`. The manifest binds the complete event stream and every declared original by size and SHA-256. Export reads originals through authenticated session/lane authority and checks their bytes; unavailable or mismatched originals refuse publication. Existing bundles are never overwritten. Redacted exports remain sharing formats and omit original bytes.

Import the bundle with `node agnes.mjs import session.agnes --key NEW_SESSION_KEY`. All declarations, event sequences, transaction boundaries and sidecar bytes are checked before a target is reserved. Originals are then rechecked and stored through the selected artifact seam with receipts scoped to the new session and lane. Pending receipts protect the bytes until the referencing ledger rows have committed, then are confirmed. A failed append or activation rolls back the new target. Original files left by a failed store operation remain content-addressed orphans for ordinary retention. Native bundles use the current product's event schema and are bounded to 32 MiB per original and 256 MiB of declared originals; they are not a reader for another product's session format.

## Control running work

Sending while the agent is working queues a steer for the next step boundary, after the active model call or tool batch. Edit or withdraw it above the composer before delivery. **Interrupt now** on a queued message cooperatively stops the active step and runs that message next; committed effects remain committed and unknown outcomes remain unknown.

**Pause** waits for the next boundary; **Resume** continues the same turn. Reloading the browser or cold restarting the daemon keeps the pause. If shutdown already ended the turn, Resume clears the retained pause so queued messages can run; it does not replay the ended turn. **Cancel** ends the turn and returns queued steers to the composer. The trace's **Human control facts** shows the actor, time, request and outcome. Controls use the session's pinned Loop generation, including during an upgrade. Unsupported controls are disabled with the pinned Loop's refusal reason.

SDK: `session.controls()` reads capabilities and state; `steer(content)`, `editQueued(itemId, content)`, `removeQueued(itemId)`, `interrupt(itemId)`, `pause()`, `resume()` and `cancel()` use durable commands. A Loop opts in through `LoopFactory.controls`; omission refuses steer, interrupt and pause. Without `afterSeq`, `controls()` returns the latest window of at most 200 facts (`facts[0].seq` is the earliest seq in that window) and sets `factsMore` when the window is full. Use `afterSeq`, starting at 0, to read history.

The composer’s child tree lists owned workflow and sub-agent sessions with duration and token usage (unknown values stay explicit). **Stop child** cooperatively ends the child’s turn while keeping the workflow waiting; a continue message runs in the same child with its original constraints. SDK callers use `stopChild(childId)` and `continueChild(childId, text)`. Child and parent control facts retain the human actor. External child providers expose their own interrupt/continue capabilities; unsupported actions remain disabled. `controls({ afterSeq })` pages the complete control history using `factsThrough` and `factsMore`.

## Original attachments

The original-upload path uses `_agnes/v1/session.fileUpload` with `destination: "original"`
and the active `laneId`. `start`, `chunk`, `status`, `finish` and `cancel` operate on a
session-scoped upload ID. Each chunk is at most 1 MiB and carries its SHA-256; `finish`
checks the complete digest and returns a pending attachment receipt. Submit that reference
in prompt content to commit it to the session. A finished, cancelled or expired upload ID
cannot be finished again. Interrupted intake can resume in the same live worker; a worker
restart requires a new upload ID. Intake expires after 30 minutes and reserves bounded quota.
Omitting `destination` retains the independent workspace-file upload semantics.

The SDK exports `uploadAttachment` and `cancelAttachmentUpload` for bounded original intake.
Web uses the same original receipts for files and images. Historical images load authorized
thumbnail/original references on demand; downloading an original preserves its bytes.
Model image renditions are provider-owned cached derivatives. The original is unchanged;
current-turn images must fit the selected model, missing older originals show a placeholder,
and an omitted historical prefix remains omitted across model changes and restart.
