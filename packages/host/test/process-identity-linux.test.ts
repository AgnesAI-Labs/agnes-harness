import { expect, it } from 'vitest'
import { linuxProcessIdentity } from '../src/adapters/process-identity-linux.js'

const boot = '11111111-2222-3333-4444-555555555555'
const record = (ticks = '12345', pid = 42) =>
  `${pid} (name ) with ()) S ${Array(18).fill('0').join(' ')} ${ticks} 0 0\n`
const error = (code: string) => Object.assign(new Error('PRIVATE-PROCESS-MARKER'), { code })
const reader = (stat: string) => async (path: string) => (path.endsWith('boot_id') ? boot : stat)
it('binds PID, boot identity and the unsigned 64-bit start time despite parentheses in comm', async () => {
  expect(await linuxProcessIdentity(42, { readText: reader(record('18446744073709551615')) })).toEqual({
    state: 'alive',
    startId: `linux:${boot}:42:18446744073709551615`,
  })
  expect(await linuxProcessIdentity(42, { readText: reader(record('12346')) })).not.toEqual(
    await linuxProcessIdentity(42, { readText: reader(record()) }),
  )
})
it.each([0, -1, 1.5, Number.NaN, 2147483648])('rejects unsafe PID %s before IO', async (pid) => {
  let reads = 0
  expect(
    (
      await linuxProcessIdentity(pid, {
        readText: async () => {
          reads++
          return boot
        },
      })
    ).state,
  ).toBe('unknown')
  expect(reads).toBe(0)
})
it.each([
  record('x'),
  record('18446744073709551616'),
  record('1', 43),
  '42 (truncated) S 0',
  'x'.repeat(8193),
])('does not certify malformed process data', async (stat) => {
  expect((await linuxProcessIdentity(42, { readText: reader(stat) })).state).toBe('unknown')
})
it.each(['EPERM', 'EACCES', 'ENOENT'])('keeps unreadable boot identity %s unknown', async (code) => {
  const result = await linuxProcessIdentity(42, {
    readText: async () => {
      throw error(code)
    },
  })
  expect(result.state).toBe('unknown')
  expect(JSON.stringify(result)).not.toContain('PRIVATE')
})
it.each(['ESRCH', 'EPERM', 'alive'])('only missing stat plus ESRCH proves dead: %s', async (state) => {
  const result = await linuxProcessIdentity(42, {
    readText: async (path) => {
      if (path.endsWith('boot_id')) return boot
      throw error('ENOENT')
    },
    checkAlive: () => {
      if (state !== 'alive') throw error(state)
    },
  })
  expect(result.state).toBe(state === 'ESRCH' ? 'dead' : 'unknown')
})
it('keeps stat permission failure unknown without converting it into a dead PID', async () => {
  let probed = false
  const result = await linuxProcessIdentity(42, {
    readText: async (path) => {
      if (path.endsWith('boot_id')) return boot
      throw error('EACCES')
    },
    checkAlive: () => {
      probed = true
      throw error('ESRCH')
    },
  })
  expect(result.state).toBe('unknown')
  expect(probed).toBe(false)
})
it('uses the default reader on the current operating system without fabricating an identity', async () => {
  const result = await linuxProcessIdentity(process.pid)
  if (process.platform === 'linux') {
    expect(result.state).toBe('alive')
    if (result.state === 'alive')
      expect(result.startId).toMatch(new RegExp(`^linux:.*:${process.pid}:[0-9]+$`))
  } else {
    expect(result.state).toBe('unknown')
  }
})
