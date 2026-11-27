# Learned file memory

English | [简体中文](memory.zh-CN.md)

Memory keeps a small set of learned preferences and conventions across sessions in the same workspace. Settings → General → Personalization → Memory offers **off**, **ask before writing**, and **automatic**. The official file provider is installed by default; agent access starts **off**. Off blocks both reads and writes through the memory API and mediated file tools on the next request. Shell protection depends on the platform as explained below. It cannot recall content already sent to a model.

Use **Open memory files** to inspect or edit Markdown with the existing text editor. Human editing remains available when agent access is off. The editor saves against the hash it opened: a conflicting human or session edit is preserved; reload, merge and save again. A note shows the last recorded writer's session and turn. Direct edits outside this editor do not update that note. Workspace file memory is outside the project checkpoint: rewinding code does not roll back learned preferences.

## Files and budgets

Files live under `$AGH_HOME/memory/workspaces/<sha256-of-canonical-workspace-path>/`. `MEMORY.md` is the index; flat topic files such as `conventions.md` hold optional detail. Only the index goes into the existing context contribution path; the agent reads topics with normal read tools. The injected index stays fixed for the turn. Once the agent commits an update or creates a topic, it can immediately read, recall and edit the new content in the same turn. Human edits and other sessions’ commits become visible next turn.

Default storage limits are 16 KiB / 200 lines for the index, 32 KiB per topic and 256 KiB per workspace. The independent injection limits are counted in UTF-8 bytes: 8 KiB for workspace memory and 2 KiB for optional user memory by default (settings `tokenBudget` and `userTokenBudget`; the names are kept for compatibility). The fixed header lines are not counted, and each layer keeps its own limit, even when the other is shorter. A layer over its limit is cut at a whole line, and a closing line tells the agent how many paragraphs and about how many KB were left out and, for workspace memory, from which line of `MEMORY.md`, so it can read the rest; the stored file is never silently truncated. Settings stored with the earlier defaults (2,048 and 512) read as the new ones, so that exact pair cannot be chosen; any other pair is kept as set. Over-cap writes return `MEMORY_CONSOLIDATION_REQUIRED` and leave the file intact. Consolidate repeated or obsolete preferences, rather than appending indefinitely.

A turn keeps any removal it has observed. If you restore an emptied or deleted file, renew a hidden paragraph, or raise the size limit for an omitted index, its newly readable content becomes available on the next turn.

For optional read-only user preferences, create `$AGH_HOME/memory/user/MEMORY.md` yourself and enable `userEnabled` via the [SDK](../reference/api.md) admin method. User memory uses the same index storage limits and its separate context budget. Agent tools cannot change it or read another workspace's memory. With [Task experience](refinement.md#save-to-user-memory) on, lessons that hold in every workspace can be added to it automatically, as saved sections with marker lines like the paragraphs below; your own text always comes first in what the agent is shown, and a lesson that does not fit is not written.

The supported SDK request `_agnes/v1/admin.memory` accepts `cwd`, an optional settings patch, or `file`, `content` and `baseHash` for an explicit human edit, or `deleteFile: { path, baseHash }` to delete a topic at its listed revision, or `saved` to manage saved task experience paragraphs (`{ action: 'list' | 'renew' | 'withdraw' | 'convert', paragraphId?, layer? }`, see below; `layer: 'user'` manages the lessons in user memory, without `convert`). Configure `indexMaxBytes`, `indexMaxLines`, `topicMaxBytes`, `totalMaxBytes`, `tokenBudget`, `userTokenBudget` and `userEnabled` here. Select an available workspace returned by `_agnes/v1/admin.context`. Settings and editor operations require local owner administration; plugin tools cannot self-enable memory.

## Managing entries and topics

In **Memory files**, each ordinary paragraph has expiry controls. Choose **Set expiry** or **Edit expiry** to select **+7d**, **+30d**, or a local date and time. **Clear expiry** removes the time limit. Other visibility rules still apply. **Delete entry** removes the paragraph. Editing a paragraph or changing its expiry marks it as human-authored and protects it from agent edits and deletion. Changes to a non-empty file become visible to agents on the next turn.

To remove a topic, first remove its links from `MEMORY.md` and save the index. Choose **Delete** beside the topic and confirm. If the index still references the topic, the file stays intact. Owner controls work in every memory mode.

The agent can call `memory_delete` with a flat topic filename or its workspace memory path. It can delete only an unreferenced topic. The index, empty topics, and topics containing hidden, managed or human-authored content are protected even in ask mode. After deletion the topic immediately disappears from the agent’s file reads, directory listings and `memory_recall` results in the same turn.

