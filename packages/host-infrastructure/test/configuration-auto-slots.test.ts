import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPrivateDirectorySync } from '@agnes/system-node'
import { afterEach, expect, it } from 'vitest'
import { createCredentialStore } from '../src/adapters/credential-store.js'
import { createConfigurationService } from '../src/configuration.js'
import { automaticFastModel } from '../src/configuration-auto-slots.js'

const model = (id: string, input = 0, output = 0) => ({
  id,
  cost: { input, output, cacheRead: 0, cacheWrite: 0 },
})

it('prefers the cheapest priced model by input plus output price, keeping saved order on a tie', () => {
  const models = [model('pro', 3, 15), model('mini', 0.5, 1.5), model('lite', 1, 1), model('unpriced-flash')]
  expect(automaticFastModel(models)?.id).toBe('mini')
  expect(automaticFastModel([model('a', 1, 1), model('b', 1, 1)])?.id).toBe('a')
})

it('reads the light tier from the id only when no model has a price, and otherwise chooses nothing', () => {
  expect(
    automaticFastModel([model('agnes-2.5-pro'), model('agnes-2.5-flash'), model('agnes-2.0-flash')])?.id,
  ).toBe('agnes-2.5-flash')
  expect(automaticFastModel([model('GPT-5-Mini'), model('gpt-5')])?.id).toBe('GPT-5-Mini')
  // A marker inside another word is not a tier.
  expect(automaticFastModel([model('minimax-large'), model('breakfast-xl')])).toBeUndefined()
  expect(automaticFastModel([])).toBeUndefined()
})

it('never picks an excluded model, however cheap or light its id looks', () => {
  const excluded = new Set(['typesafe/jev-cheap'])
  expect(
    automaticFastModel([model('typesafe/jev-cheap', 0.01, 0.01), model('chat-flash', 1, 1)], excluded)?.id,
  ).toBe('chat-flash')
  expect(automaticFastModel([model('typesafe/jev-cheap', 0.01, 0.01)], excluded)).toBeUndefined()
  expect(automaticFastModel([model('typesafe/jev-flash')], new Set(['typesafe/jev-flash']))).toBeUndefined()
})

const homes: string[] = []

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

it('a payload-only account never produces an automatic fast slot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-auto-slots-'))
  homes.push(root)
  const home = join(root, 'home')
  createPrivateDirectorySync(home)
  const ref = 'secret://generic/11111111-1111-4111-8111-111111111111'
  await createCredentialStore({ root: home }).putGeneric(ref, 'jev-test-key', {
    label: 'Jev',
    createdAt: '2026-10-16T00:00:00.000Z',
  })
  const service = createConfigurationService({ home, profile: 'local-dev' })
  const saved = await service.save({
    providerId: 'typesafe-systemone',
    accountId: 'jev',
    label: 'Jev',
    credentialRef: ref,
    model: 'typesafe/jev-cheap',
    models: [
      {
        id: 'typesafe/jev-cheap',
        name: 'Jev Cheap',
        contextWindow: 65536,
        maxTokens: 32768,
        cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0 },
      },
      { id: 'typesafe/jev-dear', name: 'Jev Dear', contextWindow: 65536, maxTokens: 32768 },
    ],
    expectedRevision: 0,
  })
  expect(saved.defaultAccountId).toBeNull()
  expect(await service.modelSlots()).toEqual({ revision: 1, slots: {} })

  // Write paths refuse a payload-only default; even a crafted file gets no automatic fast choice.
  const file = join(home, 'profiles', 'local-dev', 'configuration.json')
  const stored = JSON.parse(await readFile(file, 'utf8')) as { defaultAccountId: string | null }
  stored.defaultAccountId = 'jev'
  await writeFile(file, JSON.stringify(stored))
  const reloaded = createConfigurationService({ home, profile: 'local-dev' })
  expect(await reloaded.modelSlots()).toEqual({ revision: 1, slots: {} })
})
