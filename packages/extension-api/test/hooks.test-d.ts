import type { ResourceEntry as ProtocolResource } from '@agnes/protocol/gen/hooks'
import { describe, expectTypeOf, it } from 'vitest'
import type {
  CompactionPlan,
  ExtensionAPI,
  HookContext,
  HookEvent,
  HookHandler,
  HookPayloadMap,
  HookReturnMap,
  PlatformFacts,
  ResourceEntry,
  ToolResult,
} from '../src/index.js'

describe('author hook contracts', () => {
  it('maps every closed event and supplies the complete second argument', () => {
    expectTypeOf<keyof HookPayloadMap>().toEqualTypeOf<HookEvent>()
    expectTypeOf<keyof HookReturnMap>().toEqualTypeOf<HookEvent>()
    expectTypeOf<Parameters<HookHandler<'context'>>>().toEqualTypeOf<
      [HookPayloadMap['context'], HookContext]
    >()
    expectTypeOf<keyof HookContext>().toEqualTypeOf<
      'session' | 'replayed' | 'signal' | 'lease' | 'log' | 'projections' | 'platform' | 'workspaceHooks'
    >()
    // Hooks run on every kernel event: facts only, no capability probe (spec P2/P4).
    expectTypeOf<HookContext['platform']>().toEqualTypeOf<PlatformFacts>()
    expectTypeOf<HookContext['platform']>().not.toHaveProperty('capability')
    expectTypeOf<ResourceEntry>().toEqualTypeOf<ProtocolResource>()
  })
  it('keeps author transform results and observe void distinct from ledger events', () => {
    type Observe =
      | 'session_start'
      | 'request_error'
      | 'compact'
      | 'subagent_start'
      | 'subagent_end'
      | 'format_deviation'
      | 'shutdown'
    expectTypeOf<HookReturnMap[Observe]>().toEqualTypeOf<void>()
    expectTypeOf<HookReturnMap['tool_result']>().toEqualTypeOf<{ result?: ToolResult }>()
    expectTypeOf<HookReturnMap['before_compact']>().toEqualTypeOf<CompactionPlan | null>()
    expectTypeOf<HookReturnMap['tool_call']>().toEqualTypeOf<
      { allow: true } | { allow: false; reason: string }
    >()
    expectTypeOf<HookPayloadMap['context']['getSurface']>().returns.toMatchTypeOf<
      ReadonlyArray<{ seq: number }>
    >()
  })
})

// Compile-time negative probes exercise the public registration surface. They are deliberately
// not called at runtime: tsc must reject each marked invalid author program.
export function registrationProbes(api: ExtensionAPI) {
  api.registerHook('tool_call', (payload, ctx) => {
    expectTypeOf(payload.name).toEqualTypeOf<string>()
    expectTypeOf(payload.taint).toEqualTypeOf<boolean>()
    expectTypeOf(ctx.replayed).toEqualTypeOf<boolean>()
    expectTypeOf(ctx.signal).toEqualTypeOf<AbortSignal>()
    // @ts-expect-error payload identity is readonly
    payload.name = 'forged'
    // @ts-expect-error lease belongs to the runtime
    ctx.lease = { expiresAt: 'never', scope: {}, budget: { remaining: 0 } }
    return { allow: true }
  })
  api.registerHook('shutdown', async (payload, ctx) => {
    expectTypeOf(payload.reason).toEqualTypeOf<'close' | 'revoke' | 'reload'>()
    ctx.log.info('shutdown')
  })
  // @ts-expect-error event vocabulary is closed
  api.registerHook('invented', () => {})
  // @ts-expect-error a directive cannot return only ask
  api.registerHook('tool_call', () => ({ ask: true }))
  // @ts-expect-error a deny requires a reason
  api.registerHook('tool_call', () => ({ allow: false }))
  // @ts-expect-error compaction returns a plan, not a summary result
  api.registerHook('before_compact', () => ({ summary: 'premature' }))
  // @ts-expect-error approval handlers cannot return a verdict
  api.registerHook('approval_request', () => ({ request: { verdict: 'allow' } }))
  // @ts-expect-error approval transformations cannot replace bound arguments
  api.registerHook('approval_request', () => ({ request: { argv: {} } }))
  // @ts-expect-error a resource requires its full identity and descriptive fields
  api.registerResource({ kind: 'skill' })
}
