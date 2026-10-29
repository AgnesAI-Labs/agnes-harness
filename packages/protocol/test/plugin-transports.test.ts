import { describe, expect, it } from 'vitest'
import {
  decodePluginStreamBinary,
  encodePluginStreamBinary,
  transportCapabilityProblems,
  validateManagedServiceDescriptor,
  validateManagedServiceReady,
  validatePluginStreamOpen,
  validateStreamDeclaration,
} from '../src/index.js'

const declaration = {
  name: 'sample.frames',
  scope: 'profile',
  inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false as const },
  directions: ['outbound' as const],
  lane: 'media' as const,
  maxFrameBytes: 1048576,
  maxBufferedBytes: 2097152,
  maxBytesPerSecond: 4194304,
}
describe('plugin transport contracts', () => {
  it('admits bounded declarations and refuses inbound paths without effect authority', () => {
    expect(validateStreamDeclaration(declaration).ok).toBe(true)
    const session = { ...declaration, scope: 'session' as const, readService: 'sample.read' }
    const query = {
      name: 'sample.read',
      kind: 'query' as const,
      scope: 'session' as const,
      inputSchema: declaration.inputSchema,
      outputSchema: {},
      timeoutMs: 1000,
      maxResultBytes: 4096,
    }
    expect(transportCapabilityProblems({ streams: [session], services: [query] })).toEqual([])
    expect(transportCapabilityProblems({ streams: [session] })).toContain(
      'stream readService must name an own session query service',
    )
    expect(
      transportCapabilityProblems({ streams: [session], services: [{ ...query, scope: 'profile' }] }),
    ).toContain('stream readService must name an own session query service')
    expect(
      validateStreamDeclaration({ ...declaration, producer: true, directions: ['inbound', 'outbound'] }).ok,
    ).toBe(true)
    for (const patch of [
      { directions: ['inbound'] },
      { producer: true, scope: 'session', directions: ['inbound'] },
      { producer: true, lane: 'control', directions: ['inbound'], controlService: 'sample.effect' },
      { producer: true, controlService: 'sample.effect', directions: ['inbound'] },
      { maxFrameBytes: 1048577 },
      { lane: 'control', directions: ['inbound'], maxFrameBytes: 4096, maxBufferedBytes: 32768 },
      { upstreamUrl: 'http://example.invalid' },
    ])
      expect(validateStreamDeclaration({ ...declaration, ...patch }).ok).toBe(false)
    expect(
      validateStreamDeclaration({
        ...declaration,
        lane: 'control',
        directions: ['inbound'],
        controlService: 'sample.effect',
        maxFrameBytes: 4096,
        maxBufferedBytes: 32768,
        maxBytesPerSecond: 122880,
      }).ok,
    ).toBe(true)
  })
  it('keeps the binary envelope atomic, versioned and bounded', () => {
    const encoded = encodePluginStreamBinary(7, 3, new Uint8Array([1, 2, 3]))
    expect(decodePluginStreamBinary(encoded)).toEqual({
      streamId: 7,
      sequence: 3,
      payload: new Uint8Array([1, 2, 3]),
    })
    for (const offset of [0, 4, 5, 6, 19]) {
      const bad = encoded.slice()
      bad[offset] = 99
      expect(() => decodePluginStreamBinary(bad)).toThrow()
    }
    expect(() => encodePluginStreamBinary(1, 0, new Uint8Array(1048576))).toThrow()
    expect(() => decodePluginStreamBinary(encoded.subarray(1))).toThrow()
  })
  it('binds open scope and rejects caller identities and arbitrary URLs', () => {
    const open = {
      owner: 'sample/plugin',
      name: 'sample.frames',
      scope: { kind: 'profile', profileId: 'one' },
      input: {},
    }
    expect(validatePluginStreamOpen(open).ok).toBe(true)
    expect(validatePluginStreamOpen({ ...open, actor: 'admin' }).ok).toBe(false)
    expect(
      validatePluginStreamOpen({ ...open, scope: { kind: 'session', profileId: 'one', sessionId: 's' } }).ok,
    ).toBe(false)
  })
  it('requires explicit readiness and unique listeners', () => {
    const descriptor = {
      id: 'sample',
      scope: 'profile',
      artifact: { kind: 'node', entry: './dist/server.mjs' },
      healthPath: '/health',
      listeners: [{ name: 'main', host: '127.0.0.1', port: 'auto' }],
      startupTimeoutMs: 30000,
      shutdownTimeoutMs: 5000,
      apiVersion: '1.0.0',
      requires: [],
    }
    expect(validateManagedServiceDescriptor(descriptor).ok).toBe(true)
    expect(validateManagedServiceDescriptor({ ...descriptor, artifact: { kind: 'in-process' } }).ok).toBe(
      true,
    )
    expect(
      validateManagedServiceDescriptor({
        ...descriptor,
        artifact: { kind: 'in-process', entry: './arbitrary.js' },
      }).ok,
    ).toBe(false)
    expect(
      validateManagedServiceDescriptor({
        ...descriptor,
        listeners: [...descriptor.listeners, ...descriptor.listeners],
      }).ok,
    ).toBe(false)
    expect(
      validateManagedServiceReady({
        incarnation: 'synthetic',
        apiVersion: '1.0.0',
        listeners: ['main'],
        storageReady: true,
        shutdownReady: true,
      }).ok,
    ).toBe(true)
    expect(
      validateManagedServiceReady({ incarnation: 'synthetic', apiVersion: '1.0.0', listeners: ['main'] }).ok,
    ).toBe(false)
  })
})
