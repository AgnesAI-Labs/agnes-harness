import type { ContentBlock } from '@agnes/protocol'
import { UsageError } from '../errors.js'

const WAIT_HINT_MS = 3000

/**
 * Reads to EOF. When `hint` is given and nothing -- no chunk, no EOF -- has arrived within `delayMs`,
 * `hint` runs once. The timer is cleared on the first chunk and on every exit path, and is unref'd so
 * it can never be the thing keeping the process alive.
 */
async function readAll(s: NodeJS.ReadableStream, hint?: () => void, delayMs = WAIT_HINT_MS): Promise<string> {
  const chunks: Buffer[] = []
  let timer: ReturnType<typeof setTimeout> | undefined = hint
    ? setTimeout(() => {
        timer = undefined
        hint()
      }, delayMs)
    : undefined
  timer?.unref?.()
  try {
    for await (const c of s) {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)))
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Where the prompt comes from, in one place, because three combinations have to be told apart and
 * two of them look alike from inside a pipeline.
 *
 * stdin is read only when it is not a terminal. Reading it on a TTY would make `agh -p "hi"` wait
 * for the operator to type an EOF before it did anything, which presents as a hang with no output.
 *
 * Both present is not an error: `cat notes.md | agh -p summarize` is the shape people actually
 * write. The piped half arrives as a second block rather than concatenated into the first, so a
 * later reader can still tell the instruction from the material it was handed. protocol's
 * ContentBlock has no `resource` member, which was the first choice for carrying it, so the block is
 * text with a marker line instead.
 *
 * With a positional prompt the stdin read is optional material, yet it still blocks until the writer
 * closes the pipe. A parent that leaves stdin open (an inherited socket, a tool runner) makes that
 * look like a silent hang, so `onWaitHint` fires once if nothing has arrived after `waitHintMs`.
 * It is never called without a positional (stdin is then the prompt) or on a terminal.
 */
export async function readPromptInput(o: {
  positional: string
  stdin: NodeJS.ReadableStream
  stdinIsTTY: boolean
  onWaitHint?: () => void
  waitHintMs?: number
}): Promise<ContentBlock[]> {
  const piped = o.stdinIsTTY
    ? ''
    : await readAll(o.stdin, o.positional ? o.onWaitHint : undefined, o.waitHintMs)
  if (o.positional && piped)
    return [
      { type: 'text', text: o.positional },
      { type: 'text', text: `[stdin]\n${piped}` },
    ]
  if (o.positional) return [{ type: 'text', text: o.positional }]
  if (piped) return [{ type: 'text', text: piped }]
  throw new UsageError('agh -p needs a prompt argument or piped stdin')
}
