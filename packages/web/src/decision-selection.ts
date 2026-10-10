import type { DecisionBackendStatus, RuntimeDescriptor, RuntimeTurnOptions } from '@agnes/protocol'

type Backend = NonNullable<RuntimeTurnOptions['decisionBackend']>

/** Draft convenience only; the server binds the selected backend to each accepted input. */
export class DecisionSelection {
  private readonly drafts = new Map<string, Backend>()
  private scope = 'draft'
  private descriptor: RuntimeDescriptor | undefined
  private overrides: readonly DecisionBackendStatus[] | undefined
  private defaultBackend: Backend | undefined
  update(
    scope: string,
    descriptor: RuntimeDescriptor | undefined,
    overrides?: readonly DecisionBackendStatus[],
    defaultBackend?: Backend,
  ) {
    this.scope = scope
    this.descriptor = descriptor
    this.overrides = overrides
    this.defaultBackend = defaultBackend
  }
  get options(): readonly DecisionBackendStatus[] {
    return this.overrides ?? this.descriptor?.decisionBackends ?? []
  }
  get selected(): Backend {
    return (
      this.drafts.get(this.scope) ?? this.defaultBackend ?? this.descriptor?.defaultDecisionBackend ?? 'jev'
    )
  }
  get available(): boolean {
    return (
      this.options.length === 0 ||
      this.options.some((option) => option.backend === this.selected && option.available)
    )
  }
  select(backend: Backend) {
    if (!this.options.some((option) => option.backend === backend && option.available))
      throw new Error('所选决策后端不可用，请检查两套服务配置并重启后台。')
    this.drafts.set(this.scope, backend)
  }
  restore(backend: Backend) {
    this.drafts.set(this.scope, backend)
  }
  submission(): { decisionBackend?: Backend } {
    if (!this.available) throw new Error('本轮决策后端不可用，请重新选择。')
    return this.options.length ? { decisionBackend: this.selected } : {}
  }
}
