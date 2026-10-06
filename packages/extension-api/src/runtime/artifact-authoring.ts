import type * as Wire from '@agnes/protocol/runtime'
import type {
  ArtifactContentDescriptor,
  ArtifactsPublishRequest,
  ArtifactsReserveRequest,
} from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  RuntimeArtifactPolicy,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import type { ArtifactDraft, ArtifactToolDeclaration, AuthorSchema } from './authoring.js'
import { createAuthorSchema } from './authoring-schema-core.js'
import { runtimeAuthorSchemas } from './authoring-schemas.js'
import { copyJson, declarationError } from './authoring-validation.js'
import type { CallContext, EffectPorts, Outcome } from './public-api.js'

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

/**
 * One standard artifact tool attempt over public EffectPorts. `sealed` is the committed sealed upload
 * receipt of an earlier attempt of the same action; with it the adapter publishes without rendering.
 */
export type ArtifactToolRun<C> = {
  readonly effects: EffectPorts
  readonly call: CallContext
  readonly target: { readonly artifactId: Wire.Id; readonly expectedLatestVersion: number } | null
  readonly config?: C
  readonly sealed: { readonly upload: Wire.UploadRef; readonly title: string } | null
}

function runError(code: Wire.RuntimeErrorCode, detailCode: string): Outcome<never> {
  return {
    ok: false,
    error: {
      code,
      detailCode,
      message: 'Artifact authoring adapter refused the operation',
      retryAdvice: { kind: 'never' },
      diagnosticId: 'artifact-authoring',
    },
  }
}

function same(a: unknown, b: unknown): boolean {
  return canonicalJsonDigest(a as Wire.JsonValue) === canonicalJsonDigest(b as Wire.JsonValue)
}

function interrupted(call: CallContext): Outcome<never> | undefined {
  if (call.signal.aborted) return runError('cancelled', 'artifact_cancelled')
  if (Date.now() >= Date.parse(call.deadline)) return runError('timeout', 'artifact_deadline')
  return undefined
}

const methodRefs = RuntimeMethodSchemaRefs['agh.artifacts']
const artifactMethods = {
  reserve: {
    input: createAuthorSchema(methodRefs.reserve.input, (value) =>
      validateRuntime('ArtifactsReserveRequest', value),
    ),
    output: createAuthorSchema(methodRefs.reserve.output, (value) =>
      validateRuntime('ArtifactReservation', value),
    ),
  },
  publish: {
    input: createAuthorSchema(methodRefs.publish.input, (value) =>
      validateRuntime('ArtifactsPublishRequest', value),
    ),
    output: createAuthorSchema(methodRefs.publish.output, (value) =>
      validateRuntime('ArtifactReservation', value),
    ),
  },
} as const

async function invokeArtifacts(
  run: ArtifactToolRun<unknown>,
  method: 'reserve' | 'publish',
  request: Wire.JsonValue,
  publicationId: Wire.Id,
): Promise<Outcome<Wire.ArtifactReservation>> {
  const stop = interrupted(run.call)
  if (stop) return stop
  const codecs = artifactMethods[method]
  const input = (codecs.input.encode as (value: Wire.JsonValue) => Outcome<Wire.DataRef>)(request)
  if (!input.ok) return runError('invalid_input', 'artifact_request_invalid')
  const policy = RuntimeArtifactPolicy[method]
  try {
    const result = await run.effects.invoke(
      { operation: `${policy.contract}.${policy.method}`, input: input.value },
      run.call,
    )
    if (!result.ok) {
      if (!validateRuntime('RuntimeError', result.error).ok) throw new Error('invalid effect error')
      return { ok: false, error: copyJson(result.error) }
    }
    const ref = result.value
    if (!validateRuntime('DataRef', ref).ok || ref.kind !== 'inline' || !same(ref.schema, codecs.output.ref))
      throw new Error('invalid effect output')
    const reservation = codecs.output.parse(ref.value)
    if (
      !reservation.ok ||
      !same(codecs.output.encode(reservation.value), { ok: true, value: ref }) ||
      reservation.value.publicationId !== publicationId ||
      !same(reservation.value.schema, RuntimeSchemaRefs.ArtifactContentDescriptor)
    )
      throw new Error('invalid reservation')
    return { ok: true, value: copyJson(reservation.value) }
  } catch {
    // The request may have been applied, so the outcome is unknown rather than failed.
    return runError('unknown_effect', 'artifact_confirmation_unknown')
  }
}

