import type { JevConfigSnapshot, RuntimeDescriptor } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { withPendingJevConfiguration } from '../src/supervisor/jev-availability.js'

const capabilities = { prompt: true, cancel: true, resume: true, compact: false, fork: false }
const native: RuntimeDescriptor = {
  id: 'native',
  version: '1',
  label: 'Native',
  apiVersion: 1,
  available: true,
  capabilities,
}
const unavailable: RuntimeDescriptor = {
  id: 'jevloop',
  version: '1',
  label: 'JevLoop',
  apiVersion: 1,
  available: false,
  capabilities,
  unavailableReason: 'not configured at boot',
}
const items = [native, unavailable]
const saved: JevConfigSnapshot = {
  profile: 'local-dev',
  revision: 1,
  settings: {
    transport: 'native',
    endpoint: 'https://jev.example.invalid/decision',
    model: 'jev',
    enabled: true,
    authentication: 'none',
  },
  configured: true,
  credentialConfigured: true,
  effect: 'restart-required',
  source: 'profile',
}

it('explains pending activation without claiming that the unavailable worker is ready', () => {
  const result = withPendingJevConfiguration(items, saved)
  expect(result[0]).toBe(native)
  expect(result[1]).toMatchObject({ ...unavailable, unavailableReason: 'Jev 配置已保存，需重启后台后生效。' })
  expect(unavailable.unavailableReason).toBe('not configured at boot')
  if (!saved.settings) throw new Error('Missing saved settings')
  expect(
    withPendingJevConfiguration(items, { ...saved, settings: { ...saved.settings, backend: 'laya' } })[1],
  ).toMatchObject({ available: false, unavailableReason: 'Laya 配置已保存，需重启后台后生效。' })
})
it('does not disable or relabel an available worker when its next configuration is pending', () => {
  const available: RuntimeDescriptor = {
    id: 'jevloop',
    version: '1',
    label: 'JevLoop',
    apiVersion: 1,
    available: true,
    capabilities,
  }
  expect(withPendingJevConfiguration([native, available], saved)[1]).toBe(available)
})
it('preserves actual reasons when no saved activation is pending', () => {
  for (const snapshot of [
    undefined,
    { ...saved, configured: false },
    { ...saved, effect: 'new-sessions' as const },
  ])
    expect(withPendingJevConfiguration(items, snapshot)).toBe(items)
})
it('does not promise that restart will apply a configuration still overridden by environment', () => {
  expect(withPendingJevConfiguration(items, { ...saved, source: 'environment' })[1]).toMatchObject({
    available: false,
    unavailableReason: expect.stringContaining('环境变量'),
  })
})
