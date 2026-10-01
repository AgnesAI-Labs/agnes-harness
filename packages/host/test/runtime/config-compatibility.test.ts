import { join } from 'node:path'
import { validateRuntime } from '@agnes/protocol/runtime'
import { expect, it } from 'vitest'
import {
  applySessionParameterChange,
  convertLegacyConfiguration,
  restorePinnedConfiguration,
} from '../../src/runtime/config/effective-profile.js'

const preset = (document: Record<string, unknown>) =>
  convertLegacyConfiguration({
    presets: [{ layer: 'user', document }],
    presetId: String(document.name),
  })

it('does not let a weaker layer enable a disabled package', () => {
  const result = convertLegacyConfiguration({
    profiles: [
      { layer: 'user', document: { name: 'dev', packages: [{ id: 'pkg', enabled: false }] } },
      { layer: 'workspace', document: { name: 'workspace', packages: [{ id: 'pkg', enabled: true }] } },
    ],
  })
  expect(result.status).toBe('refused')
  expect(result.sessionParameters).toBeNull()
  expect(result.providerConfig).toBeNull()
  expect(result.diagnostics.some((item) => item.code === 'disabled_package_revived')).toBe(true)
})

it('lets a later layer narrow a capability ceiling and refuses a wider one', () => {
  const introduced = convertLegacyConfiguration({
    profiles: [
      { layer: 'user', document: { name: 'dev' } },
      { layer: 'workspace', document: { policy: { capabilityCeiling: ['fs.read'] } } },
    ],
  })
  expect(introduced.diagnostics.some((item) => item.code === 'configuration_widens_authority')).toBe(false)
  expect(introduced.providerConfig?.preserved).toEqual([])

  const widened = convertLegacyConfiguration({
    profiles: [
      { layer: 'user', document: { name: 'dev', policy: { capabilityCeiling: ['fs.read'] } } },
      {
        layer: 'workspace',
        document: { policy: { capabilityCeiling: ['fs.read', 'exec.unrestricted'] } },
      },
    ],
  })
  expect(widened.status).toBe('refused')
  expect(widened.diagnostics.some((item) => item.path === '/policy/capabilityCeiling[]')).toBe(true)
})

it('refuses a workspace approval mode that is wider than the current mode', () => {
  const result = convertLegacyConfiguration({
    profiles: [
      { layer: 'user', document: { name: 'dev', approvals: { mode: 'manual' } } },
      { layer: 'workspace', document: { name: 'workspace', approvals: { mode: 'off' } } },
    ],
  })
  expect(result.status).toBe('refused')
  expect(
    result.diagnostics.some(
      (item) => item.code === 'configuration_widens_authority' && item.path === '/approvals/mode',
    ),
  ).toBe(true)
})

it('accepts a profile policy when computer-use defaults fill the published fragment', () => {
  const result = convertLegacyConfiguration({
    profiles: [{ layer: 'user', document: { name: 'dev', approvals: { mode: 'manual' } } }],
  })
  expect(result.status).toBe('accepted')
  expect(result.publishable).toBe(true)
  expect(result.sessionParameters).toBeNull()
  const policy = validateRuntime('DefaultPolicyParameters', result.providerConfig?.policy)
  expect(policy.ok).toBe(true)
  if (policy.ok) expect(policy.value.computerUse.enabled).toBe(false)
})

it('refuses a weaker layer that enables computer use', () => {
  const result = convertLegacyConfiguration({
    profiles: [
      { layer: 'user', document: { name: 'dev', computerUse: { enabled: false } } },
      { layer: 'workspace', document: { name: 'workspace', computerUse: { enabled: true } } },
    ],
  })
  expect(result.status).toBe('refused')
  expect(
    result.diagnostics.some(
      (item) => item.code === 'configuration_widens_authority' && item.path === '/computerUse',
    ),
  ).toBe(true)
})

it('blocks a relative directory and a home path when no deployer home is supplied', () => {
  const relative = convertLegacyConfiguration({
    profiles: [{ layer: 'user', document: { name: 'dev', dataDir: 'relative/data' } }],
  })
  expect(relative.status).toBe('refused')
  expect(
    relative.diagnostics.some((item) => item.code === 'path_not_absolute' && item.path === '/dataDir'),
  ).toBe(true)

  const home = convertLegacyConfiguration({
    profiles: [{ layer: 'user', document: { name: 'dev', cacheDir: '~/cache' } }],
  })
  expect(home.status).toBe('refused')
  expect(home.diagnostics.some((item) => item.code === 'home_unresolved' && item.path === '/cacheDir')).toBe(
    true,
  )

  const expanded = convertLegacyConfiguration({
    home: '/opt/deploy',
    profiles: [{ layer: 'user', document: { name: 'dev', dataDir: '~/data' } }],
  })
  expect(expanded.status).toBe('accepted')
  // The stored directory is the absolute path under the supplied home, in the host path form.
  expect(expanded.providerConfig?.directories.dataDir).toBe(join('/opt/deploy', 'data'))
})

