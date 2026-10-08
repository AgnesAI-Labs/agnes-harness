import { types as utilTypes } from 'node:util'
import { evaluateFixedComputerUseDriverAdmission } from '@agnes/host'
import {
  type ComputerUseDoctorParams,
  type ComputerUseDoctorResult,
  type ComputerUseOperationResult,
  type ComputerUsePermissionsStatusResult,
  type ComputerUseStatusResult,
  rpcError,
} from '@agnes/protocol'

const MAX_DOCTOR_SELECTORS = 32
const CHECK_NAME = /^[a-z][a-z0-9_-]{0,63}$/u
const DOCTOR_FIELDS = new Set(['include', 'skip'])

export type ComputerUseControlAuthority = Readonly<{
  authKind?: 'local' | 'jwt' | 'source-auth' | 'portal-identity' | 'surface'
  credentialKind?: 'local' | 'jwt' | 'portal-identity' | 'sso' | 'channel'
}>

export type BlockedComputerUseControlPlane = Readonly<{
  status(authority: ComputerUseControlAuthority, params: unknown): Promise<ComputerUseStatusResult>
  doctor(authority: ComputerUseControlAuthority, params: unknown): Promise<ComputerUseDoctorResult>
  permissionsStatus(
    authority: ComputerUseControlAuthority,
    params: unknown,
  ): Promise<ComputerUsePermissionsStatusResult>
  permissionsGrant(
    authority: ComputerUseControlAuthority,
    params: unknown,
  ): Promise<ComputerUsePermissionsStatusResult>
  operationStart(authority: ComputerUseControlAuthority, params: unknown): Promise<ComputerUseOperationResult>
  operationStatus(
    authority: ComputerUseControlAuthority,
    params: unknown,
  ): Promise<ComputerUseOperationResult>
  operationCancel(
    authority: ComputerUseControlAuthority,
    params: unknown,
  ): Promise<ComputerUseOperationResult>
}>

type LockedPackageMutationBlocker =
  | 'environment-unavailable'
  | 'mutation-engine-unavailable'
  | 'publisher-keyring-unavailable'
  | 'safe-extraction-unavailable'
  | 'store-directory-unavailable'
  | 'trusted-directory-handle-unavailable'
type LockedPackageMutationStatus = Readonly<{
  activationReady: boolean
  recoveryReady: boolean
  blockers: LockedPackageMutationBlocker[]
}>
export type LockedPackageMutationStatusSource = Readonly<{ status(): unknown }>
export type ComputerUseRuntimeStatusSource = Readonly<{
  status(): unknown | Promise<unknown>
  doctor?(params: ComputerUseDoctorParams): Promise<unknown>
  permissionsStatus?(): Promise<unknown>
  permissionsGrant?(): Promise<unknown>
  operationStart?(kind: 'install' | 'update' | 'restart'): unknown
  operationStatus?(operationId?: string): unknown
  operationCancel?(operationId: string): unknown
}>
const MUTATION_BLOCKERS = new Set<LockedPackageMutationBlocker>([
  'environment-unavailable',
  'mutation-engine-unavailable',
  'publisher-keyring-unavailable',
  'safe-extraction-unavailable',
  'store-directory-unavailable',
  'trusted-directory-handle-unavailable',
])

export const DEFAULT_BLOCKED_LOCKED_PACKAGE_MUTATION_STATUS: LockedPackageMutationStatusSource =
  Object.freeze({
    status: () =>
      Object.freeze({
        activationReady: false,
        recoveryReady: false,
        blockers: Object.freeze([
          'store-directory-unavailable' as const,
          'mutation-engine-unavailable' as const,
          'environment-unavailable' as const,
          'publisher-keyring-unavailable' as const,
          'safe-extraction-unavailable' as const,
          'trusted-directory-handle-unavailable' as const,
        ]),
      }),
  })

