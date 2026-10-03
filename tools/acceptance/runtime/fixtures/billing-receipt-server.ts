import { appendFileSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { canonicalJsonDigest, validateRuntime } from '../../../../packages/protocol/src/runtime/index.js'

const log = process.argv[2]
if (!log) throw new Error('billing log required')
const receipts = new Map<string, { digest: string; entry: unknown }>()
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const data = JSON.parse(Buffer.concat(chunks).toString())
  appendFileSync(log, `${JSON.stringify({ path: req.url, body: data })}\n`, { mode: 0o600 })
  if (req.url === '/hang') return
  if (req.url === '/disconnect') {
    req.socket.destroy()
    return
  }
  const checked = validateRuntime('BillingEntry', data)
  if (!checked.ok) {
    res.writeHead(400)
    res.end('{}')
    return
  }
  const id = checked.value.externalRequestId ?? '',
    fingerprint = canonicalJsonDigest(checked.value),
    prior = receipts.get(id)
  if (prior && prior.digest !== fingerprint) {
    res.writeHead(409)
    res.end('{}')
    return
  }
  const entry = { ...checked.value, status: 'posted' as const }
  receipts.set(id, { digest: fingerprint, entry })
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(entry))
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
