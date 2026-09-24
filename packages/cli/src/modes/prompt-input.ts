import type { ContentBlock } from '@agnes/protocol'
import { UsageError } from '../errors.js'

async function readAll(s: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of s) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)))
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
 * later reader can still tell the instruction from the material it was handed. protocol's I1
 * ContentBlock has no `resource` member, which was the first choice for carrying it, so the block is
 * text with a marker line instead.
 */
export async function readPromptInput(o: {
  positional: string
  stdin: NodeJS.ReadableStream
  stdinIsTTY: boolean
}): Promise<ContentBlock[]> {
  const piped = o.stdinIsTTY ? '' : await readAll(o.stdin)
  if (o.positional && piped)
    return [
      { type: 'text', text: o.positional },
      { type: 'text', text: `[stdin]\n${piped}` },
    ]
  if (o.positional) return [{ type: 'text', text: o.positional }]
  if (piped) return [{ type: 'text', text: piped }]
  throw new UsageError('agh -p needs a prompt argument or piped stdin')
}
