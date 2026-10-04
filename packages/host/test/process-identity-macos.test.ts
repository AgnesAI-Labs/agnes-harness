import { expect, it } from 'vitest'
import { macosProcessIdentity, macosProcessIdentityBinary } from '../src/adapters/process-identity-macos.js'

const BOOT = '01234567-89ab-cdef-0123-456789abcdef'
const OTHER_BOOT = '11234567-89ab-cdef-0123-456789abcdef'

const spawnOf = (stdout: string, code: number) => async () => ({ stdout, code })

it('binds a stable boot-session UUID, PID, and process start time', async () => {
  const identity = await macosProcessIdentity(42, { spawn: spawnOf(`alive ${BOOT} 2000.000002\n`, 0) })
  expect(identity).toEqual({ state: 'alive', startId: `darwin:${BOOT}:42:2000.000002` })
  expect(await macosProcessIdentity(42, { spawn: spawnOf(`alive ${BOOT} 2000.000002\n`, 0) })).toEqual(
    identity,
  )
  for (const [pid, boot, start] of [
    [42, OTHER_BOOT, '2000.000002'],
    [43, BOOT, '2000.000002'],
    [42, BOOT, '2000.000003'],
  ] as const) {
    const changed = await macosProcessIdentity(pid, { spawn: spawnOf(`alive ${boot} ${start}\n`, 0) })
    expect(changed.state).toBe('alive')
    expect(changed).not.toEqual(identity)
  }
})

it('reports the helper-observed exit code 1 as dead', async () => {
  expect(await macosProcessIdentity(42, { spawn: spawnOf('dead\n', 1) })).toEqual({ state: 'dead' })
})

it('forwards the helper’s single-word reason for a well-formed unknown', async () => {
  const result = await macosProcessIdentity(42, { spawn: spawnOf('unknown eperm\n', 2) })
  expect(result).toEqual({ state: 'unknown', reason: 'eperm' })
})

it.each([0, -1, 1.5, Number.NaN, 2_147_483_648])(
  'rejects unsafe PID %s before spawning the helper',
  async (pid) => {
    let spawned = false
    const result = await macosProcessIdentity(pid, {
      spawn: async () => {
        spawned = true
        return { stdout: 'alive 1.0 2.0\n', code: 0 }
      },
    })
    expect(result.state).toBe('unknown')
    expect(spawned).toBe(false)
  },
)

it.each([
  ['old floating boot timestamp', 'alive 1000.000001 2000.000002\n', 0],
  ['nil boot UUID', 'alive 00000000-0000-0000-0000-000000000000 2000.000002\n', 0],
  ['nonhex boot UUID', 'alive g1234567-89ab-cdef-0123-456789abcdef 2000.000002\n', 0],
  ['short boot UUID', 'alive 01234567-89ab-cdef-0123-456789abcde 2000.000002\n', 0],
  ['noncanonical boot UUID', `alive ${BOOT.toUpperCase()} 2000.000002\n`, 0],
  ['missing microsecond precision', `alive ${BOOT} 2000.2\n`, 0],
  ['extra output line', `alive ${BOOT} 2000.000002\ndead\n`, 0],
  ['extra blank line', `alive ${BOOT} 2000.000002\n\n`, 0],
  ['leading whitespace', ` alive ${BOOT} 2000.000002\n`, 0],
  ['trailing token after valid identity', `alive ${BOOT} 2000.000002 extra\n`, 0],
  ['alive but malformed body', 'alive not-a-number\n', 0],
  ['alive with a missing field', 'alive 1000.000001\n', 0],
  ['code 0 but empty stdout', '', 0],
  ['dead exit code but wrong body', 'unknown eperm\n', 1],
  ['an exit code outside the 0/1/2 contract', 'alive 1000.000001 2000.000002\n', 99],
  ['alive line carrying an unexpected trailing token', 'alive 1000.000001 2000.000002 extra\n', 0],
])('never certifies a malformed helper answer as alive or dead: %s', async (_label, stdout, code) => {
  const result = await macosProcessIdentity(42, { spawn: spawnOf(stdout, code) })
  expect(result.state).toBe('unknown')
})

it('degrades to unknown, never throwing, when the helper cannot be spawned at all', async () => {
  const result = await macosProcessIdentity(42, {
    spawn: async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
  })
  expect(result).toEqual({ state: 'unknown', reason: expect.any(String) })
})

it('passes the resolved macOS helper binary path and the stringified pid to spawn', async () => {
  let seenBin = ''
  let seenArgs: string[] = []
  await macosProcessIdentity(42, {
    spawn: async (bin, args) => {
      seenBin = bin
      seenArgs = args
      return { stdout: 'dead\n', code: 1 }
    },
  })
  expect(seenBin).toBe(macosProcessIdentityBinary(false))
  expect(seenArgs).toEqual(['42'])
})

it('uses dist/native for development and native beside bundled entrypoints', () => {
  expect(macosProcessIdentityBinary(false)).toMatch(/dist[/\\]native[/\\]macos-process-identity$/u)
  expect(macosProcessIdentityBinary(true)).toMatch(/native[/\\]macos-process-identity$/u)
  expect(macosProcessIdentityBinary(false)).not.toMatch(/packages[/\\]host[/\\]native[/\\]/u)
})

it('uses the default spawn on the current operating system without fabricating an identity', async () => {
  const result = await macosProcessIdentity(process.pid)
  if (process.platform !== 'darwin') {
    expect(result.state).toBe('unknown')
  }
  // On darwin this only certifies the wrapper does not throw; the compiled-binary behavior is
  // covered by the gated integration test in process-identity-macos.integration.test.ts.
})
