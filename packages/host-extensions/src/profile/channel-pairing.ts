import { decisionSubjectDigest } from '@agnes/core'
import type { DecisionSnapshot } from '@agnes/extension-api'
import type { Actor, DecisionSpec, JsonValue, ProfileServiceReceipt } from '@agnes/protocol'
import { rpcError } from '@agnes/protocol'
import type { ChannelInstanceRef, ChannelTarget, ChannelTargets } from './channel-targets.js'
import { HOST_DECISION_ACTIVATION, type HostDecisionOwner } from './host-decisions.js'
import type { ProfileJournal, ProfileOperation } from './journal.js'

/** The owner name pairing approvals carry in the profile decision journal. */
export const CHANNEL_PAIRING_OWNER = 'core/channel-pairing'
const SERVICE = 'pairing-code'
const APPROVAL_TTL_MS = 600_000
const source = (operationId: string) => ({
  owner: CHANNEL_PAIRING_OWNER,
  operationId,
  sourcePackage: 'host',
  packageVersion: '1',
  alive() {},
})

type Request = { instance: ChannelInstanceRef; target: ChannelTarget }
type Waiting = Request & { expiresAt: number }
export type ChannelMintResult = { receipt: ProfileServiceReceipt; code?: string; expiresAt?: number }

function waitingOf(operation: ProfileOperation): Waiting | undefined {
  const value = operation.prepared as Partial<Waiting> | null
  if (
    operation.owner !== CHANNEL_PAIRING_OWNER ||
    operation.service !== SERVICE ||
    typeof value?.expiresAt !== 'number' ||
    typeof value.instance?.channel !== 'string' ||
    typeof value.instance.instanceId !== 'string' ||
    typeof value.target?.owner !== 'string' ||
    typeof value.target.service !== 'string'
  )
    return undefined
  return structuredClone(value as Waiting)
}

const approved = (snapshot: DecisionSnapshot) =>
  !snapshot.invalidation &&
  !snapshot.consumption &&
  snapshot.result?.reason === 'answered' &&
  snapshot.result.response.option === 'allowed-once'

/**
 * Minting a pairing code requires a person's approval. The request waits in the profile decision journal
 * beside the plugin services' approvals and is answered in the same place. The approved caller repeats
 * the request with the same operation id; that call consumes the approval and returns the code once. The
 * journal never holds the code: it lives only in Host memory, as a digest.
 */
