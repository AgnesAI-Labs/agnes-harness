import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAuditContractScenario } from '../../../../packages/extension-api/testkit/runtime/contracts/audit.js'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.js'
import { auditContractDriver } from '../../../../packages/host/test/runtime/audit-conformance-fixture.js'
import { jcs } from '../../../../packages/protocol/src/jcs.js'
import { canonicalJsonDigest } from '../../../../packages/protocol/src/runtime/index.js'
import { getConformanceBuildIdentity, withDeploymentStandIns } from '../build-identity.js'
import type { ConformanceBindRequest } from '../run-conformance.js'

const tested = ['select', 'normal', 'deny', 'cancel', 'dispose'] as const
type ProviderId = 'default' | 'reference'
const coldPath = fileURLToPath(new URL('../fixtures/audit-cold-process.ts', import.meta.url))

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
  let output: { pid: number; priorRows: number; result: unknown }
  try {
    output = await new Promise<{ pid: number; priorRows: number; result: unknown }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Audit cold process timed out: ${stderr}`)), 15_000)
      const read = () => {
        const line = stdout.indexOf('\n')
        if (line < 0) return
        clearTimeout(timer)
        try {
          resolve(
            JSON.parse(stdout.slice(0, line)) as {
              pid: number
              priorRows: number
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
          reject(new Error(`Audit cold process exited ${code}/${signal}: ${stderr}`))
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
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-audit-cold-')))
  let original: Awaited<ReturnType<typeof coldProcess>> | undefined
  try {
    original = await coldProcess(providerId, directory, 'hold')
    original.child.kill('SIGKILL')
    const ended = await original.exited
    if (ended.signal !== 'SIGKILL') throw new Error('Original Audit owner was not killed')
    const recovered = await coldProcess(providerId, directory, 'once')
    const restarted = await recovered.exited
    if (
      restarted.code !== 0 ||
      recovered.output.pid === original.output.pid ||
      original.output.priorRows !== 0 ||
      recovered.output.priorRows !== 1 ||
      jcs(recovered.output.result) !== jcs(original.output.result)
    )
      throw new Error('Independent Audit process did not replay the same durable append')
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
    request.contracts === 'all' || request.contracts.includes('agh.audit') ? ['agh.audit'] : []
  const providers = request.providers.filter((id): id is ProviderId => id === 'default' || id === 'reference')
  if (!contracts.length) return { contracts, providers }
  const build = getConformanceBuildIdentity()
  const fixtureHarness = withDeploymentStandIns(
    harness,
    'Audit authorization and archive: F02 durable fixture',
  )
  for (const providerId of providers) {
    const reference = providerId === 'reference'
    const file = reference
      ? '../../../../examples/runtime-reference/src/providers/audit.ts'
      : '../../../../packages/host/src/runtime/providers/audit.ts'
    const providerDigest = createHash('sha256')
      .update(readFileSync(new URL(file, import.meta.url)))
      .digest('hex')
    for (const scenario of tested) {
      fixtureHarness.registerCase({
        contract: 'agh.audit',
        scenario,
        providerId,
        qualification: 'required',
        async run() {
          const driver = auditContractDriver(reference)
          const fixture = await driver.open()
          const configDigest =
            fixture.configuration.kind === 'inline'
              ? fixture.configuration.digest
              : fixture.configuration.blob.digest
          await driver.close()
          const rows = await runAuditContractScenario(auditContractDriver(reference), scenario)
          if (rows.length === 0 || rows.some((row) => !row.passed)) throw new Error('Audit TCK did not pass')
          return {
            id: `agh.audit/${providerId}/${scenario}`,
            providerDigest,
            configDigest,
            recipe: 'durable-audit-public-provider',
            features: [],
            build,
            consumer: 'audit-public-consumer',
            command: request.command,
            status: 'passed',
            releaseSetDigest: build.buildDigest,
            attachmentDigest: canonicalJsonDigest(rows.map((row) => ({ id: row.id, passed: row.passed }))),
            fixture: null,
            sharedEvidenceId: null,
            reuse: {
              scope: 'workspace',
              methodKind: scenario === 'select' ? 'descriptor' : 'control+action',
              lifecycle: scenario === 'cancel' || scenario === 'dispose' ? scenario : 'call',
              undeclaredConnection: false,
            },
            perImplementation: true,
            gate: null,
          }
        },
      })
    }
    fixtureHarness.registerCase({
      contract: 'agh.audit',
      scenario: 'recover',
      providerId,
      qualification: 'required',
      async run() {
        const driver = auditContractDriver(reference)
        const fixture = await driver.open()
        const configDigest =
          fixture.configuration.kind === 'inline'
            ? fixture.configuration.digest
            : fixture.configuration.blob.digest
        await driver.close()
        const rows = await runAuditContractScenario(auditContractDriver(reference), 'recover')
        if (rows.length === 0 || rows.some((row) => !row.passed))
          throw new Error('Audit recovery TCK did not pass')
        await verifyKilledProcessRecovery(providerId)
        return {
          id: `agh.audit/${providerId}/recover`,
          providerDigest,
          configDigest,
          recipe: 'durable-audit-public-provider',
          features: [],
          build,
          consumer: 'audit-public-consumer',
          command: request.command,
          status: 'passed',
          diagnostic: 'Original Audit process killed; fresh process replayed the same SQLite append receipt',
          releaseSetDigest: build.buildDigest,
          attachmentDigest: null,
          fixture: null,
          sharedEvidenceId: null,
          reuse: {
            scope: 'workspace',
            methodKind: 'control+action',
            lifecycle: 'recover',
            undeclaredConnection: false,
          },
          perImplementation: true,
          gate: null,
        }
      },
    })
  }
  return { contracts, providers }
}
