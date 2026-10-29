import { createServer } from 'node:http'
import { mcpStablePrefix } from '@agnes/base'

type ProviderMessage = {
  role: string
  content?: unknown
  tool_call_id?: string
  tool_calls?: Array<{ id: string; function: { name: string } }>
}

// The prefix is register.ts's tool naming for the 'pager' fixture server, computed via the shared
// function rather than hardcoded (design 2026-09-23-mcp-tool-name-collision-design.md §0.4).
const PAGER_TOOL120 = `${mcpStablePrefix('pager')}tool120`

export function latestMcpCase(messages: ProviderMessage[]) {
  let lastUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    if (lastUserIndex < 0) lastUserIndex = index
    const command = /MC_CASE:(\w+):(\w+)/.exec(JSON.stringify(message.content))
    if (command) {
      const [, marker = 'unknown', behavior = 'ok'] = command
      return { marker, behavior, userIndex: index }
    }
  }
  return { marker: 'unknown', behavior: 'ok', userIndex: lastUserIndex }
}

/** Deterministic protocol driver only; this is not a real-model acceptance test. */
export async function mcpChatProvider() {
  const observations: Array<{ marker: string; tools: string[]; result: string }> = []
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'deepseek-flash' }] }))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      model: string
      messages: ProviderMessage[]
      tools?: Array<{ function: { name: string } }>
    }
    const { marker, behavior, userIndex } = latestMcpCase(body.messages)
    const turn = body.messages.slice(userIndex + 1)
    const results = turn.filter((message) => message.role === 'tool')
    const tools = body.tools?.map((tool) => tool.function.name) ?? []
    const result = JSON.stringify(results)
    observations.push({ marker, tools, result })
    const visible = tools.includes(PAGER_TOOL120)
    const calls = new Map(
      turn.flatMap(
        (message) => message.tool_calls?.map((call) => [call.id, call.function.name] as const) ?? [],
      ),
    )
    const searched = results.some(
      (message) =>
        calls.get(message.tool_call_id ?? '') === 'tool_search' &&
        JSON.stringify(message.content).includes(PAGER_TOOL120),
    )
    // Error text may name the tool too; result identity, not its wording, proves the call finished.
    const called = results.some((message) => calls.get(message.tool_call_id ?? '') === PAGER_TOOL120)
    const noTool = !visible && results.length > 0 && (!searched || results.length >= 2)
    const finished = called || noTool
    const text = result.includes(`MCP_RESULT_${marker}`)
      ? `VERIFIED_${marker}`
      : result.includes(`MCP_FAILURE_${marker}`)
        ? `FAILED_${marker}`
        : noTool
          ? `ABSENT_${marker}`
          : `UNAVAILABLE_${marker}`
    // Search finds a deferred name; describe must load its schema before the fixture can call it.
    const name = visible ? PAGER_TOOL120 : searched ? 'tool_describe' : 'tool_search'
    const args = visible ? { marker, behavior } : searched ? { name: PAGER_TOOL120 } : { query: 'tool120' }
    const delta = finished
      ? { content: text }
      : {
          tool_calls: [
            {
              index: 0,
              id: `call-${marker}-${results.length}`,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        }
    const event = { id: 'fixture', object: 'chat.completion.chunk', created: 0, model: body.model }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(
      `data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    )
    res.end(
      `data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta: {}, finish_reason: finished ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\ndata: [DONE]\n\n`,
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing provider address')
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    observations,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
