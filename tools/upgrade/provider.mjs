import assert from 'node:assert/strict'
import { createServer } from 'node:http'

export async function provider() {
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer upgrade-test')
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'deepseek-flash' }] }))
      return
    }
    const parts = []
    for await (const part of req) parts.push(part)
    const body = JSON.parse(Buffer.concat(parts).toString())
    const lastUser = body.messages.findLastIndex((message) => message.role === 'user')
    const text = JSON.stringify(body.messages[lastUser]?.content)
    const toolResult = body.messages.slice(lastUser + 1).some((message) => message.role === 'tool')
    let tool
    if (body.tools?.length && !toolResult) {
      if (text.includes('upgrade tool')) tool = { name: 'read', arguments: { path: 'input.txt' } }
      if (text.includes('upgrade present'))
        tool = { name: 'present', arguments: { files: [{ path: 'report.html', name: 'Upgrade report' }] } }
    }
    const event = { id: 'synthetic-upgrade', object: 'chat.completion.chunk', created: 0, model: body.model }
    const delta = tool
      ? {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'synthetic-tool',
              type: 'function',
              function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
            },
          ],
        }
      : { role: 'assistant', content: 'Synthetic upgrade reply. 中文' }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(
      `data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    )
    res.end(
      `data: ${JSON.stringify({
        ...event,
        choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 },
      })}\n\ndata: [DONE]\n\n`,
    )
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(resolve)
      }),
  }
}
