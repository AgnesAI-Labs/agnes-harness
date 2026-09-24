import { once } from 'node:events'
import { connect } from 'node:net'
import { describe, expect, it } from 'vitest'
import { startHealthz } from '../src/runner/health.js'
import type { RunnerStatus } from '../src/runner/runner.js'

const connected: RunnerStatus = {
  channel: 'connected',
  daemon: 'connected',
  lastEventAt: '2026-09-12T00:00:00.000Z',
  sessions: 2,
  degraded: ['agnes:t:a:fake:group:c:edit'],
}

describe('startHealthz', () => {
  it('reports only the runner health fields and changes readiness with live status', async () => {
    let status = connected
    const runner = {
      status: () => ({ ...status, secret: 'must-not-leak' }) as RunnerStatus,
    }
    const health = await startHealthz(runner, 0)
    try {
      const ready = await fetch(`http://127.0.0.1:${health.port}/healthz`)
      expect(ready.status).toBe(200)
      expect(ready.headers.get('cache-control')).toBe('no-store')
      expect(ready.headers.get('content-type')).toBe('application/json; charset=utf-8')
      expect(await ready.json()).toEqual({ ...connected, uptimeSec: expect.any(Number) })

      status = { ...connected, channel: 'reconnecting' }
      const degraded = await fetch(`http://127.0.0.1:${health.port}/healthz`)
      expect(degraded.status).toBe(503)
      expect(await degraded.json()).toMatchObject({ channel: 'reconnecting' })

      expect((await fetch(`http://127.0.0.1:${health.port}/healthz?verbose=1`)).status).toBe(404)
      expect((await fetch(`http://127.0.0.1:${health.port}/healthz`, { method: 'POST' })).status).toBe(404)
    } finally {
      await health.close()
    }
  })

  it('fails closed without echoing an exception from runner.status()', async () => {
    const health = await startHealthz(
      {
        status() {
          throw new Error('clientSecret=do-not-echo')
        },
      },
      0,
    )
    try {
      const response = await fetch(`http://127.0.0.1:${health.port}/healthz`)
      expect(response.status).toBe(503)
      const body = await response.text()
      expect(body).not.toContain('do-not-echo')
      expect(JSON.parse(body)).toMatchObject({
        channel: 'stopped',
        daemon: 'closed',
        sessions: 0,
        degraded: [],
      })
    } finally {
      await health.close()
    }
  })

  it('rejects an occupied port without disturbing its owner and releases it on close', async () => {
    const owner = await startHealthz({ status: () => connected }, 0)
    await expect(startHealthz({ status: () => connected }, owner.port)).rejects.toMatchObject({
      code: 'EADDRINUSE',
    })
    expect((await fetch(`http://127.0.0.1:${owner.port}/healthz`)).status).toBe(200)
    await owner.close()

    const replacement = await startHealthz({ status: () => connected }, owner.port)
    await replacement.close()
  })

  it('closes idempotently and destroys incomplete loopback connections', async () => {
    const health = await startHealthz({ status: () => connected }, 0)
    const socket = connect(health.port, '127.0.0.1')
    socket.on('error', () => undefined)
    await once(socket, 'connect')
    socket.write('GET /healthz HTTP/1.1\r\nHost: localhost\r\n')
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
    await Promise.all([health.close(), health.close()])
    await closed
    await expect(fetch(`http://127.0.0.1:${health.port}/healthz`)).rejects.toThrow()
  })
})
