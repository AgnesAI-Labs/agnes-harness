import { scanPages } from '@agnes/core-ledger/log/scan-pages'
import type { ToolContext } from '@agnes/extension-api'
import { type ContentBlock, sha256Hex, uploadedAttachment } from '@agnes/protocol'
import { decodeAttachmentData, USER_MESSAGE_ATTACHMENT_LIMITS } from '@agnes/protocol-validation'
import type { SessionImpl } from '../step/session.js'

type UserFile = Extract<ContentBlock, { type: 'file' | 'resource_link' }> & { name: string; mimeType: string }
const filesOf = (data: unknown): UserFile[] =>
  ((data as { content?: ContentBlock[] })?.content ?? []).filter(
    (block): block is UserFile =>
      block.type === 'file' ||
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
    let ordinal = 0
    for await (const page of scanPages(
      (query) => session.d.log.scan(query),
      { type: 'user/message', lane: session.lane, toSeq: end },
      10,
    )) {
      checkAbort()
      for (const event of page) {
        for (const [index, file] of filesOf(event.data).entries()) {
          ordinal++
          if (ordinal < offset) continue
          const line = `${ordinal}. session-file://${event.seq}/${index + 1} ${JSON.stringify(file.name)} (${file.mimeType})`
          const cost = new TextEncoder().encode(line).byteLength + 1
          if (lines.length === limit || used + cost > maxBytes) {
            lines.push(`[read session-file://list with offset=${ordinal} to continue]`)
            return {
              name: 'Attachments',
              mimeType: 'text/plain',
              bytes: new TextEncoder().encode(lines.join('\n')),
            }
          }
          lines.push(line)
          used += cost
        }
      }
    }
    return {
      name: 'Attachments',
      mimeType: 'text/plain',
      bytes: new TextEncoder().encode(lines.join('\n') || 'No attachments at this offset.'),
    }
  }
  const match = /^session-file:\/\/([1-9][0-9]*)\/([1-9][0-9]*)$/u.exec(input.path)
  const seq = Number(match?.[1])
  const index = Number(match?.[2])
  if (!match || !Number.isSafeInteger(seq) || seq > end || !Number.isSafeInteger(index)) return undefined
  const rows = await session.d.log.scan({
    fromSeq: seq,
    toSeq: seq,
    type: 'user/message',
    lane: session.lane,
    limit: 1,
  })
  checkAbort()
  const file = filesOf(rows[0]?.data)[index - 1]
  if (!file) return undefined
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
      const limit = Math.min(ref.size, requested, USER_MESSAGE_ATTACHMENT_LIMITS.maxAggregateBytes)
      // Host maps FsOps reads to the adapter's byte mode; offset is zero-based here.
      const bytes = await view.fs().read(ref.path, { offset: 0, limit })
      checkAbort()
      return { name: file.name, mimeType: file.mimeType, bytes }
    }
    return session.d.workspacePublication
      ? session.d.workspacePublication.workspace(() => ({ port, handler: invoke }))
      : port.run(invoke)
  }
  return {
    name: file.name,
    mimeType: file.mimeType,
    bytes: decodeAttachmentData(file.data, USER_MESSAGE_ATTACHMENT_LIMITS.maxAggregateBytes),
  }
}
