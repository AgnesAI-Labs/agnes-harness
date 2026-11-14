import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeSeamInit } from '@agnes/base/testkit'
import { ProfileActivations } from '@agnes/host-extensions/profile/activation'
import { createPackageManager, emptyLock, parseSource, writeLock } from '@agnes/package-manager'
import { expect, it } from 'vitest'
import * as authority from '../src/runtime/sessions/session-work-authority.js'

it.each(['disable', 'untrust', 'remove'] as const)(
  'revokes retained background authority after an actual package %s',
  async (operation) => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-background-authority-'))
    const profileDir = join(root, 'profiles', 'local-dev')
    mkdirSync(profileDir, { recursive: true })
    cpSync(new URL('../../package-manager/test/fixtures/pkg-a', import.meta.url), join(root, 'source'), {
      recursive: true,
    })
    writeLock(profileDir, {
      ...emptyLock('local-dev', '0.1.0'),
      resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
      seams: Object.fromEntries(
        ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((name) => [
          name,
          { provider: 'local' },
        ]),
      ),
      policySnapshot: { capabilityCeiling: ['tools'], workspacePackages: 'require-project-trust' },
    })
    const manager = createPackageManager({
      dataDir: root,
      cwd: root,
      agnesVersion: '0.1.0',
      references: async () => [],
    })
    let dispose: (() => void) | undefined
    try {
      const source = parseSource('file:./source')
      const preview = await manager.inspect(profileDir, source)
      await manager.install(profileDir, source, { expectedIntegrity: preview.integrity })
      const decision = { integrity: preview.integrity, capabilityHash: preview.capabilityHash }
      await manager.trust(profileDir, preview.id, decision)
      await manager.setEnabled(profileDir, preview.id, true)
      const store = fakeSeamInit().adapters.storage.namespace('activations')
      const publisher = new ProfileActivations(store, profileDir)
      const retained = new ProfileActivations(store, profileDir)
      const identity = {
        owner: 'session-work:plugin/test',
        revision: 'same-code',
        integrity: preview.integrity,
      }
      publisher.publish([identity])
      const gate = authority.createSessionWorkAuthority({
        activations: retained,
        owner: 'plugin/test',
        packageId: preview.id,
        integrity: preview.integrity,
        mountIdentity: identity.revision,
        profileDir,
        profile: 'local-dev',
        agnesVersion: '0.1.0',
      })
      dispose = gate.dispose
      expect(gate.check()).toBe(true)
      // A config-only or unrelated-row publication keeps this exact code epoch.
      publisher.publish([
        identity,
        { owner: 'plugin/test', integrity: preview.integrity, revision: 'changed-config' },
        { owner: 'other', integrity: 'other', revision: 'other-code' },
      ])
      expect(gate.signal.aborted).toBe(false)
      if (operation === 'disable') await manager.setEnabled(profileDir, preview.id, false)
      else if (operation === 'untrust') await manager.untrust(profileDir, preview.id, decision)
      else await manager.remove(profileDir, preview.id)
      // The installed lock closes the commit-before-publication window too.
      expect(gate.check()).toBe(false)
      expect(gate.signal.aborted).toBe(true)
      publisher.publish([])
      if (operation === 'disable') {
        await manager.setEnabled(profileDir, preview.id, true)
        publisher.publish([identity])
        expect(gate.check()).toBe(false)
      }
    } finally {
      dispose?.()
      rmSync(root, { recursive: true, force: true })
    }
  },
)

it('aborts only replaced or disabled code across retained activation containers', () => {
  const store = fakeSeamInit().adapters.storage.namespace('background')
  const publisher = new ProfileActivations(store, 'isolated-profile')
  const retained = new ProfileActivations(store, 'isolated-profile')
  const identity = { owner: 'session-work:plugin/test', revision: 'code-1', integrity: 'integrity' }
  publisher.publish([identity])
  const gate = authority.createSessionWorkAuthority({
    activations: retained,
    owner: 'plugin/test',
    packageId: 'synthetic',
    integrity: 'integrity',
    mountIdentity: 'code-1',
    profileDir: '/nonexistent/synthetic-background-profile',
    profile: 'synthetic',
    agnesVersion: '0.1.0',
  })
  try {
    expect(gate.check()).toBe(true)
    publisher.publish([identity, { owner: 'unrelated', revision: 'v2', integrity: 'other' }])
    expect(gate.signal.aborted).toBe(false)
    publisher.publish([{ ...identity, revision: 'code-2' }])
    expect(gate.signal.aborted).toBe(true)
    publisher.publish([identity])
    expect(gate.check()).toBe(false)
  } finally {
    gate.dispose()
  }
})
