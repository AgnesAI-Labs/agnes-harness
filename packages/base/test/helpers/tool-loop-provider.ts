import { estimateTokens } from '@agnes/core'
import { fakeProvider, type Script, sent } from '@agnes/core/testkit'
import type { InferenceEvent, ModelRecord, Provider, RequestBody } from '@agnes/protocol'

type WireMessage = RequestBody['messages'][number]

/** A failure scripted onto the n-th summary request (1-based). */
export type SummaryFault = 'retryable' | 'permanent'

export type ToolLoopOptions = {
  primaryWindow: number
  compactionWindow?: number
  /** Whether the model answers main step `i` (0-based, counted across turns) in text, ending the turn. */
  answerAt: (step: number) => boolean
  /** Multiplier on the provider's own count, to model a tokenizer that disagrees with the estimate. */
  tokenFactor?: number
  summaryText?: string
  summaryFaults?: ReadonlyMap<number, SummaryFault>
  /** Arguments of the read the model asks for at main step `i` (0-based). */
  readArgs?: (step: number) => Record<string, unknown>
}

export type ToolLoopProvider = Provider & {
  requests: RequestBody[]
  /** The provider's input count for each request, in order, beside `requests`. */
  inputs: number[]
  mainSteps: number
  summaries: number
  overflows: number
  coldStarts: number
}

const messageText = (m: WireMessage): string[] => {
  const parts: string[] = []
  for (const block of m.content as Array<{ text?: unknown }>)
    if (typeof block.text === 'string') parts.push(block.text)
  if (m.role === 'assistant')
    for (const call of (m as { toolCalls?: Array<{ name: string; args: unknown }> }).toolCalls ?? [])
      parts.push(call.name, JSON.stringify(call.args))
  return parts
}

/** What the provider bills as input for one request: every string the request carries. */
export function countInput(req: RequestBody, factor = 1): number {
  let n = estimateTokens(req.system)
  for (const m of req.messages) for (const part of messageText(m)) n += estimateTokens(part)
  n += estimateTokens(JSON.stringify(req.tools))
  return Math.ceil(n * factor)
}

/** The cached prefix of `b` against the previous main request `a`, and how many messages it covers. */
function commonPrefix(a: RequestBody | undefined, b: RequestBody): { tokens: number; messages: number } {
  if (!a || a.system !== b.system || JSON.stringify(a.tools) !== JSON.stringify(b.tools))
    return { tokens: 0, messages: 0 }
  let tokens = estimateTokens(b.system) + estimateTokens(JSON.stringify(b.tools))
  let messages = 0
  for (; messages < Math.min(a.messages.length, b.messages.length); messages++) {
    if (JSON.stringify(a.messages[messages]) !== JSON.stringify(b.messages[messages])) break
    for (const part of messageText(b.messages[messages] as WireMessage)) tokens += estimateTokens(part)
  }
  return { tokens, messages }
}

export function modelRecord(slot: 'primary' | 'compaction', contextWindow: number): ModelRecord {
  return {
    id: `${slot}-model`,
    name: `${slot}-model`,
    api: 'openai-completions',
    route: 'default',
    baseUrl: 'https://example.invalid/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 32_000,
    toolCallFormats: ['native'],
    thinkingReplay: 'native',
    contract_id: null,
    slot,
  }
}

/**
 * A provider whose usage follows the request it was actually sent, so core's context anchor moves
 * the way it does against a real model. A main request over the window fails with OVERFLOW; so does
 * a summary request whose input plus its output cap exceeds the compaction window.
 */
