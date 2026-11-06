// Version 2 of a Windows session's execution record. The first version held one execution fact that
// had to stay equal forever; on Windows the backend now changes under existing sessions. Version 2
// keeps the original version 1 value and its digest unchanged, records the permission intent the
// session was verified with, and appends an execution generation only when the backend gets
// stronger or the user confirms a replaced workspace directory. Commands reference the current
// generation; nothing is copied per command and no earlier generation is rewritten.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { SandboxExecutionLease } from '@agnes/extension-api'
import type { Permission } from '@agnes/host-common/presets/permission'
import { isWindowsWriteBoundary } from '@agnes/host-infrastructure/windows-acl/policy'
import type { SandboxExecutionRecord } from './sandbox-state.js'

/** A Windows volume and file id of the workspace root object, as an execution lease carries it. */
type RootIdentity = SandboxExecutionLease['rootIdentity']

/** What the session's preset asked of Windows commands; fixed for the session's lifetime. */
export type WindowsPermissionIntent = Readonly<{
  /** Permission level the preset was resolved with; absent for a recipe that fixes its own. */
  permission?: Permission
  access: 'read-only' | 'workspace-write' | 'full-access'
  windowsMode: 'write-restricted' | 'require-full'
  /** Who wrote `sandbox.windows_mode`: a Host-trusted builtin document, another one, or nobody. */
  windowsModeSource: 'official' | 'custom' | 'absent'
  required: boolean
  onUnavailable: 'deny' | 'allow' | 'allow-if-unimplemented'
  customFsDeny: boolean
  networkMode: 'allow' | 'hosts' | 'loopback-serve'
}>

/** Trusted facts the Host read from the session's saved composition, profile and start record. */
export type WindowsPermissionEvidence = Readonly<{
  intent: WindowsPermissionIntent
  /** Permission level recorded when the session started; absent when none was recorded. */
  recordedPermission?: Permission
  /** The static config hash a Host without Windows settings computes for the same preset. */
  legacyStaticConfigHash: string
}>

export type WindowsExecutionVerification = Readonly<{
  currentExecution: SandboxExecutionRecord
  permissionEvidence: WindowsPermissionEvidence
  /** The workspace root object as read now; required for the ACL backend. */
  rootIdentity?: RootIdentity
}>

export type ExecutionGenerationReason =
  | 'new-session'
  | 'history-adoption'
  | 'legacy-adoption'
  | 'backend-change'
  | 'workspace-confirmed'

export type SessionExecutionGeneration = SandboxExecutionRecord &
  Readonly<{
    generationId: string
    /** The root object this generation started at; a version 1 record never had one. */
    rootIdentity?: RootIdentity
    reason: ExecutionGenerationReason
    /** Digest of the intent, legacy digest and facts this generation was authorized on. */
    evidenceDigest: string
  }>

type LegacyRecord = Readonly<{ version: 1; sessionKey: string; execution: SandboxExecutionRecord }>

export type SessionExecutionRecordV2 = Readonly<{
  version: 2
  sessionKey: string
  legacyRecord?: LegacyRecord
  legacyDigest?: string
  permissionIntent: WindowsPermissionIntent
  generations: readonly SessionExecutionGeneration[]
  currentGeneration: string
}>

export type WindowsExecutionPlan = Readonly<{
  record: SessionExecutionRecordV2
  generation: SessionExecutionGeneration
  /** Whether the record on disk must be replaced by `record`. */
  changed: boolean
}>

export const executionRecordRefusal = (): Error =>
  Object.assign(
    new Error(
      'E_SANDBOX_WORKSPACE: saved execution policy is missing or incompatible; keep this history and create a new session',
    ),
    { code: 'E_SANDBOX_WORKSPACE', reason: 'session-execution-record-invalid' },
  )

const confirmationRefusal = (): Error =>
  Object.assign(
    new Error(
      'E_SANDBOX_WORKSPACE: the workspace directory no longer matches the one this session was verified with; confirm the workspace again in this session (its history and files are kept)',
    ),
    { code: 'E_SANDBOX_WORKSPACE', reason: 'session-workspace-confirmation-required' },
  )

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const HEX64 = /^[0-9a-f]{64}$/
const HEX32 = /^[0-9a-f]{32}$/
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const exactKeys = (value: Record<string, unknown>, required: string[], optional: string[] = []): boolean =>
  required.every((key) => key in value) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
const oneOf = <T extends string>(value: unknown, values: readonly T[]): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0

const EXECUTION_KEYS = [
  'workspaceId',
  'workspaceRoot',
  'policyDigest',
  'staticConfigHash',
  'provider',
  'providerVersion',
  'target',
  'implementation',
  'probeState',
  'backend',
  'enforcement',
]
const PERMISSIONS = ['read-only', 'workspace-write', 'full-access'] as const

