# Learned file memory

English | [简体中文](memory.zh-CN.md)

Memory keeps a small set of learned preferences and conventions across sessions in the same workspace. Settings → General → Personalization → Memory offers **off**, **ask before writing**, and **automatic**. The official file provider is installed by default; agent access starts **off**. Off blocks both reads and writes through the memory API and mediated file tools on the next request. Shell protection depends on the platform as explained below. It cannot recall content already sent to a model.

Use **Open memory files** to inspect or edit Markdown with the existing text editor. Human editing remains available when agent access is off. The editor saves against the hash it opened: a conflicting human or session edit is preserved; reload, merge and save again. A note shows the last recorded writer's session and turn. Direct edits outside this editor do not update that note. Workspace file memory is outside the project checkpoint: rewinding code does not roll back learned preferences.

## Files and budgets

Files live under `$AGH_HOME/memory/workspaces/<sha256-of-canonical-workspace-path>/`. `MEMORY.md` is the index; flat topic files such as `conventions.md` hold optional detail. Only the index goes into the existing context contribution path; the agent reads topics with normal read tools. Index and topic reads use one revision per turn, including repeated requests and retries. Human edits become visible next turn. An agent's just-committed change also becomes readable in that next revision; another change to the same file in the current turn conflicts.

Default storage limits are 16 KiB / 200 lines for the index, 32 KiB per topic and 256 KiB per workspace. The independent context allocation is 2,048 tokens for workspace memory and 512 for optional user memory, including the contribution header. The provider uses UTF-8 bytes as a conservative token upper bound; each layer keeps its own upper bound, even when the other is shorter. An omission marker says content was left out of the request; the stored file is never silently truncated. Over-cap writes return `MEMORY_CONSOLIDATION_REQUIRED` and leave the file intact. Consolidate repeated or obsolete preferences, rather than appending indefinitely.

For optional read-only user preferences, create `$AGH_HOME/memory/user/MEMORY.md` yourself and enable `userEnabled` via the [SDK](../reference/api.md) admin method. User memory uses the same index storage limits and its separate context budget. Agent tools cannot change it or read another workspace's memory.

The supported SDK request `_agnes/v1/admin.memory` accepts `cwd`, an optional settings patch, or `file`, `content` and `baseHash` for an explicit human edit, or `saved` to manage saved task experience paragraphs (`{ action: 'list' | 'renew' | 'withdraw' | 'convert', paragraphId? }`, see below). Configure `indexMaxBytes`, `indexMaxLines`, `topicMaxBytes`, `totalMaxBytes`, `tokenBudget`, `userTokenBudget` and `userEnabled` here. Select an available workspace returned by `_agnes/v1/admin.context`. Settings and editor operations require local owner administration; plugin tools cannot self-enable memory.

## Saved task experience

