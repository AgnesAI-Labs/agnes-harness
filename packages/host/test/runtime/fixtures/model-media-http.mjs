import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'

// A model peer that journals every request it reads. Mode `ok` answers; mode `drop` reads the request,
// journals it and closes the connection without a byte of reply.
const [journal, mode = 'ok'] = process.argv.slice(2)
const server = createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += chunk
  const input = JSON.parse(body)
  appendFileSync(journal, `${JSON.stringify({ path: request.url, input })}\n`)
  if (mode === 'drop') return void request.socket.destroy()
  response.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'fixture-response' })
  const send = (data, event) =>
    response.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`)
  if (request.url.includes('messages')) {
    send(
      {
        type: 'message_start',
        message: {
          id: 'fixture-response',
          type: 'message',
          role: 'assistant',
          model: input.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 7, output_tokens: 0 },
        },
      },
      'message_start',
    )
    send(
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      'content_block_start',
    )
    send(
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'actual wire answer' } },
      'content_block_delta',
    )
    send({ type: 'content_block_stop', index: 0 }, 'content_block_stop')
    send(
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 3 },
      },
      'message_delta',
    )
    send({ type: 'message_stop' }, 'message_stop')
  } else {
    send({
      id: 'fixture-response',
      object: 'chat.completion.chunk',
      created: 1,
      model: input.model,
      choices: [
        { index: 0, delta: { role: 'assistant', content: 'actual wire answer' }, finish_reason: null },
      ],
    })
    send({
      id: 'fixture-response',
      object: 'chat.completion.chunk',
      created: 1,
      model: input.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    })
    response.write('data: [DONE]\n\n')
  }
  response.end()
})
server.listen(0, '127.0.0.1', () => process.send?.({ port: server.address().port }))
process.on('message', (value) => {
  if (value === 'close') server.close(() => process.exit(0))
})
