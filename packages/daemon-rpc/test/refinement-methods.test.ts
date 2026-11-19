import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallContext } from '@agnes/daemon-foundation/local/endpoint'
import { RefinementSettingsStore } from '@agnes/host'
import type { RefinementModelOption } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerRefinement } from '../src/local/methods/refinement.js'

type Handler = (params: unknown, c: CallContext) => Promise<unknown>
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const model = { id: 'company/review', name: 'Review', contextWindow: 65536, maxTokens: 4096 }
const credentialRef = 'secret://generic/review'
const baseUrl = 'https://review.example/v1'
const alternateUrl = 'https://alternate-review.example/v1'
function setup(
  switchedOn?: () => void,
  skills?: Parameters<typeof registerRefinement>[1]['skills'],
  fetchModels: Parameters<typeof registerRefinement>[1]['fetchModels'] = async () => [model],
) {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-refinement-rpc-'))
  dirs.push(dir)
  const handlers = new Map<string, Handler>()
  const settings = new RefinementSettingsStore(dir, 'p', dir, [baseUrl, alternateUrl])
  vi.spyOn(settings, 'serviceKey').mockImplementation((ref) =>
    ref === credentialRef ? 'fixture' : undefined,
  )
  registerRefinement({ register: (name: string, fn: Handler) => handlers.set(name, fn) } as never, {
    settings,
    fetchModels,
    ...(switchedOn ? { switchedOn } : {}),
    ...(skills ? { skills } : {}),
  })
  const call = (method: string, params: unknown, authKind = 'local') => {
    const handler = handlers.get(`_agnes/v1/${method}`)
    if (!handler) throw new Error(`no handler ${method}`)
    return handler(params, {
      conn: { authKind, credentialKind: authKind, principalId: 'me' },
      signal: new AbortController().signal,
    } as never)
  }
  return call
}

