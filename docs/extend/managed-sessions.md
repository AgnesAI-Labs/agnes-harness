# Plugin-managed sessions

English | [简体中文](managed-sessions.zh-CN.md)

[Author kit](README.md) · [Streams and managed services](transports.md) · [Bundles and profiles](bundles-and-profiles.md)

A profile-scoped, in-process managed service can open and drive sessions for the owner who trusted and enabled its plugin. The session belongs to the owner. The Host records the package and plugin row as its manager. The owner sees it in the Web, answers its approvals there, and can stop it. The plugin sees and drives only the sessions it manages, never the owner's own sessions or another plugin's, within the [trust boundary](#trust-boundary) of in-process code.

## Declare it

Set `sessions: true` on the managed service in `capabilities.managedServices`. Trust review shows the atom `managedSessions:profile:<id>`. The capability hash covers the flag, so adding it requires a new trust decision. Without the flag, every call on `init.sessions` is refused with `CAPABILITY_DENIED`. Session tools and hooks never receive the port.

```json
{ "id": "engine", "scope": "profile", "artifact": { "kind": "in-process" }, "sessions": true, "...": "..." }
```

## Authorize a workspace

A managed session opens only in a workspace the owner granted to its plugin. The owner grants it with the `agh` command line; the plugin has no way to grant, list or revoke workspaces, because the admin methods behind the command answer only the local owner over the Unix admin connection.

```sh
agh plugins grants grant @example/companion /work/repo
agh plugins grants list [@example/companion]
agh plugins grants revoke @example/companion /work/repo
```

The workspace must already be registered and present: starting `agh` in a directory registers it, and so does adding it in the Web workbench. The backend resolves the path with the same check `start` runs and stores the canonical root, so a symlink or a trailing slash names the same grant. A grant covers every plugin row of the package. An unknown package, a package without a `sessions` managed service, an unregistered path, or a plugin row id that another installed package also declares is refused and nothing is stored; managed sessions of such a shared row are refused too. After a revoke the next `send` is refused; a turn already running finishes. Revoke also works for a workspace deleted since it was granted. A grant belongs to the package and its plugin row together, so another package that declares the same row id never inherits it. Removing a package first revokes all of its grants and detaches all of its sessions, in one step; if that fails, the removal is refused and the package stays installed. A detached session stays yours in the Web and stays a managed session, with the same rules, but no package can list or reach it again. If the package manager refuses the removal after this step, the grants and sessions stay revoked and detached. A package installed again later under the same id starts with no grants and no sessions, and you grant again; a `startKey` the earlier package used opens a new session. Grants also exist only for plugin rows an installed package declares now. After every install, update, rollback and removal, at daemon start, and before every grant, list and revoke, the backend deletes the grant of any row its package no longer declares. That covers a row an update or rollback renamed, and a package whose manifest cannot be read.

## Use it

`start(init)` receives `init.sessions`, a [ManagedSessions](../../packages/extension-api/src/managed-sessions.ts) port.

```ts
const { sessionId } = await init.sessions.start({
  bundle: '@example/companion#worker',
  workspace: '/work/repo',
  input: 'Fix the failing test.',
  startKey: 'task-42',
  retention: 'task',
})
const sent = await init.sessions.send(sessionId, { text: 'Also update the changelog.', idempotencyKey: 'task-42:2' })
if (sent.state === 'notSubmitted') console.log(sent.reason) // busy | archived | duplicateKey
```

- `start` takes a reviewed Bundle of the calling package (`<package>#<bundle>`). The Bundle's launch decides the preset, as an application launch does. The workspace must be one the owner [authorized](#authorize-a-workspace) for this plugin. A repeated `startKey` returns the session it opened (`created: false`), including after a crash during the start. Every start, a retry included, passes the workspace, model and permission checks again. A retry that asks for a different Bundle, workspace, retention, permission, model or switch is refused with `START_KEY_REUSED`.
- `taskBinding: { id, generation }` (optional, added in 5.18.0) binds the session to a task of the calling service. A bound session refuses `send` with `CAPABILITY_DENIED` (`data.reason: 'OWNER_INPUT_REQUIRED'`, checked before archived, duplicate and busy); every later input goes through [`admitInput`](#admit-the-owners-input). Repeating a `startKey` with another binding or another first input is refused with `START_KEY_REUSED`.
- A session belongs to the package and plugin row that opened it. Another package that declares the same row id cannot list, read, stop or archive it, even after the first package is removed. Neither can a package installed later under the first package's id: removal detaches the session from every package. On every call the backend rechecks the calling row against current inventory: the package must be enabled and trusted, its service must declare `sessions`, and the row must be one of that package's own plugin rows. [Trust boundary](#trust-boundary) explains what this does not cover.
- An optional `model` selects the primary model route. A route the deployment lacks refuses the start. There is no fallback to the default route.
- Every managed session runs with the [outward checkpoint](../guide/security.md#outward-checkpoint) and its command rules. Each time the backend opens the session, its sub-agents, role children or forks, it turns the rules on, whatever opens them: the first start, a send after a restart, or a bound wake. A `git push`, a package publish or another outward command in its shell waits for a person, and so does a tool that declares itself outward. A terminal (`pty_open`, `pty_send`) and a persistent shell are refused, because the check cannot see their history. An opened session whose policy does not enforce the checkpoint is refused with `CAPABILITY_DENIED` and reason `OUTWARD_CHECKPOINT_UNAVAILABLE`; a start archives it. A session already open without the rules is refused with reason `OUTWARD_COMMAND_RULES_OFF` and is not reused.
- `permission: 'full-access'`, or a Bundle preset that puts the session under full access, is granted only when both gates hold. Before the session exists, the backend checks that its opener turns the command rules on and that the platform's sandbox probe reports a full OS boundary. After it opens, it reads the session's live policy: the outward checkpoint must be enforced and the session's sandbox enforcement must be full. A missing gate refuses the start, or the send, with `FULL_ACCESS_UNAVAILABLE` and `missing: 'outward-checkpoint'` or `missing: 'os-boundary'`. An unprobed or partial boundary counts as missing, and so does a policy the backend cannot read. Full access never answers an outward checkpoint; a person does. Every start is refused while the deployment reviews approvals automatically.
- `memoryWrites: false` refuses every durable memory write in the session before any approval is asked, so full access cannot allow one. It covers memory-file writes by tools, saves of refinement results to workspace or user memory (saved skills included), whether the owner, the model or an automatic offer asks, and the renewal of entries already saved. Refinement entries kept only in the session's own history are still allowed. `skillInstalls: false` refuses every install the session requests before any approval, so full access cannot allow one. It covers skill installs (saved skills included), plugin management and MCP server management. A Bundle preset has no switch for either, so set both for a session that reads outside text.
- Both switches follow the session's lineage: every sub-agent and role child it opens, every fork of it, and their descendants keep them. The backend refuses a skill install for a session whose ancestry it cannot read. A schedule that opens a new session is not a descendant, so that session runs without the switches.
- `send` is accepted only while the session is idle. The Host records each `idempotencyKey`; a reused key returns `notSubmitted { reason: 'duplicateKey' }` and is never queued twice. Every send passes the start checks again: a revoked or unregistered workspace, a missing model route, automatic approval review, an unreviewed Bundle, or full access without its gates refuses it with the same reason, and nothing is queued. A turn already running when a grant is revoked is left to finish. `list`, `status`, `events`, `result`, `usage`, `toolResult`, `interrupt` and `archive` keep working, so the plugin can still stop and clean up.
- The input identity is `plugin:<row>`, generated by the backend. It asks for the unattended policy **hand off and notify**: an approval parks the session as waiting, and the owner answers later in the Web or a bound channel.

## Read it

| Call | Returns |
| --- | --- |
| `list()` | The sessions this package's row manages, each with its status. |
| `status(id)` | `{ kind: notLoaded \| idle \| active \| systemError, flags }`. A turn waiting for an approval or an answer is `active` with `waitingOnApproval` or `waitingOnUserInput`. Computed from runtime facts on every read. |
| `events(id, { afterSeq })` | Assistant text, tool calls, approvals and turn endings after a sequence number, and the `lastSeq` to pass next time. |
| `result(id)` | How the last turn ended and its last assistant text. |
| `usage(id)` | Input and output tokens and cost. A value the runtime cannot tell is `null`, never `0`. |
| `toolResult(id, callSeq)` | One tool call's result text, `isError`, and for `shell` the exit code as a number. `state` is `pending` while the call has no result yet; then `isError`, `text` and `exitCode` say nothing. A call that finished with no output is `done` with `text: ''`. |

For retained task sessions, `waitingOnUserInput` also includes an open native `ask_user_question`
surface from the durable ledger, even after its nonblocking tool call and turn have completed.
Status reads do not load historical workers. A failed ledger read rejects; it does not imply that
the question was answered. Do not treat a completed turn as task completion while this flag remains.

### How an approval ended

An `approval` event keeps the seq the approval first appeared at, so a reader that already passed it with `afterSeq` never sees it change. When an approval ends, `events` also returns an `approvalOutcome` event at the seq of the event that ended it:

```ts
{ kind: 'approvalOutcome'; seq: number; approvalSeq: number;
  outcome: 'allowed' | 'rejected' | 'expired';
  via: 'person' | 'full-access' | 'automatic' }
```

- `approvalSeq` is the `seq` of that approval's `approval` event. Each approval has at most one outcome event, and a read from the same `afterSeq` returns it once. A reader paging forward and never re-reading from 0 learns of every approval it was shown that it ended. `lastSeq` works as before.
- `allowed` covers an allow once, for the session or permanently. `rejected` is a refusal. `expired` means nobody answered before the deadline, or the request stopped being valid.
- `via: 'person'` means the owner answered. It is reported only when the answer carries the identity the owner's approvals have; an answer from any other identity is `automatic`, so a count of `person` plus `rejected` never includes a refusal it cannot vouch for. `full-access` is the automatic allow under full access, which is never pending: its `approval` event is already `decided`, and the outcome follows at the same seq. Expiry and everything else is `automatic`.
- The outcome is read from the session timeline, which is rebuilt from the ledger, so it survives a daemon restart and a worker recovery. `events` reads the most recent 5000 timeline nodes. A reader that falls further behind than that can miss the outcome of an approval whose node left the window.

`interrupt(id)` stops the running turn. `archive(id)` archives the session.

## Admit the owner's input

Added in 5.18.0. A service that holds a task for the owner does not push the owner's words into a bound session with `send`. It asks the platform to admit them. The platform records the input, holds the text, and submits it only while the session is idle and the start checks pass, so a busy session, an unanswered question, a revoked workspace grant or an archived session cannot lose or misroute it.

```ts
const result = await init.sessions.admitInput(sessionId, {
  key: 'task-42:owner:1', // 1–256 characters; your idempotency key
  target: { taskId: 'task-42', taskGeneration: 3, startKey: 'task-42' },
  input: { kind: 'ownerMessage', receiptId: event.receiptId },
})
// later, or after a crash: the same state without changing anything
const again = await init.sessions.inputResult(sessionId, { key: 'task-42:owner:1' })
```

`target` must match the session's `startKey` and its binding. Repeating a key with the same request returns the same input; any difference is refused.

| `input.kind` | Text | What the platform does |
| --- | --- | --- |
| `ownerMessage` | Never passed. Give the `receiptId` of a [channel event](channel-targets.md#receipts). | Takes the text from the receipt the Host recorded. The receipt must belong to your service and the owner's current pairing, and one receipt is admitted once. |
| `recoveryContinuation` | Never passed. Give `turnEndSeq`, the seq of the turn that ended. | Checks that turn was the last one, ended by cancellation or failure, with no later turn start; then writes a fixed continuation sentence. Otherwise `recoveryUnknown`. |
| `legacyOwnerMessage` | Passed as `text`, with `originalInbox: string \| null`. | The origin cannot be verified, so the result is always `recoveryUnknown`; the text runs only if the owner chooses to deliver it in the Web. |

The result is one of these states. Everything except `legacySend` and `absent` carries `inputId` (equal to `key`), `version` (rises on every change), `reason` and `reviewLocation`.

| `state` | Meaning | What to do |
| --- | --- | --- |
| `queued` | The key is taken but the record was not completed (a crash between two steps). | Call `admitInput` again. |
| `enqueued` | Admitted. The platform holds the text until the session is idle and the start checks pass. | Poll `inputResult`. |
| `consumed` | A turn took the text. Adds `turn` and `seq`. Final. | Done. |
| `retained` | Kept and never delivered: the owner chose keep or discard in the Web, or the session was archived. Final. | Done. |
| `needsOwner` | Delivery cannot be shown to be right: receipt unknown or not yours, pairing changed, grant revoked, or the start checks fail (at admission or at submit). | Notify the owner; do not retry. The owner decides in the Web. |
| `waitingQuestion` | The session has an unanswered question. The platform holds the input and moves it on once the question closes. | Notify the owner and wait. |
| `recoveryUnknown` | A `legacyOwnerMessage`, or a `recoveryContinuation` that failed its checks. | Notify the owner. The owner decides in the Web. |
| `legacySend` | The key exists only in the old `send` ledger. `delivery` is `consumed`, `pending` or `unknown`. | `consumed` is final; otherwise resubmit as `legacyOwnerMessage`. |
| `absent` | The platform knows no such key. `historyCoverage: 'complete'` only when the session was created after input records existed; otherwise `partial`. | Admit only on `complete`; on `partial` only notify. |

`reason` is one of `eligible`, `busy`, `questionOpen`, `legacySourceUnknown`, `recoveryUnverified`, `receiptUnknown`, `pairingChanged`, `grantRevoked`, `sessionArchived`, `ownerRetained`, `ownerDiscarded`. Show it as text; values may be added. `reviewLocation` is `/?session=<sessionId>&ownerInput=<inputId>`, the Web page where the owner reads the text, its source and its history and decides. The page's decisions (deliver, keep, discard, and redeliver or discard for parked channel receipts) go through `_agnes/v1/managedInput.get` and `_agnes/v1/managedInput.decide`, which accept only the owner's own Web page: a plugin, and any local SDK client on the Unix socket, is refused with `CAPABILITY_DENIED`.

Refusals reject as described under [Refusals](#refusals), with `data.reason`: `OWNER_INPUT_TARGET_MISMATCH` (`target` differs from the session's start key or binding), `OWNER_INPUT_KEY_REUSED` (same key, any difference in the request) and `SESSION_ARCHIVED` (thrown, never returned). `OWNER_INPUT_REQUIRED` is what `send` on a bound session returns. Malformed parameters are `INVALID_PARAMS`.

Trust: an admitted owner message still enters the session inbox as `origin: 'system'` with `trust: 'untrusted'`. Admission proves the text came from the paired owner's channel receipt; it does not make the text an owner-identity input and it grants no approval. There is no new declaration key: `sessions: true` already grants both methods. A plugin that needs them sets its `apiRange` to `^5.18.0`.

## Retention and lifecycle

- `retention: 'task'` keeps the session. `retention: 'ephemeral'` archives it once `result` reads an ended last turn, and keeps it out of task-experience mining: automatic refinement and the model's own proposals are refused. The owner's own refinement request still works.
- Disabling the plugin refuses new starts and sends. Existing sessions stay with the owner, running turns finish, and pending approvals can still be answered in the Web. After re-enabling, call `list()` to reconcile.

## Refusals

A refused call rejects with a plain object that has the JSON-RPC `code` (for example `-32006` for `CAPABILITY_DENIED`), a `message` that repeats the error name, and `data`. `data.code` is the error name. `data.reason` carries the refusal, such as `WORKSPACE_NOT_AUTHORIZED`, `FULL_ACCESS_UNAVAILABLE`, `OUTWARD_CHECKPOINT_UNAVAILABLE`, `START_KEY_REUSED` or `PLUGIN_ROW_AMBIGUOUS`. A `FULL_ACCESS_UNAVAILABLE` refusal also carries `data.missing`, either `outward-checkpoint` or `os-boundary`. Read `error.data.reason` to pause the task and tell the owner what to grant. No other field of the daemon's error reaches the plugin: no message text, path or stack. A failure that is not a refusal rejects with `code: 'E_REQUEST'` and carries no reason.

## Trust boundary

A managed service runs in-process in the shared session worker, together with every other in-process plugin, and reaches the backend over that worker's private channel. The backend serves a managed-session request only when it comes from the shared session worker on the profile lane that profile-scope services use. A request from another worker, or from a session's own work, is refused with `CAPABILITY_DENIED` and reason `MANAGED_SESSION_LANE`.

That check is not authentication. The calling row (owner, package, integrity and service) is what the worker reports. The backend rechecks it against fresh inventory, but it cannot tell which in-process plugin made the call. A trusted in-process plugin that chooses to can name another enabled package's row that declares `sessions`, and then drive that row's sessions, Bundles and workspace grants. Bound wakes have the same boundary. This follows the trust model in [Security and trust](../guide/security.md): in-process plugins are trusted code and are not isolated from one another. Review every in-process plugin you enable with that in mind.

## Not yet available

Granting workspaces from the Web is not available yet; use `agh plugins grants`. Binding a session to the owner's channel is follow-up work.

The Host side of owner input admission is wired up over several changes of the 5.18.0 release. A build that exports these types but has not finished them refuses `admitInput` and `inputResult` with `CAPABILITY_DENIED`; do not rely on them until the Host you run reports an API version that includes the finished behavior.

The command rules do not cover commands they cannot see: a sub-agent that runs as an external agent process (Claude Code, Codex, ACP or SDK agents) runs its own shell, and [the gaps the rules list](../guide/security.md#outward-command-rules) run unasked under full access. Weigh that before granting full access to a session that reads outside text.
