import { describe, expectTypeOf, it } from 'vitest'
import type {
  LoopContext,
  PlatformView,
  ServiceContext,
  SessionRef,
  ToolContext,
  ToolPolicyInput,
} from '../src/index.js'

describe('service context surface', () => {
  it('pins the exact key set: optional effect process port, no seam objects, platform view present (spec §5.1 / §6.1)', () => {
    expectTypeOf<keyof ServiceContext>().toEqualTypeOf<
      | 'childJobs'
      | 'session'
      | 'sandbox'
      | 'scope'
      | 'admission'
      | 'store'
      | 'wake'
      | 'actor'
      | 'source'
      | 'requestId'
      | 'cwd'
      | 'exec'
      | 'fs'
      | 'net'
      | 'artifacts'
      | 'authorize'
      | 'signal'
      | 'timeoutMs'
      | 'log'
      | 'platform'
    >()
    expectTypeOf<ToolPolicyInput['workspaceRoot']>().toEqualTypeOf<string>()
    expectTypeOf<LoopContext['session']>().toEqualTypeOf<SessionRef>()
    expectTypeOf<ToolContext['session']['workspaceRoot']>().toEqualTypeOf<string>()
    expectTypeOf<ServiceContext['session']>().toEqualTypeOf<SessionRef | undefined>()
    expectTypeOf<ServiceContext['platform']>().toEqualTypeOf<PlatformView>()
    expectTypeOf<ServiceContext['sandbox']>().toEqualTypeOf<
      Pick<ToolContext['sandbox'], 'openProcess'> | undefined
    >()
  })
})
