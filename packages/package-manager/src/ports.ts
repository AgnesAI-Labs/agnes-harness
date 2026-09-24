import { PackageError } from './errors.js'
import type { FetchedSource, PackageSource } from './sources.js'

export type OperationOptions = {
  signal?: AbortSignal
  onProgress?: (
    progress: Readonly<{ phase: 'fetching' | 'inspecting' | 'committing' | 'completed'; percent: number }>,
  ) => void
}
export type PackageSourceAdapter = {
  type: Exclude<PackageSource['type'], 'market'>
  fetch(
    source: PackageSource,
    into: string,
    options: { cwd: string; signal?: AbortSignal },
  ): Promise<FetchedSource>
}
export function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new PackageError('E_EXT_LOAD', 'package operation cancelled', { code: 'E_PACKAGE_CANCELLED' })
}
export function progress(
  options: OperationOptions,
  phase: 'fetching' | 'inspecting' | 'committing' | 'completed',
): void {
  checkCancelled(options.signal)
  options.onProgress?.(
    Object.freeze({ phase, percent: { fetching: 0, inspecting: 50, committing: 90, completed: 100 }[phase] }),
  )
  checkCancelled(options.signal)
}
