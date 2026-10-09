import { createServer } from 'node:http'
/** A loopback OTLP/HTTP collector retaining decoded payloads only in memory. */
export async function memoryCollector() {
  let status = 200
  let gate: Promise<void> | undefined
  let partial: Record<string, string> | undefined
  const requests: Array<{ path: string; body: Record<string, unknown> }> = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push({
      path: request.url ?? '',
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
    })
    await gate
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(partial ? { partialSuccess: partial } : {}))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Collector did not listen')
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    refuse(code: number) {
      status = code
    },
    hold(pending?: Promise<void>) {
      gate = pending
    },
    partial(value?: Record<string, string>) {
      partial = value
    },
    close: () =>
      new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}
