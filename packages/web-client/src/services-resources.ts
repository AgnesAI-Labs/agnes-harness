import { type Context, Service } from '@agnes/cordis'
import type { ArtifactReadResult } from '@agnes/protocol'
import { downloadArtifact } from './artifact-download.js'
import { prepareHtmlPreview } from './html-preview-resources.js'
import type {
  ClientDocumentArtifact,
  ClientDocumentKind,
  ClientDocumentLoader,
  ClientDocumentResource,
  ClientImageArtifact,
  ClientImageLoader,
  ClientImageResource,
  HostAgnesClient,
} from './service-contracts.js'
import type { SessionService } from './services-session.js'

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg'])
const SHA256 = /^[0-9a-f]{64}$/

function isImageArtifact(value: unknown): value is ClientImageArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const artifact = value as Record<string, unknown>
  return (
    typeof artifact.sha256 === 'string' &&
    SHA256.test(artifact.sha256) &&
    typeof artifact.size === 'number' &&
    Number.isSafeInteger(artifact.size) &&
    artifact.size >= 0 &&
    artifact.size <= 1024 * 1024 &&
    typeof artifact.mime === 'string' &&
    IMAGE_MIMES.has(artifact.mime)
  )
}

function isArtifact(value: unknown): value is ClientImageArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const artifact = value as Record<string, unknown>
  return (
    typeof artifact.sha256 === 'string' &&
    SHA256.test(artifact.sha256) &&
    typeof artifact.size === 'number' &&
    Number.isSafeInteger(artifact.size) &&
    artifact.size >= 0 &&
    artifact.size <= 1024 * 1024 &&
    typeof artifact.mime === 'string' &&
    artifact.mime.length > 0 &&
    artifact.mime.length <= 128
  )
}

function acceptsDocumentMime(kind: ClientDocumentKind, mime: string, name?: string): boolean {
  if (kind === 'image')
    return (
      IMAGE_MIMES.has(mime) ||
      mime === 'image/svg+xml' ||
      (mime === 'application/octet-stream' && typeof name === 'string' && /\.svg$/i.test(name))
    )
  if (kind === 'pdf') return mime === 'application/pdf'
  if (kind === 'html') return mime === 'text/html'
  if (kind === 'markdown') return mime === 'text/markdown' || mime === 'text/plain'
  return mime.startsWith('text/') || mime === 'application/json' || mime === 'application/javascript'
}

function isBoundedText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code <= 0x1f || code === 0x7f
    })
  )
}

function sameImageArtifact(left: ClientImageArtifact, right: ClientImageArtifact): boolean {
  return left.sha256 === right.sha256 && left.size === right.size && left.mime === right.mime
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = globalThis.atob(value)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}

/** Session-authorized image access for DSH components; raw URLs are intentionally not accepted. */
/** The daemon no longer holds this resource because the retention policy removed it. */
export class ClientResourceReclaimedError extends Error {
  constructor() {
    super('document resource was reclaimed by retention')
    this.name = 'ClientResourceReclaimedError'
    Object.assign(this, { code: 'artifact_reclaimed' })
  }
}

export class ClientResourceService extends Service {
  private active = true
  private readonly closed = new AbortController()
  private readonly objectUrls = new Set<string>()

  readonly images: ClientImageLoader = Object.freeze({
    load: (input) => this.loadImage(input),
  })

  readonly files = Object.freeze({
    load: async (
      input: Readonly<{ laneId: string; artifact: ClientDocumentArtifact; signal?: AbortSignal }>,
    ) => {
      const sessionId = this.session.sessionId
      if (!this.active || !sessionId) throw new Error('deliverable requires an active session')
      const signal = input.signal ? AbortSignal.any([this.closed.signal, input.signal]) : this.closed.signal
      const resource = await downloadArtifact(this.client, sessionId, input.laneId, input.artifact, signal)
      if (!this.active || this.session.sessionId !== sessionId) {
        resource.release()
        throw new Error('deliverable session changed')
      }
      this.objectUrls.add(resource.url)
      return {
        ...resource,
        release: () => {
          this.objectUrls.delete(resource.url)
          resource.release()
        },
      }
    },
  })

  readonly documents: ClientDocumentLoader = Object.freeze({
    load: (input) => this.loadDocument(input),
  })

  constructor(
    ctx: Context,
    private readonly client: HostAgnesClient,
    private readonly session: SessionService,
  ) {
    super(ctx, 'resources')
    ctx.effect(() => () => {
      this.active = false
      this.closed.abort()
      this.releaseAll()
    })
  }

  private async loadImage(
    input: Readonly<{ laneId: string; artifact: ClientImageArtifact }>,
  ): Promise<ClientImageResource> {
    const sessionId = this.session.sessionId
    if (!sessionId) throw new Error('image resource requires an active session')
    if (!isBoundedText(input.laneId) || !isImageArtifact(input.artifact))
      throw new TypeError('image resource reference is invalid')

    const resource = await this.loadDocument({ ...input, kind: 'image' })
    if (!resource.url) throw new Error('image resource URL is unavailable')
    return Object.freeze({ artifact: resource.artifact, url: resource.url, release: resource.release })
  }

