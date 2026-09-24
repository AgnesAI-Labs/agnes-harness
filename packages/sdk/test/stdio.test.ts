import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { MAX_FRAME_BYTES } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { ProtocolViolation, TransportClosed } from '../src/errors.js'
import { createClient } from '../src/index.node.js'
import { memoryJournal } from '../src/journal.js'
import { RpcConnection } from '../src/rpc.js'
import { stdioTransport } from '../src/transport/stdio.node.js'
import type { CloseInfo } from '../src/transport/types.js'

const server = fileURLToPath(new URL('./fixtures/echo-server.mjs', import.meta.url))
const owned: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  await Promise.all(owned.splice(0).map((c) => c.close()))
})
function connect(mode = 'normal', options: Parameters<typeof stdioTransport>[0] = { cmd: [] }) {
  const closes: CloseInfo[] = []
  const factory = stdioTransport({ ...options, cmd: [process.execPath, server, mode] })
  const c = new RpcConnection(
    async (handlers) => {
      const transport = await factory(handlers)
      // Teardown remains available even while testing a broken RpcConnection.close implementation.
      owned.push(transport)
      return transport
    },
    {
      requestTimeoutMs: 5000,
      onClose: (info) => closes.push(info),
    },
  )
  owned.push(c)
  return { c, closes }
}

