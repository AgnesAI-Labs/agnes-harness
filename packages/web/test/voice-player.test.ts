import { describe, expect, it, vi } from 'vitest'
import { SpeechPlayer } from '../src/voice/player.js'

class FakeAudio extends EventTarget {
  paused = true
  pauseCalls = 0
  blockNext = false
  playError: unknown
  constructor(readonly url: string) {
    super()
  }
  play(): Promise<void> {
    if (this.blockNext) {
      this.blockNext = false
      return Promise.reject(new DOMException('blocked', 'NotAllowedError'))
    }
    if (this.playError) return Promise.reject(this.playError)
    this.paused = false
    return Promise.resolve()
  }
  pause(): void {
    this.paused = true
    this.pauseCalls++
  }
  end(): void {
    this.paused = true
    this.dispatchEvent(new Event('ended'))
  }
  fail(): void {
    this.dispatchEvent(new Event('error'))
  }
}

type Pending = { text: string; signal: AbortSignal; resolve(b64: string): void; reject(e: unknown): void }

function setup(options: { blockFirst?: boolean } = {}) {
  const pending: Pending[] = []
  const audios: FakeAudio[] = []
  const urls: string[] = []
  const revoked: string[] = []
  const onStart = vi.fn()
  let nextUrl = 0
  const player = new SpeechPlayer({
    synthesize: (text, signal) =>
      new Promise<string>((resolve, reject) => {
        pending.push({ text, signal, resolve, reject })
      }),
    createAudio: (url) => {
      const audio = new FakeAudio(url)
      if (options.blockFirst && audios.length === 0) audio.blockNext = true
      audios.push(audio)
      return audio as unknown as HTMLAudioElement
    },
    createUrl: () => {
      const url = `blob:${nextUrl++}`
      urls.push(url)
      return url
    },
    revokeUrl: (url) => {
      revoked.push(url)
    },
    onStart,
  })
  const call = (index: number): Pending => {
    const entry = pending[index]
    if (!entry) throw new Error(`no synthesize call ${index}`)
    return entry
  }
  const audio = (index: number): FakeAudio => {
    const entry = audios[index]
    if (!entry) throw new Error(`no audio element ${index}`)
    return entry
  }
  return { player, pending, call, audios, audio, urls, revoked, onStart }
}

const MP3 = btoa('mp3-bytes')
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
const phase = (p: SpeechPlayer) => p.state.getSnapshot().phase

