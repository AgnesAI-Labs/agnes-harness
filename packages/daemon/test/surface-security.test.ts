import type { ResolvedDeployment } from '@agnes/host'
import { describe, expect, it, vi } from 'vitest'
import { createSurfaceRoutes } from '../src/surfaces/routes.js'
import {
  DEFAULT_SURFACE_CSP,
  safeSurfaceContent,
  surfaceSecurityHeaders,
} from '../src/surfaces/security-headers.js'

describe('Surface browser response security', () => {
  it('sets authoritative browser security headers even when an upstream tries to weaken them', () => {
    const headers = surfaceSecurityHeaders({
      'Content-Security-Policy': "default-src * 'unsafe-inline'",
      'X-Frame-Options': 'SAMEORIGIN',
      'x-content-type-options': 'off',
      'cache-control': 'private',
    })
    expect(headers).toMatchObject({
      'content-security-policy': DEFAULT_SURFACE_CSP,
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'cache-control': 'private',
    })
    expect(headers['permissions-policy']).toContain('camera=()')
    expect(headers['content-security-policy']).not.toContain('unsafe-inline')
  })

  it('does not interpret unsanitized HTML and safely degrades unknown content', () => {
    const malicious = '<img src=x onerror=alert(1)><script>alert(2)</script>'
    expect(safeSurfaceContent(malicious, 'text/html')).toEqual({
      body: malicious,
      contentType: 'text/plain; charset=utf-8',
    })
    expect(safeSurfaceContent(Buffer.from('<script>bad()</script>'), 'application/octet-stream')).toEqual({
      body: '[unsupported surface content]',
      contentType: 'text/plain; charset=utf-8',
    })
  })

  it('allows HTML only through an explicit sanitizer', () => {
    const content = safeSurfaceContent(
      '<button onclick="steal()">ok</button><script>bad()</script>',
      'text/html',
      {
        sanitizeHtml: (html) =>
          html.replace(/ on\w+="[^"]*"/gi, '').replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ''),
      },
    )
    expect(content).toEqual({ body: '<button>ok</button>', contentType: 'text/html; charset=utf-8' })
  })

  it('blocks open redirects returned by a mounted Surface relay', async () => {
    const deployment = {
      surfaces: [
        {
          instance: { mount: '/sales', sourceId: 'sales-bff', grants: [] },
        },
      ],
    } as unknown as ResolvedDeployment
    const routes = createSurfaceRoutes({
      deployment,
      resolveSubject: async () => ({
        sessionId: 'login',
        subjectId: 'user',
        credential: { token: 'subject' },
      }),
      connectionFactory: async () => ({
        request: async () => ({
          status: 302,
          headers: { location: '//evil.example/phish', 'content-type': 'text/plain' },
        }),
      }),
      secretLease: { complete: true, values: [] },
    })
    const response = await routes.handle({ method: 'GET', url: '/sales/start' })
    expect(response.status).toBe(502)
    expect(response.headers).not.toHaveProperty('location')
    expect(response.body).toBe('{"error":{"code":"unsafe_redirect"}}')
  })

  it('blocks deeply encoded redirects and strips Refresh redirects', async () => {
    const deployment = {
      surfaces: [{ instance: { mount: '/sales', sourceId: 'sales-bff', grants: [] } }],
    } as unknown as ResolvedDeployment
    const locations = ['/sales/%25252e%25252e/admin', '/sales/%255fagnes/v1/call', '/sales/api%25252fadmin']
    const routes = createSurfaceRoutes({
      deployment,
      resolveSubject: async () => ({ sessionId: 'login', subjectId: 'user', credential: {} }),
      connectionFactory: async () => ({
        request: async () => ({
          status: 302,
          headers: {
            location: locations.shift() ?? '/sales',
            refresh: '0; url=https://evil.example/phish',
            'content-type': 'text/plain',
          },
        }),
      }),
      secretLease: { complete: true, values: [] },
    })
    for (let index = 0; index < 3; index += 1) {
      const response = await routes.handle({ method: 'GET', url: '/sales/start' })
      expect(response.status).toBe(502)
      expect(response.headers).not.toHaveProperty('location')
      expect(response.headers).not.toHaveProperty('refresh')
    }
  })

  it('strips fixed and Connection-declared response framing headers', async () => {
    const deployment = {
      surfaces: [{ instance: { mount: '/sales', sourceId: 'sales-bff', grants: [] } }],
    } as unknown as ResolvedDeployment
    const routes = createSurfaceRoutes({
      deployment,
      resolveSubject: async () => ({ sessionId: 'login', subjectId: 'user', credential: {} }),
      connectionFactory: async () => ({
        request: async () => ({
          status: 200,
          headers: {
            connection: 'keep-alive, X-Relay-Framing',
            'content-length': '999999',
            'keep-alive': 'timeout=60',
            'proxy-authenticate': 'Basic realm="secret"',
            'proxy-authorization': 'Basic secret',
            te: 'trailers',
            trailer: 'x-checksum',
            'transfer-encoding': 'chunked',
            upgrade: 'websocket',
            'x-relay-framing': 'attacker-controlled',
            'cache-control': 'private, no-store',
            'content-type': 'text/plain',
          },
          body: 'safe',
        }),
      }),
      secretLease: { complete: true, values: [] },
    })

    const response = await routes.handle({ method: 'GET', url: '/sales/report' })
    expect(response.status).toBe(200)
    for (const name of [
      'connection',
      'content-length',
      'keep-alive',
      'proxy-authenticate',
      'proxy-authorization',
      'te',
      'trailer',
      'transfer-encoding',
      'upgrade',
      'x-relay-framing',
    ]) {
      expect(response.headers).not.toHaveProperty(name)
    }
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(response.body).toBe('safe')
  })

  it('strips stale representation metadata after rewriting the relay body', async () => {
    const deployment = {
      surfaces: [{ instance: { mount: '/sales', sourceId: 'sales-bff', grants: [] } }],
    } as unknown as ResolvedDeployment
    const routes = createSurfaceRoutes({
      deployment,
      resolveSubject: async () => ({ sessionId: 'login', subjectId: 'user', credential: {} }),
      connectionFactory: async () => ({
        request: async () => ({
          status: 200,
          headers: {
            'content-encoding': 'gzip',
            'content-range': 'bytes 0-3/1000',
            'content-md5': 'attacker-md5',
            digest: 'sha-256=attacker-digest',
            etag: '"attacker-etag"',
            'content-digest': 'sha-256=:attacker:',
            'repr-digest': 'sha-256=:attacker:',
            'last-modified': 'Sat, 13 Sep 2026 00:00:00 GMT',
            'accept-ranges': 'bytes',
            'cache-control': 'private, no-store',
            'content-type': 'application/json',
          },
          body: { secret: 'must-be-removed', safe: true },
        }),
      }),
      secretLease: { complete: true, values: [] },
    })

    const response = await routes.handle({ method: 'GET', url: '/sales/report' })
    expect(response.status).toBe(200)
    for (const name of [
      'content-encoding',
      'content-range',
      'content-md5',
      'digest',
      'etag',
      'content-digest',
      'repr-digest',
      'last-modified',
      'accept-ranges',
    ]) {
      expect(response.headers).not.toHaveProperty(name)
    }
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(response.body).toBe('{"safe":true}')
  })

  it('rejects oversized relay bodies before sanitizing and caps redaction amplification', async () => {
    const deployment = {
      surfaces: [{ instance: { mount: '/sales', sourceId: 'sales-bff', grants: [] } }],
    } as unknown as ResolvedDeployment
    const sanitizeHtml = vi.fn((html: string) => html)
    const oversized = createSurfaceRoutes({
      deployment,
      resolveSubject: async () => ({ sessionId: 'login', subjectId: 'user', credential: {} }),
      connectionFactory: async () => ({
        request: async () => ({
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: '<p>this response is already too large</p>',
        }),
      }),
      sanitizeHtml,
      secretLease: { complete: true, values: [] },
      maxResponseBodyBytes: 24,
    })
    const rejected = await oversized.handle({ method: 'GET', url: '/sales/report' })
    expect(rejected).toMatchObject({ status: 502 })
    expect(rejected.body).toBe('{"error":{"code":"response_too_large"}}')
    expect(sanitizeHtml).not.toHaveBeenCalled()

    const amplified = createSurfaceRoutes({
      deployment,
      resolveSubject: async () => ({ sessionId: 'login-2', subjectId: 'user', credential: {} }),
      connectionFactory: async () => ({
        request: async () => ({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: { v: 'xxxxxxxxxx' },
        }),
      }),
      secretLease: { complete: true, values: ['x'] },
      maxResponseBodyBytes: 32,
    })
    const amplificationRejected = await amplified.handle({ method: 'GET', url: '/sales/report' })
    expect(amplificationRejected.status).toBe(502)
    expect(amplificationRejected.body).not.toContain('xxxxxxxxxx')
    expect(amplificationRejected.body).toContain('response_too_large')
  })
})