export function createChannelPairingApprovals(deps: {
  targets: ChannelTargets
  /** The profile decision journal and the person its decisions are asked of; late-bound by the Host. */
  decisions(): Promise<{ journal: ProfileJournal; actor: Actor }>
  clock(): number
}): { owner: HostDecisionOwner; mint(request: Request, operationId: string): Promise<ChannelMintResult> } {
  const stands = (waiting: Waiting) =>
    deps.clock() < waiting.expiresAt && !deps.targets.mintRefusal(waiting.instance, waiting.target)
  const finish = (journal: ProfileJournal, operation: ProfileOperation, receipt: ProfileServiceReceipt) =>
    journal.write({ ...operation, receipt })

  /** The one place that decides whether a pairing code may be minted. */
  const authorizeMint = async (request: Request, operationId: string): Promise<ChannelMintResult> => {
    const { journal, actor } = await deps.decisions()
    const decisions = journal.decisions(actor, APPROVAL_TTL_MS)
    const key = decisionSubjectDigest({ owner: CHANNEL_PAIRING_OWNER, operationId })
    const input = request as unknown as JsonValue
    const requestDigest = decisionSubjectDigest({ service: SERVICE, input })
    const existing = journal.operations.get(key)
    if (existing && existing.requestDigest !== requestDigest)
      throw rpcError('SEMANTIC_REJECTED', { code: 'ID_CONFLICT' })
    if (!existing) {
      const refusal = deps.targets.mintRefusal(request.instance, request.target)
      if (refusal) throw rpcError('SEMANTIC_REJECTED', { code: refusal })
      const waiting: Waiting = { ...request, expiresAt: deps.clock() + APPROVAL_TTL_MS }
      // Requesting takes the journal's writer gate itself, so it runs before `locked`.
      const decision = await decisions.port(source(operationId)).request(specFor(operationId, request))
      const operation: ProfileOperation = {
        key,
        control: null,
        requestDigest,
        digest: decisionSubjectDigest({ owner: CHANNEL_PAIRING_OWNER, input, prepared: waiting }),
        actorId: actor.id,
        owner: CHANNEL_PAIRING_OWNER,
        service: SERVICE,
        source: 'channel-page',
        activationId: HOST_DECISION_ACTIVATION,
        receipt: { state: 'approval-required', operationId, decision },
        input,
        prepared: waiting as unknown as JsonValue,
      }
      await journal.locked(async () => {
        if (!journal.operations.has(key)) await journal.write(operation)
      })
      return { receipt: structuredClone((journal.operations.get(key) ?? operation).receipt) }
    }
    const handle = existing.receipt.decision
    if (existing.receipt.state !== 'approval-required' || !handle)
      return { receipt: structuredClone(existing.receipt) }
    const snapshot = await decisions.port(source(operationId)).get(handle)
    return journal.locked(async () => {
      const current = journal.operations.get(key)
      const waiting = current && waitingOf(current)
      if (!current || current.receipt.state !== 'approval-required' || !waiting)
        return { receipt: structuredClone((current ?? existing).receipt) }
      if (!snapshot.result && !snapshot.invalidation && !snapshot.consumption)
        return stands(waiting)
          ? { receipt: structuredClone(current.receipt) }
          : refuse(current, 'APPROVAL_WITHDRAWN')
      if (!approved(snapshot))
        return refuse(
          current,
          snapshot.result?.reason === 'answered' ? 'APPROVAL_REFUSED' : 'APPROVAL_WITHDRAWN',
        )
      if (!stands(waiting)) return refuse(current, 'APPROVAL_WITHDRAWN')
      const minted = deps.targets.mint(waiting.instance, waiting.target)
      const receipt: ProfileServiceReceipt = {
        state: 'completed',
        operationId,
        output: { expiresAt: minted.expiresAt },
      }
      await journal.write(
        { ...current, receipt },
        decisions.consumptionEvents([handle], source(operationId), operationId),
      )
      return { receipt, ...minted }
    })

    async function refuse(operation: ProfileOperation, code: string): Promise<ChannelMintResult> {
      const receipt: ProfileServiceReceipt = { state: 'refused', operationId, code }
      await finish(journal, operation, receipt)
      return { receipt }
    }
  }

  const owner: HostDecisionOwner = {
    alive(operation) {
      const waiting = waitingOf(operation)
      return !!waiting && stands(waiting)
    },
    // Approval is consumed by the caller's repeated request; only a rejection or withdrawal settles here.
    async answered(operation, decision) {
      if (approved(decision)) return
      const { journal } = await deps.decisions()
      await journal.locked(async () => {
        const current = journal.operations.get(operation.key)
        if (current?.receipt.state !== 'approval-required') return
        const code = decision.result?.reason === 'answered' ? 'APPROVAL_REFUSED' : 'APPROVAL_WITHDRAWN'
        await finish(journal, current, { state: 'refused', operationId: current.receipt.operationId, code })
      })
    },
  }
  return { owner, mint: authorizeMint }
}

function specFor(operationId: string, request: Request): DecisionSpec {
  const packageId = request.target.owner.slice(0, request.target.owner.indexOf('#'))
  const fields = (labels: { instance: string; plugin: string; service: string }) => [
    { label: labels.instance, value: request.instance.instanceId },
    { label: labels.plugin, value: packageId },
    { label: labels.service, value: request.target.service },
  ]
  return {
    key: operationId,
    purpose: 'channel.pairing',
    subject: { instance: request.instance, target: request.target },
    prompt:
      'Create a one-time pairing code? Whoever sends it to the bot in a direct message within an hour becomes the owner the plugin service receives messages from and sends messages to.',
    options: ['allowed-once', 'rejected'],
    responseSchema: { type: 'null' },
    presentation: {
      en: {
        title: 'Create a channel pairing code',
        fields: fields({ instance: 'Channel instance', plugin: 'Plugin', service: 'Service' }),
      },
      'zh-CN': {
        title: '生成渠道配对码',
        fields: fields({ instance: '渠道实例', plugin: '插件', service: '服务' }),
      },
    },
  }
}
