import type { ConversationPhase } from '@agnes/web-client'
import { describe, expect, it, vi } from 'vitest'
import { createConversation } from '../src/voice/conversation.js'
import type { TurnOutcome } from '../src/voice/turn-watch.js'

type Audio = { channels: Float32Array[]; sampleRate: number }
type ReadOutcome = 'ended' | 'stopped' | 'blocked' | 'failed'

const audio: Audio = { channels: [new Float32Array(8000)], sampleRate: 16_000 }
const reply: TurnOutcome = { kind: 'reply', turnId: 't1', nodeId: 'a1', text: '你好呀' }

/** Never settles until its signal aborts, like a listen or a turn wait that is still open. */
const hang = <T>(signal: AbortSignal): Promise<T> =>
  new Promise<T>((_, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  })

function setup(script: {
  listen?: (Audio | 'idle-timeout')[]
  transcribe?: string[]
  turns?: TurnOutcome[]
  read?: () => Promise<ReadOutcome>
  sent?: boolean
  elsewhere?: boolean
}) {
  const phases: ConversationPhase[] = []
  const listens = [...(script.listen ?? [])]
  const texts = [...(script.transcribe ?? [])]
  const turns = [...(script.turns ?? [])]
  const lock = {
    setConversation: vi.fn(),
    conversationElsewhere: vi.fn(() => script.elsewhere ?? false),
  }
  const deps = {
    listen: vi.fn((signal: AbortSignal) => {
      const next = listens.shift()
      return next ? Promise.resolve(next) : hang<Audio | 'idle-timeout'>(signal)
    }),
    transcribe: vi.fn(async () => texts.shift() ?? ''),
    send: vi.fn(() => script.sent ?? true),
    nextTurn: vi.fn((signal: AbortSignal) => {
      const next = turns.shift()
      return next ? Promise.resolve(next) : hang<TurnOutcome>(signal)
    }),
    read: vi.fn(script.read ?? (async (): Promise<ReadOutcome> => 'ended')),
    stopReading: vi.fn(),
    notice: vi.fn(),
    fail: vi.fn(),
    lock,
  }
  const conversation = createConversation(deps)
  conversation.phase.subscribe(() => phases.push(conversation.phase.getSnapshot()))
  return { conversation, deps, phases, lock }
}

describe('voice conversation', () => {
  it('runs a full round with autoSend and autoRead off', async () => {
    const { conversation, deps, phases, lock } = setup({
      listen: [audio],
      transcribe: ['你好'],
      turns: [reply],
    })
    conversation.start()
    expect(lock.setConversation).toHaveBeenCalledWith(true)
    await vi.waitFor(() => expect(phases).toHaveLength(5))
    expect(phases).toEqual(['listening', 'transcribing', 'thinking', 'reading', 'listening'])
    expect(deps.send).toHaveBeenCalledTimes(1)
    expect(deps.send).toHaveBeenCalledWith('你好')
    expect(deps.read).toHaveBeenCalledTimes(1)
    expect(deps.read).toHaveBeenCalledWith('a1', '你好呀')
    conversation.exit()
  })

  it('returns to listening on an empty transcript without sending', async () => {
    const { conversation, deps, phases } = setup({ listen: [audio], transcribe: ['  '] })
    conversation.start()
    await vi.waitFor(() => expect(phases).toEqual(['listening', 'transcribing', 'listening']))
    expect(deps.send).not.toHaveBeenCalled()
    expect(deps.nextTurn).not.toHaveBeenCalled()
    conversation.exit()
  })

  it('interrupts reading with the mic and listens again', async () => {
    let stop: ((outcome: ReadOutcome) => void) | undefined
    const { conversation, deps } = setup({
      listen: [audio],
      transcribe: ['讲个故事'],
      turns: [reply],
      read: () =>
        new Promise<ReadOutcome>((resolve) => {
          stop = resolve
        }),
    })
    deps.stopReading.mockImplementation(() => stop?.('stopped'))
    conversation.start()
    await vi.waitFor(() => expect(conversation.phase.getSnapshot()).toBe('reading'))
    conversation.interrupt()
    expect(deps.stopReading).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(conversation.phase.getSnapshot()).toBe('listening'))
    expect(deps.listen).toHaveBeenCalledTimes(2)
    conversation.exit()
  })

  it('ignores an interrupt outside reading', async () => {
    const { conversation, deps } = setup({})
    conversation.start()
    await vi.waitFor(() => expect(conversation.phase.getSnapshot()).toBe('listening'))
    conversation.interrupt()
    expect(deps.stopReading).not.toHaveBeenCalled()
    expect(conversation.phase.getSnapshot()).toBe('listening')
    conversation.exit()
  })

  it.each(['escape', 'wave', 'session', 'idle'] as const)('exits on %s', async (cause) => {
    const { conversation, deps, lock } = setup(cause === 'idle' ? { listen: ['idle-timeout'] } : {})
    conversation.start()
    if (cause !== 'idle') {
      await vi.waitFor(() => expect(conversation.phase.getSnapshot()).toBe('listening'))
      // Esc, the wave button and a session switch all end the conversation through exit().
      conversation.exit()
    }
    await vi.waitFor(() => expect(conversation.phase.getSnapshot()).toBe('idle'))
    expect(lock.setConversation).toHaveBeenLastCalledWith(false)
    expect(deps.stopReading).toHaveBeenCalled()
    expect(deps.transcribe).not.toHaveBeenCalled()
    // The aborted listen cannot restart the loop.
    await Promise.resolve()
    expect(deps.listen).toHaveBeenCalledTimes(1)
  })

  it('refuses to start while another tab is in a conversation', () => {
    const { conversation, deps, lock } = setup({ elsewhere: true })
    conversation.start()
    expect(conversation.phase.getSnapshot()).toBe('idle')
    expect(lock.setConversation).not.toHaveBeenCalled()
    expect(deps.listen).not.toHaveBeenCalled()
  })

  it('tells the user and listens again when the turn has no reply', async () => {
    const { conversation, deps, phases } = setup({
      listen: [audio],
      transcribe: ['在吗'],
      turns: [{ kind: 'no-reply', turnId: 't1', status: 'failed' }],
    })
    conversation.start()
    await vi.waitFor(() => expect(phases).toEqual(['listening', 'transcribing', 'thinking', 'listening']))
    expect(deps.notice).toHaveBeenCalledWith('turn-ended')
    expect(deps.read).not.toHaveBeenCalled()
    conversation.exit()
  })

  it('keeps the text and listens again when the composer refuses to send', async () => {
    const { conversation, deps, phases } = setup({ listen: [audio], transcribe: ['你好'], sent: false })
    conversation.start()
    await vi.waitFor(() => expect(phases).toEqual(['listening', 'transcribing', 'listening']))
    expect(deps.notice).toHaveBeenCalledWith('failed')
    expect(deps.nextTurn).not.toHaveBeenCalled()
    conversation.exit()
  })

  it('reports a failed transcription and listens again', async () => {
    const { conversation, deps, phases } = setup({ listen: [audio] })
    const error = new Error('provider')
    deps.transcribe.mockRejectedValueOnce(error)
    conversation.start()
    await vi.waitFor(() => expect(phases).toEqual(['listening', 'transcribing', 'listening']))
    expect(deps.fail).toHaveBeenCalledWith(error)
    conversation.exit()
  })
})
