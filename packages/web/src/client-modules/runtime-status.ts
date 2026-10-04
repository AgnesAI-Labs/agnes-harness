export type PluginRuntimePhase = 'idle' | 'loading' | 'active' | 'stopping' | 'failed'

export interface PluginRuntimeError {
  readonly code: string
  readonly message: string
}

export interface PluginRuntimeState {
  readonly packageId: string
  readonly revision: string | undefined
  readonly phase: PluginRuntimePhase
  readonly error?: PluginRuntimeError
}

export type RuntimeErrorStage =
  | 'import'
  | 'styles'
  | 'unsupported-slot'
  | 'module-shape'
  | 'apply'
  | 'render'
  | 'dispose'
  | 'timeout'
  | 'row-alias'
  | 'reconcile'

const ERROR_KEYS: Record<RuntimeErrorStage, string> = {
  import: 'runtime.import',
  styles: 'runtime.styles',
  'unsupported-slot': 'runtime.unsupportedSlot',
  'module-shape': 'runtime.moduleShape',
  apply: 'runtime.apply',
  render: 'runtime.render',
  dispose: 'runtime.dispose',
  timeout: 'runtime.timeout',
  'row-alias': 'runtime.rowAlias',
  reconcile: 'runtime.reconcile',
}

const ERROR_CODES: Record<RuntimeErrorStage, string> = {
  import: 'CLIENT_MODULE_IMPORT_FAILED',
  styles: 'CLIENT_MODULE_STYLES_FAILED',
  'unsupported-slot': 'CLIENT_MODULE_SLOT_UNSUPPORTED',
  'module-shape': 'CLIENT_MODULE_SHAPE_INVALID',
  apply: 'CLIENT_MODULE_APPLY_FAILED',
  render: 'CLIENT_MODULE_RENDER_FAILED',
  dispose: 'CLIENT_MODULE_DISPOSE_FAILED',
  timeout: 'CLIENT_MODULE_TIMEOUT',
  'row-alias': 'CLIENT_MODULE_ROW_ALIAS_INVALID',
  reconcile: 'CLIENT_MODULE_RECONCILE_FAILED',
}

/** Convert loader/runtime failures into a small, safe diagnostic contract. */
export function normalizeRuntimeError(
  stage: RuntimeErrorStage,
  _error: unknown,
  t: (key: string) => string = (key) => key,
): PluginRuntimeError {
  return { code: ERROR_CODES[stage], message: t(ERROR_KEYS[stage]) }
}

function copyState(state: PluginRuntimeState): PluginRuntimeState {
  return {
    packageId: state.packageId,
    revision: state.revision,
    phase: state.phase,
    ...(state.error === undefined ? {} : { error: { ...state.error } }),
  }
}

/** Small observable store used by the reconciler and embedded admin pane. */
export class RuntimeStatusStore {
  #states = new Map<string, PluginRuntimeState>()
  #listeners = new Set<(state: PluginRuntimeState) => void>()

  set(state: PluginRuntimeState, key = state.packageId): void {
    const next = copyState(state)
    this.#states.set(key, next)
    for (const listener of [...this.#listeners]) listener(copyState(next))
  }

  delete(key: string): void {
    this.#states.delete(key)
  }

  subscribe(listener: (state: PluginRuntimeState) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  snapshot(): Map<string, PluginRuntimeState> {
    return new Map([...this.#states].map(([key, state]) => [key, copyState(state)]))
  }
}
