# Learned file memory

English | [简体中文](memory.zh-CN.md)

Memory keeps a small set of learned preferences and conventions across sessions in the same workspace. Settings → Agent → Memory offers **off**, **ask before writing**, and **automatic**. The official file provider is installed by default; agent access starts **off**. Off blocks both reads and writes on the next request, including file tools and shell paths. It cannot recall content already sent to a model.

Use **Open memory files** to inspect or edit Markdown with the existing text editor. Human editing remains available when agent access is off. The editor saves against the hash it opened: a conflicting human or session edit is preserved; reload, merge and save again. A note shows the last recorded writer's session and turn. Direct edits outside this editor do not update that note. Workspace file memory is outside the project checkpoint: rewinding code does not roll back learned preferences.

## Files and budgets

Files live under `$AGH_HOME/memory/workspaces/<sha256-of-canonical-workspace-path>/`. `MEMORY.md` is the index; flat topic files such as `conventions.md` hold optional detail. Only the index goes into the existing context contribution path; the agent reads topics with normal read tools. Index and topic reads use one revision per turn, including repeated requests and retries. Human edits become visible next turn. An agent's just-committed change also becomes readable in that next revision; another change to the same file in the current turn conflicts.

Default storage limits are 16 KiB / 200 lines for the index, 32 KiB per topic and 256 KiB per workspace. The independent context allocation is 2,048 tokens for workspace memory and 512 for optional user memory, including the contribution header. The provider uses UTF-8 bytes as a conservative token upper bound; each layer keeps its own upper bound, even when the other is shorter. An omission marker says content was left out of the request; the stored file is never silently truncated. Over-cap writes return `MEMORY_CONSOLIDATION_REQUIRED` and leave the file intact. Consolidate repeated or obsolete preferences, rather than appending indefinitely.

For optional read-only user preferences, create `$AGH_HOME/memory/user/MEMORY.md` yourself and enable `userEnabled` via the [SDK](../reference/api.md) admin method. User memory uses the same index storage limits and its separate context budget. Agent tools cannot change it or read another workspace's memory.

The supported SDK request `_agnes/v1/admin.memory` accepts `cwd`, an optional settings patch, or `file`, `content` and `baseHash` for an explicit human edit. Configure `indexMaxBytes`, `indexMaxLines`, `topicMaxBytes`, `totalMaxBytes`, `tokenBudget`, `userTokenBudget` and `userEnabled` here. Select an available workspace returned by `_agnes/v1/admin.context`. Settings and editor operations require local owner administration; plugin tools cannot self-enable memory.

## Approval and privacy

The bundled **remembering** Skill explains what to learn: stable preferences, conventions and decisions. Never store secrets, private identifiers, one-off task details or transcripts. A common-credential detector rejects secret-like text; it is a conservative filter, not a universal secret detector.

In ask mode, ordinary write/edit tools produce a complete file diff, base/new hashes and source session/turn. The normal approval flow grants only that change once. Rejection, cancellation, policy changes or a changed base cannot publish a stale candidate. Full access and session grants do not approve memory writes. Process isolation denies the memory tree, so bash, aliases and symlinks cannot bypass the provider; unconfined process execution is refused where this boundary cannot be enforced. This floor also applies in off mode and Full access: command tools and terminals require usable Seatbelt (macOS) or bwrap namespaces (Linux), while mediated file tools remain available. Confined stdio MCP processes use the same Host-owned private-root floor, including the actual installation memory tree, its aliases and directories created after startup. An explicitly unconfined MCP profile remains outside that guarantee.

Writes are serialized across processes, compare the exact hash and commit through a synced temporary file plus atomic rename. Write a topic before linking it from the index. Multi-file changes are separate commits: a successful topic followed by a refused index is a partial result. A metadata failure after a file commit returns `MEMORY_COMMITTED_METADATA_FAILED`, rather than claiming the file was not written.

Memory stays in local files and the session ledger needed for tool execution. For memory-backed sessions, telemetry emits structural metadata only, even when content export was enabled. Validated token counts and the closed turn outcome remain available; free-form errors and echoed content do not. Once memory has contributed, diagnostic event exports also omit message/tool/summary content to prevent echoed preferences from leaking. Diagnostics bundles do not collect the memory directory. Deliberately retained local request traces can contain model input; treat them and the session ledger as private.

## Memory and knowledge sources together

`AGENTS.md` contains team rules checked into the project. Memory contains learned preferences outside Git. Session search answers “what did we discuss?”; knowledge bases supply source material through MCP, tools or [FDE bundles](demo.md). These can coexist with one memory provider. AGENTS.md and authoritative knowledge sources take precedence: correct conflicting memory through the same approval flow, rather than copying source documents into it.

The demo model performs no reasoning. `show remembered preferences` (or `显示记住的偏好`) displays the memory contribution actually received in that request. `call write {"path":"<memory-directory>/MEMORY.md","content":"Prefer concise summaries."}` uses the same normal tool and approval path as a configured reasoning model. Read an existing file before replacing it.

For a replaceable enterprise implementation, see [Memory providers](../extend/memory.md).
