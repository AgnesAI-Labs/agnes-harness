import type { DatabaseSync } from 'node:sqlite'
import type { CallContext } from '@agnes/extension-api/runtime'
import {
  type ConfigResolveResult,
  type SessionControlRequest,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { digestOf, sameJson } from './records.js'
import { integrity, refuse } from './refusal.js'
import {
  captureSessionControlSlots,
  fixedSessionControlData,
  isSessionControlConfiguration,
  type SessionConfigurationCapture,
  type SessionControlConfiguration,
  type SessionControlPermissionProof,
  sessionControlConfigurationUsesDatabase,
} from './session-control-configuration.js'

export type SessionControlSourceCapture = Readonly<{
  request: SessionControlRequest
  configuration: SessionConfigurationCapture['issue']
  permission: SessionControlPermissionProof
  selected: ConfigResolveResult
  requestFingerprint: string
  deadline: string
  dynamicCheck(): void
  staticCheck(): void
  finalCheck(stateStaticCheck?: () => void): void
}>
export type SessionControlSource = Readonly<{
  readHistoricalCommand(
    request: SessionControlRequest,
    proof: SessionControlPermissionProof,
  ): Readonly<{ staticCheck(): void }>
  captureSubmit(request: SessionControlRequest, context: CallContext): SessionControlSourceCapture
  captureRead(sessionId: string, context: CallContext): SessionConfigurationCapture
  captureStatus(sessionId: string, context: CallContext): SessionConfigurationCapture
}>
const sources = new WeakMap<object, DatabaseSync>()
export function isSessionControlSource(value: unknown): value is SessionControlSource {
  return typeof value === 'object' && value !== null && sources.has(value)
}
export function sessionControlSourceUsesDatabase(
  source: SessionControlSource,
  database: DatabaseSync,
): boolean {
  return sources.get(source) === database
}
/** Selected installation bridge. It supplies qualifications, never writes a State control decision. */
export function createSessionControlSource(
  input: Readonly<{ database: DatabaseSync; configuration: SessionControlConfiguration }>,
): SessionControlSource {
  if (
    !isSessionControlConfiguration(input.configuration) ||
    !sessionControlConfigurationUsesDatabase(input.configuration, input.database)
  )
    refuse('denied', 'session_control_source', 'original same-connection configuration source is required')
  const configuration = input.configuration
  const slots = captureSessionControlSlots([input, configuration])
  function captureRead(sessionId: string, context: CallContext) {
    slots()
    return configuration.capture(sessionId, 'read', context)
  }
  function captureStatus(sessionId: string, context: CallContext) {
    slots()
    return configuration.capture(sessionId, 'status', context)
  }
  function captureSubmit(raw: SessionControlRequest, context: CallContext): SessionControlSourceCapture {
    slots()
    const parsed = validateRuntime('SessionControlRequest', raw)
    if (!parsed.ok)
      refuse(
        'invalid_input',
        'session_control_request',
        'session command does not match its official input codec',
      )
    const request = fixedSessionControlData(parsed.value)
    if (request.command.kind !== 'set-preset' || request.command.apply !== 'next-run')
      refuse('denied', 'session_control_command', 'selected source supports only set-preset for the next run')
    const cap = configuration.capture(request.sessionId, 'set-preset:next-run', context)
    const command = request.command
    const retained = [cap.issue.request.defaults.preset, ...cap.issue.request.presets]
    const target = retained.find(
      (snapshot) =>
        snapshot.document.id === command.presetId && snapshot.source.digest === command.presetDigest,
    )
    if (
      !target ||
      !cap.issue.resolved.profile.presets.allowed.some(
        (allowed) => allowed.presetId === command.presetId && allowed.digest === command.presetDigest,
      )
    )
      refuse(
        'denied',
        'session_control_preset',
        'preset is not in the original selected configuration sources',
      )
    // The resolver validates inheritance; this bounded bridge retains its original source chain.
    const end = cap.issue.request.presets.indexOf(target)
    const selected = configuration.resolve({
      ...cap.issue.request,
      presets: end >= 0 ? cap.issue.request.presets.slice(0, end + 1) : [],
    })
    if (selected.preset.id !== command.presetId || !sameJson(selected.profile, cap.issue.resolved.profile))
      refuse('denied', 'session_control_preset', 'selected preset changes the original applied profile')
    const fingerprint = digestOf(request)
    return Object.freeze({
      request,
      configuration: cap.issue,
      permission: cap.permission,
      selected,
      requestFingerprint: fingerprint,
      deadline: cap.deadline,
      dynamicCheck() {
        slots()
        cap.dynamicCheck()
      },
      staticCheck() {
        slots()
        cap.staticCheck()
      },
      finalCheck(stateStaticCheck?: () => void) {
        cap.finalCheck(() => {
          slots()
          stateStaticCheck?.()
          slots()
        })
      },
    })
  }
  function readHistoricalCommand(raw: SessionControlRequest, proof: SessionControlPermissionProof) {
    slots()
    const parsed = validateRuntime('SessionControlRequest', raw)
    if (
      !parsed.ok ||
      parsed.value.command.kind !== 'set-preset' ||
      parsed.value.command.apply !== 'next-run' ||
      parsed.value.sessionId !== proof.sessionId ||
      proof.capability !== 'set-preset:next-run'
    )
      integrity('historical command does not match its original permission')
    const original = configuration.readHistoricalPermission(proof)
    return Object.freeze({
      staticCheck() {
        slots()
        original.staticCheck()
        slots()
      },
    })
  }
  const source = Object.freeze({ captureSubmit, captureRead, captureStatus, readHistoricalCommand })
  sources.set(source, input.database)
  if (!isSessionControlSource(source)) integrity('session control installation is unregistered')
  return source
}
