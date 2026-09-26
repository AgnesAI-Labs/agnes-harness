import { createServer, type Server } from 'node:http'

export type WireApi = 'anthropic-messages' | 'openai-completions' | 'openai-responses'
export type CapturedRequest = { api: WireApi; raw: string; body: unknown }
export type WireReply = { text: string } | { toolCall: { name: string; args: Record<string, unknown> } }

const apis: readonly WireApi[] = ['anthropic-messages', 'openai-completions', 'openai-responses']
const bytes = (value: string) => Buffer.byteLength(value, 'utf8')

function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'cache_control')
        .map(([key, child]) => [key, withoutCacheControl(child)]),
    )
  }
  return value
}

export function renderedParts(request: CapturedRequest): Array<{ key: string; bytes: string }> {
  const body = request.body as Record<string, unknown>
  const parts: Array<{ key: string; bytes: string }> = []
  const add = (key: string, value: unknown) => {
    if (value !== undefined) parts.push({ key, bytes: JSON.stringify(withoutCacheControl(value)) })
  }
  add('tools', body.tools)
  if (request.api === 'openai-responses') {
    add('instructions', body.instructions)
    for (const [index, item] of ((body.input as unknown[]) ?? []).entries()) add(`input[${index}]`, item)
  } else if (request.api === 'openai-completions') {
    const messages = (body.messages as Array<Record<string, unknown>>) ?? []
    const system = messages.filter((message) => message.role === 'system')
    add('system', system)
    for (const [index, message] of messages.filter((item) => item.role !== 'system').entries()) {
      add(`messages[${index}]`, message)
    }
  } else {
    add('system', body.system)
    for (const [index, message] of ((body.messages as unknown[]) ?? []).entries()) {
      add(`messages[${index}]`, message)
    }
  }
  return parts
}

export function sharedPrefix(
  previous: CapturedRequest,
  next: CapturedRequest,
): { shared: number; prevTotal: number; breakAt: string | null } {
  const before = renderedParts(previous)
  const after = renderedParts(next)
  const prevTotal = before.reduce((sum, part) => sum + bytes(part.bytes), 0)
  let shared = 0
  for (let index = 0; index < before.length; index++) {
    const left = before[index]
    const right = after[index]
    if (!left || !right || left.key !== right.key) return { shared, prevTotal, breakAt: left?.key ?? null }
    if (left.bytes !== right.bytes) {
      const leftBytes = Buffer.from(left.bytes)
      const rightBytes = Buffer.from(right.bytes)
      let match = 0
      while (
        match < leftBytes.length &&
        match < rightBytes.length &&
        leftBytes[match] === rightBytes[match]
      ) {
        match++
      }
      return { shared: shared + match, prevTotal, breakAt: left.key }
    }
    shared += bytes(left.bytes)
  }
  return { shared, prevTotal, breakAt: null }
}

export function expectExtends(
  previous: CapturedRequest,
  next: CapturedRequest,
  options: { throughMessage?: number } = {},
): void {
  const before = renderedParts(previous).filter((part) => {
    if (options.throughMessage === undefined) return true
    const match = part.key.match(/^(?:messages|input)\[(\d+)\]$/u)
    return !match || Number(match[1]) < options.throughMessage
  })
  const after = renderedParts(next)
  for (const [index, left] of before.entries()) {
    const right = after[index]
    if (left.key !== right?.key || left.bytes !== right.bytes) {
      throw new Error(
        `Wire prefix diverged at ${left.key}: previous=${left.bytes.slice(0, 80)} next=${right?.bytes.slice(0, 80) ?? '<missing>'}`,
      )
    }
  }
}

function replySse(api: WireApi, body: Record<string, unknown>, reply: WireReply): string {
  const text = 'text' in reply ? reply.text : ''
  const tool = 'toolCall' in reply ? reply.toolCall : undefined
  const inputTokens = Math.max(1, Math.ceil(bytes(JSON.stringify(body)) / 4))
  if (api === 'anthropic-messages') {
    const events: Array<[string, unknown]> = [
      [
        'message_start',
        {
          type: 'message_start',
          message: {
            id: 'wire-capture',
            type: 'message',
            role: 'assistant',
            content: [],
            model: body.model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: inputTokens, output_tokens: 0 },
          },
        },
      ],
      [
        'content_block_start',
        {
          type: 'content_block_start',
          index: 0,
          content_block: tool
            ? { type: 'tool_use', id: 'wire-tool', name: tool.name, input: {} }
            : { type: 'text', text: '' },
        },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 0,
          delta: tool
            ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.args) }
            : { type: 'text_delta', text },
        },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      [
        'message_delta',
        {
          type: 'message_delta',
          delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
          usage: { output_tokens: 1 },
        },
      ],
      ['message_stop', { type: 'message_stop' }],
    ]
    return events.map(([event, value]) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`).join('')
  }
  if (api === 'openai-responses') {
    const item = tool
      ? {
          type: 'function_call',
          id: 'wire-function',
          call_id: 'wire-tool',
          name: tool.name,
          arguments: JSON.stringify(tool.args),
        }
      : { type: 'message', id: 'wire-message', role: 'assistant', content: [] }
    const events: Array<[string, unknown]> = [
      ['response.created', { type: 'response.created', response: { id: 'wire-capture' } }],
      ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item }],
      [
        tool ? 'response.function_call_arguments.delta' : 'response.output_text.delta',
        tool
          ? {
              type: 'response.function_call_arguments.delta',
              output_index: 0,
              delta: JSON.stringify(tool.args),
            }
          : { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
      ],
      ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
      [
        'response.completed',
        {
          type: 'response.completed',
          response: {
            id: 'wire-capture',
            status: 'completed',
            output: [item],
            usage: { input_tokens: inputTokens, output_tokens: 1, total_tokens: inputTokens + 1 },
          },
        },
      ],
    ]
    return events.map(([event, value]) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`).join('')
  }
  const delta =
    'toolCall' in reply
      ? {
          tool_calls: [
            {
              index: 0,
              id: 'wire-tool',
              type: 'function',
              function: { name: reply.toolCall.name, arguments: JSON.stringify(reply.toolCall.args) },
            },
          ],
        }
      : { role: 'assistant', content: text }
  const chunk = {
    id: 'wire-capture',
    object: 'chat.completion.chunk',
    created: 0,
    model: body.model,
    choices: [{ index: 0, delta, finish_reason: null }],
  }
  const finish = {
    ...chunk,
    choices: [{ index: 0, delta: {}, finish_reason: 'toolCall' in reply ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: inputTokens, completion_tokens: 1, total_tokens: inputTokens + 1 },
  }
  return `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`
}

export async function startWireCapture(script: (body: unknown, api: WireApi) => WireReply) {
  const requests: CapturedRequest[] = []
  const server: Server = createServer(async (request, response) => {
    const api = request.url?.split('/')[1] as WireApi
    if (!apis.includes(api)) {
      response.writeHead(404)
      response.end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = JSON.parse(raw) as Record<string, unknown>
    requests.push({ api, raw, body })
    const reply = script(body, api)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(replySse(api, body, reply))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing loopback address')
  return {
    requests,
    baseUrl: (api: WireApi) => `http://127.0.0.1:${address.port}/${api}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}
