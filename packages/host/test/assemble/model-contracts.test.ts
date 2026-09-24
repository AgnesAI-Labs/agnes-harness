import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadContractStore, NullContractStore, PARSER_VERSION } from '@agnes/ai'
import { fakeModel, ScriptedProvider } from '@agnes/ai/testkit'
import { afterEach, expect, it } from 'vitest'
import { bindModelContracts } from '../../src/assemble/contracts.js'
import { createTestHost } from '../../testkit/index.js'

const id = 'agnes-model-contract@0'
const fixture = fileURLToPath(new URL('../../../ai/fixtures/contract/', import.meta.url))
const contracted = fakeModel({ id: 'bound', route: 'gw', slot: 'primary', contract_id: id })
const external = fakeModel({ id: 'external', route: 'gw', slot: 'fast', contract_id: null })
const dirs: string[] = []
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-model-contract-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const profile = (models = [contracted, external], loaded = true) => ({
  name: 'bound',
  provider: {
    package: '@agnes/ai',
    routes: [{ route: 'gw', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', models }],
    ...(loaded ? { contract: { dir: fixture, contractIds: [id] } } : {}),
  },
})
const scripts = [
  [
    { type: 'text_delta' as const, delta: 'answer' },
    {
      type: 'usage' as const,
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      creditSource: 'estimated' as const,
      credits: 1,
    },
    { type: 'done' as const, reason: 'stop' as const },
  ],
]

it('snapshots all route/model bindings and verifies actual loaded hashes', () => {
  const records = structuredClone([contracted, external])
  const store = loadContractStore({ dir: fixture, contractIds: [id] })
  const lookup = bindModelContracts(records, store)
  if (records[0]) records[0].contract_id = null
  records.reverse()
  expect(lookup({ route: 'gw', model: 'bound' })).toEqual({ contract_id: id, parser_version: PARSER_VERSION })
  expect(lookup({ route: 'gw', model: 'external' }).contract_id).toBeNull()
  expect(Object.isFrozen(lookup({ route: 'gw', model: 'bound' }))).toBe(true)
  expect(() => lookup({ route: 'elsewhere', model: 'bound' })).toThrow(/absent/)
  expect(() => bindModelContracts([contracted], new NullContractStore())).toThrow(/not loaded/)
  expect(() => bindModelContracts([external, external], new NullContractStore())).toThrow(/duplicate/)
})
it('real assembly derives each selected model contract and preserves null on a different default', async () => {
  for (const selected of ['bound', 'external']) {
    const provider = new ScriptedProvider({ scripts })
    const dataDir = temp()
    const t = await createTestHost({
      dataDir,
      provider,
      profileInputs: { user: profile() },
      presets: {
        standard: {
          name: 'standard',
          extends: 'base',
          model: {
            route: {
              primary: { route: 'gw', model: selected },
              fast: { route: 'gw', model: selected === 'bound' ? 'external' : 'bound' },
            },
          },
        },
      },
    })
    try {
      const s = await t.host.createSession({ cwd: dataDir })
      await s.enqueue('next-turn', { actor: s.d.actor, content: [{ type: 'text', text: 'hi' }] })
      expect((await s.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
        'completed',
      )
      const expected = selected === 'bound' ? id : null
      expect(provider.calls.map((r) => [r.model, r.contractId])).toEqual([[selected, expected]])
      const headers = await s.scan({ type: 'request/header', toSeq: s.lastSeq })
      expect(headers[0]?.data).toMatchObject({ contract_id: expected })
      expect(provider.calls.every((r) => !r.system.includes('You are Agnes.'))).toBe(true)
    } finally {
      await t.host.close()
    }
  }
})
it('production registry and replacement declaration paths both refuse unloaded model contracts before inference', async () => {
  for (const replacement of [false, true]) {
    const dataDir = temp()
    const provider = new ScriptedProvider({ scripts })
    await expect(
      createTestHost({
        dataDir,
        ...(replacement ? { provider } : {}),
        profileInputs: { user: profile([contracted], false) },
      }),
    ).rejects.toMatchObject({ code: 'E_PRESET_UNRESOLVED', detail: { reason: 'contract-unloaded' } })
    expect(provider.calls).toHaveLength(0)
  }
})
it('production sealed catalog accepts loaded and null models without contacting the model', async () => {
  const dataDir = temp()
  const t = await createTestHost({ dataDir, profileInputs: { user: profile() } })
  try {
    const s = await t.host.createSession({ cwd: dataDir })
    expect(s.d.contractForModel?.({ route: 'gw', model: 'bound' }).contract_id).toBe(id)
    expect(s.d.contractForModel?.({ route: 'gw', model: 'external' }).contract_id).toBeNull()
  } finally {
    await t.host.close()
  }
})
it('an unknown selected model refuses before the provider observes a request', async () => {
  const provider = new ScriptedProvider({ scripts })
  const dataDir = temp()
  const t = await createTestHost({ dataDir, provider, profileInputs: { user: profile() } })
  try {
    const s = await t.host.createSession({ cwd: dataDir })
    s.preset = {
      ...s.preset,
      model: { ...s.preset.model, id: { ...s.preset.model.id, primary: 'not-declared' } },
    }
    await s.enqueue('next-turn', { actor: s.d.actor, content: [{ type: 'text', text: 'hi' }] })
    await s.acceptInput()
    await expect(s.runInference()).rejects.toThrow(/absent/)
    expect(provider.calls).toHaveLength(0)
  } finally {
    await t.host.close()
  }
})
