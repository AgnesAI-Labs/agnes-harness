import type { JsonValue } from '@agnes/protocol'
import { describe, expectTypeOf, it } from 'vitest'
import type { HookInvocationSnapshot, SessionRef } from '../src/index.js'

describe('workspace hook author contracts', () => {
  it('keeps session workspace identity and hook snapshots data-only', () => {
    expectTypeOf<SessionRef['workspaceRoot']>().toEqualTypeOf<string>()
    expectTypeOf<keyof HookInvocationSnapshot>().toEqualTypeOf<
      'workspaceDigest' | 'policyRevision' | 'hooks'
    >()
    expectTypeOf<HookInvocationSnapshot['hooks']>().toEqualTypeOf<readonly JsonValue[]>()
  })
})
