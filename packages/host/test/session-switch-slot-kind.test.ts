import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScriptedProvider } from '@agnes/ai/testkit'
import type { ModelRecord, RouteDecl } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import type { PresetDoc } from '../src/presets/types.js'
import { createTestHost, type TestHostOptions } from '../testkit/index.js'

const chat = (route: string, id: string): ModelRecord => ({
  id,
  name: id,
  api: 'openai-completions',
  route,
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
})
const ROUTES: RouteDecl[] = [
  {
    route: 'gw',
    api: 'openai-completions',
    baseUrl: 'https://example.invalid/v1',
    models: [chat('gw', 'm1')],
  },
  {
    route: 'alt',
    api: 'openai-completions',
    baseUrl: 'https://example.invalid/v1',
    models: [chat('alt', 'm2')],
  },
  {
    route: 'jev',
    api: 'typesafe-systemone',
    baseUrl: 'https://api.typesafe.ai/v1',
    credentialRef: 'secret://typesafe/default',
    models: [
      {
        id: 'jev-1.13.0',
        name: 'Jev 1.13.0',
        api: 'typesafe-systemone',
        route: 'jev',
        baseUrl: 'https://api.typesafe.ai/v1',
        kind: 'decision',
        contextWindow: 64000,
        cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  },
]
const PRESET: PresetDoc = {
  name: 'standard',
  extends: 'base',
  disclosure: 'standard',
  model: { route: { primary: 'gw', escalation: 'alt', decision: 'jev' } },
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'agnes-slot-kind-'))
  dirs.push(d)
  return d
}
const options = (dataDir: string): TestHostOptions => ({
  dataDir,
  presets: { standard: PRESET },
  profileInputs: {
    user: { name: 'local-dev', provider: { package: '@agnes/ai', adapters: ['@agnes/ai'], routes: ROUTES } },
  },
  provider: () => new ScriptedProvider({ models: [chat('gw', 'm1'), chat('alt', 'm2')], scripts: [] }),
})

describe('validateModelSwitch checks slot kind first', () => {
  it.each([
    ['a decision model on a chat slot', { slot: 'primary', route: 'jev', model: 'jev-1.13.0' }],
    ['a chat model on the decision slot', { slot: 'decision', route: 'gw', model: 'm1' }],
    ['the decision model on the decision slot', { slot: 'decision', route: 'jev', model: 'jev-1.13.0' }],
  ])(
    'refuses %s',
    async (_name, sel) => {
      const t = await createTestHost(options(scratch()))
      try {
        let thrown: unknown
        try {
          t.host.validateModelSwitch(sel)
        } catch (e) {
          thrown = e
        }
        expect(thrown).toMatchObject({ code: 'E_MODEL_UNKNOWN', detail: { reason: 'slot-kind', ...sel } })
      } finally {
        await t.host.close()
      }
    },
    30_000,
  )

  it('still allows a chat model on a chat slot', async () => {
    const t = await createTestHost(options(scratch()))
    try {
      expect(() => t.host.validateModelSwitch({ slot: 'primary', route: 'alt', model: 'm2' })).not.toThrow()
    } finally {
      await t.host.close()
    }
  }, 30_000)
})

describe('replaying switches of mismatched kinds on open', () => {
  it('skips them with a diagnostic, applies the rest, and the session opens', async () => {
    const dataDir = scratch()
    const first = await createTestHost(options(dataDir))
    const s1 = await first.host.createSession({ cwd: dataDir })
    // Rows a ledger written before the kind gate existed could carry.
    await s1.d.log.append([
      s1.ev(
        'x/core/model-switch',
        { slot: 'primary', from: { route: 'gw', model: 'm1' }, to: { route: 'jev', model: 'jev-1.13.0' } },
        { ignorable: true },
      ),
      s1.ev(
        'x/core/model-switch',
        { slot: 'decision', from: { route: 'jev', model: 'jev-1.13.0' }, to: { route: 'gw', model: 'm1' } },
        { ignorable: true },
      ),
      s1.ev(
        'x/core/model-switch',
        { slot: 'escalation', from: { route: 'alt', model: 'm2' }, to: { route: 'gw', model: 'm1' } },
        { ignorable: true },
      ),
    ])
    const key = s1.key
    await first.host.close()

    const second = await createTestHost(options(dataDir))
    try {
      const reopened = await second.host.createSession({ cwd: dataDir, key })
      expect(reopened.preset.model.route.primary).toBe('gw')
      expect(reopened.preset.model.id.primary).toBe('m1')
      expect(reopened.preset.model.route.decision).toBe('jev')
      expect(reopened.preset.model.id.decision).toBe('jev-1.13.0')
      expect(reopened.preset.model.route.escalation).toBe('gw')
      const skipped = await reopened.scan({ type: 'x/core/model-switch-skipped', limit: 10 })
      expect(skipped.map((row) => row.data)).toEqual(
        expect.arrayContaining([
          { slot: 'primary', route: 'jev', model: 'jev-1.13.0', reason: 'slot-kind' },
          { slot: 'decision', route: 'gw', model: 'm1', reason: 'slot-kind' },
        ]),
      )
      expect(skipped).toHaveLength(2)
      expect(skipped.every((row) => row.ignorable === true)).toBe(true)

      // Opening the live session again in the same process is refused like any other reopen of a
      // session this process already holds (host/test/session.test.ts pins the same refusal), so
      // replay never runs a second time and the ledger gains no second copy of the diagnostic.
      await expect(second.host.createSession({ cwd: dataDir, key })).rejects.toMatchObject({
        code: 'E_LANE_BUSY',
      })
      expect(await reopened.scan({ type: 'x/core/model-switch-skipped', limit: 10 })).toHaveLength(2)
    } finally {
      await second.host.close()
    }
  }, 60_000)
})
