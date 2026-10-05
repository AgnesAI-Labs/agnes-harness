import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contracts } from '@agnes/extension-api/testkit'
import { expect, it } from 'vitest'
import { createInstalledEffectsFactory } from '../../../core/src/runtime/effects/installed-provider.js'
import { createReferenceEffectsDispatchFactory } from '../../../core/testkit/index.js'
import { createEffectsContractFixture } from './fixtures/effects-contract.js'

for (const [name, factory] of [
  ['installed', createInstalledEffectsFactory],
  ['reference', createReferenceEffectsDispatchFactory],
] as const)
  for (const scenario of ['select', 'normal', 'deny', 'cancel', 'recover', 'dispose'] as const)
    it(`${name} Effects actual State ${scenario}`, async () => {
      const directory = mkdtempSync(join(tmpdir(), 'effects-installed-'))
      try {
        await contracts.runEffectsContractScenario(scenario, () =>
          createEffectsContractFixture(join(directory, 'state.sqlite'), factory),
        )
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })

for (const [name, factory] of [
  ['installed', createInstalledEffectsFactory],
  ['reference', createReferenceEffectsDispatchFactory],
] as const)
  it(`${name} refuses a non-finite owner clock`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'effects-invalid-clock-'))
    const fixture = await createEffectsContractFixture(
      join(directory, 'state.sqlite'),
      (authority, descriptor, codec) => {
        authority.now = () => 'invalid-clock'
        return factory(authority, descriptor, codec)
      },
    )
    try {
      const provider = await fixture.factory.create(
        fixture.config,
        fixture.dependencies,
        fixture.factoryContext,
      )
      expect((await provider.ready(fixture.context)).ok).toBe(false)
      expect(fixture.physicalRequests()).toBe(0)
      await provider.close('shutdown')
    } finally {
      await fixture.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