function lockedPackageMutationStatus(
  readStatus: (() => unknown) | undefined,
): LockedPackageMutationStatus | undefined {
  if (!readStatus) return undefined
  try {
    const raw = readStatus()
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || utilTypes.isProxy(raw)) return undefined
    const fields = Object.getOwnPropertyDescriptors(raw)
    if (
      Reflect.ownKeys(fields).length !== 3 ||
      !['activationReady', 'recoveryReady', 'blockers'].every(
        (key) => fields[key]?.enumerable === true && Object.hasOwn(fields[key] ?? {}, 'value'),
      )
    )
      return undefined
    const activationReady = fields.activationReady?.value as unknown
    const recoveryReady = fields.recoveryReady?.value as unknown
    const blockersValue = fields.blockers?.value as unknown
    if (
      typeof activationReady !== 'boolean' ||
      typeof recoveryReady !== 'boolean' ||
      !Array.isArray(blockersValue) ||
      utilTypes.isProxy(blockersValue) ||
      blockersValue.length > MUTATION_BLOCKERS.size
    )
      return undefined
    const descriptors = Object.getOwnPropertyDescriptors(blockersValue)
    if (Reflect.ownKeys(descriptors).length !== blockersValue.length + 1) return undefined
    const blockers: LockedPackageMutationBlocker[] = []
    for (let index = 0; index < blockersValue.length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (
        descriptor?.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value') ||
        !MUTATION_BLOCKERS.has(descriptor.value as LockedPackageMutationBlocker)
      )
        return undefined
      blockers.push(descriptor.value as LockedPackageMutationBlocker)
    }
    if (new Set(blockers).size !== blockers.length) return undefined
    return Object.freeze({
      activationReady,
      recoveryReady,
      blockers,
    })
  } catch {
    return undefined
  }
}

type ComputerUseRuntimeStatus = Readonly<{
  platform: 'win32' | 'darwin' | 'linux'
  version: string
  publisher: string
  activeSessions: number
  startAttempted: boolean
}>

function boundStatusReader(source: unknown): (() => unknown) | undefined {
  try {
    if (!source || typeof source !== 'object' || utilTypes.isProxy(source)) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(source)
    const status = descriptors.status
    if (
      Reflect.ownKeys(descriptors).some(
        (key) =>
          typeof key !== 'string' ||
          ![
            'status',
            'doctor',
            'permissionsGrant',
            'permissionsStatus',
            'setSessionYolo',
            'operationStart',
            'operationStatus',
            'operationCancel',
          ].includes(key) ||
          descriptors[key]?.enumerable !== true ||
          !Object.hasOwn(descriptors[key] ?? {}, 'value') ||
          typeof descriptors[key]?.value !== 'function' ||
          utilTypes.isProxy(descriptors[key]?.value),
      ) ||
      status?.enumerable !== true ||
      !Object.hasOwn(status, 'value') ||
      typeof status.value !== 'function' ||
      utilTypes.isProxy(status.value)
    )
      return undefined
    return Reflect.apply(Function.prototype.bind, status.value, [source]) as () => unknown
  } catch {
    return undefined
  }
}

function boundAsyncReader(
  source: unknown,
  name:
    | 'doctor'
    | 'permissionsStatus'
    | 'permissionsGrant'
    | 'operationStart'
    | 'operationStatus'
    | 'operationCancel',
): ((...args: unknown[]) => Promise<unknown>) | undefined {
  try {
    if (!source || typeof source !== 'object' || utilTypes.isProxy(source)) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(source, name)
    if (
      descriptor?.enumerable !== true ||
      !Object.hasOwn(descriptor, 'value') ||
      typeof descriptor.value !== 'function' ||
      utilTypes.isProxy(descriptor.value)
    )
      return undefined
    return Reflect.apply(Function.prototype.bind, descriptor.value, [source]) as (
      ...args: unknown[]
    ) => Promise<unknown>
  } catch {
    return undefined
  }
}

