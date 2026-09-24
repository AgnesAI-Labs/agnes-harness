import { isProxy } from 'node:util/types'
import {
  type ComputerUseDriverLock,
  type DriverAdmissionDecision,
  type DriverAdmissionEvidence,
  evaluateComputerUseDriverAdmission,
} from './driver-lock.js'

const SHA256 = /^[0-9a-f]{64}$/
const READ_ACTIONS = new Set(['capture', 'wait', 'list_apps', 'list_windows'])
const MUTATION_ACTIONS = new Set([
  'click',
  'double_click',
  'right_click',
  'middle_click',
  'drag',
  'scroll',
  'type',
  'key',
  'set_value',
  'launch_app',
  'focus_app',
])
const MODES = new Set(['standard', 'bounded', 'unrestricted'])
const AUTHORIZATIONS = new Set([
  'driver-standard',
  'reviewed-manifest',
  'session-yolo',
  'trusted-profile-off',
])
const APPROVALS = new Set(['not-required', 'approved', 'bounded-manifest', 'bypassed'])

export type ComputerUseDeliveryMode = 'background' | 'foreground'
export type ComputerUsePermissionMode = 'standard' | 'bounded' | 'unrestricted'
export type ComputerUseAuthorization =
  | 'driver-standard'
  | 'reviewed-manifest'
  | 'session-yolo'
  | 'trusted-profile-off'

/** Caller facts only. Security authority is resolved inside Host and cannot be supplied here. */
export type ComputerUseEnforcementRequest = Readonly<{
  session: Readonly<{ key: string; lane: string; ownerId: string }>
  profileHash: string
  callId: string
  effectId: string
  argsHash: string
  action: string
  deliveryMode: ComputerUseDeliveryMode
  bringToFront: boolean
}>

export type ComputerUseHostAuthority = Readonly<{
  decision: 'allowed'
  sessionKey: string
  lane: string
  ownerId: string
  profileHash: string
  callId: string
  effectId: string
  argsHash: string
  action: string
  deliveryMode: ComputerUseDeliveryMode
  bringToFront: boolean
  executionDomain: 'host-computer-use'
  source: 'agnes/computer-use'
  trust: 'builtin'
  definitionFingerprint: string
  policyHash: string
  generation: number
  mode: ComputerUsePermissionMode
  authorization: ComputerUseAuthorization
  capabilityManifestDigest?: string
  approval: 'not-required' | 'approved' | 'bounded-manifest' | 'bypassed'
  approvalScopes: readonly string[]
  capability?: Readonly<{
    manifestDigest: string
    action: string
    deliveryMode: ComputerUseDeliveryMode
  }>
  surface?: Readonly<{
    reliable: boolean
    secureInput?: boolean
    payment?: boolean
    twoFactor?: boolean
    systemPermission?: boolean
  }>
}>

export type ComputerUseAuthorityResolver = Readonly<{
  /** Must attest the current active session-owned generation; stale/closed transports are denied. */
  resolve(request: ComputerUseEnforcementRequest): Promise<unknown>
}>

export type ComputerUseEffectBinding = Readonly<{
  effectId: string
  sessionKey: string
  lane: string
  ownerId: string
  profileHash: string
  callId: string
  argsHash: string
  action: string
  deliveryMode: ComputerUseDeliveryMode
  bringToFront: boolean
  definitionFingerprint: string
  policyHash: string
  generation: number
  mode: ComputerUsePermissionMode
  authorization: ComputerUseAuthorization
  capabilityManifestDigest?: string
}>

/**
 * `claim` atomically persists `dispatching` before returning claimed. A recovered dispatching row is
 * terminal unknown. Only a durably finished `not_sent` row may be claimed again.
 */
export type ComputerUseEffectStore = Readonly<{
  claim(
    binding: ComputerUseEffectBinding,
  ): Promise<
    | Readonly<{ status: 'claimed' }>
    | Readonly<{ status: 'terminal'; phase: 'dispatching' | 'responded' | 'unknown' }>
    | Readonly<{ status: 'conflict' }>
  >
  finish(binding: ComputerUseEffectBinding, phase: 'responded' | 'not_sent' | 'unknown'): Promise<void>
}>

