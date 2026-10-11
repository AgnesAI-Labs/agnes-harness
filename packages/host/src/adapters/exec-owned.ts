import type { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import type { SandboxProcess } from '@agnes/core'

/** Output that arrives before anyone listens is kept up to this many characters and replayed. */
const EARLY_CHARS = 256 * 1024

/**
 * One text stream out of a started process's stdout and stderr. Each stream has its own decoder,
 * so a character split across two chunks arrives whole; what is printed before the holder attaches
 * its listener is replayed to it rather than lost.
 */
export function ownedProcess(input: {
  pid: number | undefined
  stdout: Readable
  stderr: Readable
  done: Promise<{ code: number | null; signal?: string }>
  stop(): Promise<void>
}): SandboxProcess {
  const listeners: Array<(text: string) => void> = []
  let early: string[] | undefined = []
  let earlyChars = 0
  const emit = (text: string) => {
    if (!text) return
    if (early) {
      if (earlyChars < EARLY_CHARS) early.push(text)
      earlyChars += text.length
      return
    }
    for (const listener of listeners) listener(text)
  }
  for (const stream of [input.stdout, input.stderr]) {
    const decoder = new StringDecoder('utf8')
    stream.on('data', (chunk: Buffer) => emit(decoder.write(chunk)))
    stream.on('end', () => emit(decoder.end()))
    // A pipe torn down by stop is not an error anyone can act on; the exit is reported by `done`.
    stream.on('error', () => {})
  }
  return Object.freeze({
    pid: input.pid,
    onOutput(listener: (text: string) => void) {
      listeners.push(listener)
      if (!early) return
      const replay = early
      early = undefined
      for (const text of replay) listener(text)
    },
    done: input.done,
    stop: input.stop,
  })
}
