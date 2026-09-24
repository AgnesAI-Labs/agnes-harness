import { describe, expectTypeOf, it } from 'vitest'
import type { PlatformView, ServiceContext } from '../src/index.js'

describe('service context surface', () => {
  it('pins the exact key set: no sandbox, no seam objects, platform view present (spec §5.1 / §6.1)', () => {
    expectTypeOf<keyof ServiceContext>().toEqualTypeOf<
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
    expectTypeOf<ServiceContext>().not.toHaveProperty('sandbox')
  })
})