export type ComputerUseAttempt<T> =
  | Readonly<{ phase: 'responded'; result: T }>
  | Readonly<{ phase: 'not_sent'; error: unknown }>
  | Readonly<{ phase: 'may_have_sent'; error: unknown }>

export type ComputerUseAttemptDecision<T> =
  | Readonly<{ phase: 'responded'; result: T }>
  | Readonly<{ phase: 'not_sent' }>
  | Readonly<{ phase: 'may_have_sent' }>

type Snapshot<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>

export type ComputerUseDispatchFailure = Readonly<{
  code: 'transport-not-sent' | 'transport-outcome-unknown'
  message: string
}>

export type ComputerUseEnforcementResult<T> =
  | Readonly<{ status: 'responded'; result: T }>
  | Readonly<{ status: 'not-sent'; error: ComputerUseDispatchFailure; retryable: true }>
  | Readonly<{ status: 'unknown-outcome'; error: ComputerUseDispatchFailure; replayAllowed: false }>
  | Readonly<{ status: 'refused'; code: string; message: string }>

export type ComputerUseHostEnforcer = Readonly<{
  dispatch<T>(
    request: ComputerUseEnforcementRequest,
    attempt: () => Promise<ComputerUseAttempt<T>>,
  ): Promise<ComputerUseEnforcementResult<T>>
}>

type Dependencies = Readonly<{
  admission: () => DriverAdmissionDecision
  authority: ComputerUseAuthorityResolver
  effects?: ComputerUseEffectStore
}>

const refused = (code: string, message: string): ComputerUseEnforcementResult<never> => ({
  status: 'refused',
  code,
  message,
})

const notSentFailure = (): ComputerUseDispatchFailure => ({
  code: 'transport-not-sent',
  message: 'The trusted transport proved that no mutation bytes were sent.',
})

const unknownFailure = (): ComputerUseDispatchFailure => ({
  code: 'transport-outcome-unknown',
  message: 'The transport outcome is unknown; the mutation will not be replayed.',
})

function boundedIdentity(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= max &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code <= 0x1f || code === 0x7f
    })
  )
}

function plain(value: unknown, allowed: ReadonlySet<string>): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  if (Object.getOwnPropertySymbols(value).length !== 0) return false
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>
  const keys = Reflect.ownKeys(descriptors)
  return keys.every((key) => {
    if (typeof key !== 'string' || !allowed.has(key)) return false
    const descriptor = descriptors[key]
    return !!descriptor?.enumerable && 'value' in descriptor
  })
}

function snapshotResult<T>(value: T): Snapshot<T> {
  const active = new WeakSet<object>()
  let nodes = 0
  const visit = (current: unknown, depth: number): Snapshot<unknown> => {
    if (
      current === null ||
      typeof current === 'string' ||
      typeof current === 'boolean' ||
      typeof current === 'undefined'
    )
      return { ok: true, value: current }
    if (typeof current === 'number')
      return Number.isFinite(current) ? { ok: true, value: current } : { ok: false }
    if (typeof current !== 'object' || depth > 64 || ++nodes > 100_000 || isProxy(current))
      return { ok: false }
    if (active.has(current)) return { ok: false }
    active.add(current)
    try {
      const descriptors = Object.getOwnPropertyDescriptors(current) as unknown as Record<
        string,
        PropertyDescriptor
      >
      const keys = Reflect.ownKeys(descriptors)
      if (keys.some((key) => typeof key !== 'string')) return { ok: false }
      const stringKeys = keys as string[]
      if (Array.isArray(current)) {
        const length = current.length
        if (
          stringKeys.length !== length + 1 ||
          !stringKeys.includes('length') ||
          stringKeys.some((key) => key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))
        )
          return { ok: false }
        const copy: unknown[] = []
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[String(index)]
          if (!descriptor?.enumerable || !('value' in descriptor)) return { ok: false }
          const item = visit(descriptor.value, depth + 1)
          if (!item.ok) return item
          copy.push(item.value)
        }
        return { ok: true, value: Object.freeze(copy) }
      }
      const prototype = Object.getPrototypeOf(current)
      if (prototype !== Object.prototype && prototype !== null) return { ok: false }
      const copy = Object.create(prototype) as Record<string, unknown>
      for (const key of stringKeys) {
        const descriptor = descriptors[key]
        if (!descriptor?.enumerable || !('value' in descriptor)) return { ok: false }
        const property = visit(descriptor.value, depth + 1)
        if (!property.ok) return property
        Object.defineProperty(copy, key, {
          value: property.value,
          enumerable: true,
          writable: false,
          configurable: false,
        })
      }
      return { ok: true, value: Object.freeze(copy) }
    } catch {
      return { ok: false }
    } finally {
      active.delete(current)
    }
  }
  return visit(value, 0) as Snapshot<T>
}

