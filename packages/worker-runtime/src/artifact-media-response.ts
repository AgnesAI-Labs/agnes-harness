import { createHash } from 'node:crypto'
import { REQUEST_MEDIA_ARTIFACT_RECLAIMED } from '@agnes/host'

/** @internal Exported for byte-level contract tests; callers should use the composed request-media port. */
export function decodeArtifactMediaResponse(
  value: unknown,
  expectedSha256: string,
  maxBytes: number,
): Uint8Array | typeof REQUEST_MEDIA_ARTIFACT_RECLAIMED | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    if (
      keys.length === 2 &&
      descriptors.sha256?.value === expectedSha256 &&
      descriptors.reclaimed?.value === true
    )
      return REQUEST_MEDIA_ARTIFACT_RECLAIMED
    if (
      keys.length !== 4 ||
      keys.some(
        (key) =>
          typeof key !== 'string' ||
          !['sha256', 'size', 'mime', 'data'].includes(key) ||
          descriptors[key]?.enumerable !== true ||
          !Object.hasOwn(descriptors[key] ?? {}, 'value'),
      )
    )
      return undefined
    const response = Object.fromEntries(
      (keys as string[]).map((key) => [key, descriptors[key]?.value]),
    ) as Record<string, unknown>
    if (
      response.sha256 !== expectedSha256 ||
      !Number.isSafeInteger(response.size) ||
      (response.size as number) < 1 ||
      (response.size as number) > maxBytes ||
      (response.mime !== 'image/png' && response.mime !== 'image/jpeg') ||
      typeof response.data !== 'string' ||
      response.data.length > Math.ceil(maxBytes / 3) * 4
    )
      return undefined
    const bytes = Uint8Array.from(Buffer.from(response.data, 'base64'))
    if (
      bytes.byteLength !== response.size ||
      Buffer.from(bytes).toString('base64') !== response.data ||
      createHash('sha256').update(bytes).digest('hex') !== expectedSha256
    )
      return undefined
    return bytes
  } catch {
    return undefined
  }
}
