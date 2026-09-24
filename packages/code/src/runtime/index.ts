import type { CodeRuntime } from '@agnes/extension-api'

export type { CodeRuntime }
export type CodeRunResult = Awaited<ReturnType<CodeRuntime['run']>>
/** Transport only. The host bridge validates untrusted frames before dispatch. */
export type BridgeHandler = Parameters<CodeRuntime['run']>[0]['bindings']
export type RuntimeLogger = {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}
export type RuntimeFactory = (ctx: { log: RuntimeLogger; signal: AbortSignal }) => Promise<CodeRuntime>
export type RuntimesExport = Partial<Record<'python' | 'typescript', RuntimeFactory>>

export { type DoctorCheck, type DoctorSection, runtimeDoctor } from './doctor.js'