function exactPlain(value: unknown, fields: ReadonlySet<string>): value is Record<string, unknown> {
  return plain(value, fields) && Reflect.ownKeys(value).length === fields.size
}

const AUTHORITY_FIELDS = new Set([
  'decision',
  'sessionKey',
  'lane',
  'ownerId',
  'profileHash',
  'callId',
  'effectId',
  'argsHash',
  'action',
  'deliveryMode',
  'bringToFront',
  'executionDomain',
  'source',
  'trust',
  'definitionFingerprint',
  'policyHash',
  'generation',
  'mode',
  'authorization',
  'capabilityManifestDigest',
  'approval',
  'approvalScopes',
  'capability',
  'surface',
])
const REQUEST_FIELDS = new Set([
  'session',
  'profileHash',
  'callId',
  'effectId',
  'argsHash',
  'action',
  'deliveryMode',
  'bringToFront',
])
const SESSION_FIELDS = new Set(['key', 'lane', 'ownerId'])
const CAPABILITY_FIELDS = new Set(['manifestDigest', 'action', 'deliveryMode'])
const SURFACE_FIELDS = new Set(['reliable', 'secureInput', 'payment', 'twoFactor', 'systemPermission'])

function booleanOrAbsent(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean'
}

function denseStringArray(value: unknown, maximum: number): readonly string[] | undefined {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype)
    return undefined
  if (Object.getOwnPropertySymbols(value).length !== 0) return undefined
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>
  const length = descriptors.length?.value
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) return undefined
  const copy: string[] = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor?.enumerable || !('value' in descriptor) || !boundedIdentity(descriptor.value, 128))
      return undefined
    copy.push(descriptor.value)
  }
  if (Reflect.ownKeys(descriptors).length !== length + 1) return undefined
  return Object.freeze(copy)
}

function snapshotRequest(value: unknown): ComputerUseEnforcementRequest | undefined {
  try {
    if (!plain(value, REQUEST_FIELDS) || !plain(value.session, SESSION_FIELDS)) return undefined
    if (
      Reflect.ownKeys(value).length !== REQUEST_FIELDS.size ||
      Reflect.ownKeys(value.session).length !== SESSION_FIELDS.size ||
      !boundedIdentity(value.session.key, 512) ||
      !boundedIdentity(value.session.lane, 64) ||
      !boundedIdentity(value.session.ownerId, 256) ||
      typeof value.profileHash !== 'string' ||
      !SHA256.test(value.profileHash) ||
      !boundedIdentity(value.callId, 256) ||
      !boundedIdentity(value.effectId, 256) ||
      typeof value.argsHash !== 'string' ||
      !SHA256.test(value.argsHash) ||
      !boundedIdentity(value.action, 64) ||
      (value.deliveryMode !== 'background' && value.deliveryMode !== 'foreground') ||
      typeof value.bringToFront !== 'boolean'
    )
      return undefined
    return Object.freeze({
      session: Object.freeze({
        key: value.session.key,
        lane: value.session.lane,
        ownerId: value.session.ownerId,
      }),
      profileHash: value.profileHash,
      callId: value.callId,
      effectId: value.effectId,
      argsHash: value.argsHash,
      action: value.action,
      deliveryMode: value.deliveryMode,
      bringToFront: value.bringToFront,
    })
  } catch {
    return undefined
  }
}

