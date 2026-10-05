import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReferenceContextFactory } from '../../../../examples/runtime-reference/src/providers/context.js'
import { createContextFactory } from '../../../../packages/core/src/runtime/providers/context.js'
import type { Outcome } from '../../../../packages/extension-api/src/runtime/index.js'
import {
  type ContextContractFixture,
  contextFixtureData,
  registerContextContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/context.js'
import {
  type ConformanceHarness,
  createTestServiceContainer,
} from '../../../../packages/extension-api/testkit/runtime/harness.js'
import {
  canonicalJsonDigest,
  type JsonValue,
  type QueryReply,
} from '../../../../packages/protocol/src/runtime/index.js'
import { getConformanceBuildIdentity } from '../build-identity.js'

type ProviderId = 'default' | 'reference'
type ChildOutput = { pid: number; reply: Outcome<QueryReply> }
const coldPath = fileURLToPath(new URL('../fixtures/context-cold-process.ts', import.meta.url))

/** Public TCK fixture only: it never installs or manufactures a production source owner. */
export async function openContextFixture(id: ProviderId): Promise<ContextContractFixture> {
  const data = contextFixtureData(id === 'default' ? 'agh.default/context' : 'reference/context')
  const implementation =
    id === 'default'
      ? 'packages/core/src/runtime/providers/context.ts'
      : 'examples/runtime-reference/src/providers/context.ts'
  data.descriptor.packageDigest = createHash('sha256')
    .update(readFileSync(new URL(`../../../../${implementation}`, import.meta.url)))
    .digest('hex')
  const sourceDigest = () => canonicalJsonDigest(data.source as unknown as JsonValue)
  const originalDigest = sourceDigest()
  let allowed = true
  const factory = (id === 'default' ? createContextFactory : createReferenceContextFactory)({
    ...data,
    deployment: {
      capture: () => ({ ok: true, value: data.source }),
      checkCurrent: () => allowed,
      sourceCurrent: (source) =>
        allowed && canonicalJsonDigest(source as unknown as JsonValue) === originalDigest,
    },
  })
  return {
    ...data,
    factory,
    dependencies: createTestServiceContainer().dependencies,
    sourceDigest,
    revoke() {
      allowed = false
    },
    async cold() {
      const taskTmpRoot = realpathSync(tmpdir())
      const directory = realpathSync(mkdtempSync(join(taskTmpRoot, 'agnes-context-cold-')))
      if (dirname(directory) !== taskTmpRoot) throw new Error('Context temporary directory escaped its root')
      const snapshot = join(directory, 'fixed-input.json')
      writeFileSync(snapshot, JSON.stringify({ request: data.request, source: data.source }), {
        mode: 0o600,
      })
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', coldPath, id, snapshot, 'hold', allowed ? 'allow' : 'deny'],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      )
      let buffer = '',
        errorText = ''
      child.stderr.on('data', (chunk) => {
        errorText += chunk.toString()
      })
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once('error', reject)
          child.once('close', (code, signal) => resolve({ code, signal }))
        },
      )
      const readiness = new Promise<ChildOutput>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Context process readiness timeout: ${errorText}`)),
          15_000,
        )
        child.stdout.on('data', (chunk) => {
          buffer += chunk.toString()
          const line = buffer.indexOf('\n')
          if (line < 0) return
          clearTimeout(timer)
          try {
            resolve(JSON.parse(buffer.slice(0, line)) as ChildOutput)
          } catch (error) {
            reject(error)
          }
        })
        child.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.once('close', (code) => {
          clearTimeout(timer)
          if (!buffer.includes('\n'))
            reject(new Error(`Context process exited before query: ${code} ${errorText}`))
        })
      })
      try {
        const first = await readiness
        if (!child.kill('SIGKILL')) throw new Error('Context worker was not killed')
        const killed = await exited
        if (killed.signal !== 'SIGKILL')
          throw new Error(`Context worker kill not confirmed: ${killed.code}/${killed.signal}`)
        const restored = spawnSync(
          process.execPath,
          ['--import', 'tsx', coldPath, id, snapshot, 'once', 'allow'],
          {
            encoding: 'utf8',
            timeout: 30_000,
            windowsHide: true,
          },
        )
        if (restored.error || restored.status !== 0)
          throw new Error(`Context cold restart failed: ${restored.stderr}`, { cause: restored.error })
        const next = JSON.parse(restored.stdout) as ChildOutput
        const denied = spawnSync(
          process.execPath,
          ['--import', 'tsx', coldPath, id, snapshot, 'once', 'deny'],
          {
            encoding: 'utf8',
            timeout: 30_000,
            windowsHide: true,
          },
        )
        if (denied.error || denied.status !== 0)
          throw new Error(`Context revoked restart failed: ${denied.stderr}`, { cause: denied.error })
        const revoked = JSON.parse(denied.stdout) as ChildOutput
        return {
          first: first.reply,
          reply: next.reply,
          killedPid: first.pid,
          restoredPid: next.pid,
          revokedReply: revoked.reply,
          revokedPid: revoked.pid,
          signal: 'SIGKILL',
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await exited.catch(() => undefined)
        rmSync(directory, { recursive: true, force: true })
      }
    },
    async close() {},
  }
}
export async function bindConformance(
  harness: ConformanceHarness,
  request: { command: string; contracts: readonly string[] | 'all'; providers: readonly string[] },
) {
  if (request.contracts !== 'all' && !request.contracts.includes('agh.context'))
    return { contracts: [], providers: [] }
  const providers = request.providers.filter((id): id is ProviderId => id === 'default' || id === 'reference')
  for (const providerId of providers)
    registerContextContract(harness, {
      providerId,
      command: request.command,
      build: getConformanceBuildIdentity(),
      open: () => openContextFixture(providerId),
    })
  return { contracts: ['agh.context'], providers }
}
