import type { Host, HostSession } from '@agnes/host'
import { beforeEach, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({ transcribe: vi.fn(), speak: vi.fn(), ask: vi.fn() }))
vi.mock('@agnes/host', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agnes/host')>()),
  voiceTranscribe: host.transcribe,
  voiceSpeak: host.speak,
  askSideQuestion: host.ask,
}))
const { handleCommand } = await import('../src/commands.js')
const { VoiceError } = await import('@agnes/host')

const WAV = 'UklGR'.padEnd(64, 'A')
const session = { key: 'held' } as unknown as HostSession

function run(method: string, params: Record<string, unknown>, aborts = new Map<string, AbortController>()) {
  return handleCommand(
    session,
    { kind: 'command', requestId: '1', method: method as 'voice.transcribe', params },
    { host: {} as Host, aborts },
  )
}

/** A host call that stays pending until its signal aborts. */
function pending(signals: AbortSignal[]) {
  return (_s: unknown, _i: unknown, o: { signal: AbortSignal }) => {
    signals.push(o.signal)
    return new Promise((_r, reject) =>
      o.signal.addEventListener('abort', () => reject(new VoiceError('timeout', 'stopped'))),
    )
  }
}

beforeEach(() => {
  host.transcribe.mockReset().mockResolvedValue({ text: 'ok' })
  host.speak.mockReset().mockResolvedValue({ audio: 'AAAA', mimeType: 'audio/mpeg' })
  host.ask.mockReset().mockResolvedValue({ text: 'answer', model: 'm' })
})

it('runs voice.transcribe for a held session through the side-call hook', async () => {
  const aborts = new Map<string, AbortController>()
  await expect(
    run('voice.transcribe', { runId: 'voice:1', audio: WAV, route: 'r' }, aborts),
  ).resolves.toEqual({
    text: 'ok',
  })
  expect(host.transcribe).toHaveBeenCalledWith(
    session,
    { audio: WAV },
    { route: 'r', signal: expect.any(AbortSignal) },
  )
  await run('voice.transcribe', { runId: 'voice:2', audio: WAV, language: 'zh', route: 'r' }, aborts)
  expect(host.transcribe).toHaveBeenLastCalledWith(session, { audio: WAV, language: 'zh' }, expect.anything())
  await expect(
    run('voice.speak', { runId: 'voice:3', text: 'hi', voice: 'anna', speed: 1.5, route: 'r' }, aborts),
  ).resolves.toEqual({ audio: 'AAAA', mimeType: 'audio/mpeg' })
  expect(host.speak).toHaveBeenCalledWith(
    session,
    { text: 'hi', voice: 'anna', speed: 1.5 },
    { route: 'r', signal: expect.any(AbortSignal) },
  )
  expect(aborts.size).toBe(0)
  // A host refusal goes back as its wire error.
  host.speak.mockRejectedValueOnce(new VoiceError('budget', 'over the request cap'))
  await expect(
    run('voice.speak', { runId: 'voice:4', text: 'hi', route: 'r' }, aborts),
  ).rejects.toMatchObject({
    data: { code: 'SEMANTIC_REJECTED', reason: 'BUDGET' },
  })
  expect(aborts.size).toBe(0)
})

it('refuses a reused or non-voice run id', async () => {
  const aborts = new Map<string, AbortController>()
  await expect(run('voice.transcribe', { runId: 'btw:1', audio: WAV, route: 'r' }, aborts)).rejects.toThrow(
    'Invalid voice call id',
  )
  const signals: AbortSignal[] = []
  host.transcribe.mockImplementationOnce(pending(signals))
  const first = run('voice.transcribe', { runId: 'voice:1', audio: WAV, route: 'r' }, aborts)
  void first.catch(() => undefined)
  await expect(run('voice.speak', { runId: 'voice:1', text: 'hi', route: 'r' }, aborts)).rejects.toThrow(
    'Invalid voice call id',
  )
  expect(host.speak).not.toHaveBeenCalled()
  // The refused duplicate left the running call's controller in place.
  aborts.get('voice:1')?.abort()
  await expect(first).rejects.toMatchObject({ data: { code: 'REQUEST_TIMEOUT' } })
  expect(aborts.size).toBe(0)
})

it('aborts a running voice call by run id', async () => {
  const aborts = new Map<string, AbortController>()
  const signals: AbortSignal[] = []
  host.speak.mockImplementationOnce(pending(signals))
  const speaking = run('voice.speak', { runId: 'voice:1', text: 'hi', route: 'r' }, aborts)
  void speaking.catch(() => undefined)
  await vi.waitFor(() => expect(signals).toHaveLength(1))
  expect(signals[0]?.aborted).toBe(false)
  await run('abort', { runId: 'voice:1' }, aborts)
  expect(signals[0]?.aborted).toBe(true)
  await expect(speaking).rejects.toMatchObject({ data: { code: 'REQUEST_TIMEOUT' } })
})

it('still answers btw through the same hook', async () => {
  const aborts = new Map<string, AbortController>()
  await expect(run('btw', { runId: 'btw:1', question: 'q' }, aborts)).resolves.toEqual({
    text: 'answer',
    model: 'm',
  })
  expect(host.ask).toHaveBeenCalledWith(session, 'q', { signal: expect.any(AbortSignal) })
  await expect(run('btw', { runId: 'voice:9', question: 'q' }, aborts)).rejects.toThrow(
    'Invalid side question id',
  )
  expect(aborts.size).toBe(0)
})
