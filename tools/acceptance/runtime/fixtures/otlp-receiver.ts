import { appendFileSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { validateRuntime } from '../../../../packages/protocol/src/runtime/index.js'

// Synthetic OTLP/HTTP JSON receiver. Executable code belongs only to this fixture.
const log = process.argv[2]
if (!log) throw new Error('receiver log required')
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const body = Buffer.concat(chunks)
  appendFileSync(log, `${JSON.stringify({ path: req.url, body: JSON.parse(body.toString()) })}\n`, {
    mode: 0o600,
  })
  if (req.url === '/hang') return
  if (req.url === '/disconnect') {
    req.socket.destroy()
    return
  }
  const document = JSON.parse(body.toString())
  const spans = document.resourceSpans?.flatMap((r: { scopeSpans: { spans: unknown[] }[] }) =>
    r.scopeSpans.flatMap((s) => s.spans),
  )
  const valid =
    req.url === '/trajectory'
      ? validateRuntime('StandardToolOutput', document).ok
      : Array.isArray(spans) &&
        spans.every(
          (s) =>
            /^[0-9a-f]{32}$/.test(s.traceId) &&
            /^[0-9a-f]{16}$/.test(s.spanId) &&
            (s.parentSpanId === undefined || /^[0-9a-f]{16}$/.test(s.parentSpanId)) &&
            /^\d+$/.test(s.startTimeUnixNano) &&
            Array.isArray(s.attributes),
        )
  res.writeHead(valid ? 200 : 400, { 'content-type': 'application/json' })
  res.end(valid ? '{}' : '{"error":"invalid OTLP"}')
})
server.listen(0, '127.0.0.1', () =>
  process.send?.({ port: (server.address() as { port: number }).port, pid: process.pid }),
)
process.on('message', (message) => {
  if (message === 'inspect')
    process.send?.({
      records: readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    })
})
