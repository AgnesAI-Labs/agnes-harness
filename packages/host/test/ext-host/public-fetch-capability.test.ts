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
    expect(projected.subagent.list).toBeUndefined()
  })
  it('preserves child controls only behind the declared subagent capability', async () => {
    const child = { id: 'child', providerId: 'in-process', status: 'idle', continuable: true }
    const ctx = {
      ...raw(),
      subagent: {
        list: async () => [child],
        models: async () => [],
        sendMessage: async (key: string, text: string) => ({ messageId: `${key}:${text}` }),
        interrupt: async () => ({ accepted: true }),
      },
    } as unknown as ToolContext
    const denied = capabilityToolContext(manifest(), ctx)
    for (const operation of [
      () => denied.subagent.list?.(),
      () => denied.subagent.models?.(),
      () => denied.subagent.sendMessage?.('child', 'next'),
      () => denied.subagent.interrupt?.('child'),
    ])
      expect(operation).toThrow('E_CAPABILITY_UNDECLARED')
    const allowed = capabilityToolContext({ ...manifest(), capabilities: { subagent: true } }, ctx)
    expect(await allowed.subagent.list?.()).toEqual([child])
    expect(await allowed.subagent.models?.()).toEqual([])
    expect(await allowed.subagent.sendMessage?.('child', 'next')).toEqual({ messageId: 'child:next' })
    expect(await allowed.subagent.interrupt?.('child')).toEqual({ accepted: true })
  })
})
