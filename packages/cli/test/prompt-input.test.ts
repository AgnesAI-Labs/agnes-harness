import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { UsageError } from '../src/errors.js'
import { readPromptInput } from '../src/modes/prompt-input.js'

const stdin = (s: string): NodeJS.ReadableStream => Readable.from([Buffer.from(s)])

describe('readPromptInput', () => {
  it('takes the positional argument on its own', async () => {
    expect(await readPromptInput({ positional: 'hi', stdin: stdin(''), stdinIsTTY: true })).toEqual([
      { type: 'text', text: 'hi' },
    ])
  })

  it('takes piped stdin on its own when stdin is not a terminal', async () => {
    expect(await readPromptInput({ positional: '', stdin: stdin('from pipe\n'), stdinIsTTY: false })).toEqual(
      [{ type: 'text', text: 'from pipe\n' }],
    )
  })

  it('attaches stdin as a second block when both are present', async () => {
    expect(
      await readPromptInput({ positional: 'summarize', stdin: stdin('DATA'), stdinIsTTY: false }),
    ).toEqual([
      { type: 'text', text: 'summarize' },
      { type: 'text', text: '[stdin]\nDATA' },
    ])
  })

  it('refuses when there is neither', async () => {
    await expect(
      readPromptInput({ positional: '', stdin: stdin(''), stdinIsTTY: true }),
    ).rejects.toBeInstanceOf(UsageError)
  })

  // The reason stdin is read only off a pipe: on a terminal there is nobody typing, so reading to
  // EOF would hang with no output at all -- the failure that looks like the harness is broken.
  it('never reads a terminal stdin, even when there is no positional to fall back on', async () => {
    let read = false
    const watched = new Readable({
      read() {
        read = true
        this.push(null)
      },
    })
    await expect(
      readPromptInput({ positional: '', stdin: watched, stdinIsTTY: true }),
    ).rejects.toBeInstanceOf(UsageError)
    expect(read).toBe(false)
  })

  it('an empty pipe with a positional is the positional alone, not an empty attachment', async () => {
    expect(await readPromptInput({ positional: 'hi', stdin: stdin(''), stdinIsTTY: false })).toEqual([
      { type: 'text', text: 'hi' },
    ])
  })

  it('reassembles a body that arrives in several chunks', async () => {
    const chunked = Readable.from([Buffer.from('one '), Buffer.from('two '), Buffer.from('three')])
    expect(await readPromptInput({ positional: '', stdin: chunked, stdinIsTTY: false })).toEqual([
      { type: 'text', text: 'one two three' },
    ])
  })

  it('carries multi-byte text through whole, whichever chunk the boundary falls in', async () => {
    const bytes = Buffer.from('人工智能', 'utf8')
    const split = Readable.from([bytes.subarray(0, 5), bytes.subarray(5)])
    expect(await readPromptInput({ positional: '', stdin: split, stdinIsTTY: false })).toEqual([
      { type: 'text', text: '人工智能' },
    ])
  })
})
