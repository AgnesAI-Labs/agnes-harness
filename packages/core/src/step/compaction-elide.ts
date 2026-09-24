import type { SurfaceNode } from '../project/surface.js'
import { canonicalJson } from '../request/hash.js'
import type { Seq } from '../types.js'
import { estimateTokens } from './inference.js'

const HEADER_MAX = 240
const TEXT_MAX = 1000
const ARGS_MAX = 300

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}...` : text)

const TRUNCATED = '\n[... truncated]'

/** The longest prefix of `text` that, with a truncation marker, stays within `tokens`. */
function bound(text: string, tokens: number): string {
  if (estimateTokens(text) <= tokens) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (estimateTokens(text.slice(0, mid) + TRUNCATED) <= tokens) low = mid
    else high = mid - 1
  }
  return text.slice(0, low) + TRUNCATED
}

function texts(node: SurfaceNode): string[] {
  const content = (node.event.data as { content?: unknown } | null)?.content
  if (!Array.isArray(content)) return []
  return content.flatMap((block) =>
    block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string'
      ? [block.text]
      : [],
  )
}

/**
 * The deterministic stand-in for a model summary, used when no usable summary can be had. It keeps
 * the trail of what was asked and done and drops what tools returned. Nothing that arrived from
 * outside the harness is copied: no tool output, no untrusted or non-principal user text, no
 * runtime notes and no thinking. What is copied (a leading summary, assistant text, call arguments)
 * already reaches the model as the harness's own assistant turns. The previous summary and the first
 * request are always kept, cut to a share of `cap` if they alone are too long; when the result is
 * still over `cap` tokens, the oldest of the other entries (a user message, or an assistant step with
 * its calls and results) are folded into one count line.
 */
export function elideSpan(
  nodes: readonly SurfaceNode[],
  calls: readonly { assistantSeq: Seq; name: string; args: unknown }[],
  cause: string,
  cap: number,
): string {
  const header = cut(
    `[compaction] No model summary (${cause}); earlier tool outputs are elided below and the full record stays in the session ledger.`,
    HEADER_MAX - 3,
  )
  const entries: string[][] = []
  // The previous summary and the first request the principal made carry the goal; they are kept
  // whatever else is folded, within a share of the cap each.
  let summary: string | undefined
  let request: string | undefined
  // Results join the step of the assistant that asked for them, across a skipped runtime note.
  let step: string[] | undefined
  for (const node of nodes) {
    const data = node.event.data as { kind?: unknown; isError?: unknown } | null
    if (node.kind === 'summary') {
      step = undefined
      summary = texts(node).join('\n')
    } else if (node.kind === 'user') {
      if (data?.kind === 'runtime_context') continue
      step = undefined
      const own = node.event.origin === 'principal' && node.event.trust === 'trusted'
      const text = `[user] ${cut(texts(node).join('\n'), TEXT_MAX)}`
      if (own && request === undefined) request = text
      else entries.push([own ? text : '[user message elided]'])
    } else if (node.kind === 'assistant') {
      step = texts(node).length > 0 ? [`[assistant] ${cut(texts(node).join('\n'), TEXT_MAX)}`] : []
      for (const call of calls)
        if (call.assistantSeq === node.seq)
          step.push(`[tool call] ${call.name}(${cut(canonicalJson(call.args), ARGS_MAX)})`)
      entries.push(step)
    } else {
      const size = texts(node).reduce((n, text) => n + estimateTokens(text), 0)
      const line = `[tool result] elided (~${size} tokens, ${data?.isError === true ? 'error' : 'ok'})`
      if (step) step.push(line)
      else entries.push([line])
    }
  }
  const kept = [...(request === undefined ? [] : [bound(request, Math.floor(cap / 8))])]
  if (summary !== undefined)
    kept.unshift(
      bound(`[previous summary]\n${summary}`, Math.floor(cap / 2) - estimateTokens(kept.join('\n'))),
    )
  // The steps between are folded from the oldest on, so the most recent work stays in view.
  const render = (folded: number) =>
    [
      header,
      ...kept,
      ...(folded > 0 ? [`[${folded} earlier entries elided]`] : []),
      ...entries.slice(folded).flat(),
    ].join('\n')
  const fits = (folded: number) => estimateTokens(render(folded)) <= cap
  // Folding more only ever shortens the text, give or take the count line, so search for the least
  // fold that fits and then step past any count-line wobble.
  let low = 0
  let high = entries.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (fits(mid)) high = mid
    else low = mid + 1
  }
  while (low < entries.length && !fits(low)) low++
  return render(low)
}
