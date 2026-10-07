import { describe, expectTypeOf, it } from 'vitest'
import type { PlatformView, ServiceContext, ToolContext } from '../src/index.js'

describe('service context surface', () => {
  it('pins the exact key set: optional effect process port, no seam objects, platform view present (spec §5.1 / §6.1)', () => {
    expectTypeOf<keyof ServiceContext>().toEqualTypeOf<
      | 'childJobs'
      | 'session'
      | 'sandbox'
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
    expectTypeOf<ServiceContext['platform']>().toEqualTypeOf<PlatformView>()
    expectTypeOf<ServiceContext['sandbox']>().toEqualTypeOf<
      Pick<ToolContext['sandbox'], 'openProcess'> | undefined
    >()
  })
})
