import type { HostSession } from '@agnes/host'
import { ARTIFACT_READ_RPC_MAX_BYTES, rpcError } from '@agnes/protocol'

/** A session's attachment windows, and the verification of its history that must pass before any leaves. */
type AttachmentSession = Pick<HostSession, 'readAttachmentRange'> & {
  readonly d: { readonly log: { fullVerified(): Promise<void> } }
}
type Page = { mimeType: string; totalBytes: number; base64: string; sha256?: string }
export type AttachmentReadInput = {
  seq: number
  kind: 'image' | 'file'
  index: number
  offset: number
  length: number
  thumbnail?: boolean
}

const positive = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 1

/** The input as the method's schema bounds it, re-checked where the bytes are read. */
function checked(p: Record<string, unknown>): AttachmentReadInput {
  if (
    !positive(p.seq) ||
    (p.kind !== 'image' && p.kind !== 'file') ||
    !positive(p.index) ||
    !Number.isSafeInteger(p.offset) ||
    (p.offset as number) < 0 ||
    !positive(p.length) ||
    (p.length as number) > ARTIFACT_READ_RPC_MAX_BYTES ||
    (p.thumbnail !== undefined && typeof p.thumbnail !== 'boolean')
  )
    throw rpcError('INVALID_PARAMS', { reason: 'invalid-attachment-window' })
  return {
    seq: p.seq,
    kind: p.kind,
    index: p.index,
    offset: p.offset as number,
    length: p.length,
    ...(p.thumbnail === undefined ? {} : { thumbnail: p.thumbnail as boolean }),
  }
}

/** The failure a core attachment read reports, as the client sees it; anything else passes unchanged. */
function asRpc(error: unknown): unknown {
  const detail = (error as { code?: unknown; detail?: { code?: unknown } } | null) ?? undefined
  if (detail?.code !== 'E_ENVELOPE') return error
  switch (detail.detail?.code) {
    case 'ATTACHMENT_NOT_FOUND':
      return rpcError('INVALID_PARAMS', { reason: 'attachment-not-found' })
    case 'ATTACHMENT_RANGE':
      return rpcError('INVALID_PARAMS', { reason: 'offset-out-of-range' })
    case 'ATTACHMENT_MISSING':
    case 'ATTACHMENT_CORRUPT':
    case 'ATTACHMENT_TOO_LARGE':
    case 'ATTACHMENT_UNREADABLE': {
      const code = detail.detail.code
      return rpcError('SEMANTIC_REJECTED', { code, reason: code.slice('ATTACHMENT_'.length).toLowerCase() })
    }
    default:
      return error
  }
}

/**
 * One window (at most 1 MiB) of a user attachment of `session`, located through its attachment index.
 * Nothing leaves before the session's whole stored history has been verified; a history that failed
 * verification refuses every window with the integrity error.
 */
export async function attachmentReadPage(session: AttachmentSession, params: unknown): Promise<Page> {
  const input = checked((params ?? {}) as Record<string, unknown>)
  await session.d.log.fullVerified()
  let window: { mimeType: string; totalBytes: number; bytes: Uint8Array; sha256?: string }
  try {
    window = await session.readAttachmentRange(input)
  } catch (error) {
    throw asRpc(error)
  }
  return {
    mimeType: window.mimeType,
    totalBytes: window.totalBytes,
    base64: Buffer.from(window.bytes.buffer, window.bytes.byteOffset, window.bytes.byteLength).toString(
      'base64',
    ),
    ...(window.sha256 === undefined ? {} : { sha256: window.sha256 }),
  }
}
