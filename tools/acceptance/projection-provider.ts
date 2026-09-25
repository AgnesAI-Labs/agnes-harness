import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

type Message = {
  role: string
  content: unknown
  tool_calls?: unknown[]
  tool_call_id?: string
}

type ToolCall = { name: string; args: Record<string, unknown> }

export type ProjectionProviderOptions = {
  /** Files under the session workspace the child tasks read; one path per parallel call. */
  childFiles: readonly string[]
  /** Parallel read calls per round, and rounds, of the oversized child task. */
  bigChildFanOut?: number
  bigChildRounds?: number
}

const MODEL = 'deepseek-flash'
// Catalogue ids differ between releases; offering both lets the daemon keep whichever it knows.
const OFFERED = [MODEL, 'deepseek-v4-flash']

/**
 * Deterministic loopback model for the Web projection acceptance. The latest task message selects
 * one scripted behaviour by marker:
 *
 * - `PJ_READ`: one `read` call, then an answer.
 * - `PJ_APPROVAL`: one `shell` call (which asks for approval), then an answer.
 * - `PJ_SPAWN_SMALL` / `PJ_SPAWN_BIG`: `subagent_spawn` of a child task, `subagent_collect` of its
 *   result, then an answer. The child task is `PJ_CHILD_SMALL` (one read) or `PJ_CHILD_BIG` (many
 *   rounds of parallel reads, enough spans to exceed a per-turn trace budget).
 * - `PJ_LONG bytes=<n> piece=<n> delay=<ms>`: a long answer streamed in small pieces.
 * - anything else: a short plain answer that echoes the marker.
 *
 * A request without the needed tool in its catalog (title or summary requests) always gets plain
 * text, so background requests never consume a scripted step.
 */
