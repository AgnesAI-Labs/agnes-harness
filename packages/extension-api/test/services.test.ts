import { describe, expect, it } from 'vitest'
import { checkManifest, checkServiceDef } from '../src/index.js'
import { serviceFixture } from '../testkit/index.js'

describe('S2 author service definition', () => {
  it('uses the same six data fields as manifest capabilities', () => {
    const def = serviceFixture()
    expect(checkServiceDef(def)).toEqual({ ok: true })
    const { handler: _handler, ...capability } = def
    expect(
      checkManifest({
        id: 'acme/service',
        version: '1.0.0',
        apiRange: '^1.0.0',
        entry: './index.js',
        capabilities: { services: [capability] },
      }).ok,
    ).toBe(true)
  })
  it('rejects bad definitions without invoking handlers or getters', () => {
    let invoked = false
    for (const value of [
      null,
      {},
      { ...serviceFixture(), handler: null },
      { ...serviceFixture(), kind: 'write' },
      { ...serviceFixture(), timeoutMs: 30001 },
      { ...serviceFixture(), maxResultBytes: 1048577 },
      { ...serviceFixture(), name: '/api' },
      {
        ...serviceFixture(),
        get handler() {
          invoked = true
          return async () => null
        },
      },
      { ...serviceFixture(), inputSchema: { type: 'object' } },
    ])
      expect(checkServiceDef(value).ok).toBe(false)
    expect(invoked).toBe(false)
  })
})
