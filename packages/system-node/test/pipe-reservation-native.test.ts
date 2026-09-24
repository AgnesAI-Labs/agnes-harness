import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

type Reservation = { close(): void }
const windows = process.platform === 'win32' // guards-allow-platform: validates the actual Windows native artifact.
const native = windows
  ? (createRequire(import.meta.url)('@agnes/system-node/native') as {
      reservePipeName(...args: unknown[]): Reservation
    })
  : undefined
const reserve = (...args: unknown[]) => {
  if (!native) throw new Error('Windows native reservation required')
  return native.reservePipeName(...args)
}
const name = () => `\\\\.\\pipe\\agnes-名字-${randomUUID()}`

describe.skipIf(!windows)('native Windows pipe reservation', () => {
  it('holds a Unicode name until explicit close without exposing a descriptor', () => {
    const path = name()
    const first = reserve(path, 8)
    try {
      expect(() => reserve(path, 8)).toThrow()
      expect('fd' in first).toBe(false)
      expect('handle' in first).toBe(false)
      expect(() => first.close.call({})).toThrow('Invalid Windows pipe reservation')
      expect(() => reserve(path, 0)).toThrow()
      expect(() => reserve(path, 8)).toThrow()
    } finally {
      first.close()
      first.close()
    }
    reserve(path, 8).close()
  })

  it.each([
    undefined,
    null,
    '',
    'C:\\file',
    '\\\\remote\\pipe\\name',
    '\\\\?\\pipe\\name',
    '\\\\.\\pipe\\',
    '\\\\.\\pipe\\nested\\name',
    '\\\\.\\pipe\\bad\n',
    '\\\\.\\pipe\\bad\0',
    `\\\\.\\pipe\\${'a'.repeat(249)}`,
  ])('rejects an invalid pipe name: %s', (path) => {
    expect(() => reserve(path, 8)).toThrow()
  })

  it.each([0, 1, 1.5, 255, 256, Number.NaN, Number.POSITIVE_INFINITY, '8', null])(
    'rejects an invalid total instance count: %s',
    (maximum) => {
      const path = name()
      expect(() => reserve(path, maximum)).toThrow()
      reserve(path, 8).close()
    },
  )

  it('rejects missing and extra arguments before acquiring a name', () => {
    const path = name()
    expect(() => reserve()).toThrow()
    expect(() => reserve(path)).toThrow()
    expect(() => reserve(path, 8, true)).toThrow()
    reserve(path, 8).close()
  })
})
