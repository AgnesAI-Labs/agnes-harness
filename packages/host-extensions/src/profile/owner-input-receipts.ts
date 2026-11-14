import type { ManagedInputResult, ManagedSessions } from '@agnes/extension-api'
import type { ChannelReceipts } from './channel-receipts.js'
import type { ChannelTarget } from './channel-targets.js'
import type { HostInputResolutionWire, HostManagedSessions } from './managed-sessions.js'

/** States whose daemon record holds the receipt's text, so the Host receipt is no longer needed. */
const RECORDED = new Set<ManagedInputResult['state']>([
  'enqueued',
  'consumed',
  'retained',
  'needsOwner',
  'waitingQuestion',
  'recoveryUnknown',
])

/**
 * The sessions port a plugin receives: exactly the `ManagedSessions` methods, never `admitResolved`. An
 * `ownerMessage` is resolved from `target`'s own receipts while their pairing is current, and the text
 * travels to the daemon beside the plugin's arguments, never inside them.
 */
export function withOwnerReceipts(
  sessions: HostManagedSessions,
  receipts: ChannelReceipts | undefined,
  target: ChannelTarget,
): ManagedSessions {
  return {
    start: (input) => sessions.start(input),
    send: (sessionId, input) => sessions.send(sessionId, input),
    list: () => sessions.list(),
    status: (sessionId) => sessions.status(sessionId),
    events: (sessionId, options) => sessions.events(sessionId, options),
    result: (sessionId) => sessions.result(sessionId),
    usage: (sessionId) => sessions.usage(sessionId),
    toolResult: (sessionId, callSeq) => sessions.toolResult(sessionId, callSeq),
    interrupt: (sessionId) => sessions.interrupt(sessionId),
    archive: (sessionId) => sessions.archive(sessionId),
    inputResult: (sessionId, input) => sessions.inputResult(sessionId, input),
    admitInput: async (sessionId, input) => {
      const admission = (input as { input?: unknown } | null | undefined)?.input as
        | { kind?: unknown; receiptId?: unknown }
        | undefined
      if (admission?.kind !== 'ownerMessage' || typeof admission.receiptId !== 'string')
        return sessions.admitInput(sessionId, input)
      const receiptId = admission.receiptId
      const resolution: HostInputResolutionWire = receipts?.resolve(target, receiptId) ?? {
        kind: 'unresolved',
        receiptId,
        reason: 'receiptUnknown',
      }
      const result = await sessions.admitResolved(sessionId, input, resolution)
      if (resolution.kind === 'receipt' && RECORDED.has(result.state))
        receipts?.admitted(target.owner, receiptId)
      return result
    },
  }
}
