import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createManagedServiceRuntime, readManagedServiceInitialization } from '../src/managed-service.node.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function port() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}
describe('managed service SDK runtime', () => {
  it('requires private proof, all readiness facts and one shutdown handler, persisting cleanup atomically', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agh-managed-sdk-'))
    cleanup.push(async () => rmSync(directory, { recursive: true, force: true }))
    const selected = await port()
    const runtime = await createManagedServiceRuntime({
      port: selected,
      healthPath: '/health',
      initialization: {
        instanceId: 'synthetic-one',
        incarnation: 'synthetic-proof',
        scopeId: 'one',
        apiVersion: '1.0.0',
        storePath: join(directory, 'state.db'),
        namespace: 'one',
        listeners: { device: { host: '127.0.0.1', port: 4180 } },
      },
    })
    cleanup.push(() => runtime.close())
    const health = `http://127.0.0.1:${selected}/health`
    expect((await fetch(health)).status).toBe(403)
    expect((await fetch(health, { headers: { 'x-agnes-incarnation': 'different-instance' } })).status).toBe(
      403,
    )
    const headers = { 'x-agnes-incarnation': 'synthetic-proof', 'content-type': 'application/json' }
    expect((await fetch(health, { headers })).status).toBe(503)
    await expect(runtime.ready({ apiVersion: '1.0.0', listeners: ['device'] })).rejects.toThrow('mismatch')
    let shutdowns = 0
    runtime.onShutdown(async (reason) => {
      shutdowns++
      await runtime.store.transaction((tx) => tx.put('shutdown', { reason }, null))
      return { state: 'settled' }
    })
    await expect(runtime.ready({ apiVersion: '2.0.0', listeners: ['device'] })).rejects.toThrow('mismatch')
    await expect(runtime.ready({ apiVersion: '1.0.0', listeners: [] })).rejects.toThrow('mismatch')
    await runtime.ready({ apiVersion: '1.0.0', listeners: ['device'] })
    expect(await (await fetch(health, { headers })).json()).toEqual({
      incarnation: 'synthetic-proof',
      apiVersion: '1.0.0',
      listeners: ['device'],
      storageReady: true,
      shutdownReady: true,
    })
    const stop = `http://127.0.0.1:${selected}/_agnes/managed/shutdown`
    const results = await Promise.all(
      [1, 2].map(() => fetch(stop, { method: 'POST', headers, body: JSON.stringify({ reason: 'disable' }) })),
    )
    for (const result of results)
      expect(await result.json()).toEqual({ incarnation: 'synthetic-proof', state: 'settled' })
    expect(shutdowns).toBe(1)
    expect(runtime.signal.aborted).toBe(true)
    expect(runtime.signal.reason).toBe('disable')
    expect((await runtime.store.scan({ prefix: '', limit: 1 })).rows[0]?.value).toEqual({ reason: 'disable' })
    expect((await fetch(health, { headers })).status).toBe(503)
  })
  it('rejects malformed initialization before opening any store or listener', () => {
    for (const value of [
      undefined,
      '{}',
      '{"storePath":"../escape"}',
      JSON.stringify({
        instanceId: 'one',
        incarnation: 'proof',
        scopeId: 'one',
        apiVersion: '1.0.0',
        storePath: '/synthetic/store.db',
        namespace: 'one',
        listeners: { device: { host: '0.0.0.0', port: 4180 } },
      }),
    ])
      expect(() => readManagedServiceInitialization(value)).toThrow('invalid managed service initialization')
  })
})
