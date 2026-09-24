import {
  ARTIFACT_RECLAIMED_FAILURE,
  type LocalArtifactReadStore,
  REQUEST_MEDIA_ARTIFACT_RECLAIMED,
} from '@agnes/host'

/**
 * Reads one authorized screenshot's bytes. The store keeps no MIME sidecar, so both image types
 * are tried and Core checks the actual image magic; a screenshot retention reclaimed is reclaimed
 * under either, so it ends the search. `stillAuthorized` re-checks the reader after the read.
 */
export async function readScreenshotBytes(
  artifacts: Pick<LocalArtifactReadStore, 'inspect' | 'get'>,
  sha256: string,
  signal: AbortSignal,
  stillAuthorized: () => boolean,
): Promise<Uint8Array | typeof REQUEST_MEDIA_ARTIFACT_RECLAIMED | undefined> {
  for (const mime of ['image/png', 'image/jpeg'] as const) {
    let bytes: Uint8Array | typeof REQUEST_MEDIA_ARTIFACT_RECLAIMED
    try {
      bytes = await artifacts.get(await artifacts.inspect({ sha256, mime }, signal), signal)
    } catch (error) {
      if (error !== ARTIFACT_RECLAIMED_FAILURE) continue
      bytes = REQUEST_MEDIA_ARTIFACT_RECLAIMED
    }
    return stillAuthorized() ? bytes : undefined
  }
  return undefined
}
