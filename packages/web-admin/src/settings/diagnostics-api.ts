import { type DiagnosticsExportParams, validateAgainst, validateMethod } from '@agnes/protocol'
import { DiagnosticsExportResult } from '@agnes/protocol/gen/agnes-v1'

export class DiagnosticsRequestError extends Error {
  constructor(readonly envelope: unknown) {
    super('Diagnostics unavailable')
  }
}
export function diagnosticsApi(fetcher: typeof fetch = fetch) {
  async function call(path: string, input?: unknown, signal?: AbortSignal) {
    const response = await fetcher(`/admin/api/${path}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...(signal ? { signal } : {}),
      ...(input === undefined
        ? {}
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }),
    })
    const value: unknown = await response.json()
    if (!response.ok)
      throw new DiagnosticsRequestError(
        value && typeof value === 'object' && 'error' in value ? value.error : undefined,
      )
    return value
  }
  function bundle(value: unknown): import('@agnes/protocol').DiagnosticsExportResult {
    if (!validateAgainst(DiagnosticsExportResult, value).ok) throw new DiagnosticsRequestError(undefined)
    return value as import('@agnes/protocol').DiagnosticsExportResult
  }
  return {
    async read(signal?: AbortSignal) {
      const value = await call('diagnostics', undefined, signal)
      if (
        !value ||
        typeof value !== 'object' ||
        !('bundle' in value) ||
        !('doctorAvailable' in value) ||
        typeof value.doctorAvailable !== 'boolean'
      )
        throw new DiagnosticsRequestError(undefined)
      return { bundle: bundle(value.bundle), doctorAvailable: value.doctorAvailable }
    },
    async export(input: DiagnosticsExportParams = {}, signal?: AbortSignal) {
      return bundle(await call('diagnostics', input, signal))
    },
    async doctor(signal?: AbortSignal, probeAccounts = false) {
      const value = await call('doctor', { probeAccounts }, signal)
      if (!validateMethod('_agnes/v1/doctor.run', 'result', value).ok)
        throw new DiagnosticsRequestError(undefined)
      return value as import('@agnes/protocol/gen/app-server').DoctorResult
    },
  }
}
export type DiagnosticsApi = ReturnType<typeof diagnosticsApi>
export function downloadDiagnostics(bundle: import('@agnes/protocol').DiagnosticsExportResult) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(bundle, null, 2) + '\n'], { type: 'application/json' }),
  )
  const link = document.createElement('a')
  link.href = url
  link.download = 'agh-diagnostics.json'
  document.body.append(link)
  try {
    link.click()
  } finally {
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}
