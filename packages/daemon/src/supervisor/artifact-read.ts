import { types as utilTypes } from 'node:util'
import { createLocalArtifactReadStore } from '@agnes/host'
import {
  type ArtifactReadAuthorityPort,
  createAuthenticatedArtifactReadHandler,
  createTrustedSessionArtifactReadHandler,
  type TrustedSessionArtifactRead,
} from '../local/artifact-read.js'
import { PersistentArtifactReadAuthorityIndex } from '../local/artifact-read-authority.js'
import type { ArtifactReadRpcOptions, ArtifactReadScopeAuthority } from '../local/methods/artifacts.js'
import { SessionPrincipalOwnershipIndex } from '../storage/session-ownership.js'
import {
  type ArtifactAuthorityProjectionWriter,
  createArtifactAuthorityProjection,
  type TrustedArtifactOwnership,
} from './artifact-authority-projection.js'

export type ProductionArtifactReadAuthority = Readonly<{
  /** Trusted durable session/lane/owner binding. Request data is never a writer capability. */
  authority: ArtifactReadAuthorityPort
  /** Authenticated session/lane membership resolver owned by daemon composition. */
  scope: ArtifactReadScopeAuthority
  limits: Readonly<{ maxArtifactBytes: number; maxResponseBytes: number }>
  operationTimeoutMs: number
  scopeTimeoutMs: number
  readTimeoutMs?: number
}>

export type ProductionArtifactAuthorityProjection = Readonly<{
  authority: ArtifactReadAuthorityPort
  writer: ArtifactAuthorityProjectionWriter
  ownership: TrustedArtifactOwnership
  limits: Readonly<{ maxArtifactBytes: number; maxResponseBytes: number }>
  operationTimeoutMs: number
  scopeTimeoutMs: number
  readTimeoutMs?: number
}>

export type DefaultProductionArtifactAuthorityProjection = Readonly<{
  /** Dedicated durable artifact authority index. */
  artifactAuthority: PersistentArtifactReadAuthorityIndex
  /** Durable active-session principal authority. Pending reservations are never owners. */
  sessionOwnership: SessionPrincipalOwnershipIndex
  limits: Readonly<{ maxArtifactBytes: number; maxResponseBytes: number }>
  operationTimeoutMs: number
  scopeTimeoutMs: number
  readTimeoutMs?: number
}>

function exactConfiguration(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, PropertyDescriptor> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error('invalid')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const allowed = new Set([...required, ...optional])
  if (
    required.some(
      (key) => descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key] ?? {}, 'value'),
    ) ||
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' ||
        !allowed.has(key) ||
        descriptors[key]?.enumerable !== true ||
        !Object.hasOwn(descriptors[key] ?? {}, 'value'),
    )
  )
    throw new Error('invalid')
  return descriptors
}

/**
 * Default durable projection composition. This only wires already-created daemon-owned indexes;
 * it does not choose product limits, admit/start a driver, or infer ownership from request data.
 */
export function composeDefaultProductionProjectedArtifactRead(
  dataDir: string,
  input: DefaultProductionArtifactAuthorityProjection,
): ReturnType<typeof composeProductionProjectedArtifactRead> {
  try {
    const descriptors = exactConfiguration(
      input,
      ['artifactAuthority', 'sessionOwnership', 'limits', 'operationTimeoutMs', 'scopeTimeoutMs'],
      ['readTimeoutMs'],
    )
    const artifactAuthority = descriptors.artifactAuthority?.value
    const sessionOwnership = descriptors.sessionOwnership?.value
    if (
      utilTypes.isProxy(artifactAuthority) ||
      Object.getPrototypeOf(artifactAuthority) !== PersistentArtifactReadAuthorityIndex.prototype ||
      utilTypes.isProxy(sessionOwnership) ||
      Object.getPrototypeOf(sessionOwnership) !== SessionPrincipalOwnershipIndex.prototype
    )
      throw new Error('invalid')

    const resolveOwner = SessionPrincipalOwnershipIndex.prototype.resolve
    const ownership: TrustedArtifactOwnership = Object.freeze({
      async resolve(sessionId: string, signal: AbortSignal): Promise<unknown> {
        if (signal.aborted) throw new Error('session ownership unavailable')
        const active = Reflect.apply(resolveOwner, sessionOwnership, [sessionId]) as unknown
        if (signal.aborted) throw new Error('session ownership unavailable')
        return active
      },
    })
    const append = PersistentArtifactReadAuthorityIndex.prototype.append
    const revoke = PersistentArtifactReadAuthorityIndex.prototype.revoke
    const resolveArtifact = PersistentArtifactReadAuthorityIndex.prototype.resolve
    const authority: ArtifactReadAuthorityPort = Object.freeze({
      async resolve(sessionId: string, laneId: string, sha256: string, signal: AbortSignal) {
        if (signal.aborted) throw new Error('artifact read authority lookup unavailable')
        const binding = Reflect.apply(resolveArtifact, artifactAuthority, [sessionId, laneId, sha256])
        if (signal.aborted) throw new Error('artifact read authority lookup unavailable')
        if (!binding) return undefined
        return Object.freeze({
          sessionId: binding.sessionId,
          laneId: binding.laneId,
          ownerId: binding.ownerId,
          artifact: binding.artifact,
        })
      },
    })
    const writer: ArtifactAuthorityProjectionWriter = Object.freeze({
      append: (authority, binding) => Reflect.apply(append, artifactAuthority, [authority, binding]),
      revoke: (authority, binding) => Reflect.apply(revoke, artifactAuthority, [authority, binding]),
    })
    return composeProductionProjectedArtifactRead(dataDir, {
      authority,
      writer,
      ownership,
      limits: descriptors.limits?.value as ProductionArtifactAuthorityProjection['limits'],
      operationTimeoutMs: descriptors.operationTimeoutMs?.value as number,
      scopeTimeoutMs: descriptors.scopeTimeoutMs?.value as number,
      ...(descriptors.readTimeoutMs === undefined
        ? {}
        : { readTimeoutMs: descriptors.readTimeoutMs.value as number }),
    })
  } catch {
    throw new TypeError('default production artifact projection configuration is invalid')
  }
}