describe('real stdio subprocess', () => {
  it('same-tick connect and close waits for and tears down the newly spawned child', async () => {
    const { c, closes } = connect('normal', { cmd: [], shutdownGraceMs: 100 })
    const opening = c.connect()
    const closing = c.close()
    await Promise.all([opening, closing])
    expect(c.connected).toBe(false)
    expect(closes).toHaveLength(1)
    expect(closes[0]?.reason).toBe('exit')
    await c.close()
    expect(closes).toHaveLength(1)
    await expect(c.connect()).rejects.toBeInstanceOf(TransportClosed)
  })
  it('round trips split UTF-8 and uses default shutdown and stderr limits', async () => {
    const { c, closes } = connect()
    await c.connect()
    expect(await c.request('split', {})).toBe('漢🌱')
    await c.request('stderr', {})
    await Promise.all([c.close(), c.close()])
    expect(closes).toHaveLength(1)
    expect(closes[0]).toMatchObject({ reason: 'exit', exitCode: 0 })
    expect(closes[0]?.stderrTail).toContain('TAIL')
    expect(closes[0]?.stderrTail).toContain('shutdown observed')
    expect(Buffer.byteLength(closes[0]?.stderrTail ?? '')).toBeLessThanOrEqual(4096)
    await expect(c.connect()).rejects.toBeInstanceOf(TransportClosed)
  })
  it('wires stdio into the node createClient entry with local auth by default', async () => {
    const c = createClient({
      journal: memoryJournal(),
      transport: { kind: 'stdio', cmd: [process.execPath, server] },
    })
    owned.push(c)
    expect(await c.initialize()).toHaveProperty('capabilities')
    await expect(c.call('echo', { n: 1 })).resolves.toMatchObject({ echo: { n: 1 } })
  })
  it('passes cwd and explicit env while retaining inherited environment', async () => {
    const previous = process.env.AGNES_STDIO_INHERITED
    process.env.AGNES_STDIO_INHERITED = 'inherited'
    try {
      const { c } = connect('normal', { cmd: [], cwd: tmpdir(), env: { AGNES_STDIO_TEST_VALUE: 'present' } })
      await c.connect()
      expect(await c.request('echo', {})).toMatchObject({
        cwd: realpathSync(tmpdir()),
        env: 'present',
        inherited: 'inherited',
      })
    } finally {
      if (previous === undefined) delete process.env.AGNES_STDIO_INHERITED
      else process.env.AGNES_STDIO_INHERITED = previous
    }
  })
  it('reports crash exit and fully drained stderr on all pending requests', async () => {
    const { c, closes } = connect()
    await c.connect()
    const hanging = c.request('hang', {}, { timeoutMs: null })
    const both = Promise.allSettled([hanging, c.request('crash', {})])
    for (const r of await both) {
      expect(r.status).toBe('rejected')
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(TransportClosed)
    }
    expect(closes).toHaveLength(1)
    expect(closes[0]).toMatchObject({ exitCode: 3, stderrTail: expect.stringContaining('crash requested') })
  })
  it('settles on parent exit without close even while a descendant holds both output pipes', async () => {
    const { c, closes } = connect('normal', { cmd: [], shutdownGraceMs: 80 })
    let pid: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await c.connect()
      pid = (await c.request<{ pid: number }>('inherited-pipes', {})).pid
      const pending = c.request('hang', {}, { timeoutMs: null }).then(
        () => 'unexpected response',
        (error: unknown) => error,
      )
      const result = await Promise.race([
        pending,
        new Promise<string>((r) => {
          timer = setTimeout(() => r('still pending with inherited pipes'), 700)
        }),
      ])
      expect(result).toBeInstanceOf(TransportClosed)
      expect(closes).toHaveLength(1)
      expect(closes[0]).toMatchObject({ reason: 'exit', exitCode: 3 })
      expect(closes[0]?.stderrTail).toContain('parent exiting 3')
      if (process.platform === 'win32') {
        // SDK owns the whole Job: descendants must no longer outlive the server.
        const descendant = pid
        expect(() => process.kill(descendant, 0)).toThrow()
      } else expect(closes[0]?.stderrTail).toContain('late inherited stderr')
      await c.close()
      expect(closes).toHaveLength(1)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (pid !== undefined) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
    }
  })
  it('cancels an outstanding interaction over stdin without closing the transport', async () => {
    const { c } = connect()
    await c.connect()
    const pending = c.request('hang', {}, { timeoutMs: null })
    await c.notify('session/cancel', {})
    expect(await pending).toEqual({ cancelled: true })
    expect(await c.request('echo', 2)).toMatchObject({ echo: 2 })
  })
  it.each([
    ['bad', 'invalid-json'],
    ['envelope', 'invalid-envelope'],
    ['utf8', 'invalid-utf8'],
    ['partial', 'truncated-frame'],
  ])('fails closed on %s with a machine-readable cause', async (method, violationKind) => {
    const { c, closes } = connect('normal', { cmd: [], shutdownGraceMs: 30 })
    await c.connect()
    await expect(c.request(method, {})).rejects.toBeInstanceOf(TransportClosed)
    expect(closes).toHaveLength(1)
    expect(closes[0]?.error).toMatchObject({ kind: 'protocol-violation', violationKind })
  })
  it('accepts exactly 16 MiB inbound and rejects one byte more', async () => {
    const { c, closes } = connect()
    await c.connect()
    expect(typeof (await c.request('large', { bytes: MAX_FRAME_BYTES }))).toBe('string')
    await expect(c.request('large', { bytes: MAX_FRAME_BYTES + 1 })).rejects.toBeInstanceOf(TransportClosed)
    expect(closes[0]?.error).toMatchObject({ violationKind: 'frame-too-large' })
  })
  it('rejects oversize outbound before writing and can still exchange a valid frame', async () => {
    const { c } = connect()
    await c.connect()
    await expect(c.request('echo', 'x'.repeat(MAX_FRAME_BYTES))).rejects.toBeInstanceOf(ProtocolViolation)
    expect(await c.request('echo', 3)).toMatchObject({ echo: 3 })
  })
  it('writes an exactly-at-limit request over the real pipe', async () => {
    const { c } = connect()
    await c.connect()
    const shell = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'length', params: '' }).length
    const params = 'x'.repeat(MAX_FRAME_BYTES - shell)
    expect(await c.request('length', params)).toBe(params.length)
  })
  it('uses the default 2000 ms grace before EOF when shutdown is unanswered', async () => {
    const { c, closes } = connect('eof')
    await c.connect()
    await c.request('echo', {})
    const start = performance.now()
    await c.close()
    expect(performance.now() - start).toBeGreaterThanOrEqual(1900)
    expect(closes[0]).toMatchObject({ exitCode: 0, signal: null })
    expect(closes[0]?.stderrTail).toContain('EOF observed')
  })
  it('honours an explicit zero-byte stderr tail', async () => {
    const { c, closes } = connect('normal', { cmd: [], stderrTailBytes: 0 })
    await c.connect()
    await c.request('stderr', {})
    await c.close()
    expect(closes[0]?.stderrTail).toBe('')
  })
  it('reports the native abrupt exit and settles an unbounded pending request', async () => {
    const { c, closes } = connect()
    await c.connect()
    await expect(c.request('killme', {}, { timeoutMs: null })).rejects.toBeInstanceOf(TransportClosed)
    expect(closes).toHaveLength(1)
    expect(closes[0]).toMatchObject(
      process.platform === 'win32'
        ? { reason: 'exit', exitCode: 1, signal: null }
        : { reason: 'exit', exitCode: null, signal: 'SIGKILL' },
    )
  })
  it('request cancellation removes only that request and preserves the pipe', async () => {
    const { c } = connect()
    await c.connect()
    const ac = new AbortController()
    const promise = c.request('hang', {}, { signal: ac.signal, timeoutMs: null })
    const error = new Error('caller cancelled')
    ac.abort(error)
    await expect(promise).rejects.toBe(error)
    expect(await c.request('echo', 'still open')).toMatchObject({ echo: 'still open' })
  })
  it('refuses invalid options before spawning', () => {
    expect(() => stdioTransport({ cmd: [] })).toThrow(TypeError)
    expect(() => stdioTransport({ cmd: ['x'], shutdownGraceMs: -1 })).toThrow(RangeError)
    expect(() => stdioTransport({ cmd: ['x'], stderrTailBytes: NaN })).toThrow(RangeError)
  })
  it.each([
    ['eof', null],
    ['term', 'SIGTERM'],
    // Node terminates a Windows child at SIGTERM even if the child registered a handler.
    ['kill', process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL'],
  ])('closes a %s child at the necessary ladder rung', async (mode, signal) => {
    const { c, closes } = connect(mode, { cmd: [], shutdownGraceMs: 40 })
    await c.connect()
    await c.request('echo', {}) // The child installed its signal handlers before closing starts.
    await c.close()
    expect(closes).toHaveLength(1)
    expect(closes[0]).toMatchObject({ reason: 'exit', signal })
    expect(closes[0]?.stderrTail).toContain('shutdown observed')
    expect(closes[0]?.stderrTail).toContain('EOF observed')
    if (mode === 'kill') {
      if (process.platform === 'win32') expect(closes[0]?.stderrTail).not.toContain('SIGTERM observed')
      else expect(closes[0]?.stderrTail).toContain('SIGTERM observed')
    }
  })
  it('reports spawn failures once and closes without hanging', async () => {
    // A timer turn catches nextTick error events that precede promise continuations on POSIX.
    await new Promise<void>((done) => setImmediate(done))
    const closes: CloseInfo[] = []
    const c = new RpcConnection(stdioTransport({ cmd: ['/no-such-agnes-stdio-binary'] }), {
      requestTimeoutMs: 1000,
      onClose: (i) => closes.push(i),
    })
    owned.push(c)
    await c.connect()
    await expect(c.request('echo', {})).rejects.toBeInstanceOf(TransportClosed)
    await c.close()
    expect(closes).toHaveLength(1)
    expect(closes[0]?.reason).toBe('error')
  })
})
