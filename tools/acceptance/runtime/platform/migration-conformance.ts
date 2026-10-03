import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createReferenceMigrationProvider } from '../../../../examples/runtime-reference/src/providers/migration.js'
import { verifyReferenceMigrationReceipt } from '../../../../examples/runtime-reference/src/providers/migration-evidence.js'
import { registerMigrationPlanContract } from '../../../../packages/extension-api/testkit/runtime/contracts/migration.js'
import { MIGRATION_FIXTURE_NOW } from '../../../../packages/extension-api/testkit/runtime/contracts/migration-fixture.js'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.js'
import {
  type MigrationReceiptEvidencePort,
  verifyMigrationReceipt,
} from '../../../../packages/host/src/runtime/migration/receipt-verification.js'
import { createMigrationProvider } from '../../../../packages/host/src/runtime/providers/migration.js'
import { getConformanceBuildIdentity } from '../build-identity.js'

export async function bindConformance(
  harness: ConformanceHarness,
  request: {
    readonly command: string
    readonly contracts: readonly string[] | 'all'
    readonly providers: readonly string[]
  },
) {
  if (request.contracts !== 'all' && !request.contracts.includes('agh.migration'))
    return { contracts: [], providers: [] }
  const providers = request.providers.filter((p) => ['default', 'reference'].includes(p))
  for (const providerId of providers) {
    const folder =
      providerId === 'default' ? 'packages/host/src/runtime/' : 'examples/runtime-reference/src/providers/'
    const files =
      providerId === 'default'
        ? [
            'providers/migration.ts',
            'migration/controller.ts',
            'migration/eligibility.ts',
            'migration/primitives.ts',
            'migration/receipt-verification.ts',
            'migration/pin-retention.ts',
          ]
        : ['migration.ts', 'migration-evidence.ts']
    const digest = createHash('sha256')
    for (const file of files)
      digest.update(readFileSync(new URL(`../../../../${folder}${file}`, import.meta.url)))
    registerMigrationPlanContract(harness, {
      providerId,
      command: request.command,
      build: getConformanceBuildIdentity(),
      providerDigest: digest.digest('hex'),
      verifyReceipt: async (plan, fixture, context) => {
        const verify = providerId === 'default' ? verifyMigrationReceipt : verifyReferenceMigrationReceipt
        if (!fixture)
          return verify(
            plan,
            {
              upgradeId: plan.upgradeId,
              state: 'completed',
              checkpointRevision: 7,
              cutoverId: 'actual-cutover',
              commitRef: 'actual-commit',
              diagnosticIds: [],
            },
            {},
            context,
            MIGRATION_FIXTURE_NOW,
          )
        const port: MigrationReceiptEvidencePort = {
          authorize: async () => ({ ok: true, value: undefined }),
          probe: async () => ({ ok: true, value: fixture.commit }),
          currentHeads: async () => ({
            ok: true,
            value: { heads: fixture.commit.committedHeads, directory: fixture.commit.directoryHeads },
          }),
          readData: async (ref) =>
            ref.kind === 'inline'
              ? { ok: true, value: ref.value }
              : {
                  ok: false,
                  error: {
                    code: 'incompatible',
                    detailCode: 'fixture_blob_unavailable',
                    message: 'No fixture blob',
                    diagnosticId: 'fixture',
                    retryAdvice: { kind: 'never' },
                  },
                },
          validationIssuers: async () => ({ ok: true, value: [fixture.issuer] }),
        }
        return verify(
          plan,
          fixture.receipt,
          { [plan.request.target.kind]: port },
          context,
          MIGRATION_FIXTURE_NOW,
        )
      },
      create: (fixture) => {
        const ports = {
          authorize: async () => ({ ok: true as const, value: undefined }),
          snapshot: async () => ({ ok: true as const, value: structuredClone(fixture.snapshot) }),
          existingPlan: async () => ({ ok: true as const, value: null }),
        }
        return providerId === 'default'
          ? createMigrationProvider(ports, () => MIGRATION_FIXTURE_NOW)
          : createReferenceMigrationProvider(ports, () => MIGRATION_FIXTURE_NOW)
      },
    })
  }
  return { contracts: ['agh.migration'], providers }
}
