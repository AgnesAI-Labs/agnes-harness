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
  let disposed = false
  const fixture = rowApiFixture(
    { sessionWork: true, autoTitle: true },
    {
      sessionWorkDeclared: true,
      declaredCapabilities: { autoTitle: true },
      sessionWorkAuthority: () => ({
        check: () => true,
        signal: new AbortController().signal,
        dispose() {
          disposed = true
        },
      }),
    },
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
  expect(disposed).toBe(true)
  fixture.controller.abort()
  expect(() => fixture.api.sessionWork.register({ name: 'late', observe() {}, async run() {} })).toThrow()
})

it('refuses background registration without a current profile authority', () => {
  const fixture = rowApiFixture({ sessionWork: true }, { sessionWorkDeclared: true })
  fixture.ports.sessionWork = {
    register() {
      throw new Error('must not register')
    },
  }
  expect(() => fixture.api.sessionWork.register({ name: 'title', observe() {}, async run() {} })).toThrow(
    /not granted/,
  )
})