describe('_agnes/v1/refinement.*', () => {
  it('get/save round trip over RPC and refuses remote callers', async () => {
    const call = setup()
    const first = (await call('refinement.get', {})) as { settings: unknown; revision: string }
    expect(first).toMatchObject({ settings: { enabled: false, mode: 'manual', baseUrl } })

    const saved = (await call('refinement.save', {
      settings: { credentialRef, model: model.id, enabled: true, mode: 'auto' },
      expectedRevision: first.revision,
    })) as { revision: string }
    expect(saved.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.keys(saved)).toEqual(['revision'])
    expect(await call('refinement.get', {})).toEqual({
      settings: { credentialRef, model: model.id, enabled: true, mode: 'auto', baseUrl },
      revision: saved.revision,
      endpoints: [baseUrl, alternateUrl],
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
      settings: { credentialRef, model: model.id, enabled: true, mode: 'auto' },
    })
  })

  it('lists models only from the saved key and requires a usable selection before enabling', async () => {
    const discover = vi.fn(async (_baseUrl: string, _key: string) => [model])
    const call = setup(undefined, undefined, discover)
    await expect(call('refinement.models', {})).rejects.toMatchObject({
      data: { reason: 'REFINEMENT_KEY_MISSING' },
    })
    expect(discover).not.toHaveBeenCalled()
    const first = (await call('refinement.get', {})) as { revision: string }
    const { revision } = (await call('refinement.save', {
      settings: { enabled: false, mode: 'manual', credentialRef },
      expectedRevision: first.revision,
    })) as { revision: string }
    for (const authKind of ['remote', 'token'])
      await expect(call('refinement.models', {}, authKind)).rejects.toMatchObject({
        data: { code: 'CAPABILITY_DENIED' },
      })
    expect(await call('refinement.models', {})).toEqual({ models: [model] })
    expect(discover).toHaveBeenLastCalledWith(baseUrl, 'fixture', expect.any(AbortSignal))
    const enable = (id: string) =>
      call('refinement.save', {
        settings: { enabled: true, mode: 'manual', credentialRef, model: id },
        expectedRevision: revision,
      })
    await expect(enable('retired-review')).rejects.toMatchObject({
      data: { reason: 'REFINEMENT_MODEL_UNAVAILABLE' },
    })
    discover.mockRejectedValue(new Error('REFINEMENT_KEY_INVALID'))
    await expect(call('refinement.models', {})).rejects.toMatchObject({
      data: { reason: 'REFINEMENT_KEY_INVALID' },
    })
    await expect(enable(model.id)).rejects.toMatchObject({ data: { reason: 'REFINEMENT_KEY_INVALID' } })
    expect(await call('refinement.get', {})).toEqual({
      settings: { enabled: false, mode: 'manual', credentialRef, baseUrl },
      revision,
      endpoints: [baseUrl, alternateUrl],
    })
  })

  it('revalidates a binding against the selected gateway and drops a superseded catalogue', async () => {
    const alternative = { ...model, id: 'company/alternate' }
    let release = () => {}
    const pending = new Promise<RefinementModelOption[]>((resolve) => {
      release = () => resolve([model])
    })
    const discover = vi.fn(async (url: string) => (url === baseUrl ? [model] : [alternative]))
    const call = setup(undefined, undefined, discover)
    const first = (await call('refinement.get', {})) as { revision: string }
    const settings = { credentialRef, model: model.id, enabled: true, mode: 'auto' }
    await expect(
      call('refinement.save', {
        settings: { ...settings, baseUrl: 'https://third-party.example/v1' },
        expectedRevision: first.revision,
      }),
    ).rejects.toMatchObject({ data: { reason: 'CONFIG_INVALID_INPUT' } })
    expect(discover).not.toHaveBeenCalled()
    const active = (await call('refinement.save', { settings, expectedRevision: first.revision })) as {
      revision: string
    }
    await expect(
      call('refinement.save', {
        settings: { ...settings, baseUrl: alternateUrl },
        expectedRevision: active.revision,
      }),
    ).rejects.toMatchObject({ data: { reason: 'REFINEMENT_MODEL_UNAVAILABLE' } })

    discover.mockImplementationOnce(() => pending)
    const outdated = call('refinement.models', {})
    const paused = { ...settings, enabled: false, baseUrl: alternateUrl }
    const switched = (await call('refinement.save', {
      settings: paused,
      expectedRevision: active.revision,
    })) as { revision: string }
    release()
    await expect(outdated).rejects.toMatchObject({ data: { reason: 'CONFIG_REVISION_CONFLICT' } })
    expect(await call('refinement.models', {})).toEqual({ models: [alternative] })
    expect(discover).toHaveBeenLastCalledWith(alternateUrl, 'fixture', expect.any(AbortSignal))
    const enabled = { ...paused, model: alternative.id, enabled: true }
    await call('refinement.save', { settings: enabled, expectedRevision: switched.revision })
    expect(await call('refinement.get', {})).toMatchObject({ settings: enabled })
  })

  it('tells the daemon when a save switches refinement on, and only then', async () => {
    let told = 0
    const call = setup(() => {
      told++
      throw new Error('a listener failing does not fail the save')
    })
    const save = async (enabled: boolean, mode: 'manual' | 'auto' = 'manual') => {
      const { revision } = (await call('refinement.get', {})) as { revision: string }
      return call('refinement.save', {
        settings: { enabled, mode, credentialRef, model: model.id },
        expectedRevision: revision,
      })
    }
    await save(false)
    expect(told).toBe(0)
    expect(await save(true)).toMatchObject({ revision: expect.any(String) })
    expect(told).toBe(1)
    await save(true, 'auto')
    expect(told).toBe(1)
    await save(false)
    await save(true)
    expect(told).toBe(2)
    // A save that is refused tells nothing.
    await save(false)
    await expect(
      call('refinement.save', {
        settings: { credentialRef, model: model.id, enabled: true, mode: 'manual' },
        expectedRevision: 'stale',
      }),
    ).rejects.toMatchObject({ data: { code: 'SEMANTIC_REJECTED' } })
    expect(told).toBe(2)
  })
})

describe('_agnes/v1/refinement.skills', () => {
  it('reaches the saved skills for a local owner only, naming who asked', async () => {
    const asked: unknown[] = []
    const call = setup(undefined, async (params, actor) => {
      asked.push({ params, actor })
      return { skills: [], drafts: [] }
    })
    expect(await call('refinement.skills', { cwd: '/w', action: 'list' })).toEqual({ skills: [], drafts: [] })
    expect(asked).toEqual([{ params: { cwd: '/w', action: 'list' }, actor: 'me' }])
    for (const authKind of ['remote', 'token'])
      await expect(call('refinement.skills', { cwd: '/w' }, authKind)).rejects.toMatchObject({
        data: { code: 'CAPABILITY_DENIED' },
      })
    expect(asked).toHaveLength(1)
    // Where the daemon saves no skills, the method says so.
    await expect(setup()('refinement.skills', { cwd: '/w' })).rejects.toMatchObject({
      data: { code: 'SEMANTIC_REJECTED', reason: 'SKILL_UNAVAILABLE' },
    })
  })
})
