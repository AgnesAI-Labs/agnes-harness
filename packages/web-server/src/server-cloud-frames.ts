import { createServer } from 'node:http'
import { serveDeliverablePreview } from './deliverable-preview-frame.js'
import { servePdfPreview } from './pdf-preview-frame.js'
import { createWebDocumentResponder } from './server-document.js'
import { listen } from './server-http.js'
import type { WebServerOptions } from './server-types.js'
import { serveUiComponentFrame } from './ui-component-frame.js'

/** Separate origin for build assets and capability-scoped B transport. No A owner handlers. */
export async function createCloudFrameServer(
  options: Omit<Parameters<typeof createWebDocumentResponder>[0], 'frameOrigin'> &
    Pick<WebServerOptions, 'cloudGateway'>,
) {
  let serve: ReturnType<typeof createWebDocumentResponder> | undefined
  const server = createServer(async (request, response) => {
    try {
      const address = server.address()
      if (!address || typeof address === 'string' || request.headers.host !== `127.0.0.1:${address.port}`) {
        request.resume()
        response.writeHead(403).end()
        return
      }
      if (await options.cloudGateway?.handleHttp(request, response)) return
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        request.resume()
        response.writeHead(403).end()
        return
      }
      if (serveDeliverablePreview(request, response)) return
      if (servePdfPreview(request, response)) return
      if (serveUiComponentFrame(request, response)) return
      if (!serve) {
        response.writeHead(503).end()
        return
      }
      await serve(request, response, true)
    } catch {
      response.writeHead(404).end()
    }
  })
  server.on('upgrade', (request, socket, head) => {
    if (request.headers.host !== new URL(origin).host) {
      socket.destroy()
      return
    }
    void options.cloudGateway
      ?.handleUpgrade(request, socket, head)
      .then((handled) => {
        if (!handled) socket.destroy()
      })
      .catch(() => socket.destroy())
    if (!options.cloudGateway) socket.destroy()
  })
  const bound = await listen(server, 0)
  const origin = `http://127.0.0.1:${bound.port}`
  serve = createWebDocumentResponder({ ...options, frameOrigin: origin })
  return {
    serve,
    close: () =>
      new Promise<void>((resolve, reject) => {
        options.cloudGateway?.close()
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  }
}