it('keeps an unplaced limit and does not invent the other process limits', () => {
  const missing = convertLegacyConfiguration({
    profiles: [{ layer: 'user', document: { name: 'dev', limits: { 'cost.credits_per_usd': 100 } } }],
  })
  expect(missing.status).toBe('held')
  expect(missing.publishable).toBe(false)
  expect(missing.providerConfig?.assembly).toBeNull()
  expect(missing.providerConfig?.preserved).toContainEqual({
    path: '/limits/cost.credits_per_usd',
    value: 100,
    reason: 'target_schema_missing',
  })

  const partial = convertLegacyConfiguration({
    profiles: [{ layer: 'user', document: { name: 'dev', limits: { 'daemon.max_workers': 4 } } }],
  })
  expect(partial.status).toBe('held')
  expect(partial.providerConfig?.assembly).toBeNull()
  expect(partial.providerConfig?.preserved).toContainEqual({
    path: '/limits',
    value: { maxWorkers: 4 },
    reason: 'process-limits',
  })
  expect(JSON.stringify(partial.providerConfig)).not.toContain('shutdownGraceMs')
})

it('maps approval.park onto the session without changing the provider digest on a later session edit', () => {
  const result = convertLegacyConfiguration({
    profiles: [{ layer: 'user', document: { name: 'dev', limits: { 'approval.park': 1 } } }],
    presets: [{ layer: 'user', document: { name: 'sample', budget: { max_steps: 7 } } }],
    presetId: 'sample',
  })
  expect(result.status).not.toBe('refused')
  expect(result.sessionParameters).toMatchObject({
    approval: { on_unavailable: 'park' },
    budget: { max_steps: 7 },
  })
  const patched = applySessionParameterChange(result, '/budget/max_steps', 9)
  expect(patched.status).toBe(result.status)
  expect(patched.sessionParameters).toMatchObject({
    budget: { max_steps: 9 },
    approval: { on_unavailable: 'park' },
  })
  expect(patched.sessionDigest).not.toBe(result.sessionDigest)
  expect(patched.providerDigest).toBe(result.providerDigest)
})

it('refuses a provider-path patch and keeps the previous profile usable', () => {
  const result = preset({ name: 'sample', budget: { max_steps: 7 } })
  const before = result.sessionDigest
  const patched = applySessionParameterChange(result, '/limits', { 'daemon.max_workers': 1 })
  expect(patched.status).toBe('refused')
  expect(patched.sessionParameters).toBeNull()
  expect(
    patched.diagnostics.some((item) => item.code === 'session_patch_rejected' && item.path === '/limits'),
  ).toBe(true)
  expect(result.sessionDigest).toBe(before)
  expect(result.sessionParameters).toMatchObject({ budget: { max_steps: 7 } })
})

it('rejects an invalid session patch and still restores the pinned snapshot', () => {
  const result = preset({ name: 'sample', budget: { max_steps: 7 } })
  expect(result.pin).not.toBeNull()
  const rejected = applySessionParameterChange(result, '/budget/max_steps', 0)
  expect(rejected.status).toBe('refused')
  expect(rejected.sessionParameters).toBeNull()
  expect(result.sessionParameters).toMatchObject({ budget: { max_steps: 7 } })

  const latest = {
    presets: [{ layer: 'user' as const, document: { name: 'sample', budget: { max_steps: 99 } } }],
    presetId: 'sample',
  }
  const pin = result.pin
  expect(pin).not.toBeNull()
  if (!pin) return
  const restored = restorePinnedConfiguration(pin, latest)
  expect(restored.latestIgnored).toBe(true)
  expect(restored.sessionParameters).toMatchObject({ budget: { max_steps: 7 } })
  expect(restored.sessionDigest).toBe(result.sessionDigest)

  const tampered = structuredClone(pin)
  ;(tampered.sessionParameters.budget as { max_steps: number }).max_steps = 99
  const refused = restorePinnedConfiguration(tampered, latest)
  expect(refused.status).toBe('refused')
  expect(refused.sessionParameters).toBeNull()
  expect(JSON.stringify(refused)).not.toContain('"max_steps":99')
  expect(refused.diagnostics[0]?.message).toContain('latest document was not applied')
})

it('forbids a workspace seam and a local approval field', () => {
  const seam = convertLegacyConfiguration({
    profiles: [{ layer: 'workspace', document: { name: 'workspace', seams: { sandbox: 'pkg' } } }],
  })
  expect(seam.status).toBe('refused')
  expect(
    seam.diagnostics.some((item) => item.code === 'layer_field_forbidden' && item.path === '/seams/sandbox'),
  ).toBe(true)

  const local = convertLegacyConfiguration({
    profiles: [{ layer: 'local', document: { approvals: { mode: 'manual' } } }],
  })
  expect(local.status).toBe('refused')
  expect(
    local.diagnostics.some(
      (item) => item.code === 'layer_field_forbidden' && item.path === '/approvals/mode',
    ),
  ).toBe(true)
})
