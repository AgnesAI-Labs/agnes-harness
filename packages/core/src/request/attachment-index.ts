import { scanPages } from '@agnes/core-ledger/log/scan-pages'
import { type ArtifactRef, type ContentBlock, storedAttachment, uploadedAttachment } from '@agnes/protocol'
import { validateStoredAttachment } from '@agnes/protocol-validation'
import type { SessionImpl } from '../step/session.js'

export const attachmentIdentity = (ref: ArtifactRef) => JSON.stringify([ref.sha256, ref.size, ref.mime])
type FileEntry = Readonly<{ seq: number; index: number; name: string; mimeType: string }>
type Snapshot = Readonly<{
  through: number
  omittedThrough: number
  refs: ReadonlyMap<string, ArtifactRef>
  files: readonly FileEntry[]
  images: readonly Readonly<{ seq: number; index: number }>[]
}>
const indexes = new WeakMap<SessionImpl, { snapshot?: Snapshot; tail: Promise<unknown> }>()

/** Rebuildable projection of the verified owning log. Never persisted or accepted from a client.
 * Session identity includes the immutable fork prefix and lane; only appended ranges are scanned.
 * Publication swaps a complete snapshot, so aborted/corrupt scans cannot advance its watermark.
 */
export async function attachmentIndex(session: SessionImpl): Promise<Snapshot> {
  let state = indexes.get(session)
  if (!state) {
    state = { tail: Promise.resolve() }
    indexes.set(session, state)
  }
  const current = state
  const end = session.lastSeq
  const work = current.tail
    .catch(() => undefined)
    .then(async () => {
      const previous = current.snapshot
      if (previous?.through === end) return previous
      const base = previous && previous.through < end ? previous : undefined
      let omittedThrough = base?.omittedThrough ?? 0
      const refs = new Map(base?.refs)
      const files = [...(base?.files ?? [])]
      const images = [...(base?.images ?? [])]
      for await (const page of scanPages(
        (query) => session.d.log.scan(query),
        {
          lane: session.lane,
          fromSeq: (base?.through ?? 0) + 1,
          toSeq: end,
        },
        100,
      )) {
        for (const row of page) {
          if (row.type === 'request/header') {
            const cut = (row.data as { attachmentImagesOmittedThrough?: number })
              .attachmentImagesOmittedThrough
            if (cut !== undefined) {
              if (!Number.isSafeInteger(cut) || cut < 0 || cut >= row.seq) throw new Error('ATTACHMENT_DATA')
              omittedThrough = Math.max(omittedThrough, cut)
            }
          }
          if (row.type !== 'user/message') continue
          const blocks = (row.data as { content?: ContentBlock[] }).content ?? []
          let index = 0,
            imageIndex = 0
          for (const block of blocks) {
            if (block.type === 'image' || (storedAttachment(block) && block.attachment.image))
              images.push(Object.freeze({ seq: row.seq, index: ++imageIndex }))
            if (storedAttachment(block)) {
              validateStoredAttachment(block)
              for (const ref of [block.attachment.artifact, block.attachment.thumbnail])
                if (ref) refs.set(attachmentIdentity(ref), Object.freeze({ ...ref }))
            }
            if (
              block.type === 'file' ||
              (storedAttachment(block) && !block.attachment.image) ||
              (block.type === 'resource_link' &&
                uploadedAttachment(block.uri) &&
                block.name &&
                block.mimeType)
            ) {
              index++
              files.push(
                Object.freeze({
                  seq: row.seq,
                  index,
                  name: block.name ?? 'attachment',
                  mimeType: block.mimeType ?? 'application/octet-stream',
                }),
              )
            }
          }
        }
      }
      // Bounded metadata, no original bytes or message text. Refuse rather than silently authorize
      // from an incomplete cache; normal per-session original quotas bound much larger byte sets.
      if (refs.size > 100_000 || files.length > 100_000 || images.length > 100_000)
        throw new Error('ATTACHMENT_QUOTA')
      const snapshot: Snapshot = {
        through: end,
        omittedThrough,
        refs,
        files: Object.freeze(files),
        images: Object.freeze(images),
      }
      current.snapshot = snapshot
      return snapshot
    })
  current.tail = work
  const snapshot = await work
  return { ...snapshot, refs: new Map(snapshot.refs) }
}
