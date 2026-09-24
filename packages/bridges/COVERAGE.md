<!-- generated from @agnes/bridges@0.0.0 — do not edit -->
# Claude Code hooks coverage

Source table: `data/hooks-map.json` (0.0.0). Status: mapped 12 / 27. Anything absent from this table is unsupported.

| CC event | status | harness events | supported field contract | unsupported fields | reason |
|---|---|---|---|---|---|
| `PreToolUse` | partial | `tool_call` | in: `tool_name` → name; `tool_input` → args<br>out: `permissionDecision` → allow; `permissionDecisionReason` → reason | `updatedInput` | — |
| `PostToolUse` | supported | `tool_result` | in: `tool_name` → name; `tool_input` → args; `tool_response` → result<br>out: `additionalContext` → result.content[]; `decision` → result.content[] (block marker); `reason` → result.content[] (block marker) | — | — |
| `PostToolUseFailure` | supported | `tool_result` | in: `tool_name` → name; `tool_input` → args; `error` → result.content[]<br>out: `additionalContext` → result.content[] | — | — |
| `Notification` | unmapped | — | — | — | UI notification; no harness event |
| `UserPromptSubmit` | partial | `before_step`, `context` | in: —<br>out: `decision` → before_step.block; `reason` → before_step.reason; `additionalContext` → context.additionalContext | `prompt` | the current before_step/context payloads expose no user-message text |
| `SessionStart` | partial | `session_start` | in: `source` → reason (startup/clear→new, resume→resume; compact unavailable); `session_id` → $context.session.key; `cwd` → cwd<br>out: — | `additionalContext` | session_start currently returns null; source=compact has no legal reason value |
| `SessionEnd` | supported | `shutdown` | in: `reason` → reason<br>out: — | — | — |
| `Stop` | supported | `turn_stopping` | in: `stop_hook_active` → $context.replayed<br>out: `decision` → action; `reason` → note | — | — |
| `StopFailure` | unmapped | — | — | — | error path is turn/end{error}, not a hook |
| `SubagentStart` | partial | `subagent_start` | in: `agent_id` → childKey; `agent_type` → kind (fork/spawn only)<br>out: — | `prompt` | subagent_start has no prompt field |
| `SubagentStop` | partial | `subagent_end` | in: `agent_id` → childKey<br>out: — | `decision` | — |
| `PreCompact` | supported | `before_compact` | in: `trigger` → reason (manual→requested, auto→threshold); `custom_instructions` → customInstructions<br>out: — | — | — |
| `PostCompact` | supported | `compact` | in: —<br>out: — | — | — |
| `PermissionRequest` | partial | `approval_request` | in: `tool_name` → request.tool; `tool_input` → request.argvHash (sha256 of canonical JSON)<br>out: — | `decision`, `updatedPermissions` | approval_request can refine risk/context but cannot return an approval verdict |
| `PermissionDenied` | unmapped | — | — | — | already an approval/decided event |
| `Setup` | unmapped | — | — | — | install-time action; package lifecycle is not exposed to extensions |
| `TeammateIdle` | unmapped | — | — | — | Claude Code team model; harness has a jobs table instead |
| `TaskCreated` | unmapped | — | — | — | Claude Code task model; harness has a jobs table instead |
| `TaskCompleted` | unmapped | — | — | — | Claude Code task model; harness has a jobs table instead |
| `Elicitation` | unmapped | — | — | — | MCP elicitation is declined in v0.1 |
| `ElicitationResult` | unmapped | — | — | — | MCP elicitation is declined in v0.1 |
| `ConfigChange` | unmapped | — | — | — | profile change requires restart |
| `WorktreeCreate` | unmapped | — | — | — | worktree is a subagent-internal contract |
| `WorktreeRemove` | unmapped | — | — | — | worktree is a subagent-internal contract |
| `InstructionsLoaded` | unmapped | — | — | — | AGENTS.md is already visible in the context hook |
| `CwdChanged` | unmapped | — | — | — | session cwd is fixed |
| `FileChanged` | unmapped | — | — | — | no file watcher |

## Always unsupported

- `updatedInput` (PreToolUse)
- `prompt` (UserPromptSubmit)
- `additionalContext` (SessionStart)
- `prompt` (SubagentStart)
- `decision` (SubagentStop)
- `decision`, `updatedPermissions` (PermissionRequest)
- `transcript_path` (all events): use `agnes export` to obtain the session.
