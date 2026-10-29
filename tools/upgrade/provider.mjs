import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'

export async function provider(port = 0) {
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
    // Runtime context can follow the person's message as another user-role envelope.
    const lastUser = body.messages.findLastIndex(
      (message) =>
        message.role === 'user' &&
        /upgrade (?:plain|tool|attachment|present|queue|fork|hold)/.test(JSON.stringify(message.content)),
    )
    const text = JSON.stringify(body.messages[lastUser]?.content) ?? ''
    const calls = body.messages.slice(lastUser + 1).flatMap((message) => message.tool_calls ?? [])
    const offered = body.tools?.map((row) => row.function.name) ?? []
    let tool
    if (offered.length) {
      const desired = text.includes('upgrade tool')
        ? { name: 'read', arguments: { path: 'input.txt' } }
        : text.includes('upgrade present')
          ? { name: 'present', arguments: { files: [{ path: 'report.html', name: 'Upgrade report' }] } }
          : undefined
      if (desired && !calls.some((row) => row.function.name === desired.name)) {
        tool = offered.includes(desired.name)
          ? desired
          : { name: 'tool_describe', arguments: { name: desired.name } }
      }
    }
    const event = { id: 'synthetic-upgrade', object: 'chat.completion.chunk', created: 0, model: body.model }
    if (text.includes('upgrade hold') && offered.length) await delay(1500)
    if (res.destroyed) return
    const delta = tool
      ? {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `synthetic-tool-${body.messages.length}`,
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
    server.listen(port, '127.0.0.1', resolve)
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
