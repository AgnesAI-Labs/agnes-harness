import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SAMPLE_CONTRACT,
  SAMPLE_PROVIDER_ID,
  sampleContractCases,
} from '../../../examples/runtime-reference/src/sample-contract.ts'
import type { ConformanceHarness } from '../../../packages/extension-api/testkit/runtime/harness.ts'

// Other contracts register the same way: export bindConformance, claim only the
// contract names this file actually owns, and skip `all` unless the name is in the catalog.
export async function bindConformance(
  harness: ConformanceHarness,
  request: {
    readonly command: string
    readonly contracts: readonly string[] | 'all'
    readonly providers: readonly string[]
  },
): Promise<{ readonly contracts: readonly string[]; readonly providers: readonly string[] }> {
  if (request.contracts === 'all' || !request.contracts.includes(SAMPLE_CONTRACT)) {
    return { contracts: [], providers: [] }
  }
  if (!request.providers.includes(SAMPLE_PROVIDER_ID)) return { contracts: [SAMPLE_CONTRACT], providers: [] }
  const directory = mkdtempSync(join(tmpdir(), 'reference-sample-'))
  const sample = sampleContractCases(join(directory, 'notes.sqlite'))
  for (const registration of sample.cases) harness.registerCase(registration)
  return { contracts: [SAMPLE_CONTRACT], providers: [SAMPLE_PROVIDER_ID] }
}
