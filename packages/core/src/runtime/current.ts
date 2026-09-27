import type { ResourceRegistry } from '../registry/resources.js'
import type { ToolRegistry } from '../registry/tools.js'
import type { HookPort } from '../step/session.js'

/** A Host-owned, trusted Skill body selected from the current workspace generation. */
export type RuntimePromptPreload = Readonly<{
  note: string
  key: string
}>

export type RuntimePromptPreloader = (input: {
  sessionKey: string
  prompt: string
}) => Promise<RuntimePromptPreload | undefined> | RuntimePromptPreload | undefined

/**
 * The narrow Core view of one published Host generation. It deliberately contains no RuntimeState,
 * publication token, candidate resolver or mutation capability.
 */
export type CurrentSessionRuntime = Readonly<{
  tools: ToolRegistry
  hooks: HookPort
  resources: ResourceRegistry
  runtimePromptPreloader?: RuntimePromptPreloader
}>

/**
 * Resolves one coherent generation for an already-open session. Host owns the pointer and swaps it;
 * Core calls this synchronously immediately before a lookup and never caches the returned view.
 */
export type CurrentRuntimeLookup = Readonly<{
  /** Missing scope means Core uses the session's assembly fallback registries and hook port. */
  current(sessionKey: string): CurrentSessionRuntime | undefined
}>
