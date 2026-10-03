import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { registerArtifactTicketKeyContract } from '../../../../packages/extension-api/testkit/runtime/contracts/artifact-ticket-key.js'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.js'
import { recoverTicketKeys } from '../../../../packages/host/test/runtime/artifact-ticket-key-process.js'
import { ticketScenario } from '../../../../packages/host/test/runtime/artifact-ticket-key-scenarios.js'
import { canonicalJsonDigest } from '../../../../packages/protocol/src/runtime/index.js'
import { getConformanceBuildIdentity } from '../build-identity.js'

export function bindArtifactTicketKeyConformance(
  harness: ConformanceHarness,
  command: string,
  kind: 'default' | 'reference',
  providerId: string,
  build = getConformanceBuildIdentity(),
) {
  const source =
    kind === 'default'
      ? '../../../../packages/host/src/runtime/artifact-ticket-key.ts'
      : '../../../../examples/runtime-reference/src/providers/artifact-ticket-key.ts'
  registerArtifactTicketKeyContract(harness, {
    command,
    providerId,
    build,
    recipe: kind === 'default' ? 'sqlite-ticket-retention' : 'atomic-cabinet-webcrypto',
    async run(scenario) {
      if (scenario === 'recover') await recoverTicketKeys(kind)
      else await ticketScenario(kind, scenario)
      return {
        providerDigest: createHash('sha256')
          .update(readFileSync(fileURLToPath(new URL(source, import.meta.url))))
          .digest('hex'),
        configDigest: canonicalJsonDigest({ consumer: 'artifact-ticket', kind, retention: 60000 }),
        releaseSetDigest: canonicalJsonDigest({ kind, build: { ...build } }),
      }
    },
  })
}
