import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { windowsProcessStartTimeSync } from '../src/index.js'

type RestrictedTarget = {
  pid: number
  startTime: string
  resume(): void
  exitCode(): number | null
  close(): void
}

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

  it('rejects malformed restricted launches and ends a target that is never resumed', async () => {
    const native = createRequire(import.meta.url)('@agnes/system-node/native') as {
      spawnRestricted(...args: unknown[]): RestrictedTarget
    }
    const environment = `SystemRoot=${process.env.SystemRoot}\0\0`
    // (application, command line, cwd, environment block, write SIDs, read-only, isolation SID)
    const launch = (change: Record<number, unknown> = {}, count = 7) =>
      native.spawnRestricted(
        ...[process.execPath, `"${process.execPath}"`, process.cwd(), environment, [], true, 'S-1-4-9']
          .map((value, index) => (index in change ? change[index] : value))
          .slice(0, count),
      )
    expect(() => launch({}, 6)).toThrow()
    for (const change of [
      { 0: 'node.exe' },
      { 1: '' },
      { 2: 'relative' },
      { 3: 'SystemRoot=C:\\Windows' },
      { 3: '=bad\0\0' },
      { 4: ['S-1-4-1'] },
      { 4: [], 5: false },
      { 4: ['S-1-5-18'], 5: false },
      { 4: ['S-1-4-1', 'S-1-4-1'], 5: false },
      { 4: ['S-1-4-1', 'S-1-4-2', 'S-1-4-3'], 5: false },
      { 4: 'S-1-4-1', 5: false },
      { 5: 'yes' },
      { 6: '' },
      { 6: 'S-1-5-18' },
      { 6: 'S-1-04-9' },
      { 4: ['S-1-4-9'], 5: false },
    ])
      expect(() => launch(change)).toThrow()

    const target = launch()
    expect(target.pid).toBeGreaterThan(0)
    expect(target.startTime).toBe(windowsProcessStartTimeSync(target.pid))
    expect(target.exitCode()).toBeNull()
    expect(() => target.resume.call({})).toThrow('receiver')
    target.close()
    target.close()
    expect(() => target.exitCode()).toThrow('closed')
    expect(() => target.resume()).toThrow('closed')
    await expect.poll(() => windowsProcessStartTimeSync(target.pid)).toBeNull()
  })
})