function validateAuthority(value: unknown): ComputerUseHostAuthority | undefined {
  try {
    if (!plain(value, AUTHORITY_FIELDS)) return undefined
    const scopes = denseStringArray(value.approvalScopes, 16)
    if (
      value.decision !== 'allowed' ||
      !boundedIdentity(value.sessionKey, 512) ||
      !boundedIdentity(value.lane, 64) ||
      !boundedIdentity(value.ownerId, 256) ||
      typeof value.profileHash !== 'string' ||
      !SHA256.test(value.profileHash) ||
      !boundedIdentity(value.callId, 256) ||
      !boundedIdentity(value.effectId, 256) ||
      typeof value.argsHash !== 'string' ||
      !SHA256.test(value.argsHash) ||
      !boundedIdentity(value.action, 64) ||
      (value.deliveryMode !== 'background' && value.deliveryMode !== 'foreground') ||
      typeof value.bringToFront !== 'boolean' ||
      value.executionDomain !== 'host-computer-use' ||
      value.source !== 'agnes/computer-use' ||
      value.trust !== 'builtin' ||
      typeof value.definitionFingerprint !== 'string' ||
      !SHA256.test(value.definitionFingerprint) ||
      typeof value.policyHash !== 'string' ||
      !SHA256.test(value.policyHash) ||
      !Number.isSafeInteger(value.generation) ||
      (value.generation as number) < 1 ||
      typeof value.mode !== 'string' ||
      !MODES.has(value.mode) ||
      typeof value.authorization !== 'string' ||
      !AUTHORIZATIONS.has(value.authorization) ||
      typeof value.approval !== 'string' ||
      !APPROVALS.has(value.approval) ||
      !scopes
    )
      return undefined
    if (
      value.capabilityManifestDigest !== undefined &&
      (typeof value.capabilityManifestDigest !== 'string' || !SHA256.test(value.capabilityManifestDigest))
    )
      return undefined
    if (value.capability !== undefined) {
      if (
        !plain(value.capability, CAPABILITY_FIELDS) ||
        Reflect.ownKeys(value.capability).length !== CAPABILITY_FIELDS.size ||
        typeof value.capability.manifestDigest !== 'string' ||
        !SHA256.test(value.capability.manifestDigest) ||
        !boundedIdentity(value.capability.action, 64) ||
        (value.capability.deliveryMode !== 'background' && value.capability.deliveryMode !== 'foreground')
      )
        return undefined
    }
    if (value.surface !== undefined) {
      if (
        !plain(value.surface, SURFACE_FIELDS) ||
        typeof value.surface.reliable !== 'boolean' ||
        !booleanOrAbsent(value.surface.secureInput) ||
        !booleanOrAbsent(value.surface.payment) ||
        !booleanOrAbsent(value.surface.twoFactor) ||
        !booleanOrAbsent(value.surface.systemPermission)
      )
        return undefined
    }
    return Object.freeze({
      ...value,
      approvalScopes: scopes,
      ...(value.capability === undefined
        ? {}
        : { capability: Object.freeze({ ...(value.capability as Record<string, unknown>) }) }),
      ...(value.surface === undefined
        ? {}
        : { surface: Object.freeze({ ...(value.surface as Record<string, unknown>) }) }),
    }) as ComputerUseHostAuthority
  } catch {
    return undefined
  }
}

