import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codexChildAgentsPlugin, DISABLED_CHILD_ENGINES } from '@agnes/base'
import { createConfigurationService } from '@agnes/host'
import { expect, it } from 'vitest'
import { LocalEndpoint } from '../src/local/endpoint.js'
import { registerConfiguration } from '../src/local/methods/config.js'

const fixture = fileURLToPath(
  new URL('../../base/extensions/subagent-codex/test/fake-codex.mjs', import.meta.url),
)

function document(codex: { enabled: boolean; command: string; args: string[]; allow: string[] }) {
  return { ...structuredClone(DISABLED_CHILD_ENGINES), codex }
}

it('enables Codex through the admin RPC and starts a child with the fake CLI', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agh-child-engines-'))
  const service = createConfigurationService({ home, profile: 'local-dev' })
  const file = join(home, 'profiles', 'local-dev', 'configuration.json')
  const ep = new LocalEndpoint({ clock: Date.now, principalId: 'local' })
  ep.conn.initialized = true
  ep.conn.authKind = 'local'
  ep.conn.credentialKind = 'local'
  const published: unknown[] = []
  registerConfiguration(ep, service, undefined, undefined, async (saved) => {
    published.push(saved)
    return 'new-sessions'
  })
  const request = (method: string, params: unknown = {}) =>
    ep.handle({ jsonrpc: '2.0', id: 1, method, params })
  try {
    expect(
      await request('_agnes/v1/config.childEngines.save', {
        revision: 0,
        engines: document({ enabled: true, command: '', args: [], allow: [] }),
      }),
    ).toMatchObject({ error: { data: { reason: 'CONFIG_INVALID_INPUT' } } })
    expect(
      await request('_agnes/v1/config.childEngines.save', {
        revision: 0,
        engines: document({ enabled: true, command: 'codex', args: [], allow: [] }),
      }),
    ).toMatchObject({ error: { data: { reason: 'CONFIG_INVALID_INPUT' } } })
    expect((await service.childEngines()).revision).toBe(0)
    const leaked = await request('_agnes/v1/config.childEngines.save', {
      revision: 0,
      engines: {
        ...document({ enabled: false, command: 'codex', args: [], allow: [] }),
        codex: { enabled: false, command: 'codex', args: [], allow: [], env: { SECRET: 'super-secret' } },
      },
    })
    expect(leaked).toHaveProperty('error')
    await expect(readFile(file, 'utf8')).rejects.toThrow()
    const saved = await request('_agnes/v1/config.childEngines.save', {
      revision: 0,
      engines: document({
        enabled: true,
        command: process.execPath,
        args: [fixture],
        allow: [process.execPath],
      }),
    })
    expect(saved).toMatchObject({ result: { revision: 1, effect: 'new-sessions' } })
    expect(published).toHaveLength(1)
    const engines = (saved as { result: { engines: { codex: unknown } } }).result.engines
    let provider:
      | {
          start(
            task: string,
            options: { signal: AbortSignal; sessionKey: string; cwd: string },
          ): Promise<{ result(): Promise<{ status: string; text?: string }>; dispose(): Promise<void> }>
        }
      | undefined
    codexChildAgentsPlugin.apply(
      {
        childAgents: {
          register(next: NonNullable<typeof provider>) {
            provider = next
            return async () => undefined
          },
        },
      } as never,
      engines.codex,
    )
    const started = provider
    if (!started) throw new Error('codex provider was not registered')
    const handle = await started.start('task', {
      signal: new AbortController().signal,
      sessionKey: 'parent',
      cwd: tmpdir(),
    })
    try {
      await expect(handle.result()).resolves.toMatchObject({ status: 'completed', text: 'echo:task' })
    } finally {
      await handle.dispose()
    }
  } finally {
    await ep.close()
  }
})
