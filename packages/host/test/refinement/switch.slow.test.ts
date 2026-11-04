import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ecosystem as baseEcosystem } from '@agnes/base'
import { RefinementSettingsStore } from '@agnes/host-infrastructure/refinement-settings'
import { afterAll, describe, expect, it } from 'vitest'
import type { Host } from '../../src/runtime/lifecycle/host.js'
import { createTestHost } from '../../testkit/index.js'

const baseDir = fileURLToPath(new URL('../../../base/', import.meta.url))
const REFINEMENT_TOOLS = ['harness_inspect', 'harness_propose', 'harness_refine']
const PROFILE = 'local-dev'

/** The refinement tools a session's capability set lists (what the TUI `/tools` shows), with their state. */
const capabilityTools = (host: Pick<Host, 'sessionCapabilities'>, key: string) =>
  (host.sessionCapabilities?.(key).tools ?? [])
    .filter((tool) => REFINEMENT_TOOLS.includes(tool.id))
    .map(({ id, enabled }) => ({ id, enabled }))
    .sort((a, b) => a.id.localeCompare(b.id))

/** The refine plugin's tools a session is offered, as its tool catalog lists them. */
const offered = (session: {
  toolCatalog(): { tools: { name: string; source: string; deferred: boolean }[] }
}) =>
  session
    .toolCatalog()
    .tools.filter((tool) => tool.source === 'agnes/refine')
    .map(({ name, deferred }) => ({ name, deferred }))
    .sort((a, b) => a.name.localeCompare(b.name))

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
    const registered = [...host.kernel.tools.snapshot(0).byName.values()]
      .filter((tool) => tool.source.source === 'agnes/refine')
      .map((tool) => tool.name)
      .sort()
    const session = await host.createSession({ cwd: dataDir, key: 'switch-assembly' })
    return { registered, offered: offered(session) }
  } finally {
    await host.close()
  }
}

describe('the refinement switch at host assembly', () => {
  it('a preset carrying the legacy auto_refine key offers no session a refinement tool', async () => {
    const { registered, offered: tools } = await refinementTools(scratch())
    // The tools are registered with the host whatever the switch says; a session that is off is offered none.
    expect(registered).toEqual(REFINEMENT_TOOLS)
    expect(tools).toEqual([])
  })

  it('only the settings file turns the tools on, harness_refine always loaded and the others deferred', async () => {
    const dataDir = scratch()
    enable(dataDir)
    const { offered: tools } = await refinementTools(dataDir)
    expect(tools).toEqual(REFINEMENT_TOOLS.map((name) => ({ name, deferred: name !== 'harness_refine' })))
  })

  it('a settings file for another profile does not turn the tools on', async () => {
    const dataDir = scratch()
    const other = new RefinementSettingsStore(dataDir, 'another-profile')
    other.save({ enabled: true, mode: 'auto' }, other.read().revision)
    expect((await refinementTools(dataDir)).offered).toEqual([])
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
      // The session's tool list does not change: the tools answer that refinement is off.
      expect(offered(session)).toHaveLength(REFINEMENT_TOOLS.length)
    } finally {
      await host.close()
    }
  })

  it('off at assembly: turning it on reaches the sessions opened after it, not the open ones', async () => {
    const dataDir = scratch()
    const { host, session: before } = await opened(dataDir)
    try {
      save(dataDir, true)
      // The session that was already open runs as before: off, without the tools.
      expect(before.d.refinementEnabled?.()).toBe(false)
      expect(before.d.refinement?.settings().enabled).toBe(false)
      expect(offered(before)).toEqual([])
      // Nor does its capability set list them, so a tool filter cannot name what it does not have.
      expect(capabilityTools(host, before.key)).toEqual([])
      const after = await host.createSession({ cwd: dataDir, key: 'switch-after' })
      expect(after.d.refinementEnabled?.()).toBe(true)
      expect(after.d.refinement?.settings()).toMatchObject({ enabled: true, mode: 'auto' })
      expect(after.d.refinementTriggers?.accepts?.(after.key)).toBe(true)
      expect(offered(after).map((tool) => tool.name)).toEqual(REFINEMENT_TOOLS)
      expect(capabilityTools(host, after.key)).toEqual(REFINEMENT_TOOLS.map((id) => ({ id, enabled: true })))
      // Off reaches every session at once; the newer one keeps its tool list, which now answers off.
      save(dataDir, false)
      expect(after.d.refinementEnabled?.()).toBe(false)
      expect(after.d.refinement?.settings().enabled).toBe(false)
      expect(offered(after)).toHaveLength(REFINEMENT_TOOLS.length)
      expect(before.d.refinementEnabled?.()).toBe(false)
      expect(offered(before)).toEqual([])
    } finally {
      await host.close()
    }
  })
})