function macOSPermissionsResult(value: unknown): ComputerUsePermissionsStatusResult {
  const permissions = computerUsePermissionStatus(value)
  const admission = Object.freeze({ state: 'ready' as const, reason: 'macos-verified-driver' as const })
  if (!permissions)
    return Object.freeze({
      schemaVersion: 1,
      status: 'unknown' as const,
      admission,
      probe: Object.freeze({ state: 'failed' as const, reason: 'macos-tcc-probe-failed' as const }),
    })
  if (permissions.accessibility && permissions.screenRecording)
    return Object.freeze({
      schemaVersion: 1,
      status: 'granted' as const,
      admission,
      probe: Object.freeze({
        state: 'passed' as const,
        reason: 'macos-tcc-permissions-granted' as const,
        accessibility: true as const,
        screenRecording: true as const,
      }),
    })
  if (!permissions.accessibility)
    return Object.freeze({
      schemaVersion: 1,
      status: 'required' as const,
      admission,
      probe: Object.freeze({
        state: 'passed' as const,
        reason: 'macos-tcc-permissions-missing' as const,
        accessibility: false as const,
        screenRecording: permissions.screenRecording,
      }),
    })
  return Object.freeze({
    schemaVersion: 1,
    status: 'required' as const,
    admission,
    probe: Object.freeze({
      state: 'passed' as const,
      reason: 'macos-tcc-permissions-missing' as const,
      accessibility: true as const,
      screenRecording: false as const,
    }),
  })
}

function computerUsePermissionStatus(
  value: unknown,
): Readonly<{ accessibility: boolean; screenRecording: boolean }> | undefined {
  try {
    const row = ownDataRecord(
      value,
      new Set(['accessibility', 'screenRecording']),
      'computer-use permission status',
    )
    if (
      Reflect.ownKeys(row).length !== 2 ||
      typeof row.accessibility !== 'boolean' ||
      typeof row.screenRecording !== 'boolean'
    )
      return undefined
    return Object.freeze({
      accessibility: row.accessibility,
      screenRecording: row.screenRecording,
    })
  } catch {
    return undefined
  }
}

async function computerUseRuntimeStatus(
  readStatus: (() => unknown | Promise<unknown>) | undefined,
): Promise<ComputerUseRuntimeStatus | undefined> {
  if (!readStatus) return undefined
  try {
    const row = ownDataRecord(
      await readStatus(),
      new Set(['platform', 'version', 'publisher', 'activeSessions', 'startAttempted']),
      'computer-use runtime status',
    )
    if (
      (row.platform !== 'win32' && row.platform !== 'darwin' && row.platform !== 'linux') ||
      typeof row.version !== 'string' ||
      row.version.length < 1 ||
      row.version.length > 64 ||
      typeof row.publisher !== 'string' ||
      row.publisher.length < 1 ||
      row.publisher.length > 256 ||
      !Number.isSafeInteger(row.activeSessions) ||
      (row.activeSessions as number) < 0 ||
      typeof row.startAttempted !== 'boolean'
    )
      return undefined
    return Object.freeze(row as ComputerUseRuntimeStatus)
  } catch {
    return undefined
  }
}

function ownDataRecord(value: unknown, allowed: ReadonlySet<string>, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw rpcError('INVALID_PARAMS', { reason: `${label} must be an object` })
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null)
    throw rpcError('INVALID_PARAMS', { reason: `${label} must be a plain object` })

  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key))
      throw rpcError('INVALID_PARAMS', { reason: `unknown ${label} field` })
    const descriptor = descriptors[key]
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true)
      throw rpcError('INVALID_PARAMS', { reason: `invalid ${label} field` })
  }
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      (descriptor as PropertyDescriptor & { value: unknown }).value,
    ]),
  )
}

function selectorList(value: unknown, name: 'include' | 'skip'): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_DOCTOR_SELECTORS)
    throw rpcError('INVALID_PARAMS', { reason: `${name} must contain 1..32 selectors` })

  const descriptors = Object.getOwnPropertyDescriptors(value)
  const expectedKeys = new Set([
    'length',
    ...Array.from({ length: value.length }, (_, index) => String(index)),
  ])
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !expectedKeys.has(key)))
    throw rpcError('INVALID_PARAMS', { reason: `${name} contains unknown fields` })
  const normalized: string[] = []
  const seen = new Set<string>()
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !('value' in descriptor))
      throw rpcError('INVALID_PARAMS', { reason: `${name} must be a dense data array` })
    const selector = descriptor.value
    if (typeof selector !== 'string' || !CHECK_NAME.test(selector) || seen.has(selector))
      throw rpcError('INVALID_PARAMS', { reason: `invalid ${name} selector` })
    seen.add(selector)
    normalized.push(selector)
  }
  return normalized
}

