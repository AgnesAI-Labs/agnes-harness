import { createHash } from 'node:crypto'
import { createSessionEgressGate, privacyExtension, sessionEgressAuthority } from '@agnes/base'
import { createUploader } from '@agnes/bridges/trajectory'
import { describe, expect, it, vi } from 'vitest'

describe('trajectory privacy integration', () => {
  it('uses the real API+SessionRef gate for ANON redaction and its receipt', async () => {
    const handlers = new Map<string, (payload: unknown, context: never) => unknown>()
    const events: Array<[string, unknown]> = []
    const api = {
      events: {
        append: async (name: string, data: unknown) => {
          events.push([name, data])
          return events.length
        },
      },
      registerHook: (name: string, handler: (payload: unknown, context: never) => unknown) => {
        handlers.set(name, handler)
        return () => undefined
      },
    }
    const dispose = privacyExtension(api as never)
    const session = Object.freeze({
      key: 'trajectory-integration',
      lane: 'main',
      workspaceRoot: '/workspace',
      telemetryConsent: 'ANON' as const,
      telemetryConsentPendingAudit: true,
    })
    await handlers.get('session_start')?.({ preset: 'standard' }, { session } as never)
    const fetch = vi.fn(async (_input: URL, _init: RequestInit) =>
      Promise.resolve(new Response(null, { status: 204 })),
    )
    const uploader = createUploader({
      endpoint: 'https://trace.example',
      harness: { name: 'agnes', version: '1' },
      egress: createSessionEgressGate(api as never, session),
      authority: sessionEgressAuthority,
      allowedOrigins: ['https://trace.example'],
      fetch: fetch as never,
      hash: (bytes) => createHash('sha256').update(bytes).digest('hex'),
    })

    await uploader.upload(
      'trajectory-integration',
      new TextEncoder().encode('{"email":"alice@example.com"}\n'),
    )

    const [, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit]
    const sent = new TextDecoder().decode(init.body as ArrayBuffer)
    expect(sent).toContain('[REDACTED:email]')
    expect(sent).not.toContain('alice@example.com')
    expect(events[0]).toEqual(['consent', { from: 'DISABLED', to: 'ANON', by: 'profile:standard' }])
    expect(events[1]).toMatchObject(['egress', { consent: 'ANON' }])
    if (typeof dispose === 'function') dispose()
  })
})
