import type { ToolContext } from '@agnes/extension-api'
import type { SessionImpl } from '../step/session.js'
import { attachmentBytes } from './attachment-bytes.js'

/**
 * Lookups bounded to the active lane and the sequence visible at call start. Lists come from the
 * session's attachment index; one attachment's bytes come from the attachment store or, for an old
 * inline block, from its row (see `attachmentBytes`). `session-image://<seq>/<n>` is accepted too, so
 * an image original can be copied out as a file; reading an image for the model goes through
 * `readSessionImages`.
 */
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
    for (const file of session.attachmentIndex.list('file', session.lane)) {
      if (file.seq > end) break
      ordinal++
      if (ordinal < offset) continue
      const line = `${ordinal}. session-file://${file.seq}/${file.index} ${JSON.stringify(file.name)} (${file.mimeType})`
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
    return {
      name: 'Attachments',
      mimeType: 'text/plain',
      bytes: new TextEncoder().encode(lines.join('\n') || 'No attachments at this offset.'),
    }
  }
  const match = /^session-(file|image):\/\/([1-9][0-9]*)\/([1-9][0-9]*)$/u.exec(input.path)
  const kind = match?.[1] as 'file' | 'image' | undefined
  const seq = Number(match?.[2])
  const index = Number(match?.[3])
  if (!match || !kind || !Number.isSafeInteger(seq) || seq > end || !Number.isSafeInteger(index))
    return undefined
  const entry = session.attachmentIndex.get(seq, kind, index)
  if (!entry || entry.lane !== session.lane) return undefined
  // Missing, damaged or oversized bytes reject with a coded error the tool reports; never other bytes.
  const bytes = await attachmentBytes(session, entry, signal)
  checkAbort()
  return { name: entry.name ?? 'image', mimeType: entry.mimeType, bytes }
}