export function toolLoopProvider(o: ToolLoopOptions): ToolLoopProvider {
  const summaryText =
    o.summaryText ?? `Goal: read the files. Progress: ${'read and noted each file. '.repeat(30)}`
  let lastMain: RequestBody | undefined
  const p: ToolLoopProvider = {
    requests: [],
    inputs: [],
    mainSteps: 0,
    summaries: 0,
    overflows: 0,
    coldStarts: 0,
    models: () => [
      modelRecord('primary', o.primaryWindow),
      modelRecord('compaction', o.compactionWindow ?? o.primaryWindow),
    ],
    async *infer(req, options): AsyncIterable<InferenceEvent> {
      p.requests.push(req)
      const input = countInput(req, o.tokenFactor)
      p.inputs.push(input)
      const summary = req.kind === 'summary'
      const usage = (output: number, cacheRead = 0): InferenceEvent => ({
        type: 'usage',
        tokens: { input: input - cacheRead, output, cacheRead, cacheWrite: 0 },
        credits: 0,
        creditSource: 'estimated',
      })
      const overflow: Script = [
        {
          type: 'error',
          reason: 'error',
          code: 'OVERFLOW',
          message: 'context window exceeded',
          retryable: false,
        },
      ]
      let script: Script
      if (summary) {
        p.summaries++
        const fault = o.summaryFaults?.get(p.summaries)
        const window = o.compactionWindow ?? o.primaryWindow
        if (input + (req.sampling?.maxTokens ?? 0) > window) {
          p.overflows++
          script = overflow
        } else if (fault)
          script = [
            sent(),
            {
              type: 'error',
              reason: 'error',
              code: fault === 'retryable' ? 'RATE_LIMIT' : 'TRANSPORT',
              message: `scripted ${fault} summary failure`,
              retryable: fault === 'retryable',
            },
          ]
        else {
          // Numbered, so two summaries never render alike and a cache prefix cannot span them.
          const text = `${summaryText} [summary ${p.summaries}]`
          script = [
            sent(),
            { type: 'text_delta', delta: text },
            usage(estimateTokens(text)),
            { type: 'done', reason: 'stop' },
          ]
        }
      } else if (input > o.primaryWindow) {
        p.overflows++
        script = overflow
      } else {
        const prefix = commonPrefix(lastMain, req)
        const cacheRead = prefix.tokens
        // A request that shares no message with the one before it re-reads the whole history.
        if (lastMain && prefix.messages === 0) p.coldStarts++
        lastMain = req
        const step = p.mainSteps++
        script = !o.answerAt(step)
          ? [
              sent(),
              {
                type: 'toolcall_end',
                call: {
                  toolUseId: '',
                  name: 'read',
                  args: (o.readArgs?.(step) ?? { path: `f${step}` }) as never,
                  ordinal: 0,
                },
                via: 'native',
              },
              usage(20, cacheRead),
              { type: 'done', reason: 'toolUse' },
            ]
          : [
              sent(),
              { type: 'text_delta', delta: 'all files read' },
              usage(5, cacheRead),
              { type: 'done', reason: 'stop' },
            ]
      }
      // Delegated so the `sent` stamp is bound to this request exactly as the core fake binds it.
      yield* fakeProvider([script]).infer(req, options)
    },
  }
  return p
}

/**
 * Every tool result follows an assistant that asked for it, with only results and user lines in
 * between, and every call is answered before the next assistant or the next user that is not the
 * compaction bridge. A summary request may end on `tool_result, user(instruction)`.
 */
export function assertPaired(req: RequestBody): string | undefined {
  const BRIDGE = '[harness] Earlier context was compacted'
  const messages = req.messages
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as WireMessage
    if (m.role === 'tool_result') {
      let k = i - 1
      while (k >= 0 && (messages[k]?.role === 'tool_result' || messages[k]?.role === 'user')) k--
      const owner = messages[k] as { role?: string; toolCalls?: Array<{ toolUseId: string }> } | undefined
      const id = (m as { toolUseId: string }).toolUseId
      if (owner?.role !== 'assistant' || !owner.toolCalls?.some((c) => c.toolUseId === id))
        return `message ${i}: tool result ${id} has no call before it`
    }
    if (m.role === 'assistant')
      for (const call of (m as { toolCalls?: Array<{ toolUseId: string }> }).toolCalls ?? []) {
        let answered = false
        for (let k = i + 1; k < messages.length; k++) {
          const next = messages[k] as WireMessage
          if (next.role === 'assistant') break
          if (next.role === 'user' && !messageText(next).some((t) => t.startsWith(BRIDGE))) break
          if (next.role === 'tool_result' && (next as { toolUseId: string }).toolUseId === call.toolUseId)
            answered = true
        }
        if (!answered) return `message ${i}: call ${call.toolUseId} is never answered`
      }
  }
  return undefined
}
