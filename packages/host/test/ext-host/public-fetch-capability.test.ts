import type { ExtensionManifest, ToolContext } from '@agnes/extension-api'
import { assertCapabilityCeiling, manifestCapabilities } from '@agnes/package-manager'
import { describe, expect, it, vi } from 'vitest'
import { capabilityToolContext } from '../../src/ext-host/tool-context-capabilities.js'

const manifest = (enabled = false): ExtensionManifest => ({
  id: 'test/web',
  version: '1.0.0',
  apiRange: '^1.1',
  entry: './index.js',
  capabilities: { network: { hosts: ['example.com'] }, ...(enabled ? { 'network.publicRead': true } : {}) },
})
const raw = () =>
  ({ net: { fetch: vi.fn(), fetchPublic: vi.fn(async () => ({ url: 'ok' })) } }) as unknown as ToolContext

describe('independent public retrieval grant', () => {
  it('does not infer public access from a normal network grant', () => {
    const ctx = raw(),
      projected = capabilityToolContext(manifest(), ctx)
    expect(() => projected.net.fetchPublic?.('https://example.com')).toThrow('E_CAPABILITY_UNDECLARED')
    expect(ctx.net.fetchPublic).not.toHaveBeenCalled()
    expect(manifestCapabilities(manifest(true))).toContain('network.publicRead')
    expect(() => assertCapabilityCeiling(manifest(true), ['network'])).toThrow(
      'extension exceeds capability ceiling',
    )
  })
  it('passes public retrieval without widening ordinary fetch', async () => {
    const ctx = raw(),
      projected = capabilityToolContext(manifest(true), ctx)
    await projected.net.fetchPublic?.('https://other.example')
    expect(ctx.net.fetchPublic).toHaveBeenCalledWith('https://other.example')
    expect(() => projected.net.fetch('https://other.example')).toThrow('E_CAPABILITY_UNDECLARED')
  })
  it('fails closed when an older host lacks the method', () => {
    const projected = capabilityToolContext(manifest(true), {
      net: { fetch: vi.fn() },
    } as unknown as ToolContext)
    expect(() => projected.net.fetchPublic?.('https://example.com')).toThrow('unavailable')
  })
})