/** Defensive mirror of the shared wire schema for direct in-process callers. Check-name existence
 * remains driver-owned; retaining include/skip overlap preserves the upstream "include wins" rule. */
export function normalizeComputerUseDoctorParams(params: unknown): ComputerUseDoctorParams {
  const raw = ownDataRecord(params, DOCTOR_FIELDS, 'doctor params')
  const include = Object.hasOwn(raw, 'include') ? selectorList(raw.include, 'include') : undefined
  const skip = Object.hasOwn(raw, 'skip') ? selectorList(raw.skip, 'skip') : undefined
  return {
    ...(include ? { include } : {}),
    ...(skip ? { skip } : {}),
  }
}

const OPERATION_ID = /^cu-[a-zA-Z0-9-]{1,128}$/u
const OPERATION_KINDS = new Set(['install', 'update', 'restart'])
const OPERATION_STATES = new Set(['queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled'])
const OPERATION_PHASES = new Set(['queued', 'installing', 'restarting', 'complete'])
const OPERATION_OUTCOMES = new Set(['installed', 'already-current', 'repaired', 'restarted', 'lkg-restored'])

function operationId(value: unknown): string {
  if (typeof value !== 'string' || !OPERATION_ID.test(value))
    throw rpcError('INVALID_PARAMS', { reason: 'invalid computer-use operation id' })
  return value
}

function operationResult(value: unknown): ComputerUseOperationResult {
  const row = ownDataRecord(
    value,
    new Set(['operationId', 'kind', 'state', 'phase', 'startedAtMs', 'updatedAtMs', 'outcome', 'failure']),
    'computer-use operation result',
  )
  const id = operationId(row.operationId)
  if (
    !OPERATION_KINDS.has(row.kind as string) ||
    !OPERATION_STATES.has(row.state as string) ||
    !OPERATION_PHASES.has(row.phase as string) ||
    !Number.isSafeInteger(row.startedAtMs) ||
    (row.startedAtMs as number) < 0 ||
    !Number.isSafeInteger(row.updatedAtMs) ||
    (row.updatedAtMs as number) < (row.startedAtMs as number)
  )
    throw rpcError('INVALID_PARAMS', { reason: 'invalid computer-use operation result' })
  const state = row.state as 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled'
  const phase = row.phase as 'queued' | 'installing' | 'restarting' | 'complete'
  const outcome = row.outcome
  const failure = row.failure
  const kind = row.kind as 'install' | 'update' | 'restart'
  const activePhaseIsValid =
    kind === 'restart' ? phase === 'restarting' : phase === 'installing' || phase === 'restarting'
  const successOutcomeIsValid =
    kind === 'restart'
      ? outcome === 'restarted'
      : outcome === 'installed' ||
        outcome === 'already-current' ||
        outcome === 'repaired' ||
        outcome === 'lkg-restored'
  const valid =
    (state === 'queued' && phase === 'queued' && outcome === undefined && failure === undefined) ||
    ((state === 'running' || state === 'cancelling') &&
      activePhaseIsValid &&
      outcome === undefined &&
      failure === undefined) ||
    (state === 'succeeded' &&
      phase === 'complete' &&
      OPERATION_OUTCOMES.has(outcome as string) &&
      successOutcomeIsValid &&
      failure === undefined) ||
    (state === 'failed' && phase === 'complete' && outcome === undefined && failure === 'operation-failed') ||
    (state === 'cancelled' && phase === 'complete' && outcome === undefined && failure === undefined)
  if (!valid) throw rpcError('INVALID_PARAMS', { reason: 'inconsistent computer-use operation result' })
  const base = {
    schemaVersion: 1 as const,
    status: 'found' as const,
    operationId: id,
    startedAtMs: row.startedAtMs as number,
    updatedAtMs: row.updatedAtMs as number,
  }
  if (state === 'queued') return Object.freeze({ ...base, kind, state, phase: 'queued' as const })
  if (state === 'running' || state === 'cancelling') {
    if (kind === 'restart') return Object.freeze({ ...base, kind, state, phase: 'restarting' as const })
    return Object.freeze({ ...base, kind, state, phase: phase as 'installing' | 'restarting' })
  }
  if (state === 'succeeded') {
    if (kind === 'restart')
      return Object.freeze({
        ...base,
        kind,
        state,
        phase: 'complete' as const,
        outcome: 'restarted' as const,
      })
    return Object.freeze({
      ...base,
      kind,
      state,
      phase: 'complete' as const,
      outcome: outcome as 'installed' | 'already-current' | 'repaired' | 'lkg-restored',
    })
  }
  if (state === 'failed')
    return Object.freeze({
      ...base,
      kind,
      state,
      phase: 'complete' as const,
      failure: 'operation-failed' as const,
    })
  return Object.freeze({ ...base, kind, state: 'cancelled' as const, phase: 'complete' as const })
}

