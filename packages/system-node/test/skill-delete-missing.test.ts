import { createRequire } from 'node:module'
import { expect, it, vi } from 'vitest'

it('fails closed when the installed native module lacks safe skill deletion', async () => {
  const actual = createRequire(import.meta.url)('@agnes/system-node/native')
  const old = Object.fromEntries(Object.getOwnPropertyNames(actual).map((key) => [key, actual[key]]))
  delete old.deleteSkillEntry
  vi.resetModules()
  vi.doMock('node:module', () => ({ createRequire: () => () => old }))
  try {
    const { deleteSkillEntrySync } = await import('../src/index.js')
    expect(() =>
      deleteSkillEntrySync({
        path: import.meta.dirname,
        dev: '1',
        ino: '1',
        size: 0,
        mtimeMs: 1,
        directory: true,
      }),
    ).toThrow(expect.objectContaining({ code: 'E_SYSTEM_NATIVE_UNAVAILABLE' }))
  } finally {
    vi.doUnmock('node:module')
    vi.resetModules()
  }
})
