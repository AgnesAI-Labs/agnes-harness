import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

describe.skipIf(process.platform !== 'win32')('broker native process launch', () => {
  it('rejects malformed inputs and survives repeated failed launches', async () => {
    const native = createRequire(import.meta.url)('@agnes/system-node/native') as {
      spawnInherited(args: unknown, cwd: unknown, env: unknown, callback: unknown): number
    }
    for (const args of [[], [''], [1], ['node', 'a\0b']])
      expect(() => native.spawnInherited(args, process.cwd(), [], () => {})).toThrow()
    for (const env of [['bad'], ['=bad'], ['A=bad\0value'], [1]])
      expect(() => native.spawnInherited([process.execPath], process.cwd(), env, () => {})).toThrow()
    expect(() => native.spawnInherited([process.execPath], process.cwd(), [], null)).toThrow()

    for (let i = 0; i < 12; i++) {
      expect(() =>
        native.spawnInherited(['agnes-no-such-executable-8c4a'], process.cwd(), [], () => {}),
      ).toThrow(expect.objectContaining({ code: 'ENOENT' }))
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const done = new Promise<{ code: number; signal: number }>((resolve) => {
      const pid = native.spawnInherited(
        [process.execPath, '-e', 'setTimeout(()=>process.exit(7),25)'],
        process.cwd(),
        [],
        (code: number, signal: number) => resolve({ code, signal }),
      )
      expect(pid).toBeGreaterThan(0)
    })
    expect(await done).toEqual({ code: 7, signal: 0 })
    await new Promise<void>((resolve) => setImmediate(resolve))
  })
})
