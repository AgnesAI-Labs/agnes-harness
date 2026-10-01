import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createFileConfigProvider } from '../../src/runtime/providers/config.js'

const command = process.argv[2]

if (command === 'serve') {
  const schema = JSON.parse(process.env.AGNES_CONFIG_SCHEMA ?? 'null') as unknown
  const documents: Record<string, unknown> = {
    '1': { revision: 1, schema, value: { name: 'pinned', meta: { a: 1 } } },
    '2': { revision: 2, schema, value: { name: 'newer', meta: { a: 2 } } },
  }
  const server = createServer((request, response) => {
    const name = new URL(request.url ?? '/', 'http://127.0.0.1').pathname.replace(/^\//, '')
    const document = documents[name]
    if (document === undefined) {
      response.writeHead(404)
      response.end()
      return
    }
    process.stdout.write(`request ${name}\n`)
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(document))
  })
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (address === null || typeof address === 'string') {
      process.stderr.write('missing port\n')
      process.exit(1)
    }
    process.stdout.write(`ready ${address.port}\n`)
  })
} else if (command === 'read') {
  const path = process.argv[3]
  const revisionArg = process.argv[4]
  if (path === undefined) {
    process.stderr.write('usage: read <file> [revision]\n')
    process.exit(2)
  }
  const revision = revisionArg === undefined ? null : Number(revisionArg)
  let loads = 0
  const opened = createFileConfigProvider(() => {
    loads += 1
    return readFileSync(path, 'utf8')
  })
  const refusal = opened.source.refresh('local')
  if (refusal) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: refusal.code, loads })}\n`)
    process.exit(0)
  }
  const read = opened.provider.read({ sourceRef: 'local', revision })
  if (!read.ok) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: read.refusal.code, loads })}\n`)
    process.exit(0)
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, digest: read.result.digest, revision: read.result.revision, loads })}\n`,
  )
  process.exit(0)
} else {
  process.stderr.write('usage: serve | read <file> [revision]\n')
  process.exit(2)
}
