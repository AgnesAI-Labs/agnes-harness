import { expect, it } from 'vitest'
import { rowApiFixture } from './fixtures/row-api.js'

it('requires an independent declaration and Host grant for background registration', () => {
  const registration = { name: 'title', observe() {}, async run() {} }
  for (const [grant, declared] of [
    [{ sideCall: true }, true],
    [{ sessionWork: true }, false],
  ] as const) {
    const fixture = rowApiFixture(grant, { sessionWorkDeclared: declared })
    expect(() => fixture.api.sessionWork.register(registration)).toThrow(/not granted/)
  }
})

it('checks the live row again and owns the background registration disposer', () => {
  let attached = false
  let title = false
  const fixture = rowApiFixture(
    { sessionWork: true, autoTitle: true },
    { sessionWorkDeclared: true, declaredCapabilities: { autoTitle: true } },
  )
  fixture.ports.sessionWork = {
    register(_registration, meta) {
      attached = true
      title = meta.autoTitle === true
      return () => {
        attached = false
      }
    },
  }
  const off = fixture.api.sessionWork.register({ name: 'title', observe() {}, async run() {} })
  expect(attached).toBe(true)
  expect(title).toBe(true)
  off()
  expect(attached).toBe(false)
  fixture.controller.abort()
  expect(() => fixture.api.sessionWork.register({ name: 'late', observe() {}, async run() {} })).toThrow()
})
