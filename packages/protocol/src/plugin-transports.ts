import type { TSchema } from '@sinclair/typebox'
import type { Capabilities } from '../gen/ts/extension-manifest.js'
import * as M from '../gen/ts/managed-service.js'
import * as S from '../gen/ts/plugin-stream.js'
import { inspectJsonData } from './json-data.js'
import { type ValidationResult, validateAgainst } from './validate.js'

export const PLUGIN_STREAM_PATH = '/_agnes/plugin-stream'
export const PLUGIN_STREAM_OPEN_PATH = '/_agnes/plugin-stream/open'
export const PLUGIN_STREAM_SOURCE_PATH = '/_agnes/plugin-stream/source'
export const PLUGIN_STREAM_SOURCE_OPEN_PATH = '/_agnes/plugin-stream/source/open'
export const PLUGIN_STREAM_HEADER_BYTES = 20
export const PLUGIN_STREAM_MAX_BYTES = 1_048_576
function check<T>(schema: TSchema, value: unknown, maxBytes = 65536): ValidationResult<T> {
  const data = inspectJsonData(value, maxBytes)
  return data.ok ? validateAgainst<T>(schema, data.value) : invalid('invalid or oversized transport JSON')
}
function invalid(message: string): ValidationResult<never> {
  return { ok: false, errors: [{ path: '', code: 'OTHER', message }] }
}
export function validateStreamDeclaration(value: unknown): ValidationResult<S.StreamDeclaration> {
  const result = check<S.StreamDeclaration>(S.StreamDeclaration, value)
  if (!result.ok) return result
  const d = result.value
  if (
    d.lane === 'control' &&
    (d.maxFrameBytes > 4096 ||
      d.maxBufferedBytes > 32768 ||
      d.maxBytesPerSecond > 122880 ||
      (d.directions.includes('inbound') && !d.controlService))
  )
    return invalid('control streams require bounded buffers and an authorized effect service')
  if (
    d.producer &&
    (d.scope !== 'profile' || d.lane === 'control' || d.controlService || !d.directions.includes('inbound'))
  )
    return invalid('producers require a profile data lane without control admission')
  if (d.lane !== 'control' && d.directions.includes('inbound') && !d.producer)
    return invalid('inbound streams require the control lane')
  return result
}
export const validatePluginStreamOpen = (value: unknown) =>
  check<S.PluginStreamOpen>(S.PluginStreamOpen, value)
export const validatePluginStreamGrant = (value: unknown) =>
  check<S.PluginStreamGrant>(S.PluginStreamGrant, value, 4096)
export const validatePluginStreamHello = (value: unknown) =>
  check<S.PluginStreamHello>(S.PluginStreamHello, value, 4096)
export const validatePluginStreamJsonFrame = (value: unknown) =>
  check<S.PluginStreamJsonFrame>(S.PluginStreamJsonFrame, value, 4096)
export const validateManagedServiceReady = (value: unknown) =>
  check<M.ManagedServiceReady>(M.ManagedServiceReady, value)
export function validateManagedServiceDescriptor(
  value: unknown,
): ValidationResult<M.ManagedServiceDescriptor> {
  const result = check<M.ManagedServiceDescriptor>(M.ManagedServiceDescriptor, value)
  if (!result.ok) return result
  const d = result.value
  if (
    new Set(d.listeners.map((l) => l.name)).size !== d.listeners.length ||
    new Set(d.requires.map((r) => `${r.extension}/${r.name}`)).size !== d.requires.length
  )
    return invalid('duplicate listener or service grant')
  return result
}
export function encodePluginStreamBinary(
  streamId: number,
  sequence: number,
  payload: Uint8Array,
): Uint8Array {
  if (
    !Number.isInteger(streamId) ||
    streamId < 1 ||
    streamId > 0xffffffff ||
    !Number.isInteger(sequence) ||
    sequence < 0 ||
    sequence > 0xffffffff ||
    payload.byteLength + PLUGIN_STREAM_HEADER_BYTES > PLUGIN_STREAM_MAX_BYTES
  )
    throw new RangeError('invalid stream frame')
  const bytes = new Uint8Array(PLUGIN_STREAM_HEADER_BYTES + payload.byteLength)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x41475331)
  view.setUint8(4, 1)
  view.setUint8(5, 1)
  view.setUint32(8, streamId)
  view.setUint32(12, sequence)
  view.setUint32(16, payload.byteLength)
  bytes.set(payload, PLUGIN_STREAM_HEADER_BYTES)
  return bytes
}
export function decodePluginStreamBinary(bytes: Uint8Array): {
  streamId: number
  sequence: number
  payload: Uint8Array
} {
  if (bytes.byteLength < PLUGIN_STREAM_HEADER_BYTES || bytes.byteLength > PLUGIN_STREAM_MAX_BYTES)
    throw new RangeError('invalid stream frame size')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (
    view.getUint32(0) !== 0x41475331 ||
    view.getUint8(4) !== 1 ||
    view.getUint8(5) !== 1 ||
    view.getUint16(6) !== 0 ||
    view.getUint32(8) === 0 ||
    view.getUint32(16) !== bytes.byteLength - PLUGIN_STREAM_HEADER_BYTES
  )
    throw new TypeError('invalid stream frame header')
  return {
    streamId: view.getUint32(8),
    sequence: view.getUint32(12),
    payload: bytes.subarray(PLUGIN_STREAM_HEADER_BYTES),
  }
}

/** Semantic constraints shared by installed rows and bundled extension manifests. */
export function transportCapabilityProblems(
  value: Pick<Capabilities, 'streams' | 'managedServices' | 'services'>,
): string[] {
  const problems: string[] = []
  for (const stream of value.streams ?? []) {
    const checked = validateStreamDeclaration(stream)
    if (!checked.ok) problems.push(...checked.errors.map((e) => e.message))
    if (
      stream.readService &&
      !value.services?.some(
        (s) => s.name === stream.readService && s.kind === 'query' && (s.scope ?? 'session') === 'session',
      )
    )
      problems.push('stream readService must name an own session query service')
    if (
      stream.controlService &&
      !value.services?.some((s) => s.name === stream.controlService && s.kind === 'effect')
    )
      problems.push('stream controlService must name an own effect service')
  }
  for (const descriptor of value.managedServices ?? []) {
    const checked = validateManagedServiceDescriptor(descriptor)
    if (!checked.ok) problems.push(...checked.errors.map((e) => e.message))
  }
  for (const names of [value.streams?.map((s) => s.name), value.managedServices?.map((s) => s.id)])
    if (names && new Set(names).size !== names.length) problems.push('duplicate transport declaration')
  return problems
}
