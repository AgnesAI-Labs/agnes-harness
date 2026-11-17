import {
  META_KEY,
  parseAgentRef,
  parseLoopSelection,
  parseSessionBundles,
  parseSessionEnvironment,
  parseSystemPromptAppend,
} from '@agnes/protocol'
import type { NewSessionOptions } from './client-types.js'

/** The `ai.agnes.harness` side channel of a `session/new` request, checked before anything is sent. */
export function newSessionMeta(o: NewSessionOptions): Record<string, unknown> {
  const meta: Record<string, unknown> = {}
  if (o.agent !== undefined) {
    meta.agent = parseAgentRef(o.agent)
    if (
      o.loop ||
      o.bundles !== undefined ||
      o.preset ||
      o.permission !== undefined ||
      o.systemPromptAppend !== undefined
    )
      throw new TypeError('agent cannot be combined with execution overrides')
  }
  if (o.agentDigest !== undefined) meta.agentDigest = o.agentDigest
  if (o.loop) meta.loop = parseLoopSelection(o.loop)
  if (o.preset) meta.preset = o.preset
  if (o.agent === undefined) meta.permission = o.permission ?? 'default'
  if (o.bundles !== undefined) meta.bundles = parseSessionBundles(o.bundles)
  if (o.systemPromptAppend !== undefined)
    meta.systemPromptAppend = parseSystemPromptAppend(o.systemPromptAppend)
  if (o.environment !== undefined) meta.environment = parseSessionEnvironment(o.environment)
  if (o.sessionKey) meta.sessionKey = o.sessionKey
  return meta
}

/** The `_meta` a session opening carries for `environment`, checked first; none without one. */
export function openSessionMeta(environment: NewSessionOptions['environment']): Record<string, unknown> {
  return environment === undefined
    ? {}
    : { _meta: { [META_KEY]: { environment: parseSessionEnvironment(environment) } } }
}