The session checks tool permission for the destructive `memory_delete` call. In ask mode the memory provider also requires approval for the exact file revision.

| Memory mode | Manual permission | Auto-review | Full access |
| --- | --- | --- | --- |
| Off | Denied | Denied | Denied |
| Ask | Tool approval, then human approval for the revision | Tool review, then human approval for the revision | Automatically approves both |
| Auto | Tool approval only | Tool review only | Automatically approves the tool call |

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

**On the memory page.** In **Memory files**, the **Saved task experience** section lists each saved paragraph with whether the agent sees it, its review date and who saved it. The page refreshes at the review date or an earlier expiry annotation, including an annotation above the opening marker. A saved summary of a changed or deleted topic stays hidden until the summary is updated. Ordinary summary lines in `MEMORY.md` that have no prior link record stay visible in the memory note and are bound when you save `MEMORY.md`; once bound, editing the linked topic marks the summary as outdated until that summary line is updated (editing unrelated lines keeps the outdated warning). For each one:

- **Renew** starts a new 30-day review period. The file is not changed.
- **Withdraw** removes the paragraph from the file and records that you took it back: automatic and model saves of the same content are refused from then on. Only your own save brings it back. A withdrawal can preserve an unrelated credential-like line or broken topic link already in the index. It must leave that text intact and introduce no new invalid content.
- **Make ordinary** takes the marker lines off and keeps the text as ordinary memory, with no review date.

These work in every memory mode, like the editor, and also while task experience is off. Deleting a saved paragraph in the editor, markers and all, counts as taking it back as well; removing only the marker lines makes it ordinary memory. Both are recorded the next time a session opens in the workspace.

**In user memory.** The same page shows **Task experience in user memory**: the lessons written to user memory, read in every workspace that turns user memory on, with their review dates and whether this workspace reads user memory. **Renew** and **Withdraw** work as above; there is no **Make ordinary** (write the text by hand if you want to keep it). Deleting a lesson from the user memory file by hand, or taking off or damaging its marker lines, counts as taking it back.

**Edits by a person.** If you edit a saved paragraph in place in workspace or user memory, later saves and promotions preserve your text, including changes to spacing or letter case. Use the Memory page to edit it again.

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

## Expiring ordinary memory

In workspace or user `MEMORY.md`, or in a workspace topic file, put `<!-- expires_at: ISO8601 -->` on its own line immediately before the paragraph it applies to. The paragraph ends at the next blank line or the end of the file.

```markdown
<!-- expires_at: 2027-02-01T09:00:00Z -->
Use the staging queue during the migration.

Use the production queue for scheduled jobs.
```

At 09:00 UTC on February 1, the agent's reads and recall stop showing the staging instruction. The next turn's memory note also omits it. The production instruction remains visible. An invalid date hides the annotated paragraph immediately. The memory editor keeps the original text so you can correct or extend the date.

To tie a paragraph to a saved memory in the same layer, include its ID as `<!-- ref:r0000000001 -->` or `ref: r0000000001` within the paragraph. If that memory expires, is withdrawn, or cannot be verified, reads and recall hide the citing paragraph and the next turn’s memory note omits it. Enable user memory to include the user layer.

## Human-authored memory protection

Use the Memory page to change or withdraw a paragraph you wrote or edited. Choosing **Make ordinary** for a managed workspace paragraph also protects its text. In both `ask` and `auto` mode, an agent overwrite or deletion of a protected block fails with `MEMORY_HUMAN_EDITED` before approval. A background save that would overwrite a manual edit fails with `MEMORY_PARAGRAPH_EDITED`. If the proposed paragraphs would exceed the workspace’s 256 KiB ownership record, saving returns `MEMORY_CONSOLIDATION_REQUIRED` before publishing the file. New notes can still be appended as separate paragraphs after a blank line. When the file provider cannot verify a block’s origin, it protects it as human-authored.

For preferences such as `- test_runner: jest`, `tab_width = 4`, or `Preference: style = concise`, an automated write that introduces a different value for the same key returns `MEMORY_PREFERENCE_CONFLICT`. A human-authored preference in `MEMORY.md` or any workspace topic file applies across all workspace memory files. The check also covers handwritten preferences in enabled user memory. Managed user-memory sections can have different values. To change your preference, edit the original on the Memory page.

Use `memory_recall` to search learned preferences by text. Each match names the memory layer, file, and original line range. The session ledger and model request identify recalled text as untrusted. If the provider cannot search, use `read` on `MEMORY.md`.

With user memory enabled, set `includeUser` to search the user index and supported topic files in the same directory. Files with unsupported names or content above the topic size limit are excluded from the results.