const operationNotFound = Object.freeze({ schemaVersion: 1 as const, status: 'not-found' as const })

function assertLocalControlAuthority(authority: ComputerUseControlAuthority): void {
  // Callers must copy this authority from CallContext.conn after initialize/authGate. It is never
  // accepted from RPC params. Session credentials do not imply profile-wide control authority.
  if (authority.authKind !== 'local' || authority.credentialKind !== 'local')
    throw rpcError('CAPABILITY_DENIED', { reason: 'local computer-use control authority required' })
}

const admission = Object.freeze({ state: 'blocked' as const, reason: 'p0-evidence-incomplete' as const })
const notRun = Object.freeze({
  state: 'not-run' as const,
  reason: 'production-driver-admission-disabled' as const,
})
const doctorResult: ComputerUseDoctorResult = Object.freeze({
  schemaVersion: 1,
  status: 'blocked',
  admission,
  checks: notRun,
})
const permissionsResult: ComputerUsePermissionsStatusResult = Object.freeze({
  schemaVersion: 1,
  status: 'unavailable',
  admission,
  probe: notRun,
})

type ControlPlaneBlocker =
  | 'release-provenance-incomplete'
  | 'compatibility-evidence-incomplete'
  | 'platform-acceptance-incomplete'

export function projectComputerUseDriverLockBlockers(blockers: readonly string[]): ControlPlaneBlocker[] {
  const projected = new Set<ControlPlaneBlocker>()
  for (const blocker of blockers) {
    if (
      blocker.startsWith('verifier:') ||
      blocker.startsWith('source:') ||
      blocker.startsWith('artifact:') ||
      blocker.startsWith('artifacts:') ||
      blocker.startsWith('support:') ||
      blocker === 'lkg:status'
    )
      projected.add('release-provenance-incomplete')
    else if (blocker.startsWith('lab:') || blocker === 'lkg:platform-verification')
      projected.add('platform-acceptance-incomplete')
    else projected.add('compatibility-evidence-incomplete')
  }
  if (projected.size === 0) projected.add('compatibility-evidence-incomplete')
  return [...projected]
}

function fixedDriverLockBlockers(): ControlPlaneBlocker[] {
  try {
    const decision = evaluateFixedComputerUseDriverAdmission()
    // This P0-closed control plane must never become an admission path, even if the checked-in
    // candidate is accidentally changed to ready. Treat that impossible state as incompatible.
    return projectComputerUseDriverLockBlockers(
      decision.allowed ? ['lock:unexpected-admission-enabled'] : decision.blockers,
    )
  } catch {
    return projectComputerUseDriverLockBlockers(['schema:fixed-driver-lock-inspection-failed'])
  }
}

