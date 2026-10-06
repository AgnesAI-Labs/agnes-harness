import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReferencePolicyFactory } from '../../../../examples/runtime-reference/src/providers/policy.js'
import { createDefaultPolicyFactory } from '../../../../packages/core/src/runtime/providers/policy.js'
import { createPolicyFixture } from '../../../../packages/core/test/runtime/policy-fixture.js'
import { runPolicyContractScenario } from '../../../../packages/extension-api/testkit/runtime/contracts/policy.js'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.js'
import { getConformanceBuildIdentity, withDeploymentStandIns } from '../build-identity.js'
import type { ConformanceBindRequest } from '../run-conformance.js'

const tested = ['select', 'normal', 'deny', 'cancel', 'dispose'] as const
type ProviderId = 'default' | 'reference'
const coldPath = fileURLToPath(new URL('../fixtures/policy-cold-process.ts', import.meta.url))

async function coldProcess(providerId: ProviderId, directory: string, mode: 'hold' | 'once') {
  const child = spawn(process.execPath, ['--import', 'tsx', coldPath, providerId, directory, mode], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  let output: { pid: number; priorDecisions: number; result: unknown }
  try {
    output = await new Promise<{ pid: number; priorDecisions: number; result: unknown }>(
      (resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Policy cold process timed out: ${stderr}`)), 15_000)
        const read = () => {
          const line = stdout.indexOf('\n')
          if (line < 0) return
          clearTimeout(timer)
          try {
            resolve(
              JSON.parse(stdout.slice(0, line)) as {
                pid: number
                priorDecisions: number
                result: unknown
              },
            )
          } catch (error) {
            reject(error)
          }
        }
        child.stdout.on('data', read)
        void exited.then(({ code, signal }) => {
          clearTimeout(timer)
          if (stdout.indexOf('\n') < 0)
            reject(new Error(`Policy cold process exited ${code}/${signal}: ${stderr}`))
        }, reject)
        read()
      },
    )
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await exited
    }
    throw error
  }
  return { child, output, exited }
}

async function verifyKilledProcessRecovery(providerId: ProviderId) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-policy-cold-')))
  let original: Awaited<ReturnType<typeof coldProcess>> | undefined
  try {
    original = await coldProcess(providerId, directory, 'hold')
    original.child.kill('SIGKILL')
    const ended = await original.exited
    if (ended.signal !== 'SIGKILL') throw new Error('Original Policy owner was not killed')
    const recovered = await coldProcess(providerId, directory, 'once')
    const restarted = await recovered.exited
    if (
      restarted.code !== 0 ||
      recovered.output.pid === original.output.pid ||
      original.output.priorDecisions !== 0 ||
      recovered.output.priorDecisions !== 1 ||
      JSON.stringify(recovered.output.result) !== JSON.stringify(original.output.result)
    )
      throw new Error('Independent Policy process did not replay the same durable revoke')
  } finally {
    if (original?.child.exitCode === null && original.child.signalCode === null) {
      original.child.kill('SIGKILL')
      await original.exited
    }
    rmSync(directory, { recursive: true, force: true })
  }
}

/** The ordinary fixture is in process; the recover slot also kills and reopens its SQLite owner. */
export async function bindConformance(harness: ConformanceHarness, request: ConformanceBindRequest) {
  const contracts =
    request.contracts === 'all' || request.contracts.includes('agh.policy') ? ['agh.policy'] : []
  const providers = request.providers.filter((id): id is ProviderId => id === 'default' || id === 'reference')
  if (!contracts.length) return { contracts, providers }
  const build = getConformanceBuildIdentity()
  const standIns = withDeploymentStandIns(
    harness,
    'Policy original facts and grant owner: F02 SQLite fixture',
  )
  for (const providerId of providers) {
    const factory = providerId === 'default' ? createDefaultPolicyFactory : createReferencePolicyFactory
    for (const scenario of tested) {
      standIns.registerCase({
        contract: 'agh.policy',
        providerId,
        scenario,
        qualification: 'required',
        async run() {
          const evidence = await runPolicyContractScenario(scenario, async () =>
            createPolicyFixture(factory, providerId),
          )
          return {
            id: `agh.policy/${providerId}/${scenario}`,
            ...evidence,
            recipe: 'verified-current-facts',
            features: ['evaluate', 'listGrants', 'revokeGrant'],
            build,
            consumer: 'policy-public-consumer',
            command: request.command,
            status: 'passed',
            releaseSetDigest: build.buildDigest,
            attachmentDigest: null,
            fixture: null,
            sharedEvidenceId: null,
            reuse: {
              scope: 'session',
              methodKind: 'query/compute/control',
              lifecycle: scenario === 'cancel' || scenario === 'dispose' ? scenario : 'call',
              undeclaredConnection: false,
            },
            perImplementation: true,
            gate: null,
          }
        },
      })
    }
    standIns.registerCase({
      contract: 'agh.policy',
      providerId,
      scenario: 'recover',
      qualification: 'required',
      async run() {
        const fixture = createPolicyFixture(factory, providerId)
        try {
          await runPolicyContractScenario('recover', async () => createPolicyFixture(factory, providerId))
          await verifyKilledProcessRecovery(providerId)
          return {
            id: `agh.policy/${providerId}/recover`,
            providerDigest: fixture.factory.descriptor.packageDigest,
            configDigest: fixture.config.schema.digest,
            recipe: 'verified-current-facts',
            features: ['evaluate', 'listGrants', 'revokeGrant'],
            build,
            consumer: 'policy-public-consumer',
            command: request.command,
            status: 'passed',
            diagnostic:
              'Original Policy process killed; fresh process replayed the same SQLite revoke receipt',
            releaseSetDigest: build.buildDigest,
            attachmentDigest: null,
            fixture: null,
            sharedEvidenceId: null,
            reuse: {
              scope: 'session',
              methodKind: 'query/compute/control',
              lifecycle: 'recover',
              undeclaredConnection: false,
            },
            perImplementation: true,
            gate: null,
          }
        } finally {
          await fixture.finish()
        }
      },
    })
  }
  return { contracts, providers }
}
