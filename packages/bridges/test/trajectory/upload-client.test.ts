import { describe, expect, it, vi } from 'vitest'
import { createUploader, UploadError } from '../../src/trajectory/upload-client.js'

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
const digest = (bytes: Uint8Array): string =>
  [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .padEnd(64, '0')
    .slice(0, 64)

const authorized = new WeakSet<object>()
const authority = {
  assert(candidate: object) {
    if (!authorized.has(candidate)) throw new Error('not authorized')
  },
}

function gate(consent: 'DISABLED' | 'LOCAL' | 'ANON' | 'FULL', redact = false, sessionKey = 's') {
  let previous: string | null = null
  const receipts: string[] = []
  let tail = Promise.resolve()
  const result = {
    active: true,
    session: { key: sessionKey },
    get consent() {
      return consent
    },
    receipts,
    send(value: unknown, sender: (bytes: Uint8Array) => void | Promise<void>) {
      const run = async () => {
        if (consent === 'DISABLED' || consent === 'LOCAL') throw new Error('consent does not allow upload')
        const text = value instanceof Uint8Array ? new TextDecoder().decode(value) : String(value)
        const bytes = encode(redact ? text.replace('alice@example.com', '[REDACTED:email]') : text)
        await sender(bytes)
        previous = `${previous ?? 'root'}>${digest(bytes)}`
        receipts.push(previous)
        return { bytes, receipt: previous }
      }
      const result = tail.then(run, run)
      tail = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    },
  }
  authorized.add(result)
  return result
}

describe('trajectory uploader', () => {
  it('requires TLS for remote endpoints and permits explicit loopback HTTP', () => {
    const options = {
      harness: { name: 'agnes', version: '1' },
      egress: gate('FULL'),
      authority,
      fetch: vi.fn() as never,
      hash: digest,
    }
    expect(() => createUploader({ ...options, endpoint: 'http://trace.example' })).toThrow('must use https')
    expect(() => createUploader({ ...options, endpoint: 'http://127.0.0.1:3000' })).not.toThrow()
  })

  it('requires opaque gate authority and an explicit remote origin', () => {
    const real = gate('FULL')
    const common = {
      endpoint: 'https://169.254.169.254',
      harness: { name: 'agnes', version: '1' },
      egress: real,
      authority,
      fetch: vi.fn() as never,
      hash: digest,
    }
    expect(() => createUploader(common)).toThrow('not explicitly allowed')
    expect(() =>
      createUploader({
        ...common,
        endpoint: 'https://trace.example',
        allowedOrigins: ['https://trace.example'],
        egress: { ...real },
      }),
    ).toThrow('not authorized')
  })

  it('rejects a digest callback that could copy content into a header', async () => {
    const fetch = vi.fn()
    const uploader = createUploader({
      endpoint: 'https://trace.example',
      harness: { name: 'agnes', version: '1' },
      egress: gate('FULL'),
      authority,
      allowedOrigins: ['https://trace.example'],
      fetch: fetch as never,
      hash: (bytes) => new TextDecoder().decode(bytes),
    })
    await expect(uploader.upload('s', encode('alice@example.com'))).rejects.toThrow('sha256')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['DISABLED', 'LOCAL'] as const)('fails closed without network for %s', async (consent) => {
    const fetch = vi.fn()
    const uploader = createUploader({
      endpoint: 'https://trace.example/',
      harness: { name: 'agnes', version: '1' },
      egress: gate(consent),
      authority,
      allowedOrigins: ['https://trace.example'],
      fetch: fetch as never,
      hash: digest,
    })
    await expect(uploader.upload('s', encode('{}\n'))).resolves.toEqual({
      status: 'skipped',
      reason: 'consent',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('sends ANON only after the session gate redacts and commits a receipt', async () => {
    const sessionGate = gate('ANON', true, 's/1')
    const fetch = vi.fn(async (_input: URL, _init: RequestInit) => new Response(null, { status: 204 }))
    const uploader = createUploader({
      endpoint: 'https://trace.example',
      harness: { name: 'agnes', version: '1' },
      egress: sessionGate,
      authority,
      allowedOrigins: ['https://trace.example'],
      fetch: fetch as never,
      hash: digest,
      now: () => 0,
    })
    await expect(uploader.upload('s/1', encode('{"email":"alice@example.com"}\n'))).resolves.toEqual({
      status: 'sent',
    })
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.href).toBe('https://trace.example/api/v1/agent-traces/sessions/s%2F1')
    expect(new TextDecoder().decode(init.body as Uint8Array)).toContain('[REDACTED:email]')
    expect(new TextDecoder().decode(init.body as Uint8Array)).not.toContain('alice@example.com')
    expect(init.headers).toMatchObject({
      'X-Agnes-Harness': 'agnes/1',
      'X-Agnes-Trace-Consent': 'ANON',
    })
    expect(sessionGate.receipts).toHaveLength(1)
  })

  it('dedupes and flushes each session latest payload through its gate', async () => {
    let time = 0
    const sessionGate = gate('FULL', false, 'a')
    const fetch = vi.fn(async (_input: URL, _init: RequestInit) => new Response(null, { status: 204 }))
    const uploader = createUploader({
      endpoint: 'https://trace.example',
      harness: { name: 'agnes', version: '1' },
      egress: sessionGate,
      authority,
      allowedOrigins: ['https://trace.example'],
      fetch: fetch as never,
      hash: digest,
      now: () => time,
      minIntervalMs: 5_000,
      debounceMs: 60_000,
    })
    await uploader.upload('a', encode('v1'))
    expect(await uploader.upload('a', encode('v1'))).toEqual({ status: 'deduped' })
    time = 100
    expect(await uploader.upload('a', encode('v2'))).toEqual({ status: 'rate-limited' })
    expect(await uploader.upload('a', encode('v3'))).toEqual({ status: 'rate-limited' })
    await uploader.flush()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(sessionGate.receipts).toHaveLength(2)
    const bodies = fetch.mock.calls.map(([, init]) => new TextDecoder().decode(init.body as Uint8Array))
    expect(bodies).toContain('v3')
    expect(bodies).not.toContain('v2')
  })

  it('cancels a newer pending snapshot when the latest state returns to the remote hash', async () => {
    let time = 0
    const fetch = vi.fn(async () => new Response(null, { status: 204 }))
    const uploader = createUploader({
      endpoint: 'https://trace.example',
      allowedOrigins: ['https://trace.example'],
      harness: { name: 'agnes', version: '1' },
      egress: gate('FULL'),
      authority,
      fetch: fetch as never,
      hash: digest,
      now: () => time,
      minIntervalMs: 5_000,
      debounceMs: 60_000,
    })
    await uploader.upload('s', encode('v1'))
    time = 100
    expect(await uploader.upload('s', encode('v2'))).toEqual({ status: 'rate-limited' })
    expect(await uploader.upload('s', encode('v1'))).toEqual({ status: 'deduped' })
    await uploader.flush()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not send a debounced payload before the minimum interval', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      const fetch = vi.fn(async () => new Response(null, { status: 204 }))
      const uploader = createUploader({
        endpoint: 'https://trace.example',
        allowedOrigins: ['https://trace.example'],
        harness: { name: 'agnes', version: '1' },
        egress: gate('FULL'),
        authority,
        fetch: fetch as never,
        hash: digest,
        now: () => Date.now(),
        minIntervalMs: 5_000,
        debounceMs: 1_500,
      })
      await uploader.upload('s', encode('v1'))
      vi.setSystemTime(100)
      await uploader.upload('s', encode('v2'))
      await vi.advanceTimersByTimeAsync(4_899)
      expect(fetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not commit or dedupe a failed network send', async () => {
    const sessionGate = gate('FULL')
    const fetch = vi.fn(async (_input: URL, _init: RequestInit) => new Response('failed', { status: 503 }))
    const uploader = createUploader({
      endpoint: 'https://trace.example',
      harness: { name: 'agnes', version: '1' },
      egress: sessionGate,
      authority,
      allowedOrigins: ['https://trace.example'],
      fetch: fetch as never,
      hash: digest,
    })
    await expect(uploader.upload('s', encode('x'))).rejects.toBeInstanceOf(UploadError)
    await expect(uploader.upload('s', encode('x'))).rejects.toBeInstanceOf(UploadError)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(sessionGate.receipts).toHaveLength(0)
  })

  it('bounds an error response and cancels the remainder of its stream', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(4_096).fill(120))
      },
      cancel() {
        cancelled = true
      },
    })
    const uploader = createUploader({
      endpoint: 'https://trace.example',
      allowedOrigins: ['https://trace.example'],
      harness: { name: 'agnes', version: '1' },
      egress: gate('FULL'),
      authority,
      fetch: (async () => new Response(body, { status: 503 })) as never,
      hash: digest,
    })
    const error = await uploader.upload('s', encode('x')).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(UploadError)
    expect((error as Error).message.length).toBeLessThan(260)
    expect(cancelled).toBe(true)
  })

  it('surfaces a failed background send from flush and permits an explicit retry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      let fail = false
      const fetch = vi.fn(async () => new Response(fail ? 'no' : null, { status: fail ? 503 : 204 }))
      const uploader = createUploader({
        endpoint: 'https://trace.example',
        allowedOrigins: ['https://trace.example'],
        harness: { name: 'agnes', version: '1' },
        egress: gate('FULL'),
        authority,
        fetch: fetch as never,
        hash: digest,
        now: () => Date.now(),
        minIntervalMs: 10,
        debounceMs: 10,
      })
      await uploader.upload('s', encode('v1'))
      fail = true
      vi.setSystemTime(1)
      await uploader.upload('s', encode('v2'))
      await vi.advanceTimersByTimeAsync(10)
      await expect(uploader.flush()).rejects.toBeInstanceOf(UploadError)
      fail = false
      await expect(uploader.upload('s', encode('v2'))).resolves.toEqual({ status: 'sent' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds a hung request and leaves no receipt', async () => {
    const sessionGate = gate('FULL')
    const fetch = vi.fn(
      async (_input: URL, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        }),
    )
    const uploader = createUploader({
      endpoint: 'https://trace.example',
      harness: { name: 'agnes', version: '1' },
      egress: sessionGate,
      authority,
      allowedOrigins: ['https://trace.example'],
      fetch: fetch as never,
      hash: digest,
      requestTimeoutMs: 5,
    })
    await expect(uploader.upload('s', encode('x'))).rejects.toThrow('timed out')
    expect(sessionGate.receipts).toHaveLength(0)
  })

  it('never starts network after the lifecycle signal is already aborted', async () => {
    const fetch = vi.fn()
    const controller = new AbortController()
    controller.abort(new Error('shutdown expired'))
    const uploader = createUploader({
      endpoint: 'https://trace.example',
      harness: { name: 'agnes', version: '1' },
      egress: gate('FULL'),
      authority,
      allowedOrigins: ['https://trace.example'],
      fetch: fetch as never,
      hash: digest,
      signal: controller.signal,
    })
    await expect(uploader.upload('s', encode('x'))).rejects.toThrow('shutdown expired')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('cancels pending work and timers permanently when the lifecycle aborts', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      const fetch = vi.fn(async () => new Response(null, { status: 204 }))
      const controller = new AbortController()
      const uploader = createUploader({
        endpoint: 'https://trace.example',
        harness: { name: 'agnes', version: '1' },
        egress: gate('FULL'),
        authority,
        allowedOrigins: ['https://trace.example'],
        fetch: fetch as never,
        hash: digest,
        now: () => Date.now(),
        minIntervalMs: 5_000,
        debounceMs: 1_500,
        signal: controller.signal,
      })
      await uploader.upload('s', encode('v1'))
      vi.setSystemTime(100)
      await expect(uploader.upload('s', encode('v2'))).resolves.toEqual({ status: 'rate-limited' })
      expect(vi.getTimerCount()).toBe(1)
      controller.abort(new Error('lifecycle ended'))
      expect(vi.getTimerCount()).toBe(0)
      await vi.runAllTimersAsync()
      expect(fetch).toHaveBeenCalledTimes(1)
      await expect(uploader.upload('s', encode('v3'))).rejects.toThrow('lifecycle ended')
      await expect(uploader.flush()).rejects.toThrow('lifecycle ended')
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cannot relabel one session gate as another remote session', async () => {
    const fetch = vi.fn()
    const uploader = createUploader({
      endpoint: 'https://trace.example',
      harness: { name: 'agnes', version: '1' },
      egress: gate('FULL', false, 'owned'),
      authority,
      allowedOrigins: ['https://trace.example'],
      fetch: fetch as never,
      hash: digest,
    })
    await expect(uploader.upload('other', encode('x'))).rejects.toThrow('does not match')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses a gate whose owning session has ended', async () => {
    const fetch = vi.fn()
    const ended = { ...gate('FULL'), active: false }
    authorized.add(ended)
    const uploader = createUploader({
      endpoint: 'https://trace.example',
      harness: { name: 'agnes', version: '1' },
      egress: ended,
      authority,
      allowedOrigins: ['https://trace.example'],
      fetch: fetch as never,
      hash: digest,
    })
    await expect(uploader.upload('s', encode('x'))).rejects.toThrow('not active')
    expect(fetch).not.toHaveBeenCalled()
  })
})