export async function startProjectionProvider(options: ProjectionProviderOptions) {
  const apiKey = randomBytes(24).toString('hex')
  const fanOut = options.bigChildFanOut ?? 50
  const rounds = options.bigChildRounds ?? 12
  let completions = 0
  let streaming = 0
  const streams: Array<{ bytes: number; pieces: number; startedAt: number; endedAt?: number }> = []

  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${apiKey}`) {
      response.writeHead(401).end('fixture authentication failed')
      return
    }
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ data: OFFERED.map((id) => ({ id })) }))
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
        messages: Message[]
        tools?: Array<{ function?: { name?: string } }>
      }
      completions++
      const available = new Set((body.tools ?? []).map((tool) => tool.function?.name).filter(Boolean))
      const lastUser = body.messages.findLastIndex(
        (message) =>
          message.role === 'user' && !JSON.stringify(message.content).includes('[runtime context]'),
      )
      const task = JSON.stringify(body.messages[lastUser]?.content ?? '')
      const after = body.messages.slice(lastUser + 1)
      const round = after.filter(
        (message) => message.role === 'assistant' && message.tool_calls?.length,
      ).length
      const results = after.filter((message) => message.role === 'tool')
      const lastResult = JSON.stringify(results.at(-1)?.content ?? '')

      const envelope = {
        id: `projection-${completions}`,
        object: 'chat.completion.chunk',
        created: 0,
        model: MODEL,
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const delta = (value: unknown, finish: string | null = null) => {
        if (!response.destroyed)
          response.write(
            `data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`,
          )
      }
      const answer = (text: string) => {
        delta({ role: 'assistant', content: text })
        delta({}, 'stop')
      }
      const call = (calls: ToolCall[]) => {
        delta({
          role: 'assistant',
          tool_calls: calls.map((entry, index) => ({
            index,
            id: `pj-${completions}-${index}`,
            type: 'function',
            function: { name: entry.name, arguments: JSON.stringify(entry.args) },
          })),
        })
        delta({}, 'tool_calls')
      }
      const can = (...names: string[]) => names.every((name) => available.has(name))
      const label = task.match(/PJ_[A-Z_]+(?: \d+)?/)?.[0] ?? 'plain'

      if (task.includes('PJ_CHILD_BIG') && can('read')) {
        if (round < rounds)
          call(
            Array.from({ length: fanOut }, (_, index) => ({
              name: 'read',
              args: { path: options.childFiles[(round * fanOut + index) % options.childFiles.length] },
            })),
          )
        else answer(`Child task finished after ${rounds} rounds of ${fanOut} reads.`)
      } else if (task.includes('PJ_CHILD_SMALL') && can('read')) {
        if (round === 0) call([{ name: 'read', args: { path: options.childFiles[0] } }])
        else answer('Child task read its file and finished.')
      } else if (/PJ_SPAWN_(SMALL|BIG)/.test(task) && can('subagent_spawn', 'subagent_collect')) {
        if (round === 0) {
          const size = task.includes('PJ_SPAWN_BIG') ? 'BIG' : 'SMALL'
          call([
            { name: 'subagent_spawn', args: { task: `PJ_CHILD_${size} for ${label}`, isolation: 'shared' } },
          ])
        } else if (round === 1) {
          const childKey = lastResult.match(/spawned ([^\s"<\\]+)/)?.[1]
          if (childKey) call([{ name: 'subagent_collect', args: { childKey, wait: true } }])
          else answer(`Spawn did not return a child handle for ${label}.`)
        } else answer(`Collected the child task for ${label}.`)
      } else if (/PJ_FORK_(SMALL|BIG)/.test(task) && can('subagent_fork')) {
        if (round === 0) {
          const size = task.includes('PJ_FORK_BIG') ? 'BIG' : 'SMALL'
          call([{ name: 'subagent_fork', args: { question: `PJ_CHILD_${size} for ${label}` } }])
        } else answer(`Forked child answered for ${label}.`)
      } else if (task.includes('PJ_READ') && can('read')) {
        if (round === 0) call([{ name: 'read', args: { path: options.childFiles[0] } }])
        else answer(`Read finished for ${label}.`)
      } else if (task.includes('PJ_APPROVAL') && can('shell')) {
        if (round === 0) {
          delta({ role: 'assistant', content: 'Running one approved command.\n' })
          call([{ name: 'shell', args: { command: "printf 'projection-ok\\n'" } }])
        } else answer(`Approved command returned for ${label}.`)
      } else if (task.includes('PJ_LONG') && available.size > 0) {
        const bytes = Number(task.match(/bytes=(\d+)/)?.[1] ?? 300_000)
        const piece = Number(task.match(/piece=(\d+)/)?.[1] ?? 100)
        const delay = Number(task.match(/delay=(\d+)/)?.[1] ?? 2)
        const record: (typeof streams)[number] = { bytes: 0, pieces: 0, startedAt: Date.now() }
        streams.push(record)
        streaming++
        try {
          delta({ role: 'assistant', content: '' })
          let line = 0
          while (record.bytes < bytes && !response.destroyed) {
            line++
            const head = `Line ${String(line).padStart(5, '0')} of the long answer. `
            const text = `${head.padEnd(piece - 1, '.')}\n`
            delta({ content: text })
            record.bytes += Buffer.byteLength(text)
            record.pieces++
            if (delay > 0) await new Promise((done) => setTimeout(done, delay))
          }
          delta({ content: '\nLONG_STREAM_END\n' })
          delta({}, 'stop')
        } finally {
          record.endedAt = Date.now()
          streaming--
        }
      } else {
        const index = task.match(/PJ_PLAIN (\d+)/)?.[1]
        answer(
          index === undefined
            ? `Plain answer for ${label}.`
            : `Answer ${index}: the synthetic session keeps a steady, readable history for the projection check.`,
        )
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
    model: MODEL,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    get completions() {
      return completions
    },
    get streaming() {
      return streaming
    },
    streams,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections()
        server.close(() => done())
      }),
  }
}