function readyRef(reservation: Wire.ArtifactReservation): Outcome<Wire.ArtifactRef> {
  if (reservation.state === 'ready')
    return { ok: true, value: { artifactId: reservation.artifactId, version: reservation.version } }
  if (reservation.state === 'pending-publish')
    return runError('unknown_effect', 'artifact_publication_pending')
  return runError('conflict', `artifact_publication_${reservation.state}`)
}

/**
 * Reserve with a stable key derived from the owner action, render, then publish a sealed upload.
 * Staging and sealing fresh bytes needs the public upload write path, which is not defined yet,
 * so a fresh render ends in operation_not_supported after reserve and render; nothing is published.
 */
export async function runArtifactTool<I, C>(
  tool: ArtifactToolDeclaration<I, C>,
  input: unknown,
  run: ArtifactToolRun<C>,
): Promise<Outcome<Wire.ArtifactRef>> {
  const parsed = tool.input.parse(input)
  if (!parsed.ok) return parsed
  const config = tool.config ? tool.config.schema.parse(run.config ?? tool.config.defaults) : undefined
  if (config && !config.ok) return config
  const scope = run.call.scope
  if (scope.kind !== 'action') return runError('invalid_input', 'artifact_owner_action_missing')
  const publicationId = canonicalJsonDigest({
    ownerActionId: scope.actionId,
    purpose: 'agh.artifacts/publication',
  })
  let reserveRequest: ArtifactsReserveRequest
  try {
    reserveRequest = tool.publication.prepareReserve({
      publicationId,
      artifactId: run.target?.artifactId ?? null,
      expectedLatestVersion: run.target?.expectedLatestVersion ?? null,
      ownerActionRef: { existingActionId: scope.actionId },
      title: null,
      mediaType: null,
    } as ReserveInput)
  } catch {
    return runError('invalid_input', 'artifact_reserve_input')
  }
  const reserved = await invokeArtifacts(run, 'reserve', reserveRequest, publicationId)
  if (!reserved.ok) return reserved
  if (reserved.value.state !== 'reserved') return readyRef(reserved.value)
  if (run.sealed) {
    let publishRequest: ArtifactsPublishRequest
    try {
      publishRequest = tool.publication.preparePublish({
        publicationId,
        source: { kind: 'upload', upload: run.sealed.upload },
        expectedRevision: reserved.value.revision,
        title: run.sealed.title,
        mediaType: run.sealed.upload.mediaType,
      })
    } catch {
      return runError('invalid_input', 'artifact_sealed_receipt')
    }
    const published = await invokeArtifacts(run, 'publish', publishRequest, publicationId)
    if (!published.ok) return published
    if (published.value.state === 'ready' && published.value.blob.digest !== run.sealed.upload.digest)
      return runError('unknown_effect', 'artifact_published_digest_mismatch')
    return readyRef(published.value)
  }
  const stop = interrupted(run.call)
  if (stop) return stop
  let draft: ArtifactDraft
  try {
    draft = await tool.render(
      parsed.value,
      Object.freeze({ signal: run.call.signal, config: (config?.value ?? {}) as C }),
    )
  } catch {
    return interrupted(run.call) ?? runError('internal', 'artifact_render_failed')
  }
  const afterRender = interrupted(run.call)
  if (afterRender) return afterRender
  if (!(draft?.bytes instanceof Uint8Array)) return runError('invalid_input', 'artifact_draft_invalid')
  const bytes = new Uint8Array(draft.bytes)
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
  let descriptor: Outcome<Wire.DataRef>
  try {
    descriptor = tool.publication.contentSchema.encode({
      title: draft.title,
      mediaType: draft.mediaType,
      bytes: bytes.byteLength,
      digest,
    })
  } catch {
    return runError('invalid_input', 'artifact_draft_invalid')
  }
  if (!descriptor.ok) return runError('invalid_input', 'artifact_draft_invalid')
  // Stage and seal wait on the public upload write path; add them here once that contract exists.
  return runError('incompatible', 'operation_not_supported')
}
