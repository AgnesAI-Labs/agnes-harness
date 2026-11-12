import type { ExtensionAPI } from '@agnes/extension-api/host'
import { extensionFactoryOf } from '@agnes/plugin-runtime/bundled'
import { expect, it } from 'vitest'
import { rowApiFixture } from './fixtures/row-api.js'

it('honours a granted request on turn_stopping', () => {
  const f = rowApiFixture({ hookTimeoutMs: 15000 })
  f.api.registerHook('turn_stopping', () => ({ action: 'stop' }), { timeoutMs: 15000 })
  expect(f.registrations[0]?.meta.hookTimeoutMs).toBe(15000)
  expect(f.registrations[0]?.meta.pluginRowId).toBe('ext:fixture/main')
})
it('preserves the registration options through the bundled adapter', () => {
  const f = rowApiFixture({ hookTimeoutMs: 15000 })
  extensionFactoryOf({
    inject: ['hooks'],
    apply(ctx: any) {
      ctx.hooks.register('turn_stopping', () => ({ action: 'stop' }), { timeoutMs: 15000 })
    },
  })(f.api as unknown as ExtensionAPI)
  expect(f.registrations[0]?.meta.hookTimeoutMs).toBe(15000)
})
it('clamps to the grant and platform ceiling', () => {
  const f = rowApiFixture({ hookTimeoutMs: 9000 })
  f.api.registerHook('tool_result', () => ({}), { timeoutMs: 20000 })
  expect(f.registrations[0]?.meta.hookTimeoutMs).toBe(9000)
  const large = rowApiFixture({ hookTimeoutMs: 30000 })
  large.api.registerHook('turn_stopping', () => ({ action: 'stop' }), { timeoutMs: 20000 })
  expect(large.registrations[0]?.meta.hookTimeoutMs).toBe(15000)
})
it('ignores requests without a grant', () => {
  const f = rowApiFixture()
  f.api.registerHook('turn_stopping', () => ({ action: 'stop' }), { timeoutMs: 15000 })
  expect(f.registrations[0]?.meta).not.toHaveProperty('hookTimeoutMs')
  expect(JSON.stringify(f.diagnostics)).toContain('hook-timeout-ignored')
})
it('ignores requests on fail-closed events', () => {
  const f = rowApiFixture({ hookTimeoutMs: 15000 })
  f.api.registerHook('tool_call', () => ({ allow: true }), { timeoutMs: 15000 })
  expect(f.registrations[0]?.meta).not.toHaveProperty('hookTimeoutMs')
  expect(JSON.stringify(f.diagnostics)).toContain('hook-timeout-ignored')
})
it.each([0, -1, NaN, Infinity])('ignores invalid duration %s', (timeoutMs) => {
  const f = rowApiFixture({ hookTimeoutMs: 15000 })
  f.api.registerHook('turn_stopping', () => ({ action: 'stop' }), { timeoutMs })
  expect(f.registrations[0]?.meta).not.toHaveProperty('hookTimeoutMs')
})
