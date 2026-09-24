import { afterEach, expect, it, vi } from 'vitest'
import { realHosted } from './real-hosted.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

it('reports a lease lost in the middle of a turn as session.interrupted within one renewal period', async () => {
  const ttl = 600
  const t = await realHosted({ limits: { 'lease.ttl_ms': ttl } })
  cleanups.push(t.close)
  const key = 'push-fault'
  await t.hosted.open(t.openFrame(key))
  t.hosted.tail(key, 1)
  const release = t.hold()
  await t.prompt(key, 'hold the turn open')
  const running = t.run(key).catch(() => undefined)
  const session = t.host.kernel.get(key)
  if (!session) throw new Error('session did not open')
  await vi.waitFor(() => expect(session.op()).not.toBeNull())
  const storage = session.d.log.storage
  storage.renew = async () => {
    throw Object.assign(new Error('lease lost'), { code: 'E_WRITER_LEASE' })
  }
  const lost = Date.now()
  await vi.waitFor(() => expect(t.sent.some((f) => f.kind === 'session.interrupted')).toBe(true), {
    timeout: 5_000,
  })
  expect(Date.now() - lost).toBeLessThan(ttl)
  expect(t.sent.filter((f) => f.kind === 'session.interrupted')).toHaveLength(1)
  release()
  await running
})

it('keeps the lease of a turn that writes nothing for three lease terms, and lets an idle one lapse', async () => {
  const ttl = 300
  const t = await realHosted({ limits: { 'lease.ttl_ms': ttl } })
  cleanups.push(t.close)
  await t.hosted.open(t.openFrame('busy'))
  await t.hosted.open(t.openFrame('quiet'))
  const release = t.hold()
  await t.prompt('busy', 'hold the turn open')
  const running = t.run('busy')
  const busy = t.host.kernel.get('busy')
  if (!busy) throw new Error('session did not open')
  await vi.waitFor(() => expect(busy.op()).not.toBeNull())
  await new Promise((r) => setTimeout(r, 3 * ttl))
  const reclaim = (
    busy.d.log.storage as unknown as {
      crashReclaim: { listExpired(now: number): Array<{ sessionKey: string }> }
    }
  ).crashReclaim
  expect(reclaim.listExpired(Date.now()).map((c) => c.sessionKey)).toEqual(['quiet'])
  release()
  await running
})

it('interrupts an idle session whose lease another writer took, at its next write', async () => {
  const ttl = 300
  const t = await realHosted({ limits: { 'lease.ttl_ms': ttl } })
  cleanups.push(t.close)
  const key = 'taken'
  await t.hosted.open(t.openFrame(key))
  await t.hosted.tail(key, 1)
  const session = t.host.kernel.get(key)
  if (!session) throw new Error('session did not open')
  await new Promise((r) => setTimeout(r, 2 * ttl))
  await session.d.log.storage.open(key, { writerRunId: 'someone-else', ttlMs: 60_000 })
  expect(t.sent.some((f) => f.kind === 'session.interrupted')).toBe(false)
  await expect(t.prompt(key, 'after the takeover')).rejects.toMatchObject({ code: 'E_WRITER_LEASE' })
  await vi.waitFor(() => expect(t.sent.filter((f) => f.kind === 'session.interrupted')).toHaveLength(1))
  expect(session.d.log.faulted).toBe(true)
})

it('writes again after an idle stretch longer than the lease, taking the lease back', async () => {
  const ttl = 300
  const t = await realHosted({ limits: { 'lease.ttl_ms': ttl } })
  cleanups.push(t.close)
  const key = 'rested'
  await t.hosted.open(t.openFrame(key))
  await new Promise((r) => setTimeout(r, 2 * ttl))
  await t.prompt(key, 'after resting')
  await expect(t.run(key)).resolves.toMatchObject({ reason: 'completed' })
  expect(t.host.kernel.get(key)?.d.log.faulted).toBe(false)
})
