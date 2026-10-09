import type { UiActionReceipt, UiReadResult } from '@agnes/protocol/gen/intelligent-ui'
import type { Client, Session } from '@agnes/sdk/browser'
import type { IntelligentUiServer } from './types.js'

export function intelligentUiServer(client: Client, session: Session): IntelligentUiServer {
  let recoveryNotice = () => {}
  return {
    read: (params) => client.call<UiReadResult>('_agnes/v1/ui.read', params),
    action: (params) => client.call<UiActionReceipt>('_agnes/v1/ui.action', params),
    listen(onEvent, onGap) {
      recoveryNotice = onGap
      const listener: Parameters<typeof session.listeners.add>[0] = (method, params) => {
        if (method !== '_agnes/v1/session.event') return
        const event = params.event
        if (
          !event ||
          typeof event !== 'object' ||
          !('seq' in event) ||
          !('type' in event) ||
          typeof event.seq !== 'number' ||
          typeof event.type !== 'string'
        )
          return
        onEvent({ seq: event.seq, type: event.type })
      }
      session.listeners.add(listener)
      const stops = ['reconnecting', 'reconnected', 'closed', 'gap', 'generationChanged'] as const
      const off = stops.map((name) =>
        client.on(name, (payload) => {
          if (name === 'gap' || name === 'generationChanged') {
            if (
              !payload ||
              typeof payload !== 'object' ||
              !('sessionId' in payload) ||
              payload.sessionId !== session.id
            )
              return
          }
          onGap()
        }),
      )
      return () => {
        session.listeners.delete(listener)
        for (const stop of off) stop()
        recoveryNotice = () => {}
      }
    },
    async attach(afterSeq) {
      // The conversation owns the shared full event subscription. Never replace its filter or
      // advance its admitted cursor to the UI watermark: that could drop conversation facts.
      if (!session.attached) await session.attach({ filter: session.filter })
      // An initial attach without a generation may start after our read. Re-read its high water
      // mark rather than claiming that the missing interval is empty.
      if (session.lastServerSeq > afterSeq) recoveryNotice()
    },
  }
}
