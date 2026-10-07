import type { ExtensionContext, ToolContext } from '@agnes/extension-api'
import { expect, it } from 'vitest'
import { observePluginCapabilities } from '../src/plugin-capability-observer.js'

it('reports undeclared Host port use without exposing targets or changing port outcomes', async () => {
  const events: unknown[] = []
  const log = {
    debug() {},
    info() {},
    error() {},
    warn: (message: string, detail: unknown) => {
      events.push({ message, detail })
    },
  } as ExtensionContext['log']
  const context = {
    cwd: '/workspace',
    exec: async () => ({ stdout: 'ok' }),
    net: { fetch: async () => 'response' },
    fs: { read: async () => new Uint8Array([1]) },
    sandbox: { confine: async (argv: string[]) => argv },
  } as unknown as ToolContext
  const declared = observePluginCapabilities(
    context,
    { exec: ['node'], network: ['*.example.com'], filesystem: { read: ['workspace/*'] } },
    log,
  )
  expect(await declared.exec(['node', '--secret=do-not-log'])).toEqual({ stdout: 'ok' })
  expect(await declared.net.fetch('https://api.example.com/?token=do-not-log')).toBe('response')
  await declared.fs.read('/workspace/report.txt')
  expect(events).toEqual([])
  const undeclared = observePluginCapabilities(context, undefined, log)
  await undeclared.exec(['node', '--secret=do-not-log'])
  await undeclared.net.fetch('https://api.example.com/?token=do-not-log')
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ detail: { capability: 'exec' } }),
      expect.objectContaining({ detail: { capability: 'network' } }),
    ]),
  )
  expect(JSON.stringify(events)).not.toMatch(/do-not-log|api.example|--secret/)
  const denied = observePluginCapabilities(
    {
      ...context,
      exec: async () => {
        throw new Error('sandbox refusal')
      },
    },
    undefined,
    log,
  )
  await expect(denied.exec(['node'])).rejects.toThrow('sandbox refusal')
})
