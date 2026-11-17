import { createServer } from 'node:http'
import { createWebDocumentResponder } from './server-document.js'
import { listen } from './server-http.js'

/** Separate origin, separate listener, static build assets only. No owner handlers are installed. */
export async function createCloudFrameServer(
  options: Omit<Parameters<typeof createWebDocumentResponder>[0], 'frameOrigin'>,
) {
  let serve: ReturnType<typeof createWebDocumentResponder> | undefined
  const server = createServer(async (request, response) => {
    try {
      const address = server.address()
      if (
        !address ||
        typeof address === 'string' ||
        request.headers.host !== `127.0.0.1:${address.port}` ||
        (request.method !== 'GET' && request.method !== 'HEAD')
      ) {
        request.resume()
        response.writeHead(403).end()
        return
      }
      if (!serve) {
        response.writeHead(503).end()
        return
      }
      await serve(request, response, true)
    } catch {
      response.writeHead(404).end()
    }
  })
  server.on('upgrade', (_request, socket) => socket.destroy())
  const bound = await listen(server, 0)
  const origin = `http://127.0.0.1:${bound.port}`
  serve = createWebDocumentResponder({ ...options, frameOrigin: origin })
  return {
    serve,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  }
}
