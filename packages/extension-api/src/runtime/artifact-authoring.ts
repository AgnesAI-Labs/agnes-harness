import type {
  ArtifactContentDescriptor,
  ArtifactsPublishRequest,
  ArtifactsReserveRequest,
} from '@agnes/protocol/runtime'
import { RuntimeArtifactPolicy, RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import type { AuthorSchema } from './authoring.js'
import { runtimeAuthorSchemas } from './authoring-schemas.js'
import { copyJson, declarationError } from './authoring-validation.js'

type ReserveInput<Request = ArtifactsReserveRequest> = Request extends object
  ? Omit<Request, 'kind' | 'schema'>
  : never

/** Static publication inputs and schema dependencies; it does not execute a provider. */
export interface ArtifactPublicationDeclaration {
  readonly contentSchema: AuthorSchema<ArtifactContentDescriptor>
  readonly reserve: (typeof RuntimeMethodSchemaRefs)['agh.artifacts']['reserve']
  readonly publish: (typeof RuntimeMethodSchemaRefs)['agh.artifacts']['publish']
  prepareReserve(input: ReserveInput): ArtifactsReserveRequest
  preparePublish(input: ArtifactsPublishRequest): ArtifactsPublishRequest
}

export function artifactPublicationDeclaration(): ArtifactPublicationDeclaration {
  const contentSchema = runtimeAuthorSchemas.ArtifactContentDescriptor
  const reserve = RuntimeArtifactPolicy.reserve
  const publish = RuntimeArtifactPolicy.publish
  return Object.freeze({
    contentSchema,
    reserve: RuntimeMethodSchemaRefs[reserve.contract][reserve.method],
    publish: RuntimeMethodSchemaRefs[publish.contract][publish.method],
    prepareReserve(input: ReserveInput): ArtifactsReserveRequest {
      const value = copyJson(input)
      if (Object.hasOwn(value, 'kind') || Object.hasOwn(value, 'schema'))
        declarationError('artifact schema is supplied by the locked descriptor')
      const checked = validateRuntime('ArtifactsReserveRequest', {
        ...value,
        kind: contentSchema.ref.typeId,
        schema: contentSchema.ref,
      })
      if (!checked.ok) declarationError('invalid artifact reservation input')
      return copyJson(checked.value)
    },
    preparePublish(input: ArtifactsPublishRequest): ArtifactsPublishRequest {
      const checked = validateRuntime('ArtifactsPublishRequest', copyJson(input))
      if (!checked.ok) declarationError('invalid artifact publication input')
      if (
        checked.value.source.kind === 'upload' &&
        checked.value.source.upload.mediaType !== checked.value.mediaType
      )
        declarationError('artifact media type does not match sealed upload')
      if (
        checked.value.source.kind === 'blob' &&
        checked.value.source.blob.mediaType !== checked.value.mediaType
      )
        declarationError('artifact media type does not match pinned blob')
      return copyJson(checked.value)
    },
  })
}
