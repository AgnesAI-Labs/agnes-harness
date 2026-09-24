import type { Actor, JsonValue, ServiceCapability } from '@agnes/protocol'
import { validateServiceCapability } from '@agnes/protocol'
import type { Logger, PlatformView } from './common.js'
import type { ToolContext } from './tool.js'

export type { ServiceCapability } from '@agnes/protocol'
export type ServiceKind = ServiceCapability['kind']
export interface ServiceContext {
  readonly actor: Actor
  readonly source: string
  readonly requestId: string
  readonly cwd: string
  readonly exec: ToolContext['exec']
  readonly fs: ToolContext['fs']
  readonly net: ToolContext['net']
  readonly artifacts: ToolContext['artifacts']
  readonly authorize: ToolContext['authorize']
  // Same read-only view a tool gets; services never get sandbox (they do not spawn).
  readonly platform: PlatformView
  readonly signal: AbortSignal
  readonly timeoutMs: number
  readonly log: Logger
}
export interface ServiceDef<I extends JsonValue = JsonValue, O extends JsonValue = JsonValue>
  extends ServiceCapability {
  handler(input: I, ctx: ServiceContext): Promise<O>
}
/** Static data contract only; Host compiles schemas and enforces grants before invoking handlers. */
export function checkServiceDef(def: unknown): { ok: true } | { ok: false; problems: string[] } {
  try {
    if (def === null || typeof def !== 'object') throw new Error('object required')
    if (
      Reflect.ownKeys(def).some(
        (key) => typeof key !== 'string' || !('value' in (Object.getOwnPropertyDescriptor(def, key) ?? {})),
      )
    )
      throw new Error('data fields required')
    const capability = { ...def } as Record<string, unknown>
    const handler = Object.getOwnPropertyDescriptor(def, 'handler')?.value
    delete capability.handler
    const checked = validateServiceCapability(capability)
    if (typeof handler !== 'function') return { ok: false, problems: ['handler: expected function'] }
    return checked.ok
      ? { ok: true }
      : { ok: false, problems: checked.errors.map((e) => `${e.path}: ${e.message}`) }
  } catch {
    return { ok: false, problems: ['service: invalid definition'] }
  }
}
