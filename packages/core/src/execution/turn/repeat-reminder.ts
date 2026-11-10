import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import type { ToolResult } from '@agnes/extension-api'

/**
 * A note on a tool result when the model runs the same call again and again: the same tool, the same
 * arguments and the same result, in a row. The result is part of the key on purpose: polling a job or a
 * status repeats its arguments while the answer changes, and that is not a loop. Times and short durations in the
 * result are ignored (see `withoutTiming`), since they differ on every run of the same command. The note rides at the end
 * of the result the ledger keeps, so it adds no message of its own and moves no cached prefix. It only
 * advises; the call itself is never refused or rewritten.
 */

/** The run lengths that get a note: a gentle one, then two that name the call. */
export const REPEAT_REMINDER_AT: readonly number[] = [3, 5, 8]
const ARGS_PREVIEW_CHARS = 500
const BLOCK_LIMIT = 256

const GENTLE =
  'You are repeating the exact same tool call with identical arguments and the same result. Analyze the previous result before calling again; if the task is not done, try a different approach or different arguments.'

// Times and short durations differ on every run of the same command, so they are blanked before the
// result is compared: a failing test that prints "Done in 2.31s" and then "Done in 2.34s" is one loop, not
// two answers. A wait that counts down ("30s left", "10 seconds remaining") and minutes or longer are kept,
// so they still read as progress.
const CLOCK =
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?|(?<![\d:])\d{1,2}:\d{2}:\d{2}(?:\.\d+)?(?![\d:])/g
const SHORT_DURATION =
  /(?<![\w.-])\d+(?:\.\d+)?[ ]?(?:ms|s|secs?|seconds?)\b(?!\s+(?:left|remaining|to go|until|more)\b)/g

function withoutTiming(content: ToolResult['content']): ToolResult['content'] {
  return content.map((block) =>
    block.type === 'text'
      ? { ...block, text: block.text.replace(CLOCK, '<time>').replace(SHORT_DURATION, '<duration>') }
      : block,
  )
}

/** Per session (the owner is the session object): the key of the last call and how many times in a row. */
const runs = new WeakMap<object, { key: string; count: number }>()

export function withRepeatReminder<T extends Pick<ToolResult, 'content'>>(
  owner: object,
  name: string,
  args: unknown,
  result: T,
): T {
  let argsJson: string
  let key: string
  try {
    argsJson = canonicalJson(args)
    key = `${name}\u0000${argsJson}\u0000${sha256Hex(canonicalJson(withoutTiming(result.content)))}`
  } catch {
    return result
  }
  const last = runs.get(owner)
  const count = last?.key === key ? last.count + 1 : 1
  runs.set(owner, { key, count })
  if (!REPEAT_REMINDER_AT.includes(count)) return result
  const text =
    count === REPEAT_REMINDER_AT[0]
      ? GENTLE
      : `Repeated tool call detected: ${name} called ${count} times in a row with the same arguments and the same result: ${argsJson.slice(0, ARGS_PREVIEW_CHARS)}. Stop repeating it; change the approach or ask the user.`
  const note = `\n[Repeat reminder] ${text}`
  const tail = result.content.at(-1)
  if (tail?.type === 'text')
    return {
      ...result,
      content: [...result.content.slice(0, -1), { ...tail, text: `${tail.text}\n${note}` }],
    }
  if (result.content.length >= BLOCK_LIMIT) return result
  return { ...result, content: [...result.content, { type: 'text', text: note }] }
}
