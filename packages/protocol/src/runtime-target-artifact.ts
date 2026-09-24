import * as W from '../gen/ts/worker.js'
import { MAX_RUNTIME_TARGET_ARTIFACT_BASE64_LENGTH } from './constants.js'
import { type ValidationResult, validateAgainst } from './validate.js'

function isBase64Alphabet(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2b ||
    code === 0x2f
  )
}

function hasCanonicalBase64Shape(value: string): boolean {
  if (
    value.length < 4 ||
    value.length > MAX_RUNTIME_TARGET_ARTIFACT_BASE64_LENGTH ||
    value.length % 4 !== 0
  ) {
    return false
  }
  let contentLength = value.length
  if (value.charCodeAt(contentLength - 1) === 0x3d) contentLength -= 1
  if (value.charCodeAt(contentLength - 1) === 0x3d) contentLength -= 1
  for (let index = 0; index < contentLength; index += 1) {
    if (!isBase64Alphabet(value.charCodeAt(index))) return false
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x3d) return false
  }
  return true
}

function invalidBase64(path: string): ValidationResult<never> {
  return {
    ok: false,
    errors: [{ path, message: 'Expected canonical standard base64', code: 'PATTERN' }],
  }
}

/**
 * Validate the closed wire envelope. The owner codec must additionally verify decoded canonical
 * bytes, digest and embedded identity before the artifact is applied or persisted.
 */
export function validateRuntimeTargetArtifact(value: unknown): ValidationResult<W.RuntimeTargetArtifact> {
  const checked = validateAgainst<W.RuntimeTargetArtifact>(W.RuntimeTargetArtifact, value)
  if (!checked.ok) return checked
  if (!hasCanonicalBase64Shape(checked.value.canonicalBase64)) return invalidBase64('/canonicalBase64')
  return checked
}

/** Validate the single-artifact runtime.stale frame. */
export function validateRuntimeStaleFrame(value: unknown): ValidationResult<W.RuntimeStaleFrame> {
  const checked = validateAgainst<W.RuntimeStaleFrame>(W.RuntimeStaleFrame, value)
  if (!checked.ok) return checked
  if (!hasCanonicalBase64Shape(checked.value.artifact.canonicalBase64)) {
    return invalidBase64('/artifact/canonicalBase64')
  }
  return checked
}

export function validateRuntimeConvergenceRow(value: unknown): ValidationResult<W.RuntimeConvergenceRow> {
  return validateAgainst<W.RuntimeConvergenceRow>(W.RuntimeConvergenceRow, value)
}

export function validateRuntimeConvergenceReport(
  value: unknown,
): ValidationResult<W.RuntimeConvergenceReport> {
  return validateAgainst<W.RuntimeConvergenceReport>(W.RuntimeConvergenceReport, value)
}

export function validateRuntimeBootReadyFrame(value: unknown): ValidationResult<W.RuntimeBootReadyFrame> {
  return validateAgainst<W.RuntimeBootReadyFrame>(W.RuntimeBootReadyFrame, value)
}

export function validateRuntimeConvergedFrame(value: unknown): ValidationResult<W.RuntimeConvergedFrame> {
  return validateAgainst<W.RuntimeConvergedFrame>(W.RuntimeConvergedFrame, value)
}

export function validateRuntimeApplyFailedFrame(value: unknown): ValidationResult<W.RuntimeApplyFailedFrame> {
  return validateAgainst<W.RuntimeApplyFailedFrame>(W.RuntimeApplyFailedFrame, value)
}
