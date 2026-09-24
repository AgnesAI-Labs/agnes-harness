import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScriptedProvider } from '@agnes/ai/testkit'
import { expect, it } from 'vitest'
import { createTestHost } from '../testkit/index.js'

it('publishes a new catalogue to existing sessions and keeps the old runtime after candidate failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-model-update-'))
  const { host } = await createTestHost({
    dataDir: root,
    disableSessionTitle: true,
    provider: (profile) =>
      new ScriptedProvider({
        models: profile.provider.routes?.flatMap((r) => r.models ?? []) ?? [],
        scripts: [],
      }),
  })
  try {
    const session = await host.createSession({ cwd: root })
    const next = structuredClone(host.profile)
    const route = next.provider.routes?.[0]
    const first = route?.models?.[0]
    if (!route || !first) throw new Error('fixture model missing')
    route.models = [...(route.models ?? []), { ...first, id: 'hot-model', name: 'hot-model' }]
    await host.applyModelProfile(next)
    host.validateModelSwitch({ slot: 'primary', route: route.route, model: 'hot-model' })
    await session.setModel({ slot: 'primary', route: route.route, model: 'hot-model' })
    expect(session.preset.model.id.primary).toBe('hot-model')
    const before = host.provider
    const invalid = structuredClone(next)
    const invalidModels = invalid.provider.routes?.[0]?.models
    if (!invalidModels) throw new Error('fixture catalogue missing')
    invalidModels.push({
      ...first,
      id: 'broken',
      contract_id: 'missing-contract',
    })
    await expect(host.applyModelProfile(invalid)).rejects.toThrow()
    expect(host.provider).toBe(before)
    expect(host.provider.models().some((model) => model.id === 'broken')).toBe(false)
    await expect(host.applyModelProfile({ ...next, dataDir: join(root, 'other') })).rejects.toThrow(
      'non-model configuration',
    )
    expect(host.provider).toBe(before)
    await host.applyModelProfile(next)
    expect(host.provider.models().some((model) => model.id === 'hot-model')).toBe(true)
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('opens history with a removed selection and lets the user select an available model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-model-restore-'))
  const { host } = await createTestHost({ dataDir: root, disableSessionTitle: true })
  try {
    const initial = structuredClone(host.profile)
    const next = structuredClone(initial)
    const route = next.provider.routes?.[0]
    const first = route?.models?.[0]
    if (!route?.models || !first) throw new Error('fixture model missing')
    route.models.push({ ...first, id: 'removed-model', name: 'removed-model' })
    await host.applyModelProfile(next)
    const session = await host.createSession({ cwd: root, key: 'removed-selection' })
    await session.setModel({ slot: 'primary', route: route.route, model: 'removed-model' })
    await session.close()
    await host.applyModelProfile(initial)
    const reopened = await host.createSession({ cwd: root, key: 'removed-selection' })
    expect(reopened.preset.model.id.primary).toBe('removed-model')
    expect(() =>
      host.validateModelSwitch({ slot: 'primary', route: route.route, model: 'removed-model' }),
    ).toThrow()
    await expect(
      reopened.setModel({ slot: 'primary', route: route.route, model: 'removed-model' }),
    ).rejects.toThrow()
    expect((await reopened.scan({ type: 'x/core/model-switch', limit: 20 })).length).toBe(1)
    await reopened.setModel({ slot: 'primary', route: route.route, model: first.id })
    expect(reopened.preset.model.id.primary).toBe(first.id)
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})
