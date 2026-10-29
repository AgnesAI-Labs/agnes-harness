import type { Host } from './host.js'
import type { HostSessionRoutes } from './host-routing.js'

/** coldRead permits only storage/descriptor access without reconstructing a retired container. */
export type SessionHostOwner = (key: string, coldRead?: boolean) => Host

/** Coordinators override admission/migration; all ordinary ports share binding-based dispatch. */
export function sessionHostRoutes(
  owner: SessionHostOwner,
  current: () => Host,
  storage: () => Pick<Host, 'readSessionRows' | 'readSessionView'>,
): HostSessionRoutes {
  const computerUse = current().computerUse
  return {
    kernel: current().kernel,
    computerUse: computerUse
      ? {
          status: () => current().computerUse!.status(),
          doctor: (params) => current().computerUse!.doctor(params),
          permissionsStatus: () => current().computerUse!.permissionsStatus(),
          permissionsGrant: () => current().computerUse!.permissionsGrant(),
          setSessionYolo: (session, enabled) =>
            owner(session.key).computerUse!.setSessionYolo(session, enabled),
          operationStart: (kind) => current().computerUse!.operationStart(kind),
          operationStatus: (id) => current().computerUse!.operationStatus(id),
          operationCancel: (id) => current().computerUse!.operationCancel(id),
        }
      : undefined,
    createSession: (input) => {
      const key = input.key ?? input.binding?.sessionKey
      return (key ? owner(key) : current()).createSession(input)
    },
    sessionBinding: current().sessionBinding ? (key) => owner(key, true).sessionBinding?.(key) : undefined,
    sessionGeneration: current().sessionGeneration
      ? (key) => owner(key, true).sessionGeneration?.(key)
      : undefined,
    sessionRuntime: current().sessionRuntime ? (key) => owner(key, true).sessionRuntime!(key) : undefined,
    releaseSessionGeneration: current().releaseSessionGeneration
      ? (key) => owner(key, true).releaseSessionGeneration!(key)
      : undefined,
    migrateSessionGeneration: current().migrateSessionGeneration
      ? (key, context) => owner(key, true).migrateSessionGeneration!(key, context)
      : undefined,
    // Raw history has no runtime dependency: even a damaged pin must not hide its ledger.
    readSessionRows: (key, query) => storage().readSessionRows(key, query),
    readSessionView: (key, options) => storage().readSessionView(key, options),
    memory: (workspaceRoot, key) => owner(key).memory(workspaceRoot, key),
    captureSessionCapabilities: current().captureSessionCapabilities
      ? (key, workspace) => owner(key).captureSessionCapabilities!(key, workspace)
      : undefined,
    sessionCapabilities: current().sessionCapabilities
      ? (key) => owner(key).sessionCapabilities!(key)
      : undefined,
    executionIdentity: current().executionIdentity
      ? (key) => (key ? owner(key) : current()).executionIdentity!()
      : undefined,
    setSessionPreset: (key, name) => owner(key).setSessionPreset(key, name),
    validatePresetSwitch: (name, key) => (key ? owner(key) : current()).validatePresetSwitch(name, key),
    validateModelSwitch: (selection, key) =>
      (key ? owner(key) : current()).validateModelSwitch(selection, key),
    resolveService: (key, names) => owner(key).resolveService(key, names),
    callService: (params, ...rest) => owner(params.sessionId).callService(params, ...rest),
    inspectService: (params, ...rest) => owner(params.sessionId).inspectService(params, ...rest),
    authorizeServiceControl: (params, ...rest) =>
      owner(params.sessionId).authorizeServiceControl(params, ...rest),
  }
}
