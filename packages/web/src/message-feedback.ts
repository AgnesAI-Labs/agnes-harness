import type { UINode, UITurn } from '@agnes/protocol'
import type { SessionService } from '@agnes/web-client'
import { factChainLinks, workbenchNavigation } from '@agnes/web-client'
import { MessageFeedback } from '@agnes/web-units/message-feedback'
import { createElement } from 'react'
import { createAntdRoot } from '@agnes/web-ui'

/** This root belongs to one persisted assistant node and retires with the timeline entry. */
export function mountMessageFeedback(element: HTMLElement, session: SessionService | undefined) {
  const host = document.createElement('div')
  element.append(host)
  const root = createAntdRoot(host)
  let previous = ''
  return {
    update(node: UINode, turns: readonly UITurn[] | undefined) {
      if (node.kind !== 'assistant') return
      const sessionId = session?.getSnapshot()
      const turn = turns?.find((turn) => turn.nodeIds.includes(node.id))
      const ready =
        sessionId &&
        turn &&
        turn.status !== 'running' &&
        turn.status !== 'waiting' &&
        !turn.inherited &&
        !node.streaming &&
        node.seq > 0
      const key = JSON.stringify([sessionId, node.seq, turn?.turn, ready])
      if (key === previous) return
      previous = key
      root.render(
        ready
          ? createElement(MessageFeedback, {
              key,
              sessionId,
              target: { messageSeq: node.seq, turn: turn.turn },
              openEvidence(candidateId) {
                if (
                  !factChainLinks.open({
                    sessionId,
                    laneId: 'main',
                    anchor: { kind: 'authoring', candidateId },
                  })
                )
                  workbenchNavigation.open('facts')
              },
            })
          : null,
      )
    },
    dispose() {
      queueMicrotask(() => root.unmount())
    },
  }
}
