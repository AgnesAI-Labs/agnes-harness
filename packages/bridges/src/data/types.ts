import type { HookEvent } from '@agnes/protocol'
export const SKILL_HOSTS = ['agnes', 'agents', 'claude', 'codex'] as const
export type SkillHost = (typeof SKILL_HOSTS)[number]
export type SkillRoot = {
  root: string
  host: SkillHost
  layout: 'dir/SKILL.md'
  trust?: 'user' | 'workspace'
  note?: string
}
const CC_HOOK_EVENT_NAMES =
  'PreToolUse PostToolUse PostToolUseFailure Notification UserPromptSubmit SessionStart SessionEnd Stop StopFailure SubagentStart SubagentStop PreCompact PostCompact PermissionRequest PermissionDenied Setup TeammateIdle TaskCreated TaskCompleted Elicitation ElicitationResult ConfigChange WorktreeCreate WorktreeRemove InstructionsLoaded CwdChanged FileChanged'
type Words<S extends string> = S extends `${infer Head} ${infer Tail}` ? Head | Words<Tail> : S
export type CcHookEvent = Words<typeof CC_HOOK_EVENT_NAMES>
export const CC_HOOK_EVENTS = CC_HOOK_EVENT_NAMES.split(' ') as readonly CcHookEvent[]
export type FieldMap = { in: Record<string, string>; out: Record<string, string> }
export type HooksMapEntry = {
  to: HookEvent[] | null
  reason?: string
  fields?: FieldMap
  unsupportedFields?: string[]
}
export type HooksMap = { version: 1; events: Record<CcHookEvent, HooksMapEntry> }
export type Check<T> = { ok: true; value: T } | { ok: false; problems: string[] }
