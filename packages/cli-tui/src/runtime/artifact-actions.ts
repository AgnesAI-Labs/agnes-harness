// Artifact actions the user asks for by name: describe, link and download. Nothing here runs on its own
// or retries. A link is issued only on request and handed to the caller alone, shown once with its
// expiry; it is not kept or written anywhere. A download goes to the path the user gave, never to one
// built from server fields: bytes land in `<path>.part`, which becomes the file only after the stream's
// end summary matches what was written, and an existing file is replaced only once the user confirms.
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { rename, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type {
  ArtifactClientOpenDownloadRequest,
  ArtifactClientOpenStreamRequest,
  ArtifactDescribeInput,
  ArtifactDownloadTicket,
  ArtifactReadStreamEndResult,
  ArtifactViewRef,
  ClientArtifactStreamMetadata,
} from '@agnes/protocol/runtime'
import { escapeServerText } from '../component.js'
import { type LocaleKey, t } from '../locale.js'
import { linkUrl, type RuntimeCallResult } from './ports.js'

/** The SDK artifact reader's stream, restated like the call result; `ended` is the server's own summary. */
export type ArtifactByteStream = Readonly<{
  metadata: ClientArtifactStreamMetadata
  chunks: AsyncIterable<Uint8Array>
  ended: Promise<RuntimeCallResult<ArtifactReadStreamEndResult>>
  cancel(reason: string): Promise<void>
}>
export type ArtifactPorts = Readonly<{
  describe(input: ArtifactDescribeInput): Promise<RuntimeCallResult<ArtifactViewRef>>
  openDownload(input: ArtifactClientOpenDownloadRequest): Promise<RuntimeCallResult<ArtifactDownloadTicket>>
  openStream(input: ArtifactClientOpenStreamRequest): Promise<RuntimeCallResult<ArtifactByteStream>>
}>
export type ArtifactTarget = Readonly<{ artifactId: string; version: number }>
export type ArtifactResult = Readonly<{
  state: 'done' | 'exists' | 'revoked' | 'expired' | 'failed' | 'interrupted'
  text: string
}>

const oneLine = (text: string) => escapeServerText(text).replace(/\n/g, ' ')
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )

export function createArtifactActions(options: { ports: ArtifactPorts; baseUrl: string; locale: string }) {
  const { ports, baseUrl, locale } = options
  const result = (
    state: ArtifactResult['state'],
    key: LocaleKey,
    vars: Record<string, string | number> = {},
  ) => ({
    state,
    text: t(key, locale, vars),
  })

  /** A refusal the user can act on: access revoked, a ticket to request again, or the reason itself. */
  function failure(call: Exclude<RuntimeCallResult<unknown>, { state: 'ok' }>): ArtifactResult {
    if (call.state !== 'failed')
      return result('failed', 'runtime.artifact.failed', { reason: oneLine(call.reason) })
    // Every artifact refusal shares the `denied` code, so the detail code tells them apart.
    const { detailCode, message } = call.error
    if (detailCode === 'revoked' || detailCode === 'permission_denied')
      return result('revoked', 'runtime.artifact.revoked')
    if (detailCode === 'ticket_expired') return result('expired', 'runtime.artifact.expired')
    return result('failed', 'runtime.artifact.failed', { reason: oneLine(message) })
  }

  return {
    /** Title, type, size, version and state only; where the bytes are stored is never shown. */
    async describe(target: ArtifactTarget): Promise<ArtifactResult> {
      const described = await ports.describe(target)
      if (described.state !== 'ok') return failure(described)
      const { title, mime, size, version, status } = described.value
      return result('done', 'runtime.artifact.describe', {
        title: oneLine(title ?? '-'),
        mime: oneLine(mime ?? '-'),
        size: size ?? '-',
        version,
        status,
      })
    },

    /** One download ticket as a link to open once; an expired one is requested again, never renewed here. */
    async link(target: ArtifactTarget): Promise<ArtifactResult> {
      const ticket = await ports.openDownload({ ...target, disposition: 'attachment' })
      if (ticket.state !== 'ok') return failure(ticket)
      const url = linkUrl(baseUrl, ticket.value.url)
      if (url === undefined) return result('failed', 'runtime.artifact.failed', { reason: 'invalid link' })
      return result('done', 'runtime.artifact.link', {
        url: oneLine(url),
        expiresAt: oneLine(ticket.value.expiresAt),
      })
    },

    /**
     * Writes the artifact to `path` through `<path>.part`. A revoked artifact or a digest mismatch removes
     * the part file; any other interruption leaves it, never as the finished file, and a later download
     * starts a new stream from the beginning.
     */
    async download(target: ArtifactTarget, path: string, replace = false): Promise<ArtifactResult> {
      const file = resolve(path)
      const part = `${file}.part`
      const shown = { path: oneLine(file) }
      if (!replace && (await exists(file))) return result('exists', 'runtime.artifact.exists', shown)
      const opened = await ports.openStream(target)
      if (opened.state !== 'ok') return failure(opened)
      const stream = opened.value
      const hash = createHash('sha256')
      let bytes = 0
      async function* counted() {
        for await (const chunk of stream.chunks) {
          hash.update(chunk)
          bytes += chunk.length
          yield chunk
        }
      }
      try {
        await pipeline(counted(), createWriteStream(part, { flags: 'w' }))
      } catch {
        await stream.cancel('download not written')
        return result('interrupted', 'runtime.artifact.interrupted', shown)
      }
      const end = await stream.ended
      if (end.state !== 'ok') {
        const refused = failure(end)
        if (refused.state === 'revoked') await rm(part, { force: true })
        return end.state === 'failed' ? refused : result('interrupted', 'runtime.artifact.interrupted', shown)
      }
      if (end.value.bytes !== bytes || end.value.digest !== hash.digest('hex')) {
        await rm(part, { force: true })
        return result('failed', 'runtime.artifact.integrity')
      }
      // The file may have appeared while the bytes were arriving.
      if (!replace && (await exists(file))) return result('exists', 'runtime.artifact.exists', shown)
      try {
        await rename(part, file)
      } catch (error) {
        return result('failed', 'runtime.artifact.failed', { reason: oneLine(String(error)) })
      }
      return result('done', 'runtime.artifact.saved', shown)
    },
  }
}
