/**
 * I6's closed-network compiler leaves and runtime selector. The selector only returns a backend
 * after the Host's revocable probe runs the complete generated boundary; it never promotes a
 * version check or platform capability label into an enforcement claim.
 */

export {
  type BackendName,
  type BackendProbeExec,
  BWRAP_BACKEND,
  type DetectBackendInput,
  detectBackend,
  NONE_BACKEND,
  type RuntimeBackend,
  SEATBELT_BACKEND,
} from './backend-runtime.js'
export { bwrapConfine } from './backends/bwrap.js'
export { seatbeltConfine } from './backends/seatbelt.js'
export type {
  ClosedNetworkConfineOptions,
  SandboxBackendCompileCode,
} from './backends/shared.js'
export { winConfine } from './backends/win.js'
