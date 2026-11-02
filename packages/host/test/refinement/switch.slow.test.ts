import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  const { host } = await createTestHost({
    dataDir,
    packageDirs: { '@agnes/base': baseDir },
    presets: { standard: LEGACY_PRESET as never },
  })
  try {
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
