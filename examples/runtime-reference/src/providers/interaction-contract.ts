import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Outcome } from '@agnes/extension-api/runtime'
import {
  type BuildIdentity,
  type ConformanceHarness,
  providerFileForContract,
  type RuntimeInboxFixture,
} from '@agnes/extension-api/testkit'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest, computeApprovalIntentDigest } from '@agnes/protocol/runtime'
import {
  type InteractionContractPort,
  registerInteractionContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/interaction.js'
import {
  INTERACTION_PROVIDER,
  type InteractionEvidence,
  openInteractionStore,
  type WakeSink,
} from './interaction.js'

export const inline = (
  schema: Wire.SchemaRef,
  value: Wire.JsonValue,
): Extract<Wire.DataRef, { kind: 'inline' }> => ({
  kind: 'inline',
  schema,
  value,
  digest: canonicalJsonDigest(value),
  bytes: new TextEncoder().encode(JSON.stringify(value)).length,
})

export const human: InteractionEvidence = {
  kind: 'human',
  authenticationRef: inline(
    { typeId: 'acme.identity/login@1', revision: 1, digest: 'a'.repeat(64) },
    { s: 1 },
  ),
}
export const owner = { runId: 'run-1', actionId: 'action-1' }

export function approvalRequest(overrides: Record<string, unknown> = {}) {
  const base = {
    kind: 'approval',
    title: 'Delete build output',
    body: 'rm -rf dist',
    actionRef: 'action-7',
    inputDigest: 'b'.repeat(64),
    policyDecisionRef: 'policy-3',
    scope: { kind: 'workspace', installationId: 'i1', runtimeId: 'r1', workspaceId: 'w1' },
    allowedResponders: ['alice'],
    allowedGrantScopes: ['once', 'session'],
    expiresAt: '2026-10-08T00:00:00Z',
    idempotencyKey: 'ask-1',
    risk: 'destructive',
    intentDigest: '0'.repeat(64),
    ...overrides,
  }
  const digest = computeApprovalIntentDigest(base)
  if (!digest.ok) throw new Error('fixture is not an approval request')
  return { ...base, intentDigest: digest.value }
}

export const approve = (interactionId: string, extra: Record<string, unknown> = {}) => ({
  method: 'respondApproval' as const,
  actorRef: 'alice',
  evidence: human,
  request: {
    interactionId,
    responseId: 'resp-1',
    expectedVersion: 1,
    decision: 'approve',
    intentDigest: approvalRequest().intentDigest,
    ...extra,
  },
})

export const code = (outcome: Outcome<unknown>) => (outcome.ok ? null : outcome.error.detailCode)

export function must<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(outcome.error.message)
  return outcome.value
}

export const deliverTo =
  (inbox: RuntimeInboxFixture): WakeSink =>
  async (wake) => ({ ok: true, value: { deliveryId: inbox.notify(wake.deliveryKey).deliveryId } })

export function waiter(inbox: RuntimeInboxFixture, deliveryKey: string) {
  const seen = { woken: 0 }
  inbox.registerWaiter(deliveryKey, () => void seen.woken++)
  return seen
}

const sha256 = (url: URL) => createHash('sha256').update(readFileSync(url)).digest('hex')

const build: BuildIdentity = {
  codeSha: 'reference-code',
  buildDigest: 'reference-build',
  lockDigest: 'reference-lock',
  specVersion: 'reference-spec',
  sdkVersion: 'reference-sdk',
  sdkDigest: 'reference-sdk-digest',
  platform: 'reference-platform',
}

const provider = fileURLToPath(new URL('./interaction.ts', import.meta.url))
const root = fileURLToPath(new URL('../../../..', import.meta.url))

type Killed = { signal: string | null; pid: number | null; stdout: string; stderr: string }

/**
 * Runs one provider CLI command (the interaction provider unless `script` names another) and kills it
 * with SIGKILL the first time `ready` accepts its output. Settles only once the child's pipes have closed,
 * so neither the process nor its handles outlive the call; a child that never gets ready is killed after
 * 15 seconds and the call rejects.
 */
