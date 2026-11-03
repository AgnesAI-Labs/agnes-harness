import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ecosystem as baseEcosystem } from '@agnes/base'
import { RefinementSettingsStore } from '@agnes/host-infrastructure/refinement-settings'
import { afterAll, describe, expect, it } from 'vitest'
import { createTestHost } from '../../testkit/index.js'

const baseDir = fileURLToPath(new URL('../../../base/', import.meta.url))
const REFINEMENT_TOOLS = ['harness_inspect', 'harness_propose', 'harness_refine']
const PROFILE = 'local-dev'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-refinement-switch-'))
  dirs.push(dir)
  return dir
}

/** A preset that still carries every key the retired refine read; none of them may switch anything on. */
const LEGACY_PRESET = {
  name: 'standard',
  extends: 'base',
  disclosure: 'standard',
  model: { route: { primary: 'default' } },
  harness: {
    queue_max: 5,
    auto_refine: { enabled: true, gate: 'verifier', global_needs_human: false, cooldown_turns: 0 },
  },
} as const

function enable(dataDir: string): void {
  const store = new RefinementSettingsStore(dataDir, PROFILE)
  store.save({ enabled: true, mode: 'auto' }, store.read().revision)
}

async function refinementTools(dataDir: string) {
  let seenPreset: Record<string, unknown> | undefined
  const { host } = await createTestHost({
    dataDir,
    packageDirs: { '@agnes/base': baseDir },
    presets: { standard: LEGACY_PRESET as never },
    packages: {
      '@agnes/base': {
        ecosystem: {
          ...baseEcosystem,
          'agnes/refine': (context) => {
            seenPreset = context.profile.preset
            return baseEcosystem['agnes/refine'](context)
          },
        },
      },
    },
  })
  try {
    // Guard against a vacuous pass: the refine factory really saw the legacy key, enabled.
    expect(seenPreset?.harness).toMatchObject({ auto_refine: { enabled: true }, queue_max: 5 })
    const tools = [...host.kernel.tools.snapshot(0).byName.values()]
      .filter((tool) => tool.source.source === 'agnes/refine')
      .map((tool) => ({ name: tool.name, deferLoading: tool.meta.deferLoading }))
      .sort((a, b) => a.name.localeCompare(b.name))
    return { tools, registrations: host.kernel.registrations('agnes/refine'), loaded: host.extensions() }
  } finally {
    await host.close()
  }
}

describe('the refinement switch at host assembly', () => {
  it('a preset carrying the legacy auto_refine key registers no refinement tool', async () => {
    const { tools, registrations, loaded } = await refinementTools(scratch())
    expect(tools).toEqual([])
    expect(registrations).toEqual([])
    // The extension still loads; it just registers nothing.
    expect(loaded.find((entry) => entry.id === 'agnes/refine')?.loaded).toBe(true)
  })

  it('only the settings file turns the tools on, all three deferred', async () => {
    const dataDir = scratch()
    enable(dataDir)
    const { tools, registrations } = await refinementTools(dataDir)
    expect(tools).toEqual(REFINEMENT_TOOLS.map((name) => ({ name, deferLoading: true })))
    expect(registrations).toEqual(['tool:harness_propose', 'tool:harness_refine', 'tool:harness_inspect'])
  })

  it('a settings file for another profile does not turn the tools on', async () => {
    const dataDir = scratch()
    const other = new RefinementSettingsStore(dataDir, 'another-profile')
    other.save({ enabled: true, mode: 'auto' }, other.read().revision)
    expect((await refinementTools(dataDir)).tools).toEqual([])
  })
})

describe('what Core reads of the switch in a running host', () => {
  async function opened(dataDir: string) {
    const { host } = await createTestHost({ dataDir, packageDirs: { '@agnes/base': baseDir } })
    const session = await host.createSession({ cwd: dataDir, key: 'switch-live' })
    return { host, session }
  }
  const save = (dataDir: string, enabled: boolean) => {
    const store = new RefinementSettingsStore(dataDir, PROFILE)
    store.save({ enabled, mode: 'auto' }, store.read().revision)
  }

  it('on at assembly: Core has the planner and sees a switch-off at once, the tools stay', async () => {
    const dataDir = scratch()
    enable(dataDir)
    const { host, session } = await opened(dataDir)
    try {
      expect(session.d.refinementEnabled?.()).toBe(true)
      expect(session.d.refinement?.settings()).toMatchObject({ enabled: true, mode: 'auto' })
      // The refine plugin handed its planner over when its tools were registered.
      expect(session.d.refinement?.planner()).toMatchObject({ buildPrompt: expect.any(Function) })
      expect(session.d.refinementTriggers?.accepts?.(session.key)).toBe(true)
      save(dataDir, false)
      expect(session.d.refinementEnabled?.()).toBe(false)
      expect(session.d.refinementTriggers?.accepts?.(session.key)).toBe(false)
      expect(host.kernel.registrations('agnes/refine')).toHaveLength(REFINEMENT_TOOLS.length)
    } finally {
      await host.close()
    }
  })

  it('off at assembly: a later switch-on waits for the next assembly, like the tools', async () => {
    const dataDir = scratch()
    const { host, session } = await opened(dataDir)
    try {
      save(dataDir, true)
      expect(session.d.refinementEnabled?.()).toBe(false)
      expect(session.d.refinement?.settings().enabled).toBe(false)
      expect(host.kernel.registrations('agnes/refine')).toEqual([])
    } finally {
      await host.close()
    }
  })
})
