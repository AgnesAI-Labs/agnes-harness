import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
      ].map(code)
      await current.flush(deliverTo(inbox))
      return { refusals, record: must(current.read(interactionId)), woken: seen.woken }
    },
    async cancel({ inbox }) {
      const asked = [ask('port-cancel'), ask('port-expire', { expiresAt: '2026-10-02T00:00:00Z' })]
      const seen = asked.map((record) => waiter(inbox, `${record.interactionId}@2`))
      const [first, second] = asked.map((record) => record.interactionId)
      must(current.cancel({ interactionId: first, expectedVersion: 1, reason: 'run aborted' }))
      at = '2026-10-02T00:00:00Z'
      must(current.expire({ interactionId: second, expectedVersion: 1, reason: 'timed out' }))
      restart()
      await current.flush(deliverTo(inbox))
      const records = asked.map((record) => must(current.read(record.interactionId)))
      return { records, woken: seen.reduce((sum, item) => sum + item.woken, 0) }
    },
    async recover({ inbox }) {
      const { interactionId } = ask('port-recover')
      const key = `${interactionId}@2`
      const seen = waiter(inbox, key)
      must(current.respond(approve(interactionId, { responseId: 'port-recover' })))
      // The wake reached the inbox, but the process stopped before the acknowledgement was stored.
      inbox.notify(key)
      restart()
      const statuses = [status('port-recover')]
      const pendingWakes = current.wakes().filter((state) => state.delivery === 'pending').length
      await current.flush(deliverTo(inbox))
      statuses.push(status('port-recover'))
      return { record: must(current.read(interactionId)), statuses, pendingWakes, woken: seen.woken }
    },
    async dispose() {
      current.close()
      let refused = false
      try {
        current.read('port-1')
      } catch (error) {
        refused = error instanceof Error && error.message === 'interaction store is closed'
      }
      return { refused, storeRemains: existsSync(databasePath) }
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