/** The execution facts in one key order, so equal facts compare and digest equally. */
function execution(value: SandboxExecutionRecord): SandboxExecutionRecord {
  const { enforcement } = value
  return {
    workspaceId: value.workspaceId,
    workspaceRoot: value.workspaceRoot,
    policyDigest: value.policyDigest,
    staticConfigHash: value.staticConfigHash,
    provider: value.provider,
    providerVersion: value.providerVersion,
    target: value.target,
    implementation: value.implementation,
    probeState: value.probeState,
    backend: value.backend,
    enforcement: {
      level: enforcement.level,
      scope: [...enforcement.scope],
      ...(enforcement.boundary ? { boundary: { ...enforcement.boundary } } : {}),
    },
  }
}

function isExecution(value: unknown): value is SandboxExecutionRecord {
  if (!isRecord(value) || !exactKeys(value, EXECUTION_KEYS)) return false
  const enforcement = value.enforcement
  return (
    [
      'workspaceId',
      'workspaceRoot',
      'policyDigest',
      'staticConfigHash',
      'provider',
      'providerVersion',
      'target',
    ]
      .map((key) => value[key])
      .every(text) &&
    oneOf(value.implementation, ['implemented', 'unimplemented', 'unknown']) &&
    oneOf(value.probeState, ['ready', 'failed', 'unprobed']) &&
    oneOf(value.backend, ['none', 'l1', 'remote', 'windows-acl']) &&
    isRecord(enforcement) &&
    exactKeys(enforcement, ['level', 'scope'], ['boundary']) &&
    oneOf(enforcement.level, ['none', 'partial', 'full']) &&
    Array.isArray(enforcement.scope) &&
    enforcement.scope.every(text) &&
    (enforcement.boundary === undefined || isWindowsWriteBoundary(enforcement.boundary))
  )
}

function intent(value: WindowsPermissionIntent): WindowsPermissionIntent {
  return {
    ...(value.permission === undefined ? {} : { permission: value.permission }),
    access: value.access,
    windowsMode: value.windowsMode,
    windowsModeSource: value.windowsModeSource,
    required: value.required,
    onUnavailable: value.onUnavailable,
    customFsDeny: value.customFsDeny,
    networkMode: value.networkMode,
  }
}

function isIntent(value: unknown): value is WindowsPermissionIntent {
  return (
    isRecord(value) &&
    exactKeys(
      value,
      [
        'access',
        'windowsMode',
        'windowsModeSource',
        'required',
        'onUnavailable',
        'customFsDeny',
        'networkMode',
      ],
      ['permission'],
    ) &&
    (value.permission === undefined || oneOf(value.permission, PERMISSIONS)) &&
    oneOf(value.access, PERMISSIONS) &&
    oneOf(value.windowsMode, ['write-restricted', 'require-full']) &&
    oneOf(value.windowsModeSource, ['official', 'custom', 'absent']) &&
    typeof value.required === 'boolean' &&
    oneOf(value.onUnavailable, ['deny', 'allow', 'allow-if-unimplemented']) &&
    typeof value.customFsDeny === 'boolean' &&
    oneOf(value.networkMode, ['allow', 'hosts', 'loopback-serve'])
  )
}

const isIdentity = (value: unknown): value is RootIdentity =>
  isRecord(value) && exactKeys(value, ['volumeId', 'fileId']) && text(value.volumeId) && text(value.fileId)

const sameIdentity = (left?: RootIdentity, right?: RootIdentity): boolean =>
  left?.volumeId === right?.volumeId && left?.fileId === right?.fileId

function evidenceDigest(
  permissionIntent: WindowsPermissionIntent,
  legacyDigest: string | undefined,
  facts: SandboxExecutionRecord,
  rootIdentity: RootIdentity | undefined,
  reason: ExecutionGenerationReason,
): string {
  return sha256(
    JSON.stringify([
      'agnes.session-execution-evidence',
      1,
      intent(permissionIntent),
      legacyDigest ?? null,
      execution(facts),
      rootIdentity ? [rootIdentity.volumeId, rootIdentity.fileId] : null,
      reason,
    ]),
  )
}

function generation(
  key: string,
  index: number,
  permissionIntent: WindowsPermissionIntent,
  legacyDigest: string | undefined,
  facts: SandboxExecutionRecord,
  rootIdentity: RootIdentity | undefined,
  reason: ExecutionGenerationReason,
): SessionExecutionGeneration {
  const digest = evidenceDigest(permissionIntent, legacyDigest, facts, rootIdentity, reason)
  return {
    generationId: sha256(JSON.stringify(['agnes.session-execution-generation', key, index, digest])).slice(
      0,
      32,
    ),
    ...execution(facts),
    ...(rootIdentity
      ? { rootIdentity: { volumeId: rootIdentity.volumeId, fileId: rootIdentity.fileId } }
      : {}),
    reason,
    evidenceDigest: digest,
  }
}

