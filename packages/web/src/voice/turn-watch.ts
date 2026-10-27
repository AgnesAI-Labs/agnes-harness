import type { UINode, UITurn } from '@agnes/protocol'

export type TurnOutcome =
  | { kind: 'reply'; turnId: string; nodeId: string; text: string }
  | { kind: 'no-reply'; turnId: string; status: UITurn['status'] }

interface Baseline {
  key: string
  busy: boolean
  final: string | undefined
  lastId: string | undefined
  signature: string
}

const isBusy = (turn: UITurn | undefined): boolean => turn?.status === 'running' || turn?.status === 'waiting'

/**
 * Watches the viewed conversation and reports when a turn that was seen running (or first seen after the
 * baseline) finishes: once, with its final reply text. The first observation of a session and epoch only sets
 * the baseline, so history loads, re-opens and reconnects never report. Updates that leave the last turn's
 * signature unchanged (cost rows) are ignored.
 */
export class TurnWatch {
  private state: Baseline | undefined

  observe(
    scope: { sessionId: string; epoch: number },
    nodes: readonly UINode[],
    turns: readonly UITurn[],
  ): TurnOutcome | undefined {
    const key = `${scope.sessionId}:${scope.epoch}`
    const last = turns.at(-1)
    const final = last?.finalAssistantId ? nodes.find((node) => node.id === last.finalAssistantId) : undefined
    const signature = JSON.stringify([
      last?.id,
      last?.status,
      last?.finalAssistantId,
      final?.kind === 'assistant' ? final.streaming : undefined,
    ])
    const state = this.state
    if (!state || state.key !== key) {
      this.state = { key, busy: isBusy(last), final: last?.finalAssistantId, lastId: last?.id, signature }
      return undefined
    }
    if (state.signature === signature) return undefined
    state.signature = signature
    if (last && last.id !== state.lastId) {
      state.lastId = last.id
      state.busy = true
    }
    if (isBusy(last)) {
      state.busy = true
      return undefined
    }
    if (!last || !state.busy) return undefined
    return this.finish(state, last, final)
  }

  reset(): void {
    this.state = undefined
  }

  private finish(state: Baseline, turn: UITurn, final: UINode | undefined): TurnOutcome | undefined {
    const assistant = final?.kind === 'assistant' ? final : undefined
    if (turn.status === 'completed' && assistant?.streaming && turn.finalAssistantId !== state.final)
      return undefined
    state.busy = false
    if (turn.status === 'completed' && assistant && !assistant.streaming && assistant.text.trim()) {
      state.final = assistant.id
      return { kind: 'reply', turnId: turn.id, nodeId: assistant.id, text: assistant.text }
    }
    return { kind: 'no-reply', turnId: turn.id, status: turn.status }
  }
}
