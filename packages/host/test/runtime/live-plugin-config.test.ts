import { buildCompleteRuntimeTarget } from '@agnes/host-providers/runtime-target-builder'
import { createPluginRow, type RuntimeTarget } from '@agnes/plugin-runtime/host'
import { expect, it } from 'vitest'
import {
  applyLivePluginConfig,
  overlayLivePluginConfig,
} from '../../src/runtime/lifecycle/live-plugin-config.js'

const row = createPluginRow({
  id: 'ext:acme/agent',
  plugin: 'acme@1/main',
  snapshotDigest: '1',
  exportName: 'main',
  entryRevision: '1',
  extrasRevision: 'none',
  mountRevision: '1',
  config: { name: 'old' },
})
const target = (config: unknown, mode: 'live' | 'next-session') =>
  buildCompleteRuntimeTarget({
    rows: [{ ...row, config, configReload: mode }],
    resources: { mcp: [], skills: {} },
  }).target
it('applies live configuration to the same pinned code and compensates refusal, while next-session remains pinned', async () => {
  const previous = target({ name: 'old' }, 'live')
  let active = previous
  const host = {
    runtimeTargetSnapshot: () => active,
    applyRuntimeTarget: async (next: RuntimeTarget) => {
      active = next
    },
  }
  const next = target({ name: 'new' }, 'live')
  const rollback = await applyLivePluginConfig([host], next)
  expect(active.tree.rows[0]?.config).toEqual({ name: 'new' })
  await rollback()
  expect(active).toBe(previous)
  await applyLivePluginConfig([host], target({ name: 'future' }, 'next-session'))
  expect(active).toBe(previous)
  expect(
    overlayLivePluginConfig([{ ...row, mountIdentity: 'other' as typeof row.mountIdentity }], next)[0]
      ?.config,
  ).toEqual({ name: 'old' })
  const refusing = {
    runtimeTargetSnapshot: () => previous,
    applyRuntimeTarget: async (next: RuntimeTarget) => {
      if (next.tree.rows[0]?.config && JSON.stringify(next.tree.rows[0].config).includes('new'))
        throw new Error('refused')
    },
  }
  await expect(applyLivePluginConfig([host, refusing], next)).rejects.toThrow('refused')
  expect(active).toBe(previous)
  const reportedRefusal = {
    runtimeTargetSnapshot: () => previous,
    applyRuntimeTarget: async (next: RuntimeTarget) => ({
      hash: next.tree.hash,
      ok: next.tree.hash === previous.tree.hash,
      rows: [],
    }),
  }
  await expect(applyLivePluginConfig([host, reportedRefusal], next)).rejects.toThrow(
    'E_PLUGIN_CONFIG_REFUSED',
  )
  expect(active).toBe(previous)
  const immutable = { ...row, id: 'adapter:storage', configReload: 'live' as const }
  expect(
    overlayLivePluginConfig([immutable], {
      ...next,
      tree: { ...next.tree, rows: [{ ...immutable, config: { name: 'unsafe' } }] },
    })[0]?.config,
  ).toEqual({ name: 'old' })
})