/** Complete projected production variant: one explicit authority set owns writer, scope and read. */
export function composeProductionProjectedArtifactRead(
  dataDir: string,
  input: ProductionArtifactAuthorityProjection,
): Readonly<{
  rpc: ArtifactReadRpcOptions
  projection: ReturnType<typeof createArtifactAuthorityProjection>
  workerRead: TrustedSessionArtifactRead
}> {
  try {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      utilTypes.isProxy(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    )
      throw new Error('invalid')
    const descriptors = Object.getOwnPropertyDescriptors(input)
    const required = ['authority', 'writer', 'ownership', 'limits', 'operationTimeoutMs', 'scopeTimeoutMs']
    const allowed = new Set([...required, 'readTimeoutMs'])
    if (
      required.some(
        (key) => descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key] ?? {}, 'value'),
      ) ||
      Reflect.ownKeys(descriptors).some(
        (key) =>
          typeof key !== 'string' ||
          !allowed.has(key) ||
          descriptors[key]?.enumerable !== true ||
          !Object.hasOwn(descriptors[key] ?? {}, 'value'),
      )
    )
      throw new Error('invalid')
    const limitsValue = descriptors.limits?.value as unknown
    if (
      !limitsValue ||
      typeof limitsValue !== 'object' ||
      Array.isArray(limitsValue) ||
      utilTypes.isProxy(limitsValue) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(limitsValue))
    )
      throw new Error('invalid')
    const limitDescriptors = Object.getOwnPropertyDescriptors(limitsValue)
    if (
      Reflect.ownKeys(limitDescriptors).length !== 2 ||
      !['maxArtifactBytes', 'maxResponseBytes'].every(
        (key) =>
          limitDescriptors[key]?.enumerable === true && Object.hasOwn(limitDescriptors[key] ?? {}, 'value'),
      )
    )
      throw new Error('invalid')
    const limits = Object.freeze({
      maxArtifactBytes: limitDescriptors.maxArtifactBytes?.value as number,
      maxResponseBytes: limitDescriptors.maxResponseBytes?.value as number,
    })
    const artifacts = createLocalArtifactReadStore({ dataDir, maxArtifactBytes: limits.maxArtifactBytes })
    const projection = createArtifactAuthorityProjection({
      writer: descriptors.writer?.value as ArtifactAuthorityProjectionWriter,
      ownership: descriptors.ownership?.value as TrustedArtifactOwnership,
      inspector: Object.freeze({ inspect: artifacts.inspect.bind(artifacts) }),
    })
    const legacy: ProductionArtifactReadAuthority = Object.freeze({
      authority: descriptors.authority?.value as ArtifactReadAuthorityPort,
      scope: projection.scope,
      limits,
      operationTimeoutMs: descriptors.operationTimeoutMs?.value as number,
      scopeTimeoutMs: descriptors.scopeTimeoutMs?.value as number,
      ...(descriptors.readTimeoutMs === undefined
        ? {}
        : { readTimeoutMs: descriptors.readTimeoutMs.value as number }),
    })
    const workerRead = createTrustedSessionArtifactReadHandler({
      authority: legacy.authority,
      artifacts: Object.freeze({ get: artifacts.get }),
      limits,
      operationTimeoutMs: legacy.operationTimeoutMs,
    })
    return Object.freeze({
      rpc: composeProductionArtifactReadWithStore(dataDir, legacy, projection.scope, artifacts),
      projection,
      workerRead,
    })
  } catch {
    throw new TypeError('production artifact projection configuration is invalid')
  }
}

/**
 * Fit the real Base artifact directory to the authenticated RPC only when both trusted authorities
 * are explicitly present. Callers that omit this input leave the method unregistered.
 */
