import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallContext } from '@agnes/daemon-foundation/local/endpoint'
import { RefinementSettingsStore } from '@agnes/host'
import { afterEach, describe, expect, it } from 'vitest'
import { registerRefinement } from '../src/local/methods/refinement.js'

type Handler = (params: unknown, c: CallContext) => Promise<unknown>
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-refinement-rpc-'))
  dirs.push(dir)
  const handlers = new Map<string, Handler>()
  registerRefinement({ register: (name: string, fn: Handler) => handlers.set(name, fn) } as never, {
    settings: new RefinementSettingsStore(dir, 'p'),
  })
  const call = (method: string, params: unknown, authKind = 'local') => {
    const handler = handlers.get(`_agnes/v1/${method}`)
    if (!handler) throw new Error(`no handler ${method}`)
    return handler(params, { conn: { authKind, credentialKind: authKind, principalId: 'me' } } as never)
  }
  return call
}

describe('_agnes/v1/refinement.*', () => {
  it('get/save round trip over RPC and refuses remote callers', async () => {
    const call = setup()
    const first = (await call('refinement.get', {})) as { settings: unknown; revision: string }
    expect(first.settings).toEqual({ enabled: false, mode: 'manual' })

    const saved = (await call('refinement.save', {
      settings: { enabled: true, mode: 'auto' },
      expectedRevision: first.revision,
    })) as { revision: string }
    expect(saved.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.keys(saved)).toEqual(['revision'])
    expect(await call('refinement.get', {})).toEqual({
      settings: { enabled: true, mode: 'auto' },
      revision: saved.revision,
    })

    await expect(
      call('refinement.save', {
        settings: { enabled: false, mode: 'manual' },
        expectedRevision: first.revision,
      }),
    ).rejects.toMatchObject({ data: { code: 'SEMANTIC_REJECTED', reason: 'CONFIG_REVISION_CONFLICT' } })

    for (const authKind of ['remote', 'token']) {
      await expect(call('refinement.get', {}, authKind)).rejects.toMatchObject({
        data: { code: 'CAPABILITY_DENIED' },
      })
      await expect(
        call(
          'refinement.save',
          { settings: { enabled: false, mode: 'manual' }, expectedRevision: saved.revision },
          authKind,
        ),
      ).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
    }
    expect((await call('refinement.get', {})) as { settings: unknown }).toMatchObject({
      settings: { enabled: true, mode: 'auto' },
    })
  })
})