function requiredScopes(request: ComputerUseEnforcementRequest): string[] {
  return [
    `cua:${request.action}:${request.deliveryMode}`,
    ...(request.bringToFront ? ['cua:bring_to_front'] : []),
  ]
}

function sensitiveSurface(authority: ComputerUseHostAuthority): boolean {
  const surface = authority.surface
  return !!(surface?.secureInput || surface?.payment || surface?.twoFactor || surface?.systemPermission)
}

function authorityMatches(
  request: ComputerUseEnforcementRequest,
  authority: ComputerUseHostAuthority,
): boolean {
  if (
    authority.sessionKey !== request.session.key ||
    authority.lane !== request.session.lane ||
    authority.ownerId !== request.session.ownerId ||
    authority.profileHash !== request.profileHash ||
    authority.callId !== request.callId ||
    authority.effectId !== request.effectId ||
    authority.argsHash !== request.argsHash ||
    authority.action !== request.action ||
    authority.deliveryMode !== request.deliveryMode ||
    authority.bringToFront !== request.bringToFront
  )
    return false
  const mutation = MUTATION_ACTIONS.has(request.action)
  if (!mutation && (authority.approval !== 'not-required' || authority.approvalScopes.length !== 0))
    return false
  if (authority.mode === 'standard')
    return (
      authority.authorization === 'driver-standard' &&
      !Object.hasOwn(authority, 'capabilityManifestDigest') &&
      !Object.hasOwn(authority, 'capability') &&
      (mutation ? authority.approval === 'approved' : authority.approval === 'not-required')
    )
  if (authority.mode === 'bounded')
    return (
      authority.authorization === 'reviewed-manifest' &&
      (mutation
        ? authority.approval === 'approved' || authority.approval === 'bounded-manifest'
        : authority.approval === 'not-required') &&
      authority.capabilityManifestDigest !== undefined &&
      authority.capability?.manifestDigest === authority.capabilityManifestDigest &&
      authority.capability.action === request.action &&
      authority.capability.deliveryMode === request.deliveryMode
    )
  return (
    (authority.authorization === 'session-yolo' || authority.authorization === 'trusted-profile-off') &&
    !Object.hasOwn(authority, 'capabilityManifestDigest') &&
    !Object.hasOwn(authority, 'capability') &&
    (mutation ? authority.approval === 'bypassed' : authority.approval === 'not-required')
  )
}

function effectBinding(
  request: ComputerUseEnforcementRequest,
  authority: ComputerUseHostAuthority,
): ComputerUseEffectBinding {
  return Object.freeze({
    effectId: request.effectId,
    sessionKey: request.session.key,
    lane: request.session.lane,
    ownerId: request.session.ownerId,
    profileHash: request.profileHash,
    callId: request.callId,
    argsHash: request.argsHash,
    action: request.action,
    deliveryMode: request.deliveryMode,
    bringToFront: request.bringToFront,
    definitionFingerprint: authority.definitionFingerprint,
    policyHash: authority.policyHash,
    generation: authority.generation,
    mode: authority.mode,
    authorization: authority.authorization,
    ...(authority.capabilityManifestDigest
      ? { capabilityManifestDigest: authority.capabilityManifestDigest }
      : {}),
  })
}

export type ComputerUsePolicyDecision =
  | Readonly<{ allowed: true; mutation: boolean; binding: ComputerUseEffectBinding }>
  | Readonly<{ allowed: false; code: string; message: string }>

