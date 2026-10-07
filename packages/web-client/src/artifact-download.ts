import { ARTIFACT_READ_RPC_MAX_BYTES, type ArtifactReadResult, type ArtifactRef } from '@agnes/protocol'
import type { HostAgnesClient } from './services.js'

/** Download through the existing session/lane-authorized bounded RPC. No raw path or URL input. */
export async function downloadArtifact(
  client: Pick<HostAgnesClient, 'call'>,
  sessionId: string,
  laneId: string,
  artifact: Pick<ArtifactRef, 'sha256' | 'size' | 'mime'>,
) {
  artifact = { sha256: artifact.sha256, size: artifact.size, mime: artifact.mime }
  if (
    !/^[0-9a-f]{64}$/.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size < 0 ||
    artifact.size > 32 * 1024 * 1024 ||
    !laneId ||
    laneId.length > 512 ||
    !artifact.mime
  )
    throw new Error('invalid deliverable reference')
  const bytes = new Uint8Array(artifact.size)
  for (let start = 0; start < artifact.size || start === 0; start += ARTIFACT_READ_RPC_MAX_BYTES) {
    const end = Math.min(start + ARTIFACT_READ_RPC_MAX_BYTES, artifact.size)
    const range = artifact.size > ARTIFACT_READ_RPC_MAX_BYTES ? `bytes=${start}-${end - 1}` : undefined
    const result = await client.call<ArtifactReadResult>('_agnes/v1/artifact.read', {
      sessionId,
      laneId,
      artifact,
      ...(range ? { range } : {}),
    })
    if (!result.ok) throw new Error(`deliverable unavailable: ${result.code}`)
    if (
      result.artifact.sha256 !== artifact.sha256 ||
      result.artifact.size !== artifact.size ||
      result.artifact.mime !== artifact.mime ||
      result.contentLength !== end - start ||
      (range &&
        (result.status !== 206 || result.contentRange !== `bytes ${start}-${end - 1}/${artifact.size}`))
    )
      throw new Error('deliverable identity mismatch')
    const decoded = globalThis.atob(result.base64)
    if (decoded.length !== end - start) throw new Error('deliverable length mismatch')
    for (let i = 0; i < decoded.length; i++) bytes[start + i] = decoded.charCodeAt(i)
    if (!artifact.size) break
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  if ([...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('') !== artifact.sha256)
    throw new Error('deliverable digest mismatch')
  // HTML and unknown types download as bytes; active content never receives a same-origin document.
  const mime = /^(text\/plain|application\/pdf|image\/(png|jpeg|webp))$/.test(artifact.mime)
    ? artifact.mime
    : 'application/octet-stream'
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
  return { url, release: () => URL.revokeObjectURL(url) }
}
