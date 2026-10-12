import type { SandboxProvider } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { defineRemoteSandboxProvider } from '../src/provider.js'

const transport = {
  exec: async () => ({ code: 0, stdout: '', stderr: '', truncated: false }),
  upload: async () => {},
  download: async () => [],
  alive: () => true,
  close: async () => {},
}

describe('remote sandbox provider', () => {
  const opened: unknown[] = []
  const provider = defineRemoteSandboxProvider({
    id: 'acme-remote',
    version: '1.2.3',
    openTransport: async (...[config, ctx]: Parameters<NonNullable<SandboxProvider['openTransport']>>) => {
      opened.push([config, ctx.dataDir])
      return transport
    },
  })

  it('is a sandbox provider that hands the Host its channel opener', async () => {
    expect(provider).toMatchObject({ id: 'acme-remote', version: '1.2.3' })
    const ctx = { secret: () => '', dataDir: '/d', signal: new AbortController().signal }
    await expect(provider.openTransport?.({ rootTemplate: '/s/{session}' }, ctx)).resolves.toBe(transport)
    expect(opened).toEqual([[{ rootTemplate: '/s/{session}' }, '/d']])
  })

  it('claims no isolation of its own', () => {
    expect(provider.capabilities.enforcement).toEqual({ level: 'none', scope: [] })
    expect(provider.capabilities.available).toBe(true)
  })

  it('never carries a command itself, so nothing reaches the remote host around the Host gate', async () => {
    const instance = await provider.create({})
    await expect(instance.exec({ argv: ['true'], cwd: '/' })).rejects.toMatchObject({
      code: 'SANDBOX_UNAVAILABLE',
    })
  })
})
