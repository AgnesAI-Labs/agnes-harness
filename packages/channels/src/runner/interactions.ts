import { createHash } from 'node:crypto'
import type {
  ApprovalDecideParams,
  ChannelCredential,
  DecisionCommandReceipt,
  UiActionParams,
  UiActionReceipt,
} from '@agnes/protocol'
import { type ChannelAdapter, type ChannelEvent, whitelistCredential } from '../adapter.js'
import { decisionRef } from '../decision.js'
import type { RefStore } from './ref-store.js'

/** Supplied by the registered channel's Host, never by channel plugin configuration. */
export interface InteractionAdmission {
  surface(params: UiActionParams, credential: ChannelCredential): Promise<UiActionReceipt>
  approval(params: ApprovalDecideParams, credential: ChannelCredential): Promise<DecisionCommandReceipt>
}

export async function handleInteraction(input: {
  event: ChannelEvent
  adapter: ChannelAdapter
  refs: RefStore
  admission: InteractionAdmission
  routes: readonly { key: string; sessionId: string }[]
  allowFrom: readonly string[]
  flush(key: string): Promise<void>
}): Promise<boolean> {
  const { event, adapter } = input
  if (event.kind !== 'cardAction') return false
  const surface = adapter.onSurfaceAction?.(event)
  const approval = adapter.onApprovalAction(event)
  if (!surface && (!approval || !('decisionKey' in approval))) return false
  const credential = whitelistCredential(
    adapter.credentialOf(event),
    adapter.manifest.credentials.exposes,
  ).cred
  if (
    !event.eventId ||
    credential.kind !== 'channel' ||
    credential.channel !== adapter.manifest.id ||
    credential.accountId !== event.accountId ||
    credential.userId !== event.sender.userId ||
    credential.chatId !== event.chat.id ||
    !credential.userId ||
    (input.allowFrom.length && !input.allowFrom.includes(credential.userId))
  )
    return true
  const decision = approval && 'decisionKey' in approval ? decisionRef(approval.decisionKey) : undefined
  for (const route of input.routes) {
    if (surface && surface.sessionId !== route.sessionId) continue
    if (decision && decision.sessionId !== route.sessionId) continue
    const delivered = [...input.refs.forSession(route.key, route.sessionId).values()].some(
      (row) =>
        row.complete &&
        row.parts.some(
          (part) =>
            part.accountId === event.accountId &&
            part.ref.chatId === event.chat.id &&
            (part.ref.cardBizId ?? part.ref.messageId) === event.cardBizId &&
            (surface
              ? part.subject?.kind === 'surface' &&
                part.subject.surfaceId === surface.surfaceId &&
                part.subject.revision === surface.revision &&
                part.subject.actionId === surface.actionId
              : approval &&
                'decisionKey' in approval &&
                part.subject?.kind === 'approval' &&
                part.subject.decisionKey === approval.decisionKey),
        ),
    )
    if (!delivered) continue
    const commandId = createHash('sha256')
      .update(
        JSON.stringify([
          adapter.manifest.id,
          event.accountId,
          route.key,
          event.eventId,
          surface ? 'surface' : 'approval',
          credential.userId,
        ]),
      )
      .digest('hex')
    try {
      if (surface) await input.admission.surface({ ...surface, commandId }, credential)
      else if (
        approval &&
        decision &&
        ['allowed-once', 'allowed-session', 'rejected'].includes(approval.verdict)
      )
        await input.admission.approval(
          { ...decision, commandId, response: { option: approval.verdict, value: null } },
          credential,
        )
    } finally {
      await input.flush(route.key)
    }
    return true
  }
  return true
}