/** Pure Host policy boundary. It validates and snapshots both sides and never executes transport I/O. */
export function evaluateComputerUseHostPolicy(
  requestValue: unknown,
  authorityValue: unknown,
): ComputerUsePolicyDecision {
  const request = snapshotRequest(requestValue)
  if (!request)
    return Object.freeze({
      allowed: false,
      code: 'invalid_host_binding',
      message: 'Computer Use Host identity is invalid.',
    })
  const read = READ_ACTIONS.has(request.action)
  const mutation = MUTATION_ACTIONS.has(request.action)
  if (!read && !mutation)
    return Object.freeze({
      allowed: false,
      code: 'unknown_action',
      message: 'Unknown Computer Use action was not dispatched.',
    })
  if (request.bringToFront && (!mutation || request.deliveryMode !== 'foreground'))
    return Object.freeze({
      allowed: false,
      code: 'bring_to_front_requires_foreground',
      message: 'bring_to_front requires a foreground mutation.',
    })
  const authority = validateAuthority(authorityValue)
  if (!authority || !authorityMatches(request, authority))
    return Object.freeze({
      allowed: false,
      code: 'untrusted_host_authority',
      message: 'Computer Use Host authority is invalid or does not match this call.',
    })
  if (mutation && sensitiveSurface(authority))
    return Object.freeze({
      allowed: false,
      code: 'secure_surface_blocked',
      message: 'Computer input is blocked on a sensitive surface in every mode.',
    })
  if (mutation && !requiredScopes(request).every((scope) => authority.approvalScopes.includes(scope)))
    return Object.freeze({
      allowed: false,
      code: 'approval_scope_missing',
      message: 'Approval does not cover every Computer Use side effect.',
    })
  return Object.freeze({ allowed: true, mutation, binding: effectBinding(request, authority) })
}

export type ComputerUseMutationClaimDecision =
  | Readonly<{ dispatch: true }>
  | Readonly<{ dispatch: false; code: string }>

/** Pure decision for a strictly validated durable claim receipt; it cannot call a transport. */
export function evaluateComputerUseMutationClaim(value: unknown): ComputerUseMutationClaimDecision {
  try {
    if (exactPlain(value, new Set(['status'])) && value.status === 'claimed')
      return Object.freeze({ dispatch: true })
    if (exactPlain(value, new Set(['status'])) && value.status === 'conflict')
      return Object.freeze({ dispatch: false, code: 'effect_identity_collision' })
    if (
      exactPlain(value, new Set(['status', 'phase'])) &&
      value.status === 'terminal' &&
      (value.phase === 'dispatching' || value.phase === 'responded' || value.phase === 'unknown')
    )
      return Object.freeze({
        dispatch: false,
        code: value.phase === 'responded' ? 'mutation_already_dispatched' : 'mutation_outcome_unknown',
      })
    return Object.freeze({ dispatch: false, code: 'durable_effect_store_unavailable' })
  } catch {
    return Object.freeze({ dispatch: false, code: 'durable_effect_store_unavailable' })
  }
}

/**
 * Snapshots one transport receipt without executing I/O. Malformed or hostile receipts are treated
 * as may-have-sent, and transport errors are intentionally discarded at this boundary.
 */
export function evaluateComputerUseAttempt<T>(value: unknown): ComputerUseAttemptDecision<T> {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value))
      return Object.freeze({ phase: 'may_have_sent' })
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return Object.freeze({ phase: 'may_have_sent' })
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
      string,
      PropertyDescriptor
    >
    const keys = Reflect.ownKeys(descriptors)
    if (keys.some((key) => typeof key !== 'string')) return Object.freeze({ phase: 'may_have_sent' })
    const phase = descriptors.phase
    if (!phase?.enumerable || !('value' in phase)) return Object.freeze({ phase: 'may_have_sent' })
    if (phase.value === 'responded' && keys.length === 2 && keys.includes('result')) {
      const result = descriptors.result
      if (result?.enumerable && 'value' in result) {
        const snapshot = snapshotResult(result.value as T)
        if (snapshot.ok) return Object.freeze({ phase: 'responded', result: snapshot.value })
      }
    }
    if (
      (phase.value === 'not_sent' || phase.value === 'may_have_sent') &&
      keys.length === 2 &&
      keys.includes('error')
    ) {
      const error = descriptors.error
      if (error?.enumerable && 'value' in error)
        return Object.freeze({ phase: phase.value }) as ComputerUseAttemptDecision<T>
    }
  } catch {
    // A hostile receipt is indistinguishable from a lost response after dispatch.
  }
  return Object.freeze({ phase: 'may_have_sent' })
}

