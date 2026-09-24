export { buildConfig, type DaemonConfig } from './config.js'
export * from './packages/index.js'
export * from './resources/index.js'
export type {
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from './rpc.js'
export { fail, isNotification, isRequest, isResponse, notify, ok } from './rpc.js'
export {
  type DaemonControlCommandOptions,
  DaemonControlError,
  type DaemonStatus,
  type DaemonStatusOptions,
  daemonStatus,
  runDaemonControl,
  type StopDaemonOptions,
  type StopDaemonResult,
  stopDaemon,
} from './supervisor/control.js'
export {
  type DaemonDiscovery,
  DaemonDiscoveryError,
  type DaemonDiscoveryReadOptions,
  type DaemonDiscoveryWeb,
  type DaemonWebCredentialReadOptions,
  publishDaemonDiscovery,
  readDaemonDiscovery,
  readDaemonWebCredential,
  removeDaemonDiscovery,
} from './supervisor/discovery.js'
export { type DaemonDoctorSection, daemonDoctor } from './supervisor/doctor.js'
export { acquireDaemonOfflineMaintenance } from './supervisor/offline-maintenance.js'
export {
  createRuntimeTargetProbeLauncher,
  RUNTIME_TARGET_PROBE_REAP_TIMEOUT_MS,
  RUNTIME_TARGET_PROBE_TIMEOUT_MS,
  RuntimeTargetProbeError,
  type RuntimeTargetProbeWorker,
  type RuntimeTargetProbeWorkerFactory,
  type RuntimeTargetProbeWorkerInput,
  spawnRuntimeTargetProbeWorker,
} from './supervisor/runtime-target-probe.js'
export {
  canonicalPath,
  type DaemonScope,
  DaemonScopeError,
  type DaemonScopeOptions,
  resolveDaemonProfile,
  resolveDaemonScope,
} from './supervisor/scope.js'
export { workerServiceCaller, workerServiceInspector } from './supervisor/service-worker.js'
export { daemonSocketPaths, prepareDaemonSocketPaths } from './supervisor/socket-paths.js'
export { acquireDaemonStartup, DaemonStartupBusyError } from './supervisor/startup.js'
export {
  type RunAgnesdArgs,
  type RunAgnesdDeps,
  runAgnesd,
  type StartSupervisorOptions,
  startProductionSupervisor,
  startSupervisor,
} from './supervisor/supervisor.js'
export {
  createSurfaceController,
  SurfaceControllerError,
  type SurfaceControllerOptions,
} from './surfaces/controller.js'
export { type HealthProbe, probeSurfaceHealth, waitForSurfaceHealth } from './surfaces/health.js'
export {
  createLocalNodeRuntime,
  type LocalNodeRuntimeOptions,
  type SpawnedSurfaceProcess,
  type SurfaceSpawnOptions,
} from './surfaces/local-runtime.js'
export { createMountProxy, type MountProxyMatch, matchMount } from './surfaces/mount-proxy.js'
export {
  createSurfaceRoutes,
  DEFAULT_SURFACE_RESPONSE_BODY_BYTES,
  type PortalSubject,
  type SurfaceConnectionFactory,
  type SurfaceRelay,
  type SurfaceRelayRequest,
  type SurfaceRelayResponse,
  type SurfaceRouteRequest,
  type SurfaceRouteResponse,
  type SurfaceRoutes,
  type SurfaceSecretRedactionLease,
} from './surfaces/routes.js'
export {
  DEFAULT_SURFACE_CSP,
  type SafeSurfaceContent,
  type SurfaceHeaders,
  safeSurfaceContent,
  surfaceSecurityHeaders,
} from './surfaces/security-headers.js'
export type {
  ProductionSurfaceAdapter,
  ResolvedNodeArtifact,
  ResolvedSurface,
  SurfaceArtifactResolver,
  SurfaceController,
  SurfaceControllerSnapshot,
  SurfaceEndpoint,
  SurfaceExit,
  SurfaceInstanceState,
  SurfaceInstanceStatus,
  SurfaceLog,
  SurfaceRuntimeAdapter,
  SurfaceRuntimeHandle,
  SurfaceRuntimeStart,
  SurfaceSecretLease,
  SurfaceSecretResolver,
} from './surfaces/types.js'