/** A version 1 record exactly as the previous build wrote it; any other spelling is not evidence. */
function readLegacy(key: string, value: unknown, bytes?: string): LegacyRecord | undefined {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['version', 'sessionKey', 'execution']) ||
    value.version !== 1 ||
    value.sessionKey !== key ||
    !isExecution(value.execution)
  )
    return undefined
  if (bytes !== undefined && JSON.stringify(value) !== bytes) return undefined
  return value as LegacyRecord
}

function readRecord(key: string, value: unknown): SessionExecutionRecordV2 | undefined {
  if (
    !isRecord(value) ||
    !exactKeys(
      value,
      ['version', 'sessionKey', 'permissionIntent', 'generations', 'currentGeneration'],
      ['legacyRecord', 'legacyDigest'],
    ) ||
    value.version !== 2 ||
    value.sessionKey !== key ||
    !isIntent(value.permissionIntent) ||
    !Array.isArray(value.generations) ||
    value.generations.length === 0 ||
    (value.legacyRecord === undefined) !== (value.legacyDigest === undefined)
  )
    return undefined
  const legacyDigest = value.legacyDigest
  if (
    legacyDigest !== undefined &&
    (typeof legacyDigest !== 'string' ||
      !readLegacy(key, value.legacyRecord) ||
      sha256(JSON.stringify(value.legacyRecord)) !== legacyDigest)
  )
    return undefined
  const permissionIntent = value.permissionIntent
  const valid = value.generations.every((entry: unknown, index) => {
    if (!isRecord(entry)) return false
    const { generationId, rootIdentity, reason, evidenceDigest: digest, ...facts } = entry
    if (
      !HEX32.test(String(generationId)) ||
      !HEX64.test(String(digest)) ||
      (rootIdentity !== undefined && !isIdentity(rootIdentity)) ||
      !oneOf(reason, [
        'new-session',
        'history-adoption',
        'legacy-adoption',
        'backend-change',
        'workspace-confirmed',
      ]) ||
      !isExecution(facts)
    )
      return false
    const expected = generation(key, index, permissionIntent, legacyDigest, facts, rootIdentity, reason)
    return expected.generationId === generationId && expected.evidenceDigest === digest
  })
  const head = value.generations.at(-1) as { generationId?: unknown } | undefined
  if (!valid || head?.generationId !== value.currentGeneration) return undefined
  return value as SessionExecutionRecordV2
}

/**
 * Whether the saved intent proves the official ACL default: a Host-trusted builtin document chose
 * `write-restricted`, the permission is not full access, and nothing stronger was asked for.
 */
function aclIntent(value: WindowsPermissionIntent): boolean {
  return (
    value.windowsModeSource === 'official' &&
    value.windowsMode === 'write-restricted' &&
    value.access !== 'full-access' &&
    (value.permission === undefined || value.permission === value.access) &&
    !value.required &&
    !value.customFsDeny &&
    value.networkMode === 'allow' &&
    value.onUnavailable === 'allow-if-unimplemented'
  )
}

const SAME_FACTS = [
  'workspaceId',
  'workspaceRoot',
  'policyDigest',
  'provider',
  'providerVersion',
  'target',
] as const
const sameFacts = (left: SandboxExecutionRecord, right: SandboxExecutionRecord): boolean =>
  SAME_FACTS.every((key) => left[key] === right[key])

/** Only a stronger backend with otherwise identical facts starts a new generation by itself. */
function strengthens(
  previous: SandboxExecutionRecord,
  current: SandboxExecutionRecord,
  permissionIntent: WindowsPermissionIntent,
): boolean {
  if (!sameFacts(previous, current) || previous.staticConfigHash !== current.staticConfigHash) return false
  if (previous.backend === 'none' && current.backend === 'windows-acl') return aclIntent(permissionIntent)
  return (
    (previous.backend === 'none' || previous.backend === 'windows-acl') &&
    current.backend === 'l1' &&
    current.implementation === 'implemented' &&
    current.probeState === 'ready' &&
    current.enforcement.level === 'full' &&
    current.enforcement.scope.includes('file')
  )
}

/**
 * A version 1 Windows record carries no root object identity and was written without
 * `windows_mode`. It is adopted when the saved workspace authority still names this workspace and
 * the saved facts prove the original intent: the same backend apart from the static config hash, or
 * the official ACL default replacing the unconfined backend the previous build ran.
 */