With [Task experience](refinement.md#save-to-the-workspace) on, lessons can be saved into `MEMORY.md` as **saved paragraphs**. Each one sits between two marker lines that hold its id:

```markdown
<!-- refinement:r0a1b2c3d4e -->
Lint first
Run pnpm lint before committing; the hook rejects unformatted files.
<!-- /refinement:r0a1b2c3d4e -->
```

The id is `r` and ten lower-case letters or digits. The marker lines are how the agent's view and the records of the workspace find a paragraph; leave them as they are. Text outside marker lines is ordinary memory and is never changed by a save.

Do not start a line of your own with `<!-- refinement:` or `<!-- /refinement:`. A marker line that is damaged, repeated or on its own hides the text after it from the agent (up to the next marker line, or to the end of the file) until you fix it in the editor; the Saved task experience section does not list it. The agent cannot add, remove or change marker-like lines, in `MEMORY.md` or in topic files.

**Review date.** Each saved paragraph is in force for **30 days**. From then on the agent no longer sees it, until a later review confirms it again or you renew it. Its text stays in the file. The workspace's records of saved paragraphs (review dates, who saved them, what was taken back) live in the data directory, not in the memory file.

**What the agent sees.** The memory note and the agent's own reads of `MEMORY.md` leave out paragraphs past their review date and paragraphs nothing vouches for (for example damaged markers, or a save whose result is unknown). You see the whole file in the editor. Because the agent's view is filtered:

- the agent changes memory paragraph by paragraph: an edit is applied as exact replacements one at a time (under ask, one approval each);
- a write of the whole file is refused while some text is hidden from the agent, or when it would change or drop a saved paragraph's text.

**On the memory page.** In **Memory files**, the **Saved task experience** section lists each saved paragraph with whether the agent sees it, its review date and who saved it. For each one:

- **Renew** starts a new 30-day review period. The file is not changed.
- **Withdraw** removes the paragraph from the file and records that you took it back: automatic and model saves of the same content are refused from then on. Only your own save brings it back.
- **Make ordinary** takes the marker lines off and keeps the text as ordinary memory, with no review date.

These work in every memory mode, like the editor, and also while task experience is off. Deleting a saved paragraph in the editor, markers and all, counts as taking it back as well; removing only the marker lines makes it ordinary memory. Both are recorded the next time a session opens in the workspace.

**Edits by a person.** A save never replaces a paragraph a person edited in place; an automatic or model save of a new version is refused and your text stays. A change of spacing or letter case only counts as untouched.

**When memory is full.** A save that would go past the limits above ends with **memory full**, in every mode. Nothing is merged or dropped automatically: free space by withdrawing or editing paragraphs, then save again.

**Limits.** The checks on a saved paragraph are about structure (source, size, marker lines, secret-like text); they do not judge whether the lesson is right. Where the agent's shell is not confined (see below), it can read and change the memory file directly, including paragraphs it is not shown; a shell that takes a paragraph's marker lines off turns it into ordinary memory at the next session open.

## Approval and privacy

The bundled **remembering** Skill explains what to learn: stable preferences, conventions and decisions. Never store secrets, private identifiers, one-off task details or transcripts. A common-credential detector rejects secret-like text; it is a conservative filter, not a universal secret detector.

In ask mode, ordinary write/edit tools produce a complete file diff, base/new hashes and source session/turn. The normal approval flow grants only that change once. Rejection, cancellation, policy changes or a changed base cannot publish a stale candidate. Full access automatically allows each exact memory change and records its actor and `full-access` reason, even in ask mode. Session grants do not approve memory writes. On macOS/Linux, process isolation denies the memory tree, so bash, aliases and symlinks cannot bypass the provider; unconfined process execution is refused where this boundary cannot be enforced. This floor also applies in off mode: command tools and terminals require usable Seatbelt (macOS) or bwrap namespaces (Linux), while mediated file tools remain available. The explicit `full-access` permission is the exception, as in other agent tools' full-access modes: it trusts the user and their environment. The memory tree stays denied to commands where the OS boundary works, but where it does not (for example a Docker container or a server without bubblewrap), commands run unconfined and memory stays enabled, so a shell can read and change memory files directly. `sandbox.required: true` still refuses. When a memory file changed outside the provider since the provider last wrote or saw it, the next turn still loads it and the conversation shows a notice naming the file. The provider keeps those hashes in its own memory directory, so this is a notice, not a protection. Confined stdio MCP processes use the same Host-owned private-root floor, including the actual installation memory tree, its aliases and directories created after startup. An explicitly unconfined MCP profile remains outside that guarantee.

On the trusted local Windows backend, OS isolation is unimplemented. The conditional policy of the `read-only` and `workspace-write` permissions and explicit L0 allow execution without that memory isolation requirement. Memory off/ask/automatic, one-time approval, workspace ownership, hashes, atomic publication and human editing retain their application-level rules. An approved Windows shell command can directly access memory files using the system account; off mode and ask mode cannot prevent that bypass without OS isolation. This exception does not apply to failed macOS/Linux isolation or unknown/remote providers.

On Linux, Host safely prepares the workspace’s AGH-owned `.agh` directory before compiling the sandbox, including in a fresh workspace. A symlink or non-directory refuses session initialization; the mounted ancestor cannot be renamed to expose `.agh/secrets`. The directory uses normal permissions and existing contents are preserved. AGH neither reserves nor implicitly protects another product’s `.agnes/secrets`; there is no legacy-path migration.

Writes are serialized across processes, compare the exact hash and commit through a synced temporary file plus atomic rename. Write a topic before linking it from the index. Multi-file changes are separate commits: a successful topic followed by a refused index is a partial result. A metadata failure after a file commit returns `MEMORY_COMMITTED_METADATA_FAILED`, rather than claiming the file was not written.

Memory stays in local files and the session ledger needed for tool execution. For memory-backed sessions, telemetry emits structural metadata only, even when content export was enabled. Validated token counts and the closed turn outcome remain available; free-form errors and echoed content do not. Once memory has contributed, diagnostic event exports also omit message/tool/summary content to prevent echoed preferences from leaking. Diagnostics bundles do not collect the memory directory. Deliberately retained local request traces can contain model input; treat them and the session ledger as private.

## Memory and knowledge sources together

`AGENTS.md` contains team rules checked into the project. Memory contains learned preferences outside Git. Session search answers “what did we discuss?”; knowledge bases supply source material through MCP, tools or [Business agents](demo.md). These can coexist with one memory provider. AGENTS.md and authoritative knowledge sources take precedence: correct conflicting memory through the same approval flow, rather than copying source documents into it.

The demo model performs no reasoning. `show remembered preferences` (or `显示记住的偏好`) displays the memory contribution actually received in that request. `call write {"path":"<memory-directory>/MEMORY.md","content":"Prefer concise summaries."}` uses the same normal tool and approval path as a configured reasoning model. Read an existing file before replacing it.

For a replaceable enterprise implementation, see [Memory providers](../extend/memory.md).
