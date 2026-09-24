import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

/** Deterministic loopback model driving real tools and approvals, never synthetic UI events. */
export async function startWorkbenchProvider(
  options: { holdApproval?: boolean; richText?: string; dshToolName?: string } = {},
) {
  const apiKey = randomBytes(24).toString('hex')
  let completions = 0
  let continueTool: (() => void) | undefined
  let continueRequested = false
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${apiKey}`) {
      response.writeHead(401).end('fixture authentication failed')
      return
    }
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }] }))
      return
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        messages: Array<{ role: string; content: unknown; tool_call_id?: string }>
      }
      const lastUser = body.messages.findLastIndex((message) => message.role === 'user')
      // Different model adapters may wrap the prompt in a non-`user` message.  The
      // fixture must still recognize its deterministic control input, while the
      // normal path keeps using the latest user turn so old tool directives do not
      // leak into a later request.
      const latestTaskUser = body.messages
        .toReversed()
        .find(
          (message) =>
            message.role === 'user' && !JSON.stringify(message.content).includes('[runtime context]'),
        )
      const user = JSON.stringify(
        latestTaskUser?.content ?? body.messages[lastUser]?.content ?? body.messages,
      )
      const results = body.messages.slice(lastUser + 1).filter((message) => message.role === 'tool')
      completions++
      if (user.includes('WB_PROVIDER_ERROR')) {
        response.writeHead(401).end('controlled provider rejection')
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const envelope = {
        id: `workbench-${completions}`,
        object: 'chat.completion.chunk',
        created: 0,
        model: 'deepseek-v4-flash',
      }
      const delta = (value: unknown, finish: string | null = null) => {
        if (!response.destroyed)
          response.write(
            `data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`,
          )
      }
      const hasTools = /WB_APPROVAL|WB_FAILURE|WB_CANCEL|WB_REJECT|WB_DSH_BASH/.test(user)
      if (hasTools && !results.length) {
        delta({ role: 'assistant', content: '我会先检查工作目录，再执行这次受控命令。\n' })
        if (options.holdApproval && /WB_APPROVAL|WB_DSH_BASH/.test(user)) {
          await new Promise<void>((done) => {
            const release = () => {
              continueTool = undefined
              continueRequested = false
              done()
            }
            continueTool = release
            if (continueRequested) release()
            response.once('close', () => {
              continueTool = undefined
              done()
            })
          })
        }
        const command = user.includes('WB_CANCEL')
          ? 'sleep 30'
          : user.includes('WB_FAILURE')
            ? "sh -c 'printf workbench-failure >&2; exit 7'"
            : "printf 'workbench-ok\\n'"
        const toolName = user.includes('WB_DSH_BASH') ? (options.dshToolName ?? 'bash') : 'shell'
        delta({
          tool_calls: [
            {
              index: 0,
              id: `wb-${toolName}-${completions}`,
              type: 'function',
              function: { name: toolName, arguments: JSON.stringify({ command }) },
            },
          ],
        })
        delta({}, 'tool_calls')
      } else if (user.includes('WB_MARKDOWN') && options.richText) {
        delta({ role: 'assistant', content: '' })
        for (let at = 0; at < options.richText.length && !response.destroyed; at += 24) {
          delta({ content: options.richText.slice(at, at + 24) })
          await new Promise((done) => setTimeout(done, 100))
        }
        delta({}, 'stop')
      } else if (user.includes('WB_STREAM')) {
        delta({ role: 'assistant', content: '## 工作区检查记录\n\n' })
        for (let index = 1; index <= 50 && !response.destroyed; index++) {
          delta({ content: `第 ${index} 项：保持执行记录可读，工具输出来自真实后台。\n\n` })
          await new Promise((done) => setTimeout(done, 65))
        }
        delta({ content: '\n检查完成。<script>window.workbenchUnsafe = true</script>\n' })
        delta({}, 'stop')
      } else {
        delta({
          role: 'assistant',
          content: results.length
            ? (options.richText ?? '工具结果已经返回，本次受控任务已结束。')
            : 'Web 工作台真实后台连接测试完成。',
        })
        delta({}, 'stop')
      }
      if (!response.destroyed) response.end('data: [DONE]\n\n')
    } catch {
      if (!response.headersSent) response.writeHead(400)
      response.end('invalid fixture request')
    }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('provider fixture failed to bind')
  return {
    apiKey,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    get completions() {
      return completions
    },
    continueTool: () => {
      if (continueTool) continueTool()
      else continueRequested = true
    },
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections()
        server.close(() => done())
      }),
  }
}