/** P0-closed service for authenticated permissions and filtered-doctor RPCs. It has no driver,
 * process, filesystem or platform dependency, so it cannot probe, install, repair or start CUA. */
export function createBlockedComputerUseControlPlane(
  source?: LockedPackageMutationStatusSource,
  runtimeSource?: ComputerUseRuntimeStatusSource,
): BlockedComputerUseControlPlane {
  const driverBlockers = fixedDriverLockBlockers()
  const readStatus = boundStatusReader(source)
  const readRuntimeStatus = boundStatusReader(runtimeSource)
  const runDoctor = boundAsyncReader(runtimeSource, 'doctor')
  const readPermissionsStatus = boundAsyncReader(runtimeSource, 'permissionsStatus')
  const grantPermissions = boundAsyncReader(runtimeSource, 'permissionsGrant')
  const startOperation = boundAsyncReader(runtimeSource, 'operationStart')
  const readOperation = boundAsyncReader(runtimeSource, 'operationStatus')
  const cancelOperation = boundAsyncReader(runtimeSource, 'operationCancel')
  return Object.freeze({
    async status(authority, params) {
      if (authority.authKind === undefined)
        throw rpcError('CAPABILITY_DENIED', { method: '_agnes/v1/computerUse.status' })
      ownDataRecord(params, new Set(), 'status params')
      const mutationStatus = lockedPackageMutationStatus(readStatus)
      const rawRuntime = await Promise.resolve()
        .then(() => readRuntimeStatus?.())
        .catch(() => undefined)
      if (rawRuntime && typeof rawRuntime === 'object' && !utilTypes.isProxy(rawRuntime)) {
        const fields = Object.getOwnPropertyDescriptors(rawRuntime)
        const availability = fields.availability?.value as unknown
        if (
          Reflect.ownKeys(fields).length === 1 &&
          typeof availability === 'string' &&
          [
            'feature-disabled',
            'platform-unsupported',
            'driver-not-prepared',
            'driver-preparing',
            'driver-prepare-failed',
          ].includes(availability)
        ) {
          return {
            schemaVersion: 1,
            status: 'blocked',
            admission: { state: 'blocked', reason: 'runtime-unavailable' },
            runtime: { state: 'not-started', startAttempted: false },
            blockers: [
              availability as Extract<ComputerUseStatusResult, { status: 'blocked' }>['blockers'][number],
            ],
            ...(mutationStatus ? { lockedPackageMutations: mutationStatus } : {}),
          }
        }
      }
      const runtimeStatus = await computerUseRuntimeStatus(() => rawRuntime)
      if (runtimeStatus)
        return Object.freeze({
          schemaVersion: 1,
          status: 'ready' as const,
          admission: Object.freeze({
            state: 'ready' as const,
            reason:
              runtimeStatus.platform === 'win32'
                ? ('windows-verified-driver' as const)
                : runtimeStatus.platform === 'darwin'
                  ? ('macos-verified-driver' as const)
                  : ('linux-verified-driver' as const),
          }),
          runtime: Object.freeze({
            state: runtimeStatus.activeSessions > 0 ? ('running' as const) : ('idle' as const),
            startAttempted: runtimeStatus.startAttempted,
            activeSessions: runtimeStatus.activeSessions,
          }),
          blockers: [],
          driver: Object.freeze({
            platform: runtimeStatus.platform,
            version: runtimeStatus.version,
            publisher: runtimeStatus.publisher,
          }),
          ...(mutationStatus ? { lockedPackageMutations: mutationStatus } : {}),
        })
      return Object.freeze({
        schemaVersion: 1,
        status: 'blocked',
        admission,
        runtime: { state: 'not-started' as const, startAttempted: false as const },
        blockers: [...driverBlockers],
        ...(mutationStatus ? { lockedPackageMutations: mutationStatus } : {}),
      })
    },
    async doctor(authority, params) {
      assertLocalControlAuthority(authority)
      const normalized = normalizeComputerUseDoctorParams(params)
      const mutationStatus = lockedPackageMutationStatus(readStatus)
      const runtimeStatus = await computerUseRuntimeStatus(readRuntimeStatus)
      if (runtimeStatus) {
        const admission = Object.freeze({
          state: 'ready' as const,
          reason:
            runtimeStatus.platform === 'win32'
              ? ('windows-verified-driver' as const)
              : runtimeStatus.platform === 'darwin'
                ? ('macos-verified-driver' as const)
                : ('linux-verified-driver' as const),
        })
        if (!runDoctor)
          return Object.freeze({
            schemaVersion: 1,
            status: 'unreachable' as const,
            admission,
            checks: Object.freeze({
              state: 'unavailable' as const,
              reason: 'live-driver-doctor-unavailable' as const,
            }),
            ...(mutationStatus ? { lockedPackageMutations: mutationStatus } : {}),
          })
        try {
          await runDoctor(normalized)
        } catch {
          if (runtimeStatus.platform === 'win32')
            return Object.freeze({
              schemaVersion: 1,
              status: 'failed' as const,
              admission: Object.freeze({
                state: 'ready' as const,
                reason: 'windows-verified-driver' as const,
              }),
              checks: Object.freeze({
                state: 'failed' as const,
                reason: 'windows-driver-health-or-identity-failed' as const,
              }),
              ...(mutationStatus ? { lockedPackageMutations: mutationStatus } : {}),
            })
          if (runtimeStatus.platform === 'linux')
            return Object.freeze({
              schemaVersion: 1,
              status: 'failed' as const,
              admission: Object.freeze({
                state: 'ready' as const,
                reason: 'linux-verified-driver' as const,
              }),
              checks: Object.freeze({
                state: 'failed' as const,
                reason: 'linux-driver-health-or-identity-failed' as const,
              }),
              ...(mutationStatus ? { lockedPackageMutations: mutationStatus } : {}),
            })
          return Object.freeze({
            schemaVersion: 1,
            status: 'failed' as const,
            admission: Object.freeze({
              state: 'ready' as const,
              reason: 'macos-verified-driver' as const,
            }),
            checks: Object.freeze({
              state: 'failed' as const,
              reason: 'macos-driver-health-or-identity-failed' as const,
            }),
            ...(mutationStatus ? { lockedPackageMutations: mutationStatus } : {}),
          })
        }
        if (runtimeStatus.platform === 'win32')
          return Object.freeze({
            schemaVersion: 1,
            status: 'ready' as const,
            admission: Object.freeze({
              state: 'ready' as const,
              reason: 'windows-verified-driver' as const,
            }),
            checks: Object.freeze({
              state: 'passed' as const,
              reason: 'windows-driver-health-and-identity-verified' as const,
            }),
            ...(mutationStatus ? { lockedPackageMutations: mutationStatus } : {}),
          })
        if (runtimeStatus.platform === 'linux')
          return Object.freeze({
            schemaVersion: 1,
            status: 'ready' as const,
            admission: Object.freeze({
              state: 'ready' as const,
              reason: 'linux-verified-driver' as const,
            }),
            checks: Object.freeze({
              state: 'passed' as const,
              reason: 'linux-driver-health-and-identity-verified' as const,
            }),
            ...(mutationStatus ? { lockedPackageMutations: mutationStatus } : {}),
          })
        return Object.freeze({
          schemaVersion: 1,
          status: 'ready' as const,
          admission: Object.freeze({
            state: 'ready' as const,
            reason: 'macos-verified-driver' as const,
          }),
          checks: Object.freeze({
            state: 'passed' as const,
            reason: 'macos-driver-health-and-identity-verified' as const,
          }),
          ...(mutationStatus ? { lockedPackageMutations: mutationStatus } : {}),
        })
      }
      return Object.freeze({
        ...doctorResult,
        ...(mutationStatus ? { lockedPackageMutations: mutationStatus } : {}),
      })
    },
    async permissionsStatus(authority, params) {
      assertLocalControlAuthority(authority)
      ownDataRecord(params, new Set(), 'permissions params')
      const runtimeStatus = await computerUseRuntimeStatus(readRuntimeStatus)
      if (runtimeStatus?.platform === 'win32')
        return Object.freeze({
          schemaVersion: 1,
          status: 'not-required' as const,
          admission: Object.freeze({ state: 'ready' as const, reason: 'windows-verified-driver' as const }),
          probe: Object.freeze({
            state: 'passed' as const,
            reason: 'windows-no-os-grant-required' as const,
          }),
        })
      if (runtimeStatus?.platform === 'linux')
        return Object.freeze({
          schemaVersion: 1,
          status: 'not-required' as const,
          admission: Object.freeze({ state: 'ready' as const, reason: 'linux-verified-driver' as const }),
          probe: Object.freeze({ state: 'passed' as const, reason: 'linux-no-os-grant-required' as const }),
        })
      if (runtimeStatus?.platform === 'darwin')
        try {
          return macOSPermissionsResult(await readPermissionsStatus?.())
        } catch {
          return macOSPermissionsResult(undefined)
        }
      return permissionsResult
    },
    async permissionsGrant(authority, params) {
      assertLocalControlAuthority(authority)
      ownDataRecord(params, new Set(), 'permissions grant params')
      const runtimeStatus = await computerUseRuntimeStatus(readRuntimeStatus)
      if (runtimeStatus?.platform === 'win32')
        return Object.freeze({
          schemaVersion: 1,
          status: 'not-required' as const,
          admission: Object.freeze({ state: 'ready' as const, reason: 'windows-verified-driver' as const }),
          probe: Object.freeze({
            state: 'passed' as const,
            reason: 'windows-no-os-grant-required' as const,
          }),
        })
      if (runtimeStatus?.platform === 'linux')
        return Object.freeze({
          schemaVersion: 1,
          status: 'not-required' as const,
          admission: Object.freeze({ state: 'ready' as const, reason: 'linux-verified-driver' as const }),
          probe: Object.freeze({ state: 'passed' as const, reason: 'linux-no-os-grant-required' as const }),
        })
      if (runtimeStatus?.platform !== 'darwin' || !grantPermissions) return permissionsResult
      try {
        return macOSPermissionsResult(await grantPermissions())
      } catch {
        return macOSPermissionsResult(undefined)
      }
    },
    async operationStart(authority, params) {
      assertLocalControlAuthority(authority)
      const row = ownDataRecord(params, new Set(['kind']), 'computer-use operation start params')
      if (Reflect.ownKeys(row).length !== 1 || !OPERATION_KINDS.has(row.kind as string))
        throw rpcError('INVALID_PARAMS', { reason: 'invalid computer-use operation kind' })
      if (!startOperation)
        throw rpcError('CAPABILITY_DENIED', { reason: 'computer-use operation control is unavailable' })
      let result: unknown
      try {
        result = await startOperation(row.kind)
      } catch {
        throw rpcError('CAPABILITY_DENIED', { reason: 'computer-use operation was refused' })
      }
      return operationResult(result)
    },
    async operationStatus(authority, params) {
      assertLocalControlAuthority(authority)
      const row = ownDataRecord(params, new Set(['operationId']), 'computer-use operation status params')
      const id = Object.hasOwn(row, 'operationId') ? operationId(row.operationId) : undefined
      if (!readOperation) return operationNotFound
      let result: unknown
      try {
        result = await readOperation(id)
      } catch {
        return operationNotFound
      }
      return result === undefined ? operationNotFound : operationResult(result)
    },
    async operationCancel(authority, params) {
      assertLocalControlAuthority(authority)
      const row = ownDataRecord(params, new Set(['operationId']), 'computer-use operation cancel params')
      if (Reflect.ownKeys(row).length !== 1)
        throw rpcError('INVALID_PARAMS', { reason: 'operation id is required' })
      const id = operationId(row.operationId)
      if (!cancelOperation) return operationNotFound
      let result: unknown
      try {
        result = await cancelOperation(id)
      } catch {
        return operationNotFound
      }
      return result === undefined ? operationNotFound : operationResult(result)
    },
  })
}
