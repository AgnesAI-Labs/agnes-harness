import { describe, expect, it } from 'vitest'
import { parseConnectTarget, unixConnectTarget } from '../src/boot/connect.js'
import { BootError } from '../src/errors.js'

describe('CLI connection targets', () => {
  it('round-trips a local Windows pipe without interpreting its name as a URL host', () => {
    const path = '\\\\.\\pipe\\agnes-中文 space%'
    const uri = unixConnectTarget(path)
    expect(uri).toBe('pipe:///agnes-%E4%B8%AD%E6%96%87%20space%25')
    expect(parseConnectTarget(uri, {})).toEqual({ kind: 'unix', path })
  })

  it('preserves Unix socket punctuation and literal percent escapes', () => {
    const path = '/tmp/agnes 中文/#?%2F.sock'
    expect(parseConnectTarget(unixConnectTarget(path), {})).toEqual({ kind: 'unix', path })
  })

  it.each([
    'pipe://remote/agnes',
    'pipe://user:pass@remote/agnes',
    'pipe:///',
    'pipe:///.',
    'pipe:///..',
    'pipe:///a/b',
    'pipe:///a/../b',
    'pipe:///a/%2e%2e/b',
    'pipe:///a%2Fb',
    'pipe:///a%5Cb',
    'pipe:///a%00b',
    'pipe:///a%0Ab',
    'pipe:///a%7Fb',
    'pipe:///a:b',
    'pipe:///a%3Ab',
    'pipe:///a%3Fb',
    'pipe:///a%23b',
    'pipe:///a?token=secret',
    'pipe:///a#secret',
    'pipe:///a%',
    'pipe:///a\nb',
  ])('rejects an ambiguous or nonlocal pipe target: %j', (uri) => {
    expect(() => parseConnectTarget(uri, {})).toThrow(BootError)
  })

  it('maps a Unix URI to a socket path without reading profile files', () => {
    expect(parseConnectTarget('unix:///tmp/agnes.sock', {})).toEqual({
      kind: 'unix',
      path: '/tmp/agnes.sock',
    })
  })

  it('keeps WebSocket credentials out of the target URL and separates upgrade from JWT auth', () => {
    expect(
      parseConnectTarget('wss://daemon.example.test:8443', {
        AGNES_WS_TOKEN: 'lifecycle-token',
        AGNES_CONNECT_JWT: 'application-token',
      }),
    ).toEqual({
      kind: 'ws',
      url: 'wss://daemon.example.test:8443/',
      protocols: ['agnes-v1', 'agnes-bearer.lifecycle-token'],
      auth: { kind: 'jwt', token: 'application-token' },
    })
  })

  it('rejects URL credentials and WSS without an explicit upgrade token', () => {
    expect(() => parseConnectTarget('unix://user:pass@/tmp/agnes.sock', {})).toThrow(BootError)
    expect(() => parseConnectTarget('wss://daemon.example.test:8443', {})).toThrow(
      'AGNES_WS_TOKEN is required',
    )
  })
})