  private async loadDocument(
    input: Parameters<ClientDocumentLoader['load']>[0],
  ): Promise<ClientDocumentResource> {
    const sessionId = this.session.sessionId
    if (!sessionId) throw new Error('document resource requires an active session')
    if (
      !isBoundedText(input.laneId) ||
      !isArtifact(input.artifact) ||
      !acceptsDocumentMime(input.kind, input.artifact.mime, input.name)
    )
      throw new TypeError('document resource reference is invalid')

    const { bytes, base64 } = await this.readArtifact(sessionId, input.laneId, input.artifact)
    const svg = input.kind === 'image' && !IMAGE_MIMES.has(input.artifact.mime)
    if (svg) {
      const parsed = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'image/svg+xml')
      if (parsed.documentElement.localName !== 'svg' || parsed.querySelector('parsererror'))
        throw new Error('SVG preview is invalid')
    }
    const needsUrl = input.kind === 'image' || input.kind === 'pdf'
    let content = input.kind === 'pdf' ? base64 : needsUrl ? undefined : new TextDecoder().decode(bytes)
    if (input.kind === 'html') {
      content = await prepareHtmlPreview(
        content ?? '',
        input.artifact,
        async () => {
          const handle = this.client.sessions.get(sessionId)
          if (!handle) throw new Error('HTML preview session is unavailable')
          let { callSeq, resultSeq } = input.source ?? {}
          // Older surface/inline cards carry no tool coordinates. Resolve only one exact durable match.
          if (callSeq === undefined || resultSeq === undefined) {
            const matches = []
            for (let afterSeq: number | undefined = 0; afterSeq !== undefined; ) {
              if (!this.active || this.session.sessionId !== sessionId)
                throw new Error('document resource session changed')
              const page = await handle.deliverables({ afterSeq })
              for (const item of page.items) {
                const data = item.structured as
                  | { surfaceId?: string; deliverables?: Array<{ ref?: ClientImageArtifact }> }
                  | undefined
                if (
                  (callSeq === undefined || item.callSeq === callSeq) &&
                  (input.source?.surfaceId === undefined || data?.surfaceId === input.source.surfaceId) &&
                  Array.isArray(data?.deliverables) &&
                  data.deliverables.some((row) => row?.ref && sameImageArtifact(row.ref, input.artifact))
                )
                  matches.push(item)
              }
              if (matches.length > 1) throw new Error('HTML preview source is ambiguous')
              afterSeq = page.nextAfterSeq
            }
            if (matches.length !== 1 || !matches[0])
              throw new Error('HTML preview source is ambiguous or unavailable')
            callSeq = matches[0].callSeq
            resultSeq = matches[0].resultSeq
          }
          if (
            typeof callSeq !== 'number' ||
            typeof resultSeq !== 'number' ||
            !Number.isSafeInteger(callSeq) ||
            !Number.isSafeInteger(resultSeq) ||
            callSeq < 1 ||
            callSeq >= resultSeq
          )
            throw new Error('HTML preview source is unavailable')
          return handle.readToolDetail(callSeq, resultSeq)
        },
        (ref) => this.readArtifact(sessionId, input.laneId, ref),
      )
    }
    if (!this.active || this.session.sessionId !== sessionId)
      throw new Error('document resource session changed')
    const url = needsUrl
      ? this.createObjectUrl(bytes, svg ? 'image/svg+xml' : input.artifact.mime)
      : undefined
    let released = false
    return Object.freeze({
      artifact: input.artifact,
      kind: input.kind,
      ...(content === undefined ? {} : { content }),
      ...(url === undefined ? {} : { url }),
      release: () => {
        if (released) return
        released = true
        if (url !== undefined) {
          this.objectUrls.delete(url)
          globalThis.URL.revokeObjectURL(url)
        }
      },
    })
  }

  private async readArtifact(sessionId: string, laneId: string, artifact: ClientImageArtifact) {
    if (!this.active || this.session.sessionId !== sessionId)
      throw new Error('document resource session changed')
    if (!isArtifact(artifact)) throw new TypeError('document resource reference is invalid')
    const result = await this.client.call<ArtifactReadResult>('_agnes/v1/artifact.read', {
      sessionId,
      laneId,
      artifact,
    })
    if (this.session.sessionId !== sessionId) throw new Error('document resource session changed')
    if (!result.ok && result.status === 410 && result.code === 'artifact_reclaimed')
      throw new ClientResourceReclaimedError()
    if (!result.ok)
      throw Object.assign(new Error(`document resource is unavailable: ${result.code}`), {
        code: result.code,
      })
    if (!sameImageArtifact(result.artifact, artifact) || result.contentLength !== artifact.size)
      throw new Error('document resource identity mismatch')

    const bytes = decodeBase64(result.base64)
    if (bytes.byteLength !== result.contentLength) throw new Error('document resource length mismatch')
    return { bytes, base64: result.base64 }
  }

  private createObjectUrl(bytes: ArrayBuffer, mime: string): string {
    const createObjectUrl = globalThis.URL?.createObjectURL
    if (!createObjectUrl) throw new Error('document resource URLs are unavailable')
    const url = createObjectUrl(new Blob([bytes], { type: mime }))
    this.objectUrls.add(url)
    return url
  }

  private releaseAll(): void {
    for (const url of this.objectUrls) globalThis.URL.revokeObjectURL(url)
    this.objectUrls.clear()
  }
}