export function killWhenReady(
  args: readonly string[],
  ready: (stdout: string) => boolean,
  script = provider,
): Promise<Killed> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let killed = false
    let timedOut = false
    const kill = () => {
      killed = true
      child.kill('SIGKILL')
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, 15_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (!killed && ready(stdout)) kill()
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (_code, signal) => {
      clearTimeout(timer)
      if (timedOut) reject(new Error(`provider child timed out\n${stderr}\n${stdout}`))
      else resolve({ signal, pid: child.pid ?? null, stdout, stderr })
    })
  })
}

/** Open descriptors of this process, or null where there is no `/dev/fd` to list them (Windows). */
const openHandles = () => (existsSync('/dev/fd') ? readdirSync('/dev/fd').length : null)

/** Drives the reference store through the six scenarios; the contract module judges what it reports. */
export function referenceInteractionPort(
  databasePath: string,
  providerId: string = INTERACTION_PROVIDER.id,
): {
  port: InteractionContractPort
  close(): void
} {
  let at = '2026-10-01T00:00:00Z'
  let next = 0
  const options = { clock: { now: () => at, newId: () => `port-${++next}` } }
  let current = openInteractionStore(databasePath, options)
  const ask = (idempotencyKey: string, extra: Record<string, unknown> = {}) =>
    must(current.request({ request: approvalRequest({ idempotencyKey, ...extra }), owner }))
  const status = (responseId: string) => must(current.responseStatus(responseId)).status
  const restart = () => {
    current.close()
    current = openInteractionStore(databasePath, options)
  }
  const port: InteractionContractPort = {
    async select() {
      return {
        binding: {
          requirement: {
            contract: 'agh.interaction',
            major: 1,
            logicalName: 'interaction',
            features: [],
            scope: 'run',
            optional: false,
          },
          binding: {
            bindingId: 'reference-interaction',
            contract: 'agh.interaction',
            logicalName: 'interaction',
            providerId,
          },
        },
      }
    },
    async normal({ inbox }) {
      const { interactionId } = ask('port-normal')
      const seen = waiter(inbox, `${interactionId}@2`)
      const answer = approve(interactionId, { responseId: 'port-normal' })
      const statuses = [current.respond(answer), current.respond(answer)].map((o) =>
        o.ok ? o.value.status : '',
      )
      await current.flush(deliverTo(inbox))
      await current.flush(deliverTo(inbox))
      statuses.push(status('port-normal'))
      return { statuses, record: must(current.read(interactionId)), woken: seen.woken }
    },
    async deny({ inbox }) {
      const { interactionId } = ask('port-deny')
      const seen = waiter(inbox, `${interactionId}@2`)
      const refusals = [
        current.respond({ ...approve(interactionId, { responseId: 'deny-1' }), actorRef: 'mallory' }),
        current.respond(approve(interactionId, { responseId: 'deny-2', intentDigest: 'e'.repeat(64) })),
        current.respond(approve(interactionId, { responseId: 'deny-3', expectedVersion: 7 })),
        current.respond(approve(interactionId, { responseId: 'deny-4', unknownField: true })),
        current.respond(approve(interactionId, { responseId: 'deny-5', grantScope: 'permanent' })),
      ].map(code)
      await current.flush(deliverTo(inbox))
      return { refusals, record: must(current.read(interactionId)), woken: seen.woken }
    },
    async cancel({ inbox }) {
      const due = { expiresAt: '2026-10-02T00:00:00Z' }
      const asked = ['port-cancel', 'port-expire', 'port-overdue'].map((key) => ask(key, due))
      // Counts a wake for any later version, including one a wrongly accepted late answer would add.
      const seen = asked.flatMap(({ interactionId }) =>
        [2, 3].map((version) => waiter(inbox, `${interactionId}@${version}`)),
      )
      const [first, second] = asked.map((record) => record.interactionId)
      must(current.cancel({ interactionId: first, expectedVersion: 1, reason: 'run aborted' }))
      at = '2026-10-02T00:00:00Z'
      must(current.expire({ interactionId: second, expectedVersion: 1, reason: 'timed out' }))
      // Answers from a client that has not seen the change; the third is due but was never expired.
      const { intentDigest } = approvalRequest(due)
      const refusals = asked.map(({ interactionId }) =>
        code(current.respond(approve(interactionId, { responseId: `late-${interactionId}`, intentDigest }))),
      )
      restart()
      await current.flush(deliverTo(inbox))
      return {
        records: asked.map(({ interactionId }) => must(current.read(interactionId))),
        refusals,
        statuses: asked.map(({ interactionId }) => status(`late-${interactionId}`)),
        woken: seen.reduce((sum, item) => sum + item.woken, 0),
      }
    },
    async recover({ inbox }) {
      // A store of its own: the provider processes run on the wall clock, not on this port's clock.
      const file = `${databasePath}.recover`
      const held = await killWhenReady(['hold', file], (stdout) => stdout.includes('\n'))
      const [, committed, uncommitted] = /^READY (\S+) (\S+)\n$/.exec(held.stdout) ?? []
      if (committed === undefined || uncommitted === undefined)
        throw new Error(`interaction child did not get ready\n${held.stderr}`)
      const key = `${committed}@2`
      const seen = waiter(inbox, key)
      let delivered = 0
      const delivering = await killWhenReady(['deliver', file], (stdout) => {
        if (!stdout.includes(`DELIVERED ${key}\n`)) return false
        // The wake reached the inbox; the process dies before it records the acknowledgement.
        inbox.notify(key)
        delivered++
        return true
      })
      const store = openInteractionStore(file)
      try {
        const relay = deliverTo(inbox)
        const sink: WakeSink = (wake) => {
          delivered++
          return relay(wake)
        }
        const statuses = [must(store.responseStatus('resp-a')).status]
        const pendingWakes = store.wakes().filter((state) => state.delivery === 'pending').length
        await store.flush(sink)
        await store.flush(sink)
        statuses.push(must(store.responseStatus('resp-a')).status)
        return {
          kills: [held, delivering].map(({ signal, pid }) => ({ signal, pid })),
          record: must(store.read(committed)),
          uncommitted: must(store.read(uncommitted)),
          uncommittedStatus: must(store.responseStatus('resp-b')).status,
          statuses,
          pendingWakes,
          delivered,
          woken: seen.woken,
        }
      } finally {
        store.close()
      }
    },
    async dispose() {
      current.close()
      let refused = false
      try {
        current.read('port-1')
      } catch (error) {
        refused = error instanceof Error && error.message === 'interaction store is closed'
      }
      const garbage = `${databasePath}.garbage`
      writeFileSync(garbage, 'not an interaction store\n'.repeat(200))
      // Counted synchronously; no child process or file operation from an earlier scenario is open.
      const baseline = openHandles()
      let mountRefused = false
      try {
        openInteractionStore(garbage, options).close()
      } catch {
        mountRefused = true
      }
      const afterFailedMount = openHandles()
      openInteractionStore(databasePath, options).close()
      const afterClose = openHandles()
      return {
        refused,
        storeRemains: existsSync(databasePath),
        mountRefused,
        handles: { baseline, afterFailedMount, afterClose },
      }
    },
  }
  return { port, close: () => current.close() }
}

/**
 * Registers the six interaction cases for the reference provider on a fresh database, reported under
 * `providerId` (the runner passes the name it was asked for, such as `reference`). `change` lets a
 * test break one scenario to prove the contract notices. Call `close` after the harness has run.
 */
export function bindInteractionContract(
  harness: ConformanceHarness,
  command: string,
  options: Readonly<{
    providerId?: string
    change?: (port: InteractionContractPort) => InteractionContractPort
  }> = {},
): { close(): void } {
  const providerId = options.providerId ?? INTERACTION_PROVIDER.id
  const directory = mkdtempSync(join(tmpdir(), 'reference-interaction-contract-'))
  const reference = referenceInteractionPort(join(directory, 'contract.sqlite'), providerId)
  registerInteractionContract(harness, {
    providerId,
    recipe: providerFileForContract('agh.interaction'),
    command,
    build,
    providerDigest: sha256(new URL('./interaction.ts', import.meta.url)),
    configDigest: canonicalJsonDigest({ maxFailures: 20, batch: 100 }),
    releaseSetDigest: sha256(new URL('../../package.json', import.meta.url)),
    port: options.change ? options.change(reference.port) : reference.port,
  })
  return {
    close() {
      reference.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}