export function composeProductionArtifactRead(
  dataDir: string,
  input: ProductionArtifactReadAuthority,
): ArtifactReadRpcOptions {
  return composeProductionArtifactReadWithStore(dataDir, input)
}

function composeProductionArtifactReadWithStore(
  dataDir: string,
  input: ProductionArtifactReadAuthority,
  scopeOverride?: ArtifactReadScopeAuthority,
  artifactStore?: ReturnType<typeof createLocalArtifactReadStore>,
): ArtifactReadRpcOptions {
  try {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      utilTypes.isProxy(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    )
      throw new Error('invalid')
    const descriptors = Object.getOwnPropertyDescriptors(input)
    const allowed = new Set([
      'authority',
      'scope',
      'limits',
      'operationTimeoutMs',
      'scopeTimeoutMs',
      'readTimeoutMs',
    ])
    if (
      !['authority', 'scope', 'limits', 'operationTimeoutMs', 'scopeTimeoutMs'].every(
        (key) => descriptors[key]?.enumerable === true && Object.hasOwn(descriptors[key] ?? {}, 'value'),
      ) ||
      Reflect.ownKeys(descriptors).some(
        (key) =>
          typeof key !== 'string' ||
          !allowed.has(key) ||
          descriptors[key]?.enumerable !== true ||
          !Object.hasOwn(descriptors[key] ?? {}, 'value'),
      )
    )
      throw new Error('invalid')
    const authority = descriptors.authority?.value as ArtifactReadAuthorityPort
    const scopeValue = descriptors.scope?.value as unknown
    const limitsValue = descriptors.limits?.value as unknown
    const operationTimeoutMs = descriptors.operationTimeoutMs?.value as number
    const scopeTimeoutMs = descriptors.scopeTimeoutMs?.value as number
    const readTimeoutMs = descriptors.readTimeoutMs?.value as number | undefined
    if (
      !scopeValue ||
      typeof scopeValue !== 'object' ||
      Array.isArray(scopeValue) ||
      utilTypes.isProxy(scopeValue) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(scopeValue)) ||
      !limitsValue ||
      typeof limitsValue !== 'object' ||
      Array.isArray(limitsValue) ||
      utilTypes.isProxy(limitsValue) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(limitsValue))
    )
      throw new Error('invalid')
    const scopeDescriptors = Object.getOwnPropertyDescriptors(scopeValue)
    const limitDescriptors = Object.getOwnPropertyDescriptors(limitsValue)
    if (
      Reflect.ownKeys(scopeDescriptors).length !== 1 ||
      scopeDescriptors.resolve?.enumerable !== true ||
      !Object.hasOwn(scopeDescriptors.resolve ?? {}, 'value') ||
      typeof scopeDescriptors.resolve?.value !== 'function' ||
      utilTypes.isProxy(scopeDescriptors.resolve.value) ||
      Reflect.ownKeys(limitDescriptors).length !== 2 ||
      !['maxArtifactBytes', 'maxResponseBytes'].every(
        (key) =>
          limitDescriptors[key]?.enumerable === true && Object.hasOwn(limitDescriptors[key] ?? {}, 'value'),
      )
    )
      throw new Error('invalid')
    const scope =
      scopeOverride ??
      (Object.freeze({ resolve: scopeDescriptors.resolve.value }) as ArtifactReadScopeAuthority)
    const limits = Object.freeze({
      maxArtifactBytes: limitDescriptors.maxArtifactBytes?.value as number,
      maxResponseBytes: limitDescriptors.maxResponseBytes?.value as number,
    })
    const artifacts =
      artifactStore ?? createLocalArtifactReadStore({ dataDir, maxArtifactBytes: limits.maxArtifactBytes })
    const read = createAuthenticatedArtifactReadHandler({
      authority,
      artifacts: Object.freeze({ get: artifacts.get }),
      limits,
      operationTimeoutMs,
    })
    return Object.freeze({
      read,
      scope,
      scopeTimeoutMs,
      ...(readTimeoutMs === undefined ? {} : { readTimeoutMs }),
    })
  } catch {
    throw new TypeError('production artifact read configuration is invalid')
  }
}

/** The worker's `artifact-media-read` reply: a screenshot's bytes, reclaimed, or nothing. */
export function artifactMediaReadReply(
  result: Awaited<ReturnType<TrustedSessionArtifactRead>>,
  sha256: string,
): Readonly<Record<string, unknown>> | undefined {
  if (result && 'reclaimed' in result) return Object.freeze({ sha256, reclaimed: true })
  if (!result || (result.artifact.mime !== 'image/png' && result.artifact.mime !== 'image/jpeg'))
    return undefined
  return Object.freeze({
    sha256: result.artifact.sha256,
    size: result.artifact.size,
    mime: result.artifact.mime,
    data: Buffer.from(result.body).toString('base64'),
  })
}
