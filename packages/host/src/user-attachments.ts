import { createHash } from 'node:crypto'
import { readdir, statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { UserAttachmentPort } from '@agnes/core'
import { type AttachmentStore, attachmentReceiptFor } from './attachment-store.js'

const GIB = 1024 ** 3
/** The `profile.limits` keys for user attachments and their defaults. */
export const ATTACHMENT_LIMIT_DEFAULTS = Object.freeze({
  'attachments.max_upload_bytes': 2 * GIB,
  'attachments.session_quota_bytes': 8 * GIB,
  'attachments.global_quota_bytes': 64 * GIB,
  'attachments.min_free_bytes': 2 * GIB,
  'attachments.orphan_grace_ms': 7 * 24 * 60 * 60 * 1000,
})
export type AttachmentLimitKey = keyof typeof ATTACHMENT_LIMIT_DEFAULTS

/** A limit from the profile, or its default when it is absent or not a non-negative safe integer. */
export function attachmentLimit(limits: Readonly<Record<string, number>>, key: AttachmentLimitKey): number {
  const value = limits[key]
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : ATTACHMENT_LIMIT_DEFAULTS[key]
}

/** Refusal of an attachment write because a size limit or quota would be passed. */
export class AttachmentQuotaError extends Error {
  readonly code = 'UPLOAD_QUOTA'
  constructor(message: string) {
    super(message)
    this.name = 'AttachmentQuotaError'
  }
}

/** Free bytes on the volume holding `dir`; the store's directory may not exist before its first write. */
async function defaultDiskFree(dir: string): Promise<number> {
  for (let at = dir; ; at = dirname(at)) {
    try {
      const s = await statfs(at)
      return Number(s.bavail) * Number(s.bsize)
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT' || dirname(at) === at) throw error
    }
  }
}

export type HostUserAttachmentPort = UserAttachmentPort & {
  /** Bytes of every marked user attachment, rebuilt from the marker directory on first use. */
  usage(): Promise<number>
  /** Throws `UPLOAD_QUOTA` when `add` more bytes would pass the session or global quota or the free-space floor. */
  checkQuota(input: { add: number; sessionBytes: number }): Promise<void>
}

/**
 * The host side of attachment admission: one store, a global byte count, and the sessions' upload
 * receipts.
 *
 * The count is kept per process: it is rebuilt from the markers when first needed and then advanced by
 * this process's own writes, so writes from another process are seen at the next start. The quota is a
 * bound on growth, not an exact ledger. Marks made here never carry a receipt; a receipt-less mark only
 * ever creates a missing marker (see the store), so a session worker can mark safely while the process
 * that owns uploads adds receipts.
 */
export function createUserAttachmentPort(o: {
  store: AttachmentStore
  limits: Readonly<Record<string, number>>
  storeByReference: boolean
  diskFree?: (dir: string) => Promise<number>
}): HostUserAttachmentPort {
  let counted: Promise<number> | undefined
  let global = 0
  // Bytes admitted by a quota check whose write has not finished: concurrent writes share the room.
  let pending = 0
  const usage = async (): Promise<number> => {
    counted ??= (async () => {
      let total = 0
      const root = join(o.store.root, 'user-attachment-meta')
      for (const shard of await readdir(root).catch(() => [] as string[]))
        for (const name of await readdir(join(root, shard)).catch(() => [] as string[])) {
          if (!/^[0-9a-f]{64}\.json$/u.test(name)) continue
          const marker = await o.store.userAttachment(name.slice(0, -5)).catch(() => undefined)
          if (marker) total += marker.bytes
        }
      global += total
      return total
    })()
    await counted
    return global
  }
  const limit = (key: AttachmentLimitKey) => attachmentLimit(o.limits, key)
  const checkQuota = async ({ add, sessionBytes }: { add: number; sessionBytes: number }) => {
    if (sessionBytes + add > limit('attachments.session_quota_bytes'))
      throw new AttachmentQuotaError('This session has no room for more attachments.')
    if ((await usage()) + pending + add > limit('attachments.global_quota_bytes'))
      throw new AttachmentQuotaError('Attachment storage is full.')
    if (
      (await (o.diskFree ?? defaultDiskFree)(o.store.root)) - pending - add <
      limit('attachments.min_free_bytes')
    )
      throw new AttachmentQuotaError('The disk is too full to store this attachment.')
  }
  return {
    storeByReference: o.storeByReference,
    usage,
    checkQuota,
    async store({ bytes, mimeType, sessionBytes }) {
      if (bytes.byteLength > limit('attachments.max_upload_bytes'))
        throw new AttachmentQuotaError('The attachment is larger than the upload limit.')
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      // Bytes already marked are already counted and need no room; the reference is all that is new.
      const known = await o.store.userAttachment(sha256).catch(() => undefined)
      if (!known) {
        await checkQuota({ add: bytes.byteLength, sessionBytes })
        pending += bytes.byteLength
      }
      try {
        const object = await o.store.put(bytes, { kind: 'user-attachment', mimeType })
        await usage()
        const before = known ?? (await o.store.userAttachment(object.sha256).catch(() => undefined))
        await o.store.markUserAttachment(object, { mimeType })
        if (!before) global += object.bytes
        return { sha256: object.sha256, bytes: object.bytes }
      } finally {
        if (!known) pending -= bytes.byteLength
      }
    },
    async authorize({ sha256, bytes, sessionKey, referenced }) {
      // Entitlement first: telling "missing" from "not yours" for an object the session has no claim
      // on would let it probe the store for content it was never given.
      if (!referenced) {
        const marker = await o.store.userAttachment(sha256).catch(() => undefined)
        if (!marker?.receipts.includes(attachmentReceiptFor(sessionKey))) return 'unauthorized'
      }
      const object = await o.store.stat(sha256)
      return object && object.bytes === bytes ? 'ok' : 'missing'
    },
    read: (sha256, range, signal) => o.store.read(sha256, range, signal),
  }
}
