import { createRequire } from 'node:module'
import type {
  AttachmentImagePolicy,
  AttachmentImageVersion,
  AttachmentScope,
  AttachmentStore,
  PersistenceMetadataNamespace,
} from '@agnes/extension-api'
import type { ArtifactsSeam } from '@agnes/extension-api/seams'
import { type ArtifactRef, AttachmentError, IncrementalSha256 } from '@agnes/protocol'
import {
  decodeSafeImageBytes,
  USER_IMAGE_ORIGINAL_LIMITS,
  USER_MESSAGE_IMAGE_LIMITS,
} from '@agnes/protocol-validation'

let codec: typeof import('sharp') | undefined
let running = 0
const waiters: (() => void)[] = []
async function acquire(signal: AbortSignal) {
  signal.throwIfAborted()
  if (running < 2) {
    running++
    return
  }
  if (waiters.length >= 4) throw new AttachmentError('ATTACHMENT_QUOTA')
  await new Promise<void>((resolve, reject) => {
    const ready = () => {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    const abort = () => {
      const at = waiters.indexOf(ready)
      if (at >= 0) {
        waiters.splice(at, 1)
        reject(signal.reason)
      }
    }
    waiters.push(ready)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}
function release() {
  const next = waiters.shift()
  if (next) next()
  else running--
}

/** Cache keys include codec policy version, original identity, scope and every output constraint.
 * Cached receipts are GC roots, never authority to the original. Damaged cache entries regenerate.
 */
export function imageVersions(
  store: AttachmentStore,
  bytes: Pick<ArtifactsSeam, 'get'>,
  cache: PersistenceMetadataNamespace,
): NonNullable<AttachmentStore['imageVersion']> {
  return async (
    scope: AttachmentScope,
    original: ArtifactRef,
    policy: AttachmentImagePolicy,
    caller: AbortSignal,
  ) => {
    const signal = AbortSignal.any([caller, AbortSignal.timeout(30_000)])
    signal.throwIfAborted()
    if (
      ![policy.maxWidth, policy.maxHeight, policy.maxBytes, policy.jpegQuality].every(Number.isSafeInteger) ||
      policy.maxWidth < 1 ||
      policy.maxHeight < 1 ||
      policy.maxWidth > 1456 ||
      policy.maxHeight > 1456 ||
      policy.maxBytes < 1 ||
      policy.maxBytes > USER_MESSAGE_IMAGE_LIMITS.maxBytesPerImage ||
      policy.jpegQuality < 1 ||
      policy.jpegQuality > 100
    )
      throw new AttachmentError('ATTACHMENT_DATA')
    const key = new IncrementalSha256()
      .update(
        new TextEncoder().encode(
          JSON.stringify([
            'image-v1',
            scope.sessionKey,
            scope.lane,
            original.sha256,
            original.size,
            original.mime,
            policy.maxWidth,
            policy.maxHeight,
            policy.maxBytes,
            policy.jpegQuality,
          ]),
        ),
      )
      .digest()
    const cached = cache.get(key) as AttachmentImageVersion | undefined
    if (cached) {
      try {
        if (await store.authorize(scope, cached, signal)) {
          const data = await bytes.get(cached.artifact)
          const image = decodeSafeImageBytes(
            { bytes: data, mimeType: cached.artifact.mime },
            USER_MESSAGE_IMAGE_LIMITS,
          )
          if (
            data.length <= policy.maxBytes &&
            image.width === cached.width &&
            image.height === cached.height &&
            image.width <= policy.maxWidth &&
            image.height <= policy.maxHeight
          )
            return cached
        }
      } catch {
        signal.throwIfAborted()
      }
      cache.delete(key)
    }
    await acquire(signal)
    const work = (async () => {
      try {
        signal.throwIfAborted()
        const input = await bytes.get(original)
        const image = decodeSafeImageBytes(
          { bytes: input, mimeType: original.mime },
          USER_IMAGE_ORIGINAL_LIMITS,
        )
        if (
          image.width <= policy.maxWidth &&
          image.height <= policy.maxHeight &&
          input.length <= policy.maxBytes
        ) {
          const receipt = await store.store(scope, input, original.mime, signal)
          return { ...receipt, width: image.width, height: image.height }
        }
        const sharp: typeof import('sharp') = codec ?? createRequire(import.meta.url)('sharp')
        codec = sharp
        sharp.cache(false)
        const decoder = sharp(input, {
          limitInputPixels: 64_000_000,
          failOn: 'warning',
          sequentialRead: true,
        })
        const meta = await decoder.metadata()
        if (
          (meta.pages ?? 1) !== 1 ||
          (meta.isProgressive &&
            (image.pixels > 16_000_000 ||
              image.pixels * Math.max(4, meta.channels ?? 4) > 64 * 1024 * 1024)) ||
          !['uchar', 'char', 'ushort', 'short'].includes(meta.depth ?? '') ||
          image.pixels * Math.max(4, meta.channels ?? 4) * (meta.depth?.includes('short') ? 2 : 1) >
            256 * 1024 * 1024
        )
          throw new AttachmentError('ATTACHMENT_PIXELS')
        let width = Math.min(policy.maxWidth, image.width)
        let height = Math.min(policy.maxHeight, image.height)
        for (let attempt = 0; attempt < 10; attempt++) {
          signal.throwIfAborted()
          const resized = decoder
            .clone()
            .rotate()
            .resize({ width, height, fit: 'inside', withoutEnlargement: true })
            .timeout({ seconds: 30 })
          const output = await (original.mime === 'image/png'
            ? resized.png()
            : resized.jpeg({ quality: policy.jpegQuality })
          ).toBuffer()
          signal.throwIfAborted()
          if (output.length <= policy.maxBytes) {
            const checked = decodeSafeImageBytes(
              { bytes: output, mimeType: original.mime },
              USER_IMAGE_ORIGINAL_LIMITS,
            )
            const receipt = await store.store(scope, output, original.mime, signal)
            return { ...receipt, width: checked.width, height: checked.height }
          }
          width = Math.max(1, Math.floor(width * 0.7))
          height = Math.max(1, Math.floor(height * 0.7))
        }
        throw new AttachmentError('ATTACHMENT_BYTES')
      } finally {
        release()
      }
    })()
    // Caller cancellation releases no native slot until its actual native work has settled.
    const version = await new Promise<AttachmentImageVersion>((resolve, reject) => {
      const abort = () =>
        reject(new AttachmentError(caller.aborted ? 'ATTACHMENT_CANCELLED' : 'ATTACHMENT_TIMEOUT'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
    signal.throwIfAborted()
    const entries = cache.entries()
    if (entries.length >= 1024 && entries[0]) cache.delete(entries[0].key)
    cache.set(key, version)
    return version
  }
}
