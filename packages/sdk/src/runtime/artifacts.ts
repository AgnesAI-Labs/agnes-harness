// Artifact access over the runtime client wire: authorized descriptions, download tickets and verified
// byte reads. The SDK never navigates by itself. A ticket is followed only through the deployment's
// own follower, only when this client issued it, before it expires, and only on this deployment's
// download route; any other URL, including one a ticket was edited to name, is refused.
import {
  type ArtifactClientOpenDownloadRequest,
  type ArtifactDownloadTicket,
  RuntimeClientTransportWire,
} from '@agnes/protocol/runtime'
import { artifactReader } from './artifact-reader.js'
import { type CallResult, localRuntimeError, type RuntimeClientTransport } from './client-transport.js'

const download = RuntimeClientTransportWire.routes.download.path.replace('{ticketId}', '')
/** One encoded ticket id and its nonce, exactly as the route reads them. */
const TICKET_PATH = /^[^/?#]+\?nonce=[A-Za-z0-9_-]+$/

export type ArtifactClientOptions = {
  /** Opens or saves a verified absolute download URL, as the platform does it. Without one, following
   * a ticket is refused as not supported and the caller delivers the ticket itself. */
  followDownload?: (url: string) => void
  now?: () => number
}

export function artifactClient(transport: RuntimeClientTransport, options: ArtifactClientOptions = {}) {
  const now = options.now ?? Date.now
  const issued = new WeakSet<ArtifactDownloadTicket>()
  const { readRange, openStream } = artifactReader(transport)
  return {
    describe: (artifactId: string, version: number, signal?: AbortSignal) =>
      transport.query('artifact.describe', { artifactId, version }, signal),
    async openDownload(
      request: ArtifactClientOpenDownloadRequest,
      signal?: AbortSignal,
    ): Promise<CallResult<ArtifactDownloadTicket>> {
      const result = await transport.command('artifact.openDownload', request, signal)
      // Frozen, so the ticket this client remembers is the one the server issued.
      if (result.state === 'ok') issued.add(Object.freeze(result.value))
      return result
    },
    readRange,
    openStream,
    followDownload(ticket: ArtifactDownloadTicket): CallResult<void> {
      if (
        !issued.has(ticket) ||
        !ticket.url.startsWith(download) ||
        !TICKET_PATH.test(ticket.url.slice(download.length))
      )
        return { state: 'refused', reason: 'invalid-request' }
      if (!(Date.parse(ticket.expiresAt) > now()))
        return {
          state: 'failed',
          error: localRuntimeError('denied', 'ticket_expired', 'download ticket expired'),
        }
      if (!options.followDownload)
        return {
          state: 'failed',
          error: localRuntimeError(
            'incompatible',
            'operation_not_supported',
            'no download follower is installed',
          ),
        }
      options.followDownload(transport.url(ticket.url))
      return { state: 'ok', value: undefined }
    },
  }
}
