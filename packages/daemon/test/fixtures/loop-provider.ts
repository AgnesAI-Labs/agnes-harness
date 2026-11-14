import { createServer } from 'node:http'

/** Scripted loopback responses only; no model or remote fallback. */
export async function startLoopProvider() {
  let blocking = false
  let entered: (() => void) | undefined
  let disconnected: (() => void) | undefined
  const requests: string[] = []
  let held: { entered: () => void; gate: Promise<void> } | undefined
  const attempts: {
    requestIndex: number
    enteredAt: number
    responseCloseAt: number | null
    requestAborted: boolean
    socketClosedAt: number | null
    socketDestroyed: () => boolean
    responseDestroyed: () => boolean
  }[] = []
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      messages: Array<{ role: string; content?: unknown }>
    }
    const messages = JSON.stringify(body.messages)
    requests.push(messages)
    // Hold and fail read only what follows the last reply, so a later turn of the session is unaffected.
    const newest = messages.includes('summarizing a chat')
      ? ''
      : JSON.stringify(
          body.messages.slice(body.messages.findLastIndex((message) => message.role === 'assistant') + 1),
        )
    if (newest.includes('FAIL_THIS_TURN')) {
      response.writeHead(500, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'scripted server failure', type: 'server_error' } }))
      return
    }
    if (held && newest.includes('HOLD_THIS_TURN')) {
      const release = held
      held = undefined
      release.entered()
      await release.gate
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.flushHeaders()
    if (blocking && messages.includes('Cancel this blocked turn')) {
      const attempt = {
        requestIndex: requests.length - 1,
        enteredAt: Date.now(),
        responseCloseAt: null as number | null,
        requestAborted: request.aborted,
        socketClosedAt: null as number | null,
        socketDestroyed: () => request.socket.destroyed,
        responseDestroyed: () => response.destroyed,
      }
      attempts.push(attempt)
      request.once('aborted', () => {
        attempt.requestAborted = true
      })
      request.socket.once('close', () => {
        attempt.socketClosedAt = Date.now()
      })
      response.once('close', () => {
        attempt.responseCloseAt = Date.now()
        disconnected?.()
      })
      entered?.()
      return
    }
    if (
      messages.includes('BUNDLE_WRITE_PROBE') &&
      !body.messages.some((message) => message.role === 'tool')
    ) {
      const event = { id: 'write-fixture', object: 'chat.completion.chunk', created: 0, model: 'loop-script' }
      response.write(
        `data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'bundle-write', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'bundle-must-not-write.txt', content: 'forbidden' }) } }] }, finish_reason: null }] })}\n\n`,
      )
      response.end(
        `data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
      )
      return
    }
    if (
      (messages.includes('CHANNEL_APPROVAL_ALLOW') || messages.includes('CHANNEL_APPROVAL_DENY')) &&
      !body.messages.some((message) => message.role === 'tool')
    ) {
      const allow = messages.includes('CHANNEL_APPROVAL_ALLOW')
      const event = {
        id: 'approval-fixture',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'loop-script',
      }
      const args = { command: `printf completed > approval-${allow ? 'allow' : 'deny'}.txt` }
      response.write(
        `data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'approval-shell', type: 'function', function: { name: 'shell', arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}\n\n`,
      )
      response.end(
        `data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
      )
      return
    }
    if (
      messages.includes('CHANNEL_QUESTION_PROBE') &&
      !body.messages.some((message) => message.role === 'tool')
    ) {
      const event = {
        id: 'question-fixture',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'loop-script',
      }
      const args = {
        questions: [
          { id: 'single', question: 'Pick one', options: ['A', 'B'] },
          { id: 'multi', question: 'Pick several', options: ['A', 'B'], multiple: true },
          { id: 'text', question: 'Explain' },
        ],
      }
      response.write(
        `data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'native-question', type: 'function', function: { name: 'ask_user_question', arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}\n\n`,
      )
      response.end(
        `data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
      )
      return
    }
    const content = messages.includes('<dag-planner-protocol>')
      ? '[]'
      : messages.includes('summarizing a chat')
        ? '{"title":"Example loop","keywords":[]}'
        : 'Refund window is 30 days.'
    const event = { id: 'loop-fixture', object: 'chat.completion.chunk', created: 0, model: 'loop-script' }
    response.write(
      `data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`,
    )
    response.end(
      `data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`,
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture listener unavailable')
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    diagnostics: () =>
      attempts.map(({ socketDestroyed, responseDestroyed, ...row }) => ({
        ...row,
        socketDestroyed: socketDestroyed(),
        responseDestroyed: responseDestroyed(),
      })),
    block() {
      blocking = true
      return {
        entered: new Promise<void>((resolve) => {
          entered = resolve
        }),
        disconnected: new Promise<void>((resolve) => {
          disconnected = resolve
        }),
      }
    },
    unblock() {
      blocking = false
    },
    /** Holds the next request whose newest message says HOLD_THIS_TURN until `release`, then answers. */
    hold() {
      let entered!: () => void
      let release!: () => void
      const reached = new Promise<void>((resolve) => {
        entered = resolve
      })
      held = { entered, gate: new Promise<void>((resolve) => (release = resolve)) }
      return { entered: reached, release }
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
