import { expect, it } from 'vitest'
import { releaseChildEngineOwner } from '../src/release-policy.js'

const owner = {
  id: '@agnes/base',
  version: '0.0.0',
  source: 'builtin',
  trust: 'builtin',
  enabled: true,
  integrity: 'builtin:0.0.0',
}
it.each([
  { source: 'file:./base' },
  { source: 'link:./base' },
  { source: 'workspace:extensions/base' },
  { source: 'npm:@agnes/base' },
  { trust: 'trusted' },
  { enabled: false },
  { integrity: 'sha256-spoof' },
  { version: '1.0.0' },
  { id: '@agnes/code' },
])('does not authorize child-engine publication for a release lookalike: %j', (patch) => {
  expect(releaseChildEngineOwner([{ ...owner, ...patch }])).toBeUndefined()
})
it('rechecks the release row on each owner lookup', () => {
  const current = { ...owner }
  expect(releaseChildEngineOwner([current])).toBe(current)
  current.enabled = false
  expect(releaseChildEngineOwner([current])).toBeUndefined()
  current.enabled = true
  current.trust = 'trusted'
  expect(releaseChildEngineOwner([current])).toBeUndefined()
})
