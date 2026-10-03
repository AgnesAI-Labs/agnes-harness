import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { registerPackageInstallerProposalContract } from '../../../../packages/extension-api/testkit/runtime/contracts/package-installer.js'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.js'
import {
  coldInstallerStatus,
  installerContext,
  openInstallerFixture,
} from '../../../../packages/package-manager/test/runtime/fixtures/installer.js'
import { getConformanceBuildIdentity } from '../build-identity.js'

export async function bindConformance(
  harness: ConformanceHarness,
  request: {
    readonly command: string
    readonly contracts: readonly string[] | 'all'
    readonly providers: readonly string[]
  },
): Promise<{ readonly contracts: readonly string[]; readonly providers: readonly string[] }> {
  if (request.contracts !== 'all' && !request.contracts.includes('agh.package-installer'))
    return { contracts: [], providers: [] }
  const providers = request.providers.filter((id) => id === 'default' || id === 'reference')
  for (const providerId of providers) {
    const files =
      providerId === 'default'
        ? [
            'packages/package-manager/src/runtime/providers/package-installer.ts',
            'packages/package-manager/src/runtime/install-journal.ts',
            'packages/package-manager/src/runtime/repair-plan.ts',
          ]
        : ['examples/runtime-reference/src/providers/package-installer.ts']
    const hash = createHash('sha256')
    for (const file of files) hash.update(readFileSync(new URL(`../../../../${file}`, import.meta.url)))
    registerPackageInstallerProposalContract(harness, {
      providerId,
      command: request.command,
      providerDigest: hash.digest('hex'),
      build: getConformanceBuildIdentity(),
      context: installerContext,
      open: (directory) => openInstallerFixture(providerId, directory),
      coldStatus: async (directory, proposalId) => coldInstallerStatus(providerId, directory, proposalId),
    })
  }
  return { contracts: ['agh.package-installer'], providers }
}
