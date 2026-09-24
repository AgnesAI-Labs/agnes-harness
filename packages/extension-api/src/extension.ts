import type { JsonValue } from '@agnes/protocol'
import type { Disposer, LeaseView, Logger, PlatformFacts, Seq } from './common.js'
import type { HookEvent, HookHandler } from './hooks.js'
import type { ProjectionDef } from './projections.js'
import type { ResourceEntry } from './resources.js'
import type { ServiceDef } from './services.js'
import type { SlotFill, SlotName } from './slots.js'
import type { ToolDef } from './tool.js'

export type TrustTier = 'builtin' | 'trusted'

export interface ExtensionContext {
  readonly extId: string
  readonly version: string
  readonly trust: TrustTier
  readonly lease: LeaseView
  readonly log: Logger // 进 host 审计流的 ext 通道，不进账本
  readonly signal: AbortSignal // host 关闭 / revoke 时拉
  readonly info: {
    readonly agnesVersion: string
    readonly apiVersion: string
    readonly profileName: string
    // Optional: three ExtensionAPI construction sites under host/test still build this object
    // literal with only the original three fields, and this task doesn't touch host.
    readonly preset?: string
    readonly cwd?: string
  }
  readonly platform: PlatformFacts // assembly-time snapshot; terminal.width is not live (spec §5.2)
}

// Six controlled registrations, events and ctx, plus the optional legacy latestExtEvent reader.
// Required profile components remain deployment-owned. test/extension.test-d.ts pins the surface.
export interface ExtensionAPI {
  registerService<I extends JsonValue, O extends JsonValue>(def: ServiceDef<I, O>): Disposer
  registerProjection<S extends JsonValue>(def: ProjectionDef<S>): Disposer
  registerTool(def: ToolDef): Disposer // 名字须带 capabilities.tools.prefix；同名 ⇒ 启动期 E_REGISTRY_DUPLICATE
  registerHook<E extends HookEvent>(event: E, handler: NoInfer<HookHandler<E>>): Disposer // event 须在 capabilities.hooks
  registerSlot<S extends SlotName>(slot: S, fill: NoInfer<SlotFill<S>>): Disposer // slot 须在 capabilities.slots
  registerResource(entry: ResourceEntry): Disposer // kind 须在 capabilities.resources
  readonly events: { append(name: string, data: JsonValue): Promise<Seq> } // 落 x/<extId>/<name>；需 capabilities.events
  // 读回本扩展自己最近一条 x/<extId>/<name> 事件；type-only——host 侧真正从账本读回属于
  // host Task22（[I5]），本次不接线，未注册过该 name 时返回 undefined。可选：两个现有
  // ExtensionAPI 构造点（host `ext-host/api.ts` 的旧 stub、`ext-host/api-proxy.ts` 的
  // Task22 新实现，均不在本次改动范围）还没有实现它；必需会把它们双双钉成编译错误。
  latestExtEvent?(name: string): JsonValue | undefined
  readonly ctx: ExtensionContext
}

// 稿 §4 的签名：工厂可以什么都不返回（同步或异步），也可以返回一个 Disposer。下面的 void 正是
// 「没有返回值」那一支——biome 建议的 undefined 会让 `defineExtension(async () => {})` 不再可赋值。
// biome-ignore lint/suspicious/noConfusingVoidType: 见上，Promise<void> 是必须能赋值的返回形状
export type ExtensionFactory = (agnes: ExtensionAPI) => void | Disposer | Promise<void | Disposer>

export function defineExtension(f: ExtensionFactory): ExtensionFactory {
  return f
}
