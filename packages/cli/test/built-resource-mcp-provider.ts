import { createServer } from 'node:http'
import { mcpLocalToolPrefix } from '@agnes/base'

type ProviderMessage = { role: string; content?: unknown }

// The prefix is register.ts's tool naming for the 'pager' fixture server, computed via the shared
// function rather than hardcoded (design 2026-09-23-mcp-tool-name-collision-design.md §0.4).
const PAGER_TOOL120 = `${mcpLocalToolPrefix('pager')}tool120`

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
    const results = body.messages.slice(userIndex + 1).filter((message) => message.role === 'tool')
    const tools = body.tools?.map((tool) => tool.function.name) ?? []
    const result = JSON.stringify(results)
    observations.push({ marker, tools, result })
    const called = results.some((message) => !JSON.stringify(message.content).includes(PAGER_TOOL120))
    const visible = tools.includes(PAGER_TOOL120)
    const noTool = !visible && results.length > 0
    // Search only if the tool is deferred. A missing catalog cannot turn into a fabricated call.
    const finished = called || noTool
    const text = result.includes(`MCP_RESULT_${marker}`)
      ? `VERIFIED_${marker}`
      : result.includes(`MCP_FAILURE_${marker}`)
        ? `FAILED_${marker}`
        : noTool
          ? `ABSENT_${marker}`
          : `UNAVAILABLE_${marker}`
    const delta = finished
      ? { content: text }
      : {
          tool_calls: [
            {
              index: 0,
              id: `call-${marker}-${results.length}`,
              type: 'function',
              function: {
                name: visible ? PAGER_TOOL120 : 'tool_search',
                arguments: JSON.stringify(visible ? { marker, behavior } : { query: 'tool120' }),
              },
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
