# Default context

English | [简体中文](context.zh-CN.md)

[Documentation](../README.md) · [Skills](skills.md) · [Default tools](../reference/default-tools.md)

Open **Settings → Context** to inspect repository rules for a registered workspace, configure the clock, or add trusted Skill directories. Code stays pinned to the session generation; these files are live resources.

The `agnes/context-rules` extension loads `$AGH_HOME/AGENTS.md`, then the nearest `.git` project root through the session working directory. In each directory it reads `AGENTS.md`, `CLAUDE.md`, `AGENTS.local.md`, and `CLAUDE.local.md` in that order. Trimmed identical siblings collapse to the first candidate. More specific directories and local overlays take precedence within their scope. Descendant rules load when tools reference files in that directory; touched scopes persist across resume. Rules refresh before every model request, including edits and deletions. The Context preview shows the selected workspace baseline.

Repository text is subordinate guidance and cannot grant tool permissions, modify authorization, or override the system contract. Project symlinks escaping the project root are skipped. A file is limited to 1 MiB, aggregate source reads to 4 MiB, and the rendered section to 32 KiB by default. Unreadable or oversized files are skipped and reported in the preview.

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

For extension authors, return `refreshOnRequest: true` from a `context` hook to refresh that contributor before each model request. Other contributors retain their once-per-turn snapshot. Use `additionalContext` for changing clock notes; stable repository rules use system sections.

`getSurface()` exposes `messageKind` to distinguish actual input from automatic `runtime_context` notes. Compaction plans selecting user questions should skip those notes.