describe('SpeechPlayer', () => {
  it('prefetches the next segment while one plays and cancels the rest on stop', async () => {
    const { player, pending, audios, urls, revoked, call, audio } = setup()
    const done = player.play('n1', ['s0', 's1', 's2'])
    expect(phase(player)).toBe('loading')
    expect(player.state.getSnapshot().nodeId).toBe('n1')
    expect(pending.map((p) => p.text)).toEqual(['s0'])
    call(0).resolve(MP3)
    await flush()
    expect(audios).toHaveLength(1)
    expect(phase(player)).toBe('playing')
    expect(pending.map((p) => p.text)).toEqual(['s0', 's1'])
    expect(audio(0).paused).toBe(false)
    player.stop()
    expect(call(1).signal.aborted).toBe(true)
    expect(audio(0).pauseCalls).toBe(1)
    expect(revoked).toEqual(urls.slice(0, 1))
    expect(await done).toBe('stopped')
    expect(phase(player)).toBe('idle')
    call(1).resolve(MP3)
    await flush()
    expect(audios).toHaveLength(1)
    expect(urls).toHaveLength(1)
    expect(pending).toHaveLength(2)
  })

  it('plays every segment in order and resolves ended', async () => {
    const { player, pending, audios, revoked, onStart, call, audio } = setup()
    const done = player.play('n1', ['a', 'b'])
    call(0).resolve(MP3)
    await flush()
    expect(onStart).toHaveBeenCalledTimes(1)
    call(1).resolve(MP3)
    await flush()
    expect(audios).toHaveLength(1)
    audio(0).end()
    await flush()
    expect(revoked).toEqual(['blob:0'])
    expect(audios).toHaveLength(2)
    expect(phase(player)).toBe('playing')
    audio(1).end()
    expect(await done).toBe('ended')
    expect(revoked).toEqual(['blob:0', 'blob:1'])
    expect(phase(player)).toBe('idle')
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(pending).toHaveLength(2)
  })

  it('shows loading while the next segment is still being synthesized', async () => {
    const { player, call, audio } = setup()
    const done = player.play('n1', ['a', 'b'])
    call(0).resolve(MP3)
    await flush()
    audio(0).end()
    await flush()
    expect(phase(player)).toBe('loading')
    call(1).resolve(MP3)
    await flush()
    expect(phase(player)).toBe('playing')
    audio(1).end()
    expect(await done).toBe('ended')
  })

  it('enters blocked on NotAllowedError and plays on resume', async () => {
    const { player, onStart, call, audio } = setup({ blockFirst: true })
    const done = player.play('n1', ['a', 'b'])
    call(0).resolve(MP3)
    expect(await done).toBe('blocked')
    expect(phase(player)).toBe('blocked')
    expect(player.state.getSnapshot().nodeId).toBe('n1')
    expect(onStart).not.toHaveBeenCalled()
    const resumed = player.resume()
    await flush()
    expect(phase(player)).toBe('playing')
    expect(audio(0).paused).toBe(false)
    expect(onStart).toHaveBeenCalledTimes(1)
    call(1).resolve(MP3)
    audio(0).end()
    await flush()
    audio(1).end()
    await resumed
    expect(phase(player)).toBe('idle')
  })

  it('stays blocked when resume is refused again and stops cleanly', async () => {
    const { player, revoked, call, audio } = setup({ blockFirst: true })
    const done = player.play('n1', ['a'])
    call(0).resolve(MP3)
    expect(await done).toBe('blocked')
    audio(0).blockNext = true
    void player.resume()
    await flush()
    expect(phase(player)).toBe('blocked')
    player.stop()
    expect(phase(player)).toBe('idle')
    expect(revoked).toEqual(['blob:0'])
  })

  it('resume does nothing unless blocked', async () => {
    const { player } = setup()
    await expect(player.resume()).resolves.toBeUndefined()
    expect(phase(player)).toBe('idle')
  })

  it('resolves failed when a segment cannot be synthesized', async () => {
    const { player, audios, call } = setup()
    const done = player.play('n1', ['a', 'b'])
    call(0).reject(new Error('boom'))
    expect(await done).toBe('failed')
    expect(phase(player)).toBe('idle')
    expect(audios).toHaveLength(0)
  })

  it('plays what is ready, then fails when a prefetched segment failed', async () => {
    const { player, call, audio } = setup()
    const done = player.play('n1', ['a', 'b'])
    call(0).resolve(MP3)
    await flush()
    call(1).reject(new Error('later'))
    await flush()
    expect(phase(player)).toBe('playing')
    audio(0).end()
    expect(await done).toBe('failed')
  })

  it('cancels the prefetch when the playlist fails', async () => {
    const { player, call, audio } = setup()
    const done = player.play('n1', ['a', 'b', 'c'])
    call(0).resolve(MP3)
    await flush()
    expect(call(1).signal.aborted).toBe(false)
    audio(0).fail()
    expect(await done).toBe('failed')
    expect(call(1).signal.aborted).toBe(true)
  })

  it('resolves failed when the audio element errors or cannot start', async () => {
    const first = setup()
    const a = first.player.play('n1', ['a'])
    first.call(0).resolve(MP3)
    await flush()
    first.audio(0).fail()
    expect(await a).toBe('failed')
    expect(first.revoked).toEqual(['blob:0'])

    const second = setup()
    const b = second.player.play('n1', ['a'])
    second.call(0).resolve(btoa('x'))
    await flush()
    second.audio(0).end()
    expect(await b).toBe('ended')

    const third = setup()
    const c = third.player.play('n1', ['a'])
    third.call(0).resolve('%%% not base64 %%%')
    expect(await c).toBe('failed')
  })

  it('resolves ended for an empty playlist without a call', async () => {
    const { player, pending } = setup()
    expect(await player.play('n1', [])).toBe('ended')
    expect(pending).toHaveLength(0)
    expect(phase(player)).toBe('idle')
  })

  it('stops the previous playlist when a new one starts', async () => {
    const { player, call, audio } = setup()
    const first = player.play('n1', ['a', 'b'])
    call(0).resolve(MP3)
    await flush()
    const second = player.play('n2', ['c'])
    expect(await first).toBe('stopped')
    expect(call(1).signal.aborted).toBe(true)
    expect(audio(0).pauseCalls).toBe(1)
    expect(player.state.getSnapshot().nodeId).toBe('n2')
    call(2).resolve(MP3)
    await flush()
    audio(1).end()
    expect(await second).toBe('ended')
  })

  it('stops while still loading and drops the late result', async () => {
    const { player, audios, call } = setup()
    const done = player.play('n1', ['a'])
    player.stop()
    expect(await done).toBe('stopped')
    expect(call(0).signal.aborted).toBe(true)
    call(0).resolve(MP3)
    await flush()
    expect(audios).toHaveLength(0)
  })

  it('notifies subscribers on phase changes and supports unsubscribe', async () => {
    const { player, call, audio } = setup()
    const listener = vi.fn()
    const off = player.state.subscribe(listener)
    const first = player.state.getSnapshot()
    expect(player.state.getSnapshot()).toBe(first)
    const done = player.play('n1', ['a'])
    call(0).resolve(MP3)
    await flush()
    audio(0).end()
    await done
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(3)
    off()
    const count = listener.mock.calls.length
    player.stop()
    await player.play('n2', [])
    expect(listener.mock.calls.length).toBe(count)
  })
})
