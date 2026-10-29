# Default context

English | [简体中文](context.zh-CN.md)

[Documentation](../README.md) · [Skills](skills.md) · [Default tools](../reference/default-tools.md)

Open **Settings → Models → Run configuration → Context** to inspect repository rules for a registered workspace, configure the clock, or add trusted Skill directories. Code stays pinned to the session generation; these files are live resources.

The `agnes/context-rules` extension loads `$AGH_HOME/AGENTS.md`, then the nearest `.git` project root through the session working directory. In each directory it reads `AGENTS.md`, `CLAUDE.md`, `AGENTS.local.md`, and `CLAUDE.local.md` in that order. Trimmed identical siblings collapse to the first candidate. More specific directories and local overlays take precedence within their scope. Descendant rules load when tools reference files in that directory; touched scopes persist across resume. Rules refresh before every model request, including edits and deletions. The Context preview shows the selected workspace baseline.

Repository text is subordinate guidance and cannot grant tool permissions, modify authorization, or override the system contract. It arrives as readable Markdown with a path/scope header, once per file at baseline, then only when a file becomes applicable, changes or is removed. These durable tail notes preserve the system prefix. Project symlinks escaping the project root are skipped. A file is limited to 1 MiB, aggregate source reads to 4 MiB, and the complete rendered rules to 32 KiB by default. Unreadable or oversized files are skipped and reported in the preview.

The `agnes/time-context` extension contributes a cache-friendly tail note with the configured current time and IANA zone, plus elapsed time since the previous turn ended. The first turn has no elapsed anchor. Clock anchors persist for resume. The default refresh interval is ten minutes within a turn; each new turn samples again. The configured display zone is not inferred browser authority; clarify the user's zone when needed.

Installation settings live in `$AGH_HOME/context.json` (default `~/.agh/context.json`). Repository files do not configure external Skill roots. For example:

```json
{
  "rulesEnabled": true,
  "instructionFiles": ["AGENTS.md", "CLAUDE.md"],
  "localInstructionFiles": ["AGENTS.local.md", "CLAUDE.local.md"],
  "maxBytes": 32768,
  "maxSourceBytes": 1048576,
  "timeEnabled": true,
  "timeZone": "Asia/Shanghai",
  "refreshIntervalMs": 600000,
  "customSkillRoots": []
}
```

Set `rulesEnabled` or `timeEnabled` to `false` to disable that contributor; `refreshIntervalMs: 0` samples every request. Invalid zones, relative custom roots, path-like instruction candidates and budgets above the supported caps are refused. Custom roots rescan automatically and retain the existing Skill trust, enable/disable, shadowing and revision rules. Only configure directories whose instructions you trust.

`ask_user_question` continues immediately by default. Set `timeoutMs` up to 60000 for a bounded wait. Its card appears while waiting, cancellation cleans up the wait, and late answers remain valid ordinary user input. Answers do not authorize tool execution. Invoke Skills with `/skill invoke NAME ARGUMENTS` in Web or TUI, or use the Context invocation form.

For extension authors, return `refreshOnRequest: true` from a `context` hook to refresh that contributor before each model request. Other contributors retain their once-per-turn snapshot. Context items in `sections` accept `delivery: 'stable-section'` (the default) or `delivery: 'live-note'`. Use stable sections for session policy and live notes for changing facts such as goal status, workflow/child receipts, memory indexes and repository files. A live item's identity is its registered source plus `id`; keep that identity stable and emit its complete current text. Core appends a trusted tail note only when the text changes, and explicitly clears previously visible items that are omitted. Rule files use one item per path, so refresh sends only additions, replacements and removals. `additionalContext` remains available for a single combined clock or hook note.

Live notes use the existing request-note path: all text is sanitized and committed atomically with the request. Deduplication reads visible ledger history, so resume and fork reuse an unchanged item exactly once. After compaction masks an item, the next ordinary request re-emits its current text. No process-local delivery flag or new ledger format is involved. Moving an existing section to a note is additive to the hook contract; already recorded requests keep their original bodies.

`additionalContext` is presented as a trusted harness note, so it must only carry text the extension itself wrote. Text a model produced from outside material (tool output, web pages, files) must be returned as `untrustedContext` instead. Core records it as an untrusted `[hook data]` note and wraps it in the untrusted-content envelope, so the model reads it as data and never as an instruction. Both fields have their own 8192-byte limit, so untrusted text cannot crowd out trusted context.

`getSurface()` exposes `messageKind` to distinguish actual input from automatic `runtime_context` notes. Compaction plans selecting user questions should skip those notes.