function adoptLegacy(
  legacy: SandboxExecutionRecord,
  current: SandboxExecutionRecord,
  input: WindowsExecutionVerification,
) {
  const evidence = input.permissionEvidence
  if (legacy.target !== 'win32' || current.target !== 'win32') throw executionRecordRefusal()
  if (legacy.workspaceId !== current.workspaceId || legacy.workspaceRoot !== current.workspaceRoot)
    throw confirmationRefusal()
  if (legacy.staticConfigHash !== evidence.legacyStaticConfigHash) throw executionRecordRefusal()
  if (
    isDeepStrictEqual(execution(legacy), execution({ ...current, staticConfigHash: legacy.staticConfigHash }))
  )
    return
  if (
    legacy.backend !== 'none' ||
    current.backend !== 'windows-acl' ||
    !sameFacts(legacy, current) ||
    !aclIntent(evidence.intent) ||
    evidence.recordedPermission !== evidence.intent.permission
  )
    throw executionRecordRefusal()
}

function parse(bytes: string): unknown {
  try {
    return JSON.parse(bytes)
  } catch {
    throw executionRecordRefusal()
  }
}

/**
 * Decides what a Windows session's record must say for this open. `bytes` is the record on disk,
 * absent when there is none. `confirm` is the user's confirmation of a replaced workspace directory
 * inside the same session; it never changes the workspace, the permission or the backend.
 */
export function planWindowsExecution(input: {
  key: string
  bytes: string | undefined
  verification: WindowsExecutionVerification
  hasHistory: boolean
  mode: 'verify' | 'confirm'
  canAdoptHistory(execution: SandboxExecutionRecord): boolean
}): WindowsExecutionPlan {
  const { key, verification } = input
  const current = execution(verification.currentExecution)
  const permissionIntent = intent(verification.permissionEvidence.intent)
  const rootIdentity = verification.rootIdentity
  if (
    !isExecution(current) ||
    !isIntent(permissionIntent) ||
    (current.backend === 'windows-acl' && !rootIdentity)
  )
    throw executionRecordRefusal()
  const fresh = (
    reason: ExecutionGenerationReason,
    legacy?: Readonly<{ record: LegacyRecord; digest: string }>,
  ): WindowsExecutionPlan => {
    const first = generation(key, 0, permissionIntent, legacy?.digest, current, rootIdentity, reason)
    return {
      record: {
        version: 2,
        sessionKey: key,
        ...(legacy ? { legacyRecord: legacy.record, legacyDigest: legacy.digest } : {}),
        permissionIntent,
        generations: [first],
        currentGeneration: first.generationId,
      },
      generation: first,
      changed: true,
    }
  }
  if (input.bytes === undefined) {
    if (input.mode === 'confirm' || (input.hasHistory && !input.canAdoptHistory(current)))
      throw executionRecordRefusal()
    return fresh(input.hasHistory ? 'history-adoption' : 'new-session')
  }
  const value = parse(input.bytes)
  if (isRecord(value) && value.version === 1) {
    const legacy = readLegacy(key, value, input.bytes)
    if (!legacy || input.mode === 'confirm') throw executionRecordRefusal()
    adoptLegacy(legacy.execution, current, verification)
    return fresh('legacy-adoption', { record: legacy, digest: sha256(input.bytes) })
  }
  const record = readRecord(key, value)
  const head = record?.generations.at(-1)
  if (!record || !head || !isDeepStrictEqual(record.permissionIntent, permissionIntent))
    throw executionRecordRefusal()
  const append = (reason: ExecutionGenerationReason): WindowsExecutionPlan => {
    const next = generation(
      key,
      record.generations.length,
      permissionIntent,
      record.legacyDigest,
      current,
      rootIdentity,
      reason,
    )
    return {
      record: { ...record, generations: [...record.generations, next], currentGeneration: next.generationId },
      generation: next,
      changed: true,
    }
  }
  const sameWorkspace =
    head.workspaceId === current.workspaceId && head.workspaceRoot === current.workspaceRoot
  const replaced =
    head.rootIdentity !== undefined &&
    rootIdentity !== undefined &&
    !sameIdentity(head.rootIdentity, rootIdentity)
  const { generationId: _id, rootIdentity: _root, reason: _reason, evidenceDigest: _digest, ...facts } = head
  if (input.mode === 'confirm') {
    if (!sameWorkspace || !replaced || !isDeepStrictEqual(execution(facts), current))
      throw executionRecordRefusal()
    return append('workspace-confirmed')
  }
  if (!sameWorkspace || replaced) throw confirmationRefusal()
  if (isDeepStrictEqual(execution(facts), current) && sameIdentity(head.rootIdentity, rootIdentity))
    return { record, generation: head, changed: false }
  if (strengthens(facts, current, permissionIntent)) return append('backend-change')
  throw executionRecordRefusal()
}
