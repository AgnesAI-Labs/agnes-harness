import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { RequestTraceStore } from '../src/request-traces.js'

const fault = vi.hoisted(() => ({
  partial: '',
  delayed: '',
  wait: Promise.resolve(),
  release: () => {},
}))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    async stat(...args: Parameters<typeof fs.stat>) {
      if (fault.delayed && String(args[0]).endsWith(fault.delayed)) {
        await fault.wait
        // Let the failed writer's catch/finally complete before this sibling asks for capacity.
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      return fs.stat(...args)
    },
    async writeFile(...args: Parameters<typeof fs.writeFile>) {
      if (fault.partial && String(args[0]).endsWith(fault.partial)) {
        fault.partial = ''
        await fs.writeFile(args[0], 'x'.repeat(5000), args[2])
        fault.release()
        throw new Error('synthetic partial write failure')
      }
      return fs.writeFile(...args)
    },
  }
})

it('accounts for partial-write remnants before a sibling admission and recovers on the next transaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agh-trace-write-fault-'))
  const totalBytes = 12 * 1024
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  const bytes = async (dir: string) =>
    (await Promise.all((await readdir(dir)).map(async (name) => (await stat(join(dir, name))).size))).reduce(
      (a, b) => a + b,
      0,
    )
  try {
    const store = new RequestTraceStore(root, 'fault', {
      callBytes: 128 * 1024,
      totalBytes,
      calls: 16,
      ttlMs: 60000,
    })
    const request = {
      kind: 'inference' as const,
      sessionKey: 'synthetic',
      slot: 'primary' as const,
      route: 'synthetic',
      model: 'synthetic',
      contractId: null,
      derivedHash: 'a'.repeat(64),
      system: 'synthetic',
      tools: [],
      messages: [],
    }
    const first = await store.begin(request)
    fault.partial = `${hash(JSON.stringify('a'.repeat(7000)))}.blob.json`
    fault.delayed = `${hash(JSON.stringify('b'.repeat(7300)))}.blob.json`
    fault.wait = new Promise<void>((resolve) => {
      fault.release = resolve
    })
    await expect(first.wire({ system: 'a'.repeat(7000), tools: 'b'.repeat(7300) })).rejects.toThrow(
      'synthetic partial write failure',
    )
    fault.delayed = ''
    const dir = join(root, 'model-requests', hash('fault'))
    expect(await bytes(dir)).toBeLessThanOrEqual(totalBytes)
    expect(await store.clear('synthetic', first.id)).toBe(true)
    const next = await store.begin(request)
    await next.finish()
    expect((await store.get('synthetic', next.id)).snapshot?.system).toBe('synthetic')
    expect(await bytes(dir)).toBeLessThanOrEqual(totalBytes)
  } finally {
    fault.partial = ''
    fault.delayed = ''
    fault.release()
    await rm(root, { recursive: true, force: true })
  }
})
