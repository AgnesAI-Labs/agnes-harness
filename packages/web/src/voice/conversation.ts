import type { ConversationPhase } from '@agnes/web-client'
import type { VoiceTabLock } from './tab-lock.js'
import type { TurnOutcome } from './turn-watch.js'

export type { ConversationPhase }
export type HeardAudio = { channels: Float32Array[]; sampleRate: number }
export type ReadOutcome = 'ended' | 'stopped' | 'blocked' | 'failed'
/** Rounds in a row whose voice call failed; this many ends the conversation. */
const MAX_FAILED_ROUNDS = 2

export type ConversationDeps = {
  /** Records one utterance; rejects when its signal aborts. */
  listen(signal: AbortSignal): Promise<HeardAudio | 'idle-timeout'>
  transcribe(audio: HeardAudio, signal: AbortSignal): Promise<string>
  /** Puts the text in the composer and sends it; false when the composer refused. */
  send(text: string): boolean
  /** The next finished turn of the viewed session; rejects when its signal aborts. */
  nextTurn(signal: AbortSignal): Promise<TurnOutcome>
  /** Reads the reply to its end (or until stopped). */
  read(nodeId: string, text: string): Promise<ReadOutcome>
  stopReading(): void
  notice(key: 'turn-ended' | 'turn-failed' | 'failed' | 'stopped'): void
  /**
   * A step failed for a reason the conversation cannot handle itself (a denied mic, a failed call).
   * True when retrying cannot help (a rejected account, no budget): the conversation then ends.
   */
  fail(error: unknown): boolean
  lock: Pick<VoiceTabLock, 'setConversation' | 'conversationElsewhere'>
}

export type Conversation = {
  start(): void
  exit(): void
  /** The mic during a conversation: only reading can be interrupted, and then it listens again. */
  interrupt(): void
  readonly phase: { getSnapshot(): ConversationPhase; subscribe(listener: () => void): () => void }
}

/**
 * The voice conversation loop: listen → transcribe → send → wait for the turn → read the reply → listen.
 * Esc, the wave button, a session switch and a long silence all exit; one tab at a time holds it. So do
 * a failed turn (its text goes back to the composer), a failure retrying cannot fix, and two rounds in
 * a row whose voice call failed.
 */
export function createConversation(deps: ConversationDeps): Conversation {
  let phase: ConversationPhase = 'idle'
  let run: AbortController | undefined
  let failedRounds = 0
  const listeners = new Set<() => void>()
  const set = (next: ConversationPhase): void => {
    if (next === phase) return
    phase = next
    for (const listener of [...listeners]) listener()
  }

  const exit = (): void => {
    const current = run
    if (!current) return
    run = undefined
    current.abort()
    deps.stopReading()
    deps.lock.setConversation(false)
    set('idle')
  }

  /** A round's voice call failed; resolves the round to whether to listen again. */
  const failedRound = (): boolean => {
    failedRounds++
    if (failedRounds < MAX_FAILED_ROUNDS) return true
    deps.notice('stopped')
    return false
  }
  const goodRound = (): boolean => {
    failedRounds = 0
    return true
  }

  /** One round; resolves true to listen again. */
  const round = async (signal: AbortSignal): Promise<boolean> => {
    set('listening')
    const heard = await deps.listen(signal)
    if (heard === 'idle-timeout') return false
    set('transcribing')
    let text: string
    try {
      text = (await deps.transcribe(heard, signal)).trim()
    } catch (error) {
      if (signal.aborted) return true
      return !deps.fail(error) && failedRound()
    }
    if (signal.aborted) return true
    if (!text) return goodRound()
    if (!deps.send(text)) {
      deps.notice('failed')
      return true
    }
    set('thinking')
    const outcome = await deps.nextTurn(signal)
    // The failed send put the text back in the composer; the next utterance would be sent after it.
    if (outcome.kind === 'no-reply' && outcome.status === 'failed') {
      deps.notice('turn-failed')
      return false
    }
    if (outcome.kind === 'no-reply') {
      deps.notice('turn-ended')
      return goodRound()
    }
    set('reading')
    return (await deps.read(outcome.nodeId, outcome.text)) === 'failed' ? failedRound() : goodRound()
  }

  const loop = async (current: AbortController): Promise<void> => {
    try {
      let again = true
      while (again && run === current) again = await round(current.signal)
    } catch (error) {
      if (run === current) deps.fail(error)
    }
    if (run === current) exit()
  }

  return {
    start() {
      if (run || deps.lock.conversationElsewhere()) return
      const current = new AbortController()
      run = current
      failedRounds = 0
      deps.lock.setConversation(true)
      void loop(current)
    },
    exit,
    interrupt() {
      if (phase === 'reading') deps.stopReading()
    },
    phase: {
      getSnapshot: () => phase,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
  }
}