function createEnforcer(deps: Dependencies): ComputerUseHostEnforcer {
  return Object.freeze({
    async dispatch<T>(
      request: ComputerUseEnforcementRequest,
      attempt: () => Promise<ComputerUseAttempt<T>>,
    ): Promise<ComputerUseEnforcementResult<T>> {
      let admitted: DriverAdmissionDecision
      try {
        admitted = deps.admission()
      } catch {
        return refused('production_driver_admission_blocked', 'Computer Use driver admission is blocked.')
      }
      if (!admitted.allowed)
        return refused('production_driver_admission_blocked', 'Computer Use driver admission is blocked.')

      const requestSnapshot = snapshotRequest(request)
      if (!requestSnapshot) return refused('invalid_host_binding', 'Computer Use Host identity is invalid.')

      let resolved: unknown
      try {
        resolved = await deps.authority.resolve(requestSnapshot)
      } catch {
        return refused('host_authority_unavailable', 'Computer Use Host authority is unavailable.')
      }
      const policy = evaluateComputerUseHostPolicy(requestSnapshot, resolved)
      if (!policy.allowed) return refused(policy.code, policy.message)
      const { mutation, binding } = policy
      if (mutation && !deps.effects)
        return refused(
          'durable_effect_store_unavailable',
          'Durable Computer Use effect storage is unavailable.',
        )

      if (!mutation) {
        let observed: ComputerUseAttemptDecision<T>
        try {
          observed = evaluateComputerUseAttempt<T>(await attempt())
        } catch {
          observed = Object.freeze({ phase: 'may_have_sent' })
        }
        if (observed.phase === 'responded') return { status: 'responded', result: observed.result }
        if (observed.phase === 'not_sent')
          return { status: 'not-sent', error: notSentFailure(), retryable: true }
        return { status: 'unknown-outcome', error: unknownFailure(), replayAllowed: false }
      }

      let claim: Awaited<ReturnType<ComputerUseEffectStore['claim']>>
      try {
        claim = await (deps.effects as ComputerUseEffectStore).claim(binding)
      } catch {
        return refused(
          'durable_effect_store_unavailable',
          'Durable Computer Use effect storage is unavailable.',
        )
      }
      const claimDecision = evaluateComputerUseMutationClaim(claim)
      if (!claimDecision.dispatch)
        return refused(claimDecision.code, 'A mutation without a fresh durable claim cannot be dispatched.')

      let observed: ComputerUseAttemptDecision<T>
      try {
        observed = evaluateComputerUseAttempt<T>(await attempt())
      } catch {
        observed = Object.freeze({ phase: 'may_have_sent' })
      }
      const phase =
        observed.phase === 'responded' ? 'responded' : observed.phase === 'not_sent' ? 'not_sent' : 'unknown'
      try {
        await (deps.effects as ComputerUseEffectStore).finish(binding, phase)
      } catch {
        return { status: 'unknown-outcome', error: unknownFailure(), replayAllowed: false }
      }
      if (observed.phase === 'responded') return { status: 'responded', result: observed.result }
      if (observed.phase === 'not_sent')
        return { status: 'not-sent', error: notSentFailure(), retryable: true }
      return { status: 'unknown-outcome', error: unknownFailure(), replayAllowed: false }
    },
  })
}

const unavailableAuthority: ComputerUseAuthorityResolver = Object.freeze({
  async resolve() {
    return Object.freeze({ decision: 'denied' })
  },
})

/** Production constructor: P0 evidence is evaluated internally and cannot be replaced by a callback. */
export function createComputerUseHostEnforcer(
  lock: ComputerUseDriverLock | unknown,
  evidence: DriverAdmissionEvidence = new Map(),
): ComputerUseHostEnforcer {
  return createEnforcer({
    admission: () => evaluateComputerUseDriverAdmission(lock, evidence),
    authority: unavailableAuthority,
  })
}
