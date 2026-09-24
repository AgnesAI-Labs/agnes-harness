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

const ERROR_DETAILS: Record<RuntimeErrorStage, PluginRuntimeError> = {
  import: { code: 'CLIENT_MODULE_IMPORT_FAILED', message: '插件 UI 入口加载失败，可重试' },
  styles: { code: 'CLIENT_MODULE_STYLES_FAILED', message: '插件 UI 样式加载失败，可重试' },
  'unsupported-slot': {
    code: 'CLIENT_MODULE_SLOT_UNSUPPORTED',
    message: '插件 UI 使用了当前宿主未实现的槽位',
  },
  'module-shape': { code: 'CLIENT_MODULE_SHAPE_INVALID', message: '插件 UI 模块格式无效，可重试' },
  apply: { code: 'CLIENT_MODULE_APPLY_FAILED', message: '插件 UI 启动失败，可重试' },
  render: { code: 'CLIENT_MODULE_RENDER_FAILED', message: '插件 UI 渲染失败，可重试' },
  dispose: { code: 'CLIENT_MODULE_DISPOSE_FAILED', message: '插件 UI 卸载失败，后台清理中，可重试' },
  timeout: { code: 'CLIENT_MODULE_TIMEOUT', message: '插件 UI 操作超时，后台清理中，可重试' },
  'row-alias': { code: 'CLIENT_MODULE_ROW_ALIAS_INVALID', message: '插件 UI 行身份迁移不明确，已停止激活' },
  reconcile: { code: 'CLIENT_MODULE_RECONCILE_FAILED', message: '插件 UI 名册暂不可用，可重试' },
}

/** Convert loader/runtime failures into a small, safe diagnostic contract. */
export function normalizeRuntimeError(stage: RuntimeErrorStage, _error: unknown): PluginRuntimeError {
  return { ...ERROR_DETAILS[stage] }
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
