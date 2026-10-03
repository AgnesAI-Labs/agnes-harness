import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { ScenarioName } from '../../../packages/extension-api/testkit/runtime/evidence.js'
import { SCENARIOS } from '../../../packages/extension-api/testkit/runtime/evidence.js'
import type { ConformanceHarness } from '../../../packages/extension-api/testkit/runtime/harness.js'
import { canonicalJsonDigest } from '../../../packages/protocol/src/runtime/index.js'
import { getConformanceBuildIdentity } from './build-identity.js'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const vitest = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs')
const execute = promisify(execFile)
const OWNED = ['agh.routing', 'agh.model-adapter'] as const
type Contract = (typeof OWNED)[number]
type Kind = 'default' | 'reference'
interface CaseResult {
  fullName: string
  status: string
}
interface ExecutedSuite {
  cases: readonly CaseResult[]
  digest: string
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid actual test report')
  return value as Record<string, unknown>
}
async function actualSuite(
  file: string,
  expected: number,
  suiteRuns: Map<string, Promise<ExecutedSuite>>,
): Promise<ExecutedSuite> {
  const key = `${file}:${expected}`
  const previous = suiteRuns.get(key)
  if (previous) return previous
  const run = (async () => {
    const directory = mkdtempSync(join(tmpdir(), 'routing-model-conformance-'))
    const report = join(directory, 'report.json')
    try {
      await execute(
        process.execPath,
        [vitest, 'run', file, '--maxWorkers=1', '--reporter=json', `--outputFile=${report}`],
        {
          cwd: ROOT,
          timeout: 120000,
          maxBuffer: 4 * 1024 * 1024,
          env: { PATH: process.env.PATH, LANG: 'C', NODE_ENV: 'test' },
        },
      )
      const raw = readFileSync(report, 'utf8')
      const parsed = object(JSON.parse(raw))
      if (
        parsed.success !== true ||
        parsed.numTotalTests !== expected ||
        parsed.numPassedTests !== expected ||
        parsed.numFailedTests !== 0 ||
        parsed.numPendingTests !== 0 ||
        parsed.numTodoTests !== 0
      )
        throw new Error(`Incomplete actual suite: ${file}`)
      if (!Array.isArray(parsed.testResults) || parsed.testResults.length !== 1)
        throw new Error('Unexpected collected suites')
      const assertions = object(parsed.testResults[0]).assertionResults
      if (!Array.isArray(assertions) || assertions.length !== expected)
        throw new Error('Unexpected actual case count')
      const cases = assertions.map((rawCase: unknown) => {
        const item = object(rawCase)
        if (typeof item.fullName !== 'string' || item.status !== 'passed')
          throw new Error('Nonpassing actual case')
        return { fullName: item.fullName, status: item.status }
      })
      return { cases, digest: createHash('sha256').update(raw).digest('hex') }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })()
  suiteRuns.set(key, run)
  return run
}
function selection(contract: Contract, kind: Kind, scenario: ScenarioName) {
  if (contract === 'agh.routing') {
    if (scenario === 'recover')
      return {
        file: 'packages/host/test/runtime/routing-process-recovery.e2e.test.ts',
        count: 2,
        match: (name: string) =>
          name.includes(`actual ${kind} routing provider in a fresh PID after SIGKILL`),
      }
    return {
      file: 'packages/host/test/runtime/routing.test.ts',
      count: 12,
      match: (name: string) => name.includes(`reference=${kind === 'reference'} scenario=${scenario}`),
    }
  }
  if (scenario === 'recover')
    return kind === 'default'
      ? {
          file: 'packages/ai/test/runtime/model-adapter-crash.e2e.test.ts',
          count: 2,
          match: (name: string) =>
            name.includes('recovers the default ') && name.includes('fresh PID after SIGKILL'),
        }
      : {
          file: 'packages/ai/test/runtime/reference-model-process-recovery.e2e.test.ts',
          count: 1,
          match: (name: string) =>
            name.includes('different process') && name.includes('original durable receipt without resend'),
        }
  return {
    file:
      kind === 'default'
        ? 'packages/ai/test/runtime/model-adapter-contract.e2e.test.ts'
        : 'packages/ai/test/runtime/reference-model-adapter-contract.e2e.test.ts',
    count: 6,
    match: (name: string) => name.endsWith(`model adapter contract ${scenario}`),
  }
}
function sourceDigest(contract: Contract, kind: Kind, file: string) {
  const provider =
    contract === 'agh.routing'
      ? kind === 'default'
        ? 'packages/host/src/runtime/providers/routing.ts'
        : 'examples/runtime-reference/src/providers/routing.ts'
      : kind === 'default'
        ? 'packages/ai/src/runtime/providers/model-adapter.ts'
        : 'examples/runtime-reference/src/providers/model-adapter.ts'
  const helper =
    contract === 'agh.routing'
      ? 'packages/extension-api/src/runtime/routing-authoring.ts'
      : 'packages/ai/src/runtime/model-adapter/ports.ts'
  const related =
    contract === 'agh.routing'
      ? file.includes('process-recovery')
        ? [
            'packages/host/test/runtime/fixtures/routing-recovery-source.ts',
            'packages/host/test/runtime/fixtures/routing-recovery-worker.ts',
          ]
        : []
      : [
          kind === 'default'
            ? 'packages/ai/test/runtime/model-fixture.ts'
            : 'packages/ai/test/runtime/reference-model-fixture.ts',
          'packages/ai/test/runtime/fixtures/model-http.mjs',
          ...(file.includes('model-adapter-crash')
            ? [
                'packages/ai/test/runtime/model-crash-fixture.ts',
                'packages/ai/test/runtime/fixtures/model-crash-worker.ts',
                'packages/ai/test/runtime/fixtures/model-crash-storage.ts',
              ]
            : file.includes('process-recovery')
              ? ['packages/ai/test/runtime/fixtures/reference-model-worker.ts']
              : []),
        ]
  const source = [provider, helper, file, ...related].map((path) => ({
    path,
    digest: createHash('sha256')
      .update(readFileSync(join(ROOT, path)))
      .digest('hex'),
  }))
  return { providerDigest: source[0]?.digest, releaseSetDigest: canonicalJsonDigest(source), provider }
}
/** Each evidence slot invokes real collected fixture tests; no JSON pass flag supplies authority. */
export async function bindConformance(
  harness: ConformanceHarness,
  request: {
    readonly command: string
    readonly contracts: readonly string[] | 'all'
    readonly providers: readonly string[]
  },
) {
  const contracts =
    request.contracts === 'all' ? [...OWNED] : OWNED.filter((name) => request.contracts.includes(name))
  if (!contracts.length) return { contracts: [], providers: [] }
  const providers = request.providers.filter((id): id is Kind => id === 'default' || id === 'reference')
  const build = getConformanceBuildIdentity()
  const suiteRuns = new Map<string, Promise<ExecutedSuite>>()
  for (const contract of contracts)
    for (const providerId of providers)
      for (const scenario of SCENARIOS) {
        harness.registerCase({
          contract,
          providerId,
          scenario,
          qualification: 'required',
          build,
          async run() {
            const target = selection(contract, providerId, scenario)
            const suite = await actualSuite(target.file, target.count, suiteRuns)
            const matched = suite.cases.filter((item) => target.match(item.fullName))
            const count =
              contract === 'agh.model-adapter' && providerId === 'default' && scenario === 'recover' ? 2 : 1
            if (matched.length !== count)
              throw new Error(`Actual scenario mapping absent: ${contract}/${providerId}/${scenario}`)
            const source = sourceDigest(contract, providerId, target.file)
            if (!source.providerDigest) throw new Error('Missing provider source')
            return {
              id: `${contract}/${providerId}/${scenario}`,
              providerDigest: source.providerDigest,
              recipe: 'actual-fixed-source-offline-consumer',
              features: [],
              build,
              consumer: target.file,
              command: request.command,
              status: 'passed',
              diagnostic:
                scenario === 'recover'
                  ? 'Actual SIGKILL and fresh PID; fixed original source/receipt, no live vendor claim'
                  : 'Actual public contract consumer with restricted owners; no production installation claim',
              // Both original contract fixtures encode the actual empty configuration body.
              configDigest: canonicalJsonDigest({}),
              releaseSetDigest: source.releaseSetDigest,
              attachmentDigest: suite.digest,
              fixture: 'test-service-container',
              sharedEvidenceId: null,
            }
          },
        })
      }
  return { contracts, providers }
}
