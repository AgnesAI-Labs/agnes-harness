import { cloudFailureCode } from './cloud-errors.js'
import type { BackendCommand } from './frame-contract.js'
import { dispatchDiagnosticBackendRoute, dispatchWorkbenchSelect } from './local-workbench-bus.js'

export type BackendFrameContext = { remote: string; parentOrigin: string }

/** Only the isolated Cloud B iframe runs inside a child frame; Local A runs natively at top level. */
export function backendFrame(): BackendFrameContext | undefined {
  if (typeof window === 'undefined' || window.parent === window) return undefined
  const meta = document.querySelector<HTMLMetaElement>('meta#agnes-config')
  if (meta?.dataset.backendFrame === 'cloud' && meta.dataset.parentOrigin && meta.dataset.remote)
    return { remote: meta.dataset.remote, parentOrigin: meta.dataset.parentOrigin }
  try {
    const frame = window.frameElement
    const remote = frame?.getAttribute('data-backend-origin')
    if (frame?.getAttribute('data-agh-backend-frame') === '1' && remote)
      return {
        remote,
        parentOrigin: location.origin,
      }
  } catch {
    return undefined
  }
}

export function frameFailure(message: string): void {
  const context = backendFrame()
  if (context)
    window.parent.postMessage(
      { type: 'agh.backend.frame/v1', kind: 'error', message: cloudFailureCode(message) },
      context.parentOrigin,
    )
}

export function requestBackendEnvironment(remote?: string): boolean {
  const context = backendFrame()
  if (!context) return false
  window.parent.postMessage(
    { type: 'agh.backend.frame/v1', kind: 'environment', ...(remote ? { remote } : {}) },
    context.parentOrigin,
  )
  return true
}

/** Redirect only management navigation from a remote conversation; native B pages remain local to B. */
export function requestLocalManagement(
  command: Extract<BackendCommand, { kind: 'home' | 'settings' }>,
): boolean {
  const context = backendFrame()
  if (!context) {
    if (
      typeof document !== 'undefined' &&
      document.body?.dataset.aghActiveBackend === 'cloud' &&
      !(command.kind === 'settings' && command.section.split('/')[0] === 'diagnostics')
    )
      dispatchWorkbenchSelect('local')
    return false
  }
  if (command.kind === 'settings' && command.section.split('/')[0] === 'diagnostics') return false
  window.parent.postMessage(
    { type: 'agh.backend.frame/v1', kind: 'local-management', command },
    context.parentOrigin,
  )
  return true
}

/** The local server advertises its isolated cloud listener; query input cannot choose it. */
export function cloudFrameOrigin(): string {
  const value = document.querySelector<HTMLMetaElement>('meta#agnes-config')?.dataset.cloudOrigin
  if (!value) throw Error('CLOUD_AUTH_UNAVAILABLE')
  const url = new URL(value)
  if (
    url.protocol !== location.protocol ||
    url.hostname !== location.hostname ||
    url.origin === location.origin ||
    url.origin !== value
  )
    throw Error('CLOUD_ORIGIN_DENIED')
  return url.origin
}

/** Ask the workbench to route diagnostics to Cloud B when Cloud is the active diagnostic target. */
export function requestDiagnosticBackend(section: unknown): boolean {
  if (
    backendFrame() ||
    typeof section !== 'string' ||
    section.length > 128 ||
    section.split('/')[0] !== 'diagnostics'
  )
    return false
  return dispatchDiagnosticBackendRoute(section)
}
