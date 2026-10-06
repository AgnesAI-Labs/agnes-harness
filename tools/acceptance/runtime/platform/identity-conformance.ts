import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runIdentityContractCase } from '../../../../packages/extension-api/testkit/runtime/contracts/identity.js'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.js'
import { tckFixture } from '../../../../packages/host/test/runtime/identity-conformance-fixture.js'
import { getConformanceBuildIdentity, withDeploymentStandIns } from '../build-identity.js'
import type { ConformanceBindRequest } from '../run-conformance.js'

const tested = ['select', 'normal', 'deny', 'cancel', 'dispose'] as const
type ProviderId = 'default' | 'reference'
const coldPath = fileURLToPath(new URL('../fixtures/identity-cold-process.ts', import.meta.url))

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
  let output: { pid: number; priorInstances: number; replayDenied: boolean; accepted: boolean }
  try {
    output = await new Promise<{
      pid: number
      priorInstances: number
      replayDenied: boolean
      accepted: boolean
    }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Identity cold process timed out: ${stderr}`)), 15_000)
      const read = () => {
        const line = stdout.indexOf('\n')
        if (line < 0) return
        clearTimeout(timer)
        try {
          resolve(
            JSON.parse(stdout.slice(0, line)) as {
              pid: number
              priorInstances: number
              replayDenied: boolean
              accepted: boolean
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
          reject(new Error(`Identity cold process exited ${code}/${signal}: ${stderr}`))
      }, reject)
      read()
    })
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
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-identity-cold-')))
  let original: Awaited<ReturnType<typeof coldProcess>> | undefined
  try {
    original = await coldProcess(providerId, directory, 'hold')
    original.child.kill('SIGKILL')
    const ended = await original.exited
    if (ended.signal !== 'SIGKILL') throw new Error('Original Identity owner was not killed')
    const recovered = await coldProcess(providerId, directory, 'once')
    const restarted = await recovered.exited
    if (
      restarted.code !== 0 ||
      recovered.output.pid === original.output.pid ||
      original.output.priorInstances !== 0 ||
      recovered.output.priorInstances !== 1 ||
      !recovered.output.replayDenied ||
      !original.output.accepted ||
      !recovered.output.accepted
    )
      throw new Error(
        'Independent Identity process did not replay the original persisted instance and nonce replay',
      )
  } finally {
    if (original?.child.exitCode === null && original.child.signalCode === null) {
      original.child.kill('SIGKILL')
      await original.exited
    }
    rmSync(directory, { recursive: true, force: true })
  }
}

export async function bindConformance(harness: ConformanceHarness, request: ConformanceBindRequest) {
  const contracts =
    request.contracts === 'all' || request.contracts.includes('agh.identity') ? ['agh.identity'] : []
  const providers = request.providers.filter((id): id is ProviderId => id === 'default' || id === 'reference')
  if (!contracts.length) return { contracts, providers }
  const build = getConformanceBuildIdentity()
  const fixtureHarness = withDeploymentStandIns(harness, 'Identity transport and durable owner: F02 fixture')
  for (const providerId of providers) {
    for (const scenario of tested) {
      fixtureHarness.registerCase({
        contract: 'agh.identity',
        scenario,
        providerId,
        qualification: 'required',
        async run() {
          const directory = mkdtempSync(join(tmpdir(), 'agnes-identity-tck-'))
          const fixture = await tckFixture(providerId, join(directory, 'owner.sqlite'))
          try {
            await runIdentityContractCase(fixture, scenario)
            return {
              id: `agh.identity/${providerId}/${scenario}`,
              providerDigest: fixture.factory.descriptor.packageDigest,
              configDigest:
                fixture.config.kind === 'inline' ? fixture.config.digest : fixture.config.blob.digest,
              releaseSetDigest: fixture.releaseSetDigest,
              recipe: 'identity-transport',
              features: [...fixture.factory.descriptor.features],
              build,
              consumer: 'identity-current-authorization-consumer',
              command: request.command,
              status: 'passed',
              attachmentDigest: null,
              fixture: null,
              sharedEvidenceId: null,
              reuse: {
                scope: 'deployment',
                methodKind: scenario === 'normal' ? 'query' : 'ingress',
                lifecycle: scenario === 'cancel' || scenario === 'dispose' ? scenario : 'call',
                undeclaredConnection: false,
              },
              perImplementation: true,
              gate: null,
            }
          } finally {
            await fixture.dispose()
            rmSync(directory, { recursive: true, force: true })
          }
        },
      })
    }
    fixtureHarness.registerCase({
      contract: 'agh.identity',
      scenario: 'recover',
      providerId,
      qualification: 'required',
      async run() {
        const directory = mkdtempSync(join(tmpdir(), 'agnes-identity-tck-'))
        const fixture = await tckFixture(providerId, join(directory, 'owner.sqlite'))
        try {
          await runIdentityContractCase(fixture, 'recover')
          await verifyKilledProcessRecovery(providerId)
          return {
            id: `agh.identity/${providerId}/recover`,
            providerDigest: fixture.factory.descriptor.packageDigest,
            configDigest:
              fixture.config.kind === 'inline' ? fixture.config.digest : fixture.config.blob.digest,
            releaseSetDigest: fixture.releaseSetDigest,
            recipe: 'identity-transport',
            features: [...fixture.factory.descriptor.features],
            build,
            consumer: 'identity-current-authorization-consumer',
            command: request.command,
            status: 'passed',
            diagnostic:
              'Original Identity process killed; fresh process rejected nonce replay and issued a new context',
            attachmentDigest: null,
            fixture: null,
            sharedEvidenceId: null,
            reuse: {
              scope: 'deployment',
              methodKind: 'ingress',
              lifecycle: 'recover',
              undeclaredConnection: false,
            },
            perImplementation: true,
            gate: null,
          }
        } finally {
          await fixture.dispose()
          rmSync(directory, { recursive: true, force: true })
        }
      },
    })
  }
  return { contracts, providers }
}
