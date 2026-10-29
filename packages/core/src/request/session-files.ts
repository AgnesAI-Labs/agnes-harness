import type { ToolContext } from '@agnes/extension-api'
import {
  AttachmentError,
  type ContentBlock,
  IncrementalSha256,
  sha256Hex,
  storedAttachment,
  uploadedAttachment,
} from '@agnes/protocol'
import { decodeAttachmentData, USER_MESSAGE_ATTACHMENT_LIMITS } from '@agnes/protocol-validation'
import type { SessionImpl } from '../step/session.js'
import { attachmentIndex } from './attachment-index.js'

type UserFile = Extract<ContentBlock, { type: 'file' | 'resource_link' }> & { name: string; mimeType: string }
const filesOf = (data: unknown): UserFile[] =>
  ((data as { content?: ContentBlock[] })?.content ?? []).filter(
    (block): block is UserFile =>
      block.type === 'file' ||
      (storedAttachment(block) && !block.attachment.image) ||
      (block.type === 'resource_link' &&
        !!uploadedAttachment(block.uri) &&
        typeof block.name === 'string' &&
        typeof block.mimeType === 'string'),
  )

/** Immutable log lookup, bounded to the active lane and the sequence visible at call start. */
export const readSessionAttachment = async (
  session: SessionImpl,
  input: { path: string; offset?: number; limit?: number; maxBytes?: number },
  signal: AbortSignal,
): ReturnType<NonNullable<ToolContext['session']['readAttachment']>> => {
  const end = session.lastSeq
  const checkAbort = () => {
    if (signal.aborted) throw new Error('Attachment read cancelled.')
  }
  checkAbort()
  if (input.path === 'session-file://list') {
    const offset = input.offset ?? 1
    const limit = Math.min(input.limit ?? 20, 100)
    const maxBytes = Math.max(2048, Math.min(input.maxBytes ?? 16384, 32768))
    if (
      !Number.isSafeInteger(offset) ||
      offset < 1 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      !Number.isSafeInteger(maxBytes)
    )
      throw new Error('Invalid attachment list offset or limit.')
    const lines: string[] = []
    let used = 200
    let ordinal = offset - 1
    const indexed = await attachmentIndex(session)
    for (const file of indexed.files.slice(offset - 1, offset + limit)) {
      checkAbort()
      ordinal++
      const line = `${ordinal}. session-file://${file.seq}/${file.index} ${JSON.stringify(file.name)} (${file.mimeType})`
      const cost = new TextEncoder().encode(line).byteLength + 1
      if (lines.length === limit || used + cost > maxBytes) {
        lines.push(`[read session-file://list with offset=${ordinal} to continue]`)
        break
      }
      lines.push(line)
      used += cost
    }
    return {
      name: 'Attachments',
      mimeType: 'text/plain',
      bytes: new TextEncoder().encode(lines.join('\n') || 'No attachments at this offset.'),
    }
  }
  const match = /^session-(file|image):\/\/([1-9][0-9]*)\/([1-9][0-9]*)$/u.exec(input.path)
  const seq = Number(match?.[2])
  const index = Number(match?.[3])
  if (!match || !Number.isSafeInteger(seq) || seq > end || !Number.isSafeInteger(index)) return undefined
  const rows = await session.d.log.scan({
    fromSeq: seq,
    toSeq: seq,
    type: 'user/message',
    lane: session.lane,
    limit: 1,
  })
  checkAbort()
  const content = (rows[0]?.data as { content?: ContentBlock[] } | undefined)?.content ?? []
  const file = (
    match[1] === 'image'
      ? content.filter(
          (block) => block.type === 'image' || (storedAttachment(block) && block.attachment.image),
        )
      : filesOf(rows[0]?.data)
  )[index - 1]
  if (!file) return undefined
  const maxBytes = input.maxBytes ?? USER_MESSAGE_ATTACHMENT_LIMITS.maxAggregateBytes
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new AttachmentError('ATTACHMENT_DATA')
  if (storedAttachment(file)) {
    if (file.attachment.artifact.size > maxBytes) throw new AttachmentError('ATTACHMENT_TOO_LARGE')
    let bytes: Uint8Array
    try {
      bytes = await session.d.runtime.artifactGet(file.attachment.artifact)
    } catch (error) {
      throw error instanceof AttachmentError ? error : new AttachmentError('ATTACHMENT_UNAVAILABLE')
    }
    checkAbort()
    if (
      bytes.length !== file.attachment.artifact.size ||
      new IncrementalSha256().update(bytes).digest() !== file.attachment.artifact.sha256
    )
      throw new AttachmentError('ATTACHMENT_HASH_MISMATCH')
    return { name: file.name, mimeType: file.mimeType, bytes }
  }
  if (file.type === 'resource_link') {
    const ref = uploadedAttachment(file.uri)
    const port = session.d.workspaceInvocation
    if (
      !ref ||
      !port ||
      (ref.session !== sha256Hex(session.key) &&
        !(
          session.d.log.parent &&
          seq <= session.d.log.parent.boundarySeq &&
          ref.session === sha256Hex(session.d.log.parent.key)
        ))
    )
      throw new Error('Uploaded attachment workspace is unavailable.')
    const invoke = async (view: Parameters<Parameters<typeof port.run>[0]>[0]) => {
      checkAbort()
      // Existing document parsers are bounded. Large originals remain available to workspace
      // tools, which can read ranges without allocating the entire upload.
      if (ref.size > USER_MESSAGE_ATTACHMENT_LIMITS.maxAggregateBytes && input.maxBytes === undefined)
        throw new Error(
          `Attachment exceeds the document reader byte limit. Read ranges from ${ref.path} with workspace tools.`,
        )
      const requested = input.maxBytes ?? USER_MESSAGE_ATTACHMENT_LIMITS.maxAggregateBytes
      if (!Number.isSafeInteger(requested) || requested < 0) throw new Error('Invalid attachment byte limit.')
      if (ref.size > requested || ref.size > USER_MESSAGE_ATTACHMENT_LIMITS.maxAggregateBytes)
        throw new AttachmentError('ATTACHMENT_TOO_LARGE')
      const limit = ref.size + 1
      // Host maps FsOps reads to the adapter's byte mode; offset is zero-based here.
      const bytes = await view.fs().read(ref.path, { offset: 0, limit })
      checkAbort()
      if (bytes.length !== ref.size || new IncrementalSha256().update(bytes).digest() !== ref.sha256)
        throw new AttachmentError('ATTACHMENT_HASH_MISMATCH')
      return { name: file.name ?? 'attachment', mimeType: file.mimeType ?? 'application/octet-stream', bytes }
    }
    return session.d.workspacePublication
      ? session.d.workspacePublication.workspace(() => ({ port, handler: invoke }))
      : port.run(invoke)
  }
  if (file.type !== 'file' && file.type !== 'image') return undefined
  return {
    name: file.type === 'file' ? file.name : 'image',
    mimeType: file.mimeType,
    bytes: decodeAttachmentData(
      file.type === 'image' || file.type === 'file' ? file.data : '',
      maxBytes || 1,
    ),
  }
}
