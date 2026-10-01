import type { ArtifactAccessPort, ArtifactDownloadDelivery, CallContext } from '@agnes/extension-api/runtime'
import { defineArtifactTool, runtimeAuthorSchemas } from '@agnes/extension-api/runtime'
import type { ArtifactDownloadMetadata, ArtifactRedeemDownloadRequest } from '@agnes/protocol/runtime'

const document = defineArtifactTool({
  id: 'document',
  description: 'Document',
  input: runtimeAuthorSchemas.StandardToolOutput,
  render: () => ({ title: 'Document', mediaType: 'text/plain', bytes: new Uint8Array() }),
})
const newVersion = document.publication.prepareReserve({
  publicationId: 'publication',
  artifactId: 'artifact',
  expectedLatestVersion: 1,
  title: null,
  mediaType: null,
  ownerActionRef: { existingActionId: 'action' },
})
// @ts-expect-error Existing artifacts need the actual last allocated version.
document.publication.prepareReserve({
  publicationId: 'p',
  artifactId: 'a',
  expectedLatestVersion: null,
  title: null,
  mediaType: null,
  ownerActionRef: { existingActionId: 'action' },
})

export async function deliveryConsumer(
  port: ArtifactAccessPort,
  request: ArtifactRedeemDownloadRequest,
  context: CallContext,
) {
  const result = await port.redeemDownload(request, context)
  if (!result.ok) return result
  const delivery: ArtifactDownloadDelivery = result.value
  const wire: ArtifactDownloadMetadata = {
    stream: { streamId: 'stream', offset: request.offset, totalBytes: delivery.metadata.artifact.size },
    download: delivery.metadata,
  }
  // @ts-expect-error Local byte streams are not a serialized Wire metadata object.
  const invalid: ArtifactDownloadMetadata = { stream: delivery.stream, download: delivery.metadata }
  const replacementStream = delivery.stream
  // @ts-expect-error The delivery handle is readonly.
  delivery.stream = replacementStream
  void [newVersion, invalid]
  return wire
}
