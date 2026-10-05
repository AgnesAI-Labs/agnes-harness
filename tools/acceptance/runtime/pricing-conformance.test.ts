import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { contracts } from '../../../packages/extension-api/testkit/index.js'
import { createConformanceHarness } from '../../../packages/extension-api/testkit/runtime/harness.js'
import { createPricingContractFixture } from './fixtures/pricing.js'

for (const kind of ['default', 'reference'] as const)
  describe(`pricing public contract ${kind}`, () => {
    for (const scenario of ['select', 'normal', 'deny', 'cancel', 'dispose'] as const)
      it(scenario, async () => {
        const result = await contracts.runPricingContractScenario(scenario, async () =>
          createPricingContractFixture(kind),
        )
        expect(result.providerDigest).toMatch(/^[0-9a-f]{64}$/)
        expect(result.configDigest).toMatch(/^[0-9a-f]{64}$/)
      })
    it('refuses to report recovery when a real fresh-process consumer is absent', async () => {
      await expect(
        contracts.runPricingContractScenario('recover', async () => createPricingContractFixture(kind)),
      ).rejects.toThrow('real process recovery consumer is missing')
    })
    it('recovers actual selected pricing from SQLite after SIGKILL in a fresh PID', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'pricing-process-recovery-'))
      try {
        const result = await contracts.runPricingContractScenario('recover', async () =>
          createPricingContractFixture(kind, {
            databasePath: join(directory, 'catalog.sqlite'),
            recover: true,
          }),
        )
        expect(result.providerDigest).toMatch(/^[0-9a-f]{64}$/)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })
    it('rejects a changed persisted catalog during fresh-process recovery', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'pricing-process-tamper-'))
      const path = join(directory, 'catalog.sqlite')
      const fixture = createPricingContractFixture(kind, { databasePath: path, recover: true })
      try {
        const db = new DatabaseSync(path)
        try {
          db.prepare('UPDATE catalog SET digest=? WHERE id=?').run('0'.repeat(64), 'selected')
        } finally {
          db.close()
        }
        await expect(fixture.recover?.()).rejects.toThrow('worker exited before proof')
      } finally {
        await fixture.finish()
        rmSync(directory, { recursive: true, force: true })
      }
    })
  })

for (const kind of ['default', 'reference'] as const)
  it(`${kind} rejects evidence attributed to an unexecuted provider`, async () => {
    const harness = createConformanceHarness()
    contracts.registerPricingContract(harness, {
      providerId: 'foreign.unexecuted.provider',
      command: 'pricing-binding-test',
      releaseSetDigest: 'a'.repeat(64),
      build: {
        codeSha: 'fixture-build',
        buildDigest: 'b'.repeat(64),
        lockDigest: 'c'.repeat(64),
        specVersion: '1.0.0',
        sdkVersion: '1.0.0',
        sdkDigest: 'd'.repeat(64),
        platform: 'darwin-arm64',
      },
      async create() {
        return createPricingContractFixture(kind)
      },
    })
    const report = await harness.run({
      contracts: ['agh.pricing'],
      providers: ['foreign.unexecuted.provider'],
      command: 'pricing-binding-test',
      clock: { startedAt: '2026-10-04T00:00:00.000Z', finishedAt: '2026-10-04T00:00:01.000Z' },
    })
    const normal = report.assertions.find((assertion) => assertion.scenario === 'normal')
    expect(normal).toBeDefined()
    expect(normal?.status).toBe('failed')
  })
